"""
Celery tasks — subscription billing lifecycle + tenant database provisioning.

Registered schedules (config/celery.py):
    00:05 UTC daily  →  suspend_expired_subscriptions
    09:00 UTC daily  →  send_renewal_reminders

On-demand tasks (fired by services.py after payment webhook):
    provision_tenant_db_task  →  create PostgreSQL DB + run migrations
"""
import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Task 1: Suspend expired subscriptions (daily @ 00:05)
# ──────────────────────────────────────────────────────────────────────────────

@shared_task(
    name="accounts.tasks.suspend_expired_subscriptions",
    bind=True,
    max_retries=3,
    default_retry_delay=300,   # retry after 5 minutes if it crashes
)
def suspend_expired_subscriptions(self):
    """
    Find every ACTIVE subscription whose next_billing_date has passed
    (beyond the grace period) and suspend both the subscription and the user.

    Grace period (SUBSCRIPTION_GRACE_DAYS, default 0) lets you give users
    a buffer before hard-suspending them. Set to 3 in .env for a 3-day grace.
    """
    from .models import Subscription

    grace_days = getattr(settings, "SUBSCRIPTION_GRACE_DAYS", 0)
    cutoff     = timezone.localdate() - timedelta(days=grace_days)

    # All ACTIVE subscriptions whose next_billing_date has ARRIVED (<= cutoff).
    # With the default 0-day grace this locks the account at 12 AM (this task
    # runs 00:05) ON the billing due date itself if the bill is still unpaid —
    # e.g. a sub due 30 June is suspended at 00:05 on 30 June. No data is
    # touched; only the user/subscription status flips to SUSPENDED.
    expired_qs = Subscription.objects.filter(
        status           = Subscription.Status.ACTIVE,
        next_billing_date__lte = cutoff,
    ).select_related("user")

    count = 0
    errors = 0

    renewed_free = 0
    for sub in expired_qs:
        try:
            # Referral milestone — a pending FREE-month credit renews
            # the subscription automatically instead of suspending it.
            if _try_free_month_renewal(sub):
                renewed_free += 1
                continue
            _suspend_one(sub)
            count += 1
        except Exception as exc:
            errors += 1
            logger.error(
                "Failed to suspend subscription %s (user=%s): %s",
                sub.id, sub.user.email, exc,
            )

    logger.info(
        "suspend_expired_subscriptions: suspended=%d auto_renewed_free=%d errors=%d cutoff=%s",
        count, renewed_free, errors, cutoff,
    )
    return {"suspended": count, "auto_renewed_free": renewed_free, "errors": errors}


@transaction.atomic
def _try_free_month_renewal(sub) -> bool:
    """Referral milestone auto-renewal. If the subscriber holds a
    pending FREE-month (>=100%) DiscountCredit, consume it: record a
    zero-amount SUCCESS renewal payment, renew the subscription, and
    keep the user active. Returns True when the renewal happened."""
    from .models import DiscountCredit, Payment, User
    from .services import generate_transaction_id

    credit = (
        DiscountCredit.objects
        .select_for_update()
        .filter(user=sub.user, applied_at__isnull=True, percent__gte=100)
        .order_by("earned_at")
        .first()
    )
    if not credit:
        return False

    payment = Payment.objects.create(
        user           = sub.user,
        subscription   = sub,
        amount         = 0,
        status         = Payment.Status.SUCCESS,
        paid_at        = timezone.now(),
        transaction_id = generate_transaction_id(),
        metadata = {
            "type":               "renewal",
            "auto":               "free_month_referral",
            "discount_credit_id": str(credit.id),
            "plan_name":          getattr(sub.plan, "name", ""),
            "note":               "Free month earned via referral milestone (5 referrals in one month).",
        },
    )
    credit.applied_at = timezone.now()
    credit.applied_payment = payment
    credit.save(update_fields=["applied_at", "applied_payment"])

    sub.renew()   # resets next_billing_date + status ACTIVE

    user = sub.user
    if user.status == User.Status.SUSPENDED or not user.is_active:
        user.status    = User.Status.ACTIVE
        user.is_active = True
        user.save(update_fields=["status", "is_active"])

    logger.info(
        "Free-month auto-renewal: user=%s sub=%s credit=%s next_billing=%s",
        user.email, sub.id, credit.id, sub.next_billing_date,
    )
    return True


@transaction.atomic
def _suspend_one(sub):
    """Atomically suspend a single subscription + its user, then notify."""
    from .emails import send_suspension_email

    sub.status = sub.Status.SUSPENDED
    sub.save(update_fields=["status"])

    user = sub.user
    user.status    = user.Status.SUSPENDED
    user.is_active = False
    user.save(update_fields=["status", "is_active"])

    logger.info(
        "Suspended: user=%s subscription=%s expired=%s",
        user.email, sub.id, sub.next_billing_date,
    )
    # Fire email outside this function using on_commit so it only
    # fires after the DB transaction commits.
    transaction.on_commit(lambda: send_suspension_email(user, sub))


# ──────────────────────────────────────────────────────────────────────────────
# Task 2: Send renewal reminder emails (daily @ 09:00)
# ──────────────────────────────────────────────────────────────────────────────

@shared_task(
    name="accounts.tasks.send_renewal_reminders",
    bind=True,
    max_retries=3,
    default_retry_delay=300,
)
def send_renewal_reminders(self):
    """
    Daily billing reminders. Runs once a day (09:00) and reminds EVERY active
    subscriber whose bill is due within the reminder window — every day from
    SUBSCRIPTION_REMINDER_DAYS before the due date right up to the due date,
    until they pay. (Once they pay, the subscription renews and falls out of
    the window; once the due date passes unpaid, suspend_expired_subscriptions
    locks them and they leave the ACTIVE set.)

    Example: a sub due 30 June with the default 5-day window gets a reminder
    every day on 25, 26, 27, 28, 29 and 30 June until paid.
    """
    from .models import Subscription
    from .emails import send_renewal_reminder_email

    window = getattr(settings, "SUBSCRIPTION_REMINDER_DAYS", 5)
    today  = timezone.localdate()
    window_end = today + timedelta(days=window)

    expiring_qs = Subscription.objects.filter(
        status                 = Subscription.Status.ACTIVE,
        next_billing_date__gte = today,         # not yet overdue
        next_billing_date__lte = window_end,    # within the reminder window
    ).select_related("user", "plan")

    count  = 0
    errors = 0

    for sub in expiring_qs:
        try:
            send_renewal_reminder_email(sub.user, sub)
            _create_in_app_billing_reminder(sub)
            count += 1
        except Exception as exc:
            errors += 1
            logger.error(
                "Failed to send reminder to user=%s: %s",
                sub.user.email, exc,
            )

    logger.info(
        "send_renewal_reminders: sent=%d errors=%d window=[%s..%s]",
        count, errors, today, window_end,
    )
    return {"reminders_sent": count, "errors": errors}


def _create_in_app_billing_reminder(sub):
    """
    Drop an IN_APP Notification row in the tenant DB so the tenant sees a
    reminder bell + entry next time they sign in. Best-effort — failures
    don't block the email path.
    """
    try:
        from accounts.tenant_db import register_tenant_db
        from notifications.models import Notification

        tenant = getattr(sub.user, "tenant", None)
        if not tenant or not tenant.is_provisioned:
            return

        alias = tenant.db_alias
        register_tenant_db(alias, tenant.db_name)

        # One reminder per subscriber per day (the task runs daily; this guards
        # against an accidental double-run spamming the bell).
        today = timezone.localdate()
        already = Notification.objects.using(alias).filter(
            event_type="BILLING_REMINDER",
            related_id=str(sub.id),
            created_at__date=today,
        ).exists()
        if already:
            return

        try:
            from .views import get_bdt_plan_price  # noqa: PLC0415
            amount = get_bdt_plan_price(sub.plan)
        except Exception:
            amount = getattr(sub.plan, "price", "")
        days_left = (sub.next_billing_date - today).days
        when = ("today" if days_left == 0
                else f"in {days_left} day{'s' if days_left != 1 else ''}")
        body = (
            f"Your {sub.plan.name} subscription bill of ৳{amount} is due "
            f"{when} ({sub.next_billing_date.isoformat()}). Please pay before the "
            f"due date — if it's not paid, your account is locked at 12:00 AM on "
            f"the due date. Don't worry: all your data stays safe and is restored "
            f"the moment you pay."
        )
        Notification.objects.using(alias).create(
            template=None,
            event_type="BILLING_REMINDER",
            channel="IN_APP",
            recipient_id=sub.user.id,
            recipient_email=sub.user.email,
            recipient_name=sub.user.name,
            subject="Subscription bill due — pay to avoid account lock",
            body=body,
            context={
                "plan": sub.plan.name,
                "amount": str(amount),
                "next_billing_date": sub.next_billing_date.isoformat(),
                "days_left": days_left,
            },
            related_type="Subscription",
            related_id=str(sub.id),
        )
    except Exception as exc:
        logger.warning("In-app billing reminder skipped for %s: %s", sub.user.email, exc)


# ──────────────────────────────────────────────────────────────────────────────
# Task 2b: Referral programme — safety-net awarder
#
# The synchronous payment-success path already awards referrals immediately.
# This nightly task exists ONLY to catch edge cases the sync path missed —
# typically a trial signup whose conversion-to-paid happened during a window
# where the webhook handler crashed or wasn't reachable. Idempotent — calling
# award_for_first_paid_payment on an already-awarded referral is a no-op.
# ──────────────────────────────────────────────────────────────────────────────

@shared_task(
    name="accounts.tasks.award_pending_referrals",
    bind=True,
    max_retries=3,
    default_retry_delay=600,
)
def award_pending_referrals(self):
    """Find every Referral with awarded_at=None whose referred user has at
    least one successful non-trial Payment. Issue the referrer's discount
    credit for each match. Designed for daily cron."""
    from .models import Payment, Referral
    from . import referrals as referrals_service

    cutoff = timezone.now() - timedelta(days=90)   # safety: don't scan forever
    pending = (
        Referral.objects
        .filter(awarded_at__isnull=True, created_at__gte=cutoff)
        .select_related("referred", "referrer")
    )

    awarded = 0
    for referral in pending:
        # Find the user's earliest successful non-trial payment.
        payment = (
            Payment.objects
            .filter(
                user_id=referral.referred_id,
                status=Payment.Status.SUCCESS,
                amount__gt=0,
            )
            .select_related("subscription__plan")
            .order_by("paid_at", "created_at")
            .first()
        )
        if not payment:
            continue
        # Skip if it was a trial-plan payment (defence in depth — non-trial
        # plans always have amount > 0, but a misconfigured plan could slip
        # through).
        if payment.subscription and payment.subscription.plan and \
           payment.subscription.plan.is_trial:
            continue

        if referrals_service.award_for_first_paid_payment(payment):
            awarded += 1

    logger.info(
        "award_pending_referrals: scanned=%d awarded=%d",
        pending.count(), awarded,
    )
    return {"scanned": pending.count(), "awarded": awarded}


# ──────────────────────────────────────────────────────────────────────────────
# Task 3: Provision tenant database (triggered after successful payment)
# ──────────────────────────────────────────────────────────────────────────────

@shared_task(
    name="accounts.tasks.provision_tenant_db",
    bind=True,
    max_retries=5,
    default_retry_delay=30,  # retry quickly — provisioning should be fast
)
def provision_tenant_db_task(self, user_id: str):
    """
    Asynchronously create and initialise a tenant's dedicated PostgreSQL database.

    Steps (delegated to accounts.tenant_db.provision_tenant):
      1. Create the physical PostgreSQL database (psycopg2, autocommit).
      2. Register the alias in settings.DATABASES.
      3. Run tenant-app migrations (no-op until business apps are added).
      4. Mark Tenant.is_provisioned = True in the master DB.

    Retried up to 5 times with a 30-second delay between attempts so that
    transient DB unavailability doesn't permanently fail the provisioning.
    """
    from .tenant_db import provision_tenant  # noqa: PLC0415

    logger.info("provision_tenant_db_task started: user_id=%s", user_id)
    try:
        provision_tenant(user_id)
        logger.info("provision_tenant_db_task succeeded: user_id=%s", user_id)
    except Exception as exc:
        logger.exception(
            "provision_tenant_db_task failed (attempt %d): user_id=%s",
            self.request.retries + 1, user_id,
        )
        raise self.retry(exc=exc)
