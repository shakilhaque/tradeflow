"""
Subscription Management — Super-Admin service layer.

Pure business logic for the platform admin Subscription module: KPI roll-ups,
derived status, list/detail serialization, and the admin actions
(change/upgrade/downgrade plan, extend, bonus days, change billing date,
suspend, reactivate). Every mutating action writes a SubscriptionHistory row
and, when the status changes, a SubscriptionStatusLog row — so the details
page can render a full audit timeline.

All money is reported in canonical BDT via accounts.views.get_bdt_plan_price.
Integrates with the existing billing/suspension system: suspend/reactivate
go through User.suspend()/activate() so the BillingGate + middleware lock /
unlock the tenant exactly like the automated flow does.
"""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from .models import Plan, Subscription, SubscriptionHistory, SubscriptionStatusLog

EXPIRING_SOON_DAYS = 7


# ──────────────────────────────────────────────────────────────────────────────
# Pricing helpers
# ──────────────────────────────────────────────────────────────────────────────

def _plan_price(plan) -> Decimal:
    """Canonical monthly/cycle price in BDT for a plan."""
    if plan is None:
        return Decimal("0")
    try:
        from .views import get_bdt_plan_price
        return Decimal(str(get_bdt_plan_price(plan)))
    except Exception:
        return Decimal(str(getattr(plan, "price", 0) or 0))


def _monthly_fee(plan) -> Decimal:
    """Normalise a plan's price to a per-MONTH figure for MRR."""
    price = _plan_price(plan)
    if plan is not None and getattr(plan, "billing_cycle", "monthly") == Plan.BillingCycle.YEARLY:
        return (price / Decimal("12")).quantize(Decimal("0.01"))
    return price.quantize(Decimal("0.01"))


# ──────────────────────────────────────────────────────────────────────────────
# Derived status
# ──────────────────────────────────────────────────────────────────────────────

def derived_status(sub) -> str:
    """
    Map a subscription to one of the admin-facing statuses:
    trial | active | expiring_soon | expired | suspended | cancelled.
    """
    raw = sub.status
    if raw == Subscription.Status.CANCELLED:
        return "cancelled"
    if raw == Subscription.Status.SUSPENDED:
        return "suspended"
    days = (sub.next_billing_date - timezone.localdate()).days
    if getattr(sub.plan, "is_trial", False):
        return "expired" if days < 0 else "trial"
    if days < 0:
        return "expired"
    if days <= EXPIRING_SOON_DAYS:
        return "expiring_soon"
    return "active"


def days_remaining(sub) -> int:
    return (sub.next_billing_date - timezone.localdate()).days


# ──────────────────────────────────────────────────────────────────────────────
# KPIs
# ──────────────────────────────────────────────────────────────────────────────

def kpis() -> dict:
    """Dashboard KPI roll-up across every subscription."""
    today = timezone.localdate()
    qs = Subscription.objects.select_related("plan")

    active = expiring_7 = expiring_30 = suspended = trial = 0
    mrr = Decimal("0")
    for sub in qs:
        st = sub.status
        if st == Subscription.Status.SUSPENDED:
            suspended += 1
            continue
        if st != Subscription.Status.ACTIVE:
            continue  # expired / cancelled don't count toward active/MRR
        # ACTIVE from here.
        is_trial = bool(getattr(sub.plan, "is_trial", False))
        if is_trial:
            trial += 1
        else:
            active += 1
            mrr += _monthly_fee(sub.plan)
        days = (sub.next_billing_date - today).days
        if 0 <= days <= 7:
            expiring_7 += 1
        if 0 <= days <= 30:
            expiring_30 += 1

    mrr = mrr.quantize(Decimal("0.01"))
    return {
        "active_subscriptions":   active,
        "expiring_7_days":        expiring_7,
        "expiring_30_days":       expiring_30,
        "suspended_subscriptions": suspended,
        "trial_accounts":         trial,
        "mrr":                    str(mrr),
        "arr":                    str((mrr * Decimal("12")).quantize(Decimal("0.01"))),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Serialization
# ──────────────────────────────────────────────────────────────────────────────

def _tenant_company(user) -> str:
    tenant = getattr(user, "tenant", None)
    if tenant is not None:
        for attr in ("business_name", "company_name", "name"):
            val = getattr(tenant, attr, "") or ""
            if val:
                return val
    return getattr(user, "business_name", "") or ""


def serialize_row(sub) -> dict:
    user = sub.user
    plan = sub.plan
    return {
        "id":               str(sub.id),
        "tenant_name":      getattr(user, "name", "") or getattr(user, "email", ""),
        "tenant_email":     getattr(user, "email", ""),
        "company_name":     _tenant_company(user),
        "plan_id":          str(plan.id) if plan else None,
        "plan_name":        getattr(plan, "name", "—"),
        "billing_cycle":    getattr(plan, "billing_cycle", ""),
        "status":           derived_status(sub),
        "raw_status":       sub.status,
        "account_status":   getattr(user, "status", ""),
        "is_trial":         bool(getattr(plan, "is_trial", False)),
        "start_date":       sub.start_date.isoformat() if sub.start_date else None,
        "expiry_date":      sub.next_billing_date.isoformat() if sub.next_billing_date else None,
        "days_remaining":   days_remaining(sub),
        "monthly_fee":      str(_monthly_fee(plan)),
        "plan_price":       str(_plan_price(plan)),
    }


def serialize_detail(sub) -> dict:
    user = sub.user
    base = serialize_row(sub)

    # Payment history (master-DB Payment rows for this user).
    payments = []
    try:
        from .models import Payment
        for p in Payment.objects.filter(user=user).order_by("-created_at")[:100]:
            payments.append({
                "id":             str(p.id),
                "amount":         str(p.amount),
                "status":         p.status,
                "transaction_id": p.transaction_id,
                "paid_at":        p.paid_at.isoformat() if getattr(p, "paid_at", None) else None,
                "created_at":     p.created_at.isoformat() if getattr(p, "created_at", None) else None,
                "metadata":       getattr(p, "metadata", {}) or {},
            })
    except Exception:
        payments = []

    history = [
        {
            "id":          str(h.id),
            "action":      h.action,
            "from_plan":   getattr(h.from_plan, "name", None),
            "to_plan":     getattr(h.to_plan, "name", None),
            "previous_billing_date": h.previous_billing_date.isoformat() if h.previous_billing_date else None,
            "new_billing_date":      h.new_billing_date.isoformat() if h.new_billing_date else None,
            "days_delta":  h.days_delta,
            "amount":      str(h.amount) if h.amount is not None else None,
            "note":        h.note,
            "performed_by_email": h.performed_by_email,
            "created_at":  h.created_at.isoformat(),
        }
        for h in sub.history.select_related("from_plan", "to_plan").all()[:200]
    ]

    status_logs = [
        {
            "id":          str(s.id),
            "from_status": s.from_status,
            "to_status":   s.to_status,
            "reason":      s.reason,
            "performed_by_email": s.performed_by_email,
            "created_at":  s.created_at.isoformat(),
        }
        for s in sub.status_logs.all()[:200]
    ]

    tenant = getattr(user, "tenant", None)
    base.update({
        "tenant": {
            "name":          getattr(user, "name", ""),
            "email":         getattr(user, "email", ""),
            "phone":         getattr(user, "phone", ""),
            "company_name":  _tenant_company(user),
            "account_status": getattr(user, "status", ""),
            "is_active":     getattr(user, "is_active", True),
            "db_name":       getattr(tenant, "db_name", "") if tenant else "",
            "is_provisioned": getattr(tenant, "is_provisioned", False) if tenant else False,
            "joined_at":     user.created_at.isoformat() if getattr(user, "created_at", None) else None,
        },
        "plan": {
            "id":            str(sub.plan.id) if sub.plan else None,
            "name":          getattr(sub.plan, "name", ""),
            "billing_cycle": getattr(sub.plan, "billing_cycle", ""),
            "price":         str(_plan_price(sub.plan)),
            "duration_days": getattr(sub.plan, "duration_days", None),
        },
        "payments":     payments,
        "history":      history,
        "status_logs":  status_logs,
    })
    return base


def serialize_plan(plan) -> dict:
    return {
        "id":            str(plan.id),
        "name":          plan.name,
        "billing_cycle": plan.billing_cycle,
        "price":         str(_plan_price(plan)),
        "duration_days": plan.duration_days,
        "is_trial":      plan.is_trial,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Audit helpers
# ──────────────────────────────────────────────────────────────────────────────

def _actor_fields(actor):
    if actor is None:
        return None, ""
    return getattr(actor, "id", None), getattr(actor, "email", "") or ""


def _log_history(sub, action, *, actor=None, note="", from_plan=None, to_plan=None,
                 previous_billing_date=None, new_billing_date=None, days_delta=None,
                 amount=None, metadata=None):
    pid, pemail = _actor_fields(actor)
    SubscriptionHistory.objects.create(
        subscription=sub, user=sub.user, action=action,
        from_plan=from_plan, to_plan=to_plan,
        previous_billing_date=previous_billing_date, new_billing_date=new_billing_date,
        days_delta=days_delta, amount=amount, note=note or "",
        metadata=metadata or {}, performed_by=pid, performed_by_email=pemail,
    )


def _log_status(sub, from_status, to_status, *, actor=None, reason=""):
    pid, pemail = _actor_fields(actor)
    SubscriptionStatusLog.objects.create(
        subscription=sub, user=sub.user,
        from_status=from_status or "", to_status=to_status, reason=reason or "",
        performed_by=pid, performed_by_email=pemail,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Admin actions
# ──────────────────────────────────────────────────────────────────────────────

class SubscriptionAdminError(Exception):
    """Friendly error surfaced to the admin UI."""


@transaction.atomic
def change_plan(sub, *, new_plan_id, actor=None, reason="") -> Subscription:
    """Change / upgrade / downgrade the plan. Direction is inferred from price."""
    try:
        new_plan = Plan.objects.get(id=new_plan_id)
    except Plan.DoesNotExist:
        raise SubscriptionAdminError("Selected plan not found.")
    old_plan = sub.plan
    if old_plan and str(old_plan.id) == str(new_plan.id):
        raise SubscriptionAdminError("That is already the current plan.")

    old_price = _plan_price(old_plan)
    new_price = _plan_price(new_plan)
    action = (SubscriptionHistory.Action.UPGRADED if new_price > old_price
              else SubscriptionHistory.Action.DOWNGRADED if new_price < old_price
              else SubscriptionHistory.Action.PLAN_CHANGED)

    sub.plan = new_plan
    sub.save(update_fields=["plan"])
    _log_history(sub, action, actor=actor, note=reason,
                 from_plan=old_plan, to_plan=new_plan)
    return sub


@transaction.atomic
def extend_subscription(sub, *, days, actor=None, reason="", bonus=False) -> Subscription:
    """Add `days` to the next billing date (paid extension or free bonus days)."""
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise SubscriptionAdminError("Days must be a whole number.")
    if days == 0:
        raise SubscriptionAdminError("Days must be non-zero.")
    prev = sub.next_billing_date
    sub.next_billing_date = prev + timedelta(days=days)
    sub.save(update_fields=["next_billing_date"])
    _log_history(
        sub,
        SubscriptionHistory.Action.BONUS_DAYS if bonus else SubscriptionHistory.Action.EXTENDED,
        actor=actor, note=reason, days_delta=days,
        previous_billing_date=prev, new_billing_date=sub.next_billing_date,
    )
    return sub


@transaction.atomic
def change_billing_date(sub, *, new_date, actor=None, reason="") -> Subscription:
    prev = sub.next_billing_date
    sub.next_billing_date = new_date
    sub.save(update_fields=["next_billing_date"])
    _log_history(sub, SubscriptionHistory.Action.BILLING_DATE_CHANGED,
                 actor=actor, note=reason,
                 previous_billing_date=prev, new_billing_date=new_date)
    return sub


@transaction.atomic
def suspend_subscription(sub, *, actor=None, reason="") -> Subscription:
    if sub.status == Subscription.Status.SUSPENDED:
        raise SubscriptionAdminError("Subscription is already suspended.")
    from_status = sub.status
    # User.suspend() flips the user + active subs to SUSPENDED — the same path
    # the automated lock uses, so the tenant is locked to the Pay Bill flow.
    sub.user.suspend()
    sub.refresh_from_db()
    if sub.status != Subscription.Status.SUSPENDED:
        sub.status = Subscription.Status.SUSPENDED
        sub.save(update_fields=["status"])
    _log_history(sub, SubscriptionHistory.Action.SUSPENDED, actor=actor, note=reason)
    _log_status(sub, from_status, Subscription.Status.SUSPENDED, actor=actor, reason=reason)
    return sub


def send_reminder(sub, *, actor=None, reason="") -> Subscription:
    """Email the tenant a renewal reminder for this subscription (best-effort)."""
    try:
        from . import emails
        emails.send_renewal_reminder_email(sub.user, sub)
    except Exception:  # noqa: BLE001
        raise SubscriptionAdminError("Could not send the reminder email. Please try again.")
    try:
        _log_history(sub, "reminder_sent", actor=actor, note=reason or "Renewal reminder sent")
    except Exception:  # noqa: BLE001
        pass
    return sub


@transaction.atomic
def reactivate_subscription(sub, *, actor=None, reason="") -> Subscription:
    if sub.status == Subscription.Status.ACTIVE and sub.user.is_active:
        raise SubscriptionAdminError("Subscription is already active.")
    from_status = sub.status
    sub.status = Subscription.Status.ACTIVE
    sub.save(update_fields=["status"])
    sub.user.activate()
    _log_history(sub, SubscriptionHistory.Action.REACTIVATED, actor=actor, note=reason)
    _log_status(sub, from_status, Subscription.Status.ACTIVE, actor=actor, reason=reason)
    return sub
