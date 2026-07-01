"""
Referral programme — phone-based.

API consumed by the rest of the codebase:
    record_referral_from_phone(*, new_user, referrer_phone, plan)
        Called from trial signup AND the paid-signup webhook. Creates a
        Referral row if we can identify an existing tenant by phone.
        Silently returns None for invalid / self / duplicate / unknown phones.

    award_for_first_paid_payment(payment)
        Called from the payment-success path. If `payment.user` has a
        pending Referral (and the payment is for a non-trial plan), credit
        the referrer with a 20% DiscountCredit and SMS them.

    apply_pending_discount(*, user, base_amount)
        Called from create_renewal_payment (and any flow that bills an
        existing tenant). Returns the discounted amount and the
        DiscountCredit row to link to the payment afterwards.

    finalize_applied_credit(credit, payment)
        Marks a DiscountCredit as consumed once the payment row is created.

    list_referral_status(user)
        Returns the dashboard summary for /api/me/referrals/.

The daily safety-net Celery task (accounts.tasks.award_pending_referrals)
calls award_for_first_paid_payment for any Referrals it finds with
awarded_at=None whose referred user has a recent successful non-trial
payment that was missed by the synchronous path.
"""
from __future__ import annotations

import logging
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Tuple

from django.db import transaction
from django.utils import timezone

from .models import DiscountCredit, Payment, Plan, Referral, User
from .sms import _normalize_msisdn, send_sms

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# 1. record_referral_from_phone — runs at signup time
# ──────────────────────────────────────────────────────────────────────────────


def record_referral_from_phone(
    *,
    new_user: User,
    referrer_phone: str,
    plan: Optional[Plan] = None,
) -> Optional[Referral]:
    """
    Try to register a Referral linking `new_user` to whichever existing tenant
    matches `referrer_phone`. Returns the Referral row, or None if the phone
    cannot be matched / is self-referral / a referral already exists.

    Errors are LOGGED but never raised — referrals are best-effort and must
    never block the signup flow.
    """
    if not referrer_phone:
        return None

    msisdn = _normalize_msisdn(referrer_phone)
    if not msisdn:
        logger.info("Referral phone %r could not be normalised — ignored.", referrer_phone)
        return None

    # Match against any candidate whose normalised phone equals msisdn.
    # Phones are stored verbatim, so we filter by digit-tail then double-check
    # via _normalize_msisdn(). This avoids needing a separate normalised column.
    # Sort the candidates by created_at ascending and pick the FIRST match —
    # the genuine owner of a phone number registered earliest. Previously we
    # just took next() over an unordered queryset, which is non-deterministic
    # and caused at least one misattribution where two Users shared a phone.
    tail = msisdn[-9:]   # last 9 digits — enough to uniquely identify in BD
    candidates = list(
        User.objects.exclude(pk=new_user.pk)
        .filter(phone__icontains=tail)
        .order_by("created_at")
        .only("id", "email", "phone", "name", "username", "created_at")
    )
    matches = [u for u in candidates if _normalize_msisdn(u.phone) == msisdn]
    if not matches:
        logger.info(
            "Referral phone %s did not match any tenant — skipping.", msisdn
        )
        return None
    if len(matches) > 1:
        # Log so the operator can clean up the duplicate later. We still
        # proceed using the earliest-created account — the original owner.
        logger.warning(
            "Referral phone %s matches %d users; picking earliest-created (%s). "
            "Duplicates: %s",
            msisdn, len(matches), matches[0].email,
            [m.email for m in matches[1:]],
        )
    referrer = matches[0]

    # Block self-referral (paranoia — already excluded by pk above, but the
    # input phone might equal the user's own phone).
    if referrer.pk == new_user.pk:
        return None

    # Block duplicate Referral for this referred user.
    if hasattr(new_user, "referral_source"):
        logger.info(
            "Referral for %s already recorded — ignoring duplicate.", new_user.email
        )
        return None

    referral = Referral.objects.create(
        referrer=referrer,
        referred=new_user,
        referrer_phone_snapshot=referrer_phone.strip()[:30],
        plan_at_signup=plan,
    )
    logger.info(
        "Referral recorded: %s referred by %s (plan=%s)",
        new_user.email, referrer.email, plan.name if plan else "—",
    )
    return referral


# ──────────────────────────────────────────────────────────────────────────────
# 2. award_for_first_paid_payment — runs on payment success
# ──────────────────────────────────────────────────────────────────────────────


def _payment_is_for_trial(payment: Payment) -> bool:
    """A trial payment has no real cash flow — Decimal(0) and the linked
    subscription's plan has is_trial=True."""
    if payment.amount and Decimal(str(payment.amount)) > Decimal("0"):
        return False
    if payment.subscription and payment.subscription.plan.is_trial:
        return True
    meta_plan_id = (payment.metadata or {}).get("plan_id")
    if meta_plan_id:
        plan = Plan.objects.filter(id=meta_plan_id).only("is_trial").first()
        if plan and plan.is_trial:
            return True
    return False


def award_for_first_paid_payment(payment: Payment) -> Optional[DiscountCredit]:
    """
    If `payment.user` has a pending Referral (the user was referred by
    someone, and that referral hasn't been awarded yet), and this payment
    is the user's first SUCCESS payment for a non-trial plan, issue the
    referrer's 20% DiscountCredit and SMS them.

    Idempotent — safe to call from both the synchronous webhook path and
    from the daily safety-net task.
    """
    if not payment or not payment.user_id:
        return None
    if payment.status != Payment.Status.SUCCESS:
        return None
    if _payment_is_for_trial(payment):
        return None

    # Does the user have a pending referral pointing AT them?
    referral = (
        Referral.objects
        .select_related("referrer")
        .filter(referred_id=payment.user_id, awarded_at__isnull=True)
        .first()
    )
    if not referral:
        return None

    referrer = referral.referrer
    with transaction.atomic():
        # Re-check inside the transaction to avoid duplicate awards under
        # concurrent webhook deliveries.
        locked = (
            Referral.objects
            .select_for_update()
            .filter(pk=referral.pk, awarded_at__isnull=True)
            .first()
        )
        if not locked:
            return None

        credit = DiscountCredit.objects.create(
            user=referrer,
            referral=locked,
            percent=DiscountCredit.DEFAULT_PERCENT,
            notes=(
                f"Earned by referring {payment.user.email} "
                f"(payment {payment.transaction_id})."
            ),
        )
        locked.awarded_at = timezone.now()
        locked.triggering_payment = payment
        locked.save(update_fields=["awarded_at", "triggering_payment"])

    transaction.on_commit(lambda: _send_award_sms(referrer, credit, payment.user))
    # Milestone check — every 5 awarded referrals inside the calendar
    # month earns a FREE month on top of the per-referral 20% credits.
    transaction.on_commit(lambda: check_referral_milestones(referrer))
    logger.info(
        "Referral awarded: %s → %s credit=%s (txn=%s)",
        payment.user.email, referrer.email, credit.id, payment.transaction_id,
    )
    return credit


# ──────────────────────────────────────────────────────────────────────────────
# 3b. Referral milestones — every 5 referrals AWARDED inside one calendar
#     month earns ONE FREE MONTH (a 100%-off DiscountCredit). 10 in a
#     month → two free months, and so on. The free month is consumed by
#     the auto-renew task in accounts.tasks, NOT by manual renewals —
#     apply_pending_discount skips >=100% credits so the operator's
#     manual payment flow never tries to charge ৳0 through the gateway.
# ──────────────────────────────────────────────────────────────────────────────

MILESTONE_SIZE    = 5
MILESTONE_PERCENT = Decimal("100.00")


def check_referral_milestones(referrer: User, when=None) -> list:
    """Grant any FREE-month credits the referrer has earned for the
    calendar month of `when` (default: now). Idempotent — each granted
    milestone is stamped into the credit's notes as
    'milestone:<YYYY-MM>:<n>' and never re-granted."""
    now = when or timezone.localtime()
    month_key   = now.strftime("%Y-%m")
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if now.month == 12:
        next_month = now.replace(year=now.year + 1, month=1, day=1,
                                 hour=0, minute=0, second=0, microsecond=0)
    else:
        next_month = now.replace(month=now.month + 1, day=1,
                                 hour=0, minute=0, second=0, microsecond=0)

    awarded = Referral.objects.filter(
        referrer=referrer,
        awarded_at__gte=month_start,
        awarded_at__lt=next_month,
    ).count()
    earned = awarded // MILESTONE_SIZE
    if earned <= 0:
        return []

    marker = f"milestone:{month_key}"
    already = DiscountCredit.objects.filter(
        user=referrer, notes__startswith=marker,
    ).count()
    created = []
    for n in range(already + 1, earned + 1):
        created.append(DiscountCredit.objects.create(
            user=referrer,
            percent=MILESTONE_PERCENT,
            notes=(
                f"{marker}:{n} — FREE month earned for "
                f"{n * MILESTONE_SIZE} referrals in {month_key}. "
                f"Auto-applies to the next renewal."
            ),
        ))
    if created:
        logger.info(
            "Referral milestone: user=%s month=%s free_months_granted=%d",
            referrer.email, month_key, len(created),
        )
    return created


def _send_award_sms(referrer: User, credit: DiscountCredit, referred: User) -> None:
    if not referrer.phone:
        return
    msg = (
        f"IFFAA: {referred.name or 'A new tenant'} just subscribed using your phone "
        f"as referral. You'll get {int(credit.percent)}% off your next month's bill. "
        "Thank you for spreading the word!"
    )
    try:
        send_sms(referrer.phone, msg)
    except Exception as exc:  # pragma: no cover
        logger.exception("Referral award SMS failed for %s: %s", referrer.email, exc)


# ──────────────────────────────────────────────────────────────────────────────
# 3. apply_pending_discount — runs when a renewal payment is being created
# ──────────────────────────────────────────────────────────────────────────────


def apply_pending_discount(
    *,
    user: User,
    base_amount: Decimal,
) -> Tuple[Decimal, Optional[DiscountCredit]]:
    """
    Look up the user's oldest unapplied DiscountCredit. If one exists, return
    (discounted_amount, credit_row). Otherwise return (base_amount, None).

    The caller is expected to:
        1. Use `discounted_amount` when creating the Payment row.
        2. Call `finalize_applied_credit(credit, payment)` after the Payment
           row is committed, to link the credit to the payment and mark it
           consumed.
    """
    credit = (
        DiscountCredit.objects
        # Free-month (>=100%) milestone credits are consumed ONLY by
        # the auto-renew task — charging ৳0 through the gateway from
        # the manual Pay Bill flow would fail, so skip them here.
        .filter(user=user, applied_at__isnull=True, percent__lt=Decimal("100"))
        .order_by("earned_at")
        .first()
    )
    if not credit:
        return Decimal(str(base_amount)), None

    base = Decimal(str(base_amount))
    factor = (Decimal("100") - credit.percent) / Decimal("100")
    discounted = (base * factor).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return discounted, credit


def finalize_applied_credit(credit: DiscountCredit, payment: Payment) -> None:
    """Mark the credit as applied to a specific payment. No-op if already
    applied (idempotent under retries)."""
    if not credit or credit.applied_at:
        return
    credit.applied_at = timezone.now()
    credit.applied_payment = payment
    credit.save(update_fields=["applied_at", "applied_payment"])


# ──────────────────────────────────────────────────────────────────────────────
# 4. list_referral_status — for the dashboard banner + history page
# ──────────────────────────────────────────────────────────────────────────────


def list_referral_status(user: User) -> dict:
    """Compact view for /api/me/referrals/."""
    referrals = (
        Referral.objects
        .filter(referrer=user)
        .select_related("referred")
        .order_by("-created_at")[:50]
    )
    credits = (
        DiscountCredit.objects
        .filter(user=user)
        .order_by("-earned_at")[:50]
    )
    pending_credits = [c for c in credits if c.applied_at is None]

    # Milestone status for the dashboard banner.
    now = timezone.localtime()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    monthly_awarded = Referral.objects.filter(
        referrer=user, awarded_at__gte=month_start,
    ).count()
    free_pending = [c for c in pending_credits if c.percent >= Decimal("100")]
    month_key = now.strftime("%Y-%m")
    earned_this_month = DiscountCredit.objects.filter(
        user=user, notes__startswith=f"milestone:{month_key}",
    ).count()

    return {
        "summary": {
            "total_referrals":     Referral.objects.filter(referrer=user).count(),
            "awarded_referrals":   Referral.objects.filter(referrer=user, awarded_at__isnull=False).count(),
            "pending_referrals":   Referral.objects.filter(referrer=user, awarded_at__isnull=True).count(),
            "pending_credits":     len([c for c in pending_credits if c.percent < Decimal("100")]),
            "next_discount_percent": next(
                (int(c.percent) for c in pending_credits if c.percent < Decimal("100")), 0
            ),
            # Milestone programme — 5 referrals in a month = 1 free month.
            "milestone_size":            MILESTONE_SIZE,
            "monthly_awarded_referrals": monthly_awarded,
            "referrals_to_next_free":    max(0, MILESTONE_SIZE - (monthly_awarded % MILESTONE_SIZE)) % MILESTONE_SIZE,
            "free_months_pending":       len(free_pending),
            "free_months_earned_this_month": earned_this_month,
        },
        "referrals": [
            {
                "id":            str(r.id),
                "referred_name": r.referred.name,
                "referred_email": r.referred.email,
                "plan_at_signup": r.plan_at_signup.name if r.plan_at_signup else None,
                "awarded":       r.awarded_at is not None,
                "awarded_at":    r.awarded_at,
                "created_at":    r.created_at,
            }
            for r in referrals
        ],
        "credits": [
            {
                "id":         str(c.id),
                "percent":    str(c.percent),
                "earned_at":  c.earned_at,
                "applied_at": c.applied_at,
                "is_pending": c.applied_at is None,
                "notes":      c.notes,
            }
            for c in credits
        ],
    }
