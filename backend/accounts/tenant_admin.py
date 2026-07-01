"""
Tenant Management — Super-Admin service layer.

Tenant-centric view of the platform: one row per tenant (the owner User +
their Tenant record + latest Subscription). Reuses the subscription-admin
service (subscription_admin.py) for plan/extend/suspend/reactivate actions and
for derived status / pricing helpers, and adds the tenant-only pieces:

    • mobile number, branch count, registration date, account status columns
    • reset-password and impersonate ("login as tenant") admin actions
    • a per-tenant detail bundle: company / owner / subscription / billing /
      branch / recent-activity / login-history / account-status sections

Branch count is read best-effort from each tenant's own database (only for the
current page of rows, so we never fan out to every tenant DB at once).
Everything is platform-admin only and routed under /api/accounts/admin/tenants/.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from .models import Plan, Subscription, User
from . import subscription_admin as sub_svc

logger = logging.getLogger(__name__)

NEW_REGISTRATION_DAYS = 30


# ──────────────────────────────────────────────────────────────────────────────
# Tenant queryset + helpers
# ──────────────────────────────────────────────────────────────────────────────

def tenant_owners_qs():
    """Owner users that represent a tenant (exclude sub-users + platform staff)."""
    return (
        User.objects
        .filter(parent_owner__isnull=True)
        .exclude(is_superuser=True)
        .exclude(is_staff=True)
        .select_related("tenant")
        .prefetch_related("subscriptions__plan")
        .order_by("-created_at")
    )


def latest_subscription(user):
    subs = list(user.subscriptions.all())
    if not subs:
        return None
    # prefetched — sort in Python by created_at desc.
    subs.sort(key=lambda s: (s.created_at or timezone.now()), reverse=True)
    return subs[0]


def _branch_count(user) -> int | None:
    """Best-effort branch count from the tenant's own DB. None if unavailable."""
    tenant = getattr(user, "tenant", None)
    if not tenant or not getattr(tenant, "is_provisioned", False):
        return None
    try:
        from .tenant_db import register_tenant_db  # noqa: PLC0415
        from inventory.models import Location  # noqa: PLC0415
        register_tenant_db(tenant.db_alias, tenant.db_name)
        return Location.objects.using(tenant.db_alias).filter(is_active=True).count()
    except Exception:
        logger.debug("branch_count unavailable for tenant=%s", getattr(tenant, "db_name", "?"))
        return None


def tenant_status(user, sub) -> str:
    """active | trial | suspended | expired | cancelled — combines account + sub."""
    if getattr(user, "status", "") == User.Status.SUSPENDED:
        return "suspended"
    if sub is None:
        return "expired"
    return sub_svc.derived_status(sub)


# ──────────────────────────────────────────────────────────────────────────────
# Serialization
# ──────────────────────────────────────────────────────────────────────────────

def serialize_row(user, *, with_branches=False) -> dict:
    sub = latest_subscription(user)
    plan = sub.plan if sub else None
    return {
        "id":                  str(user.id),       # tenant id == owner user id
        "company_name":        sub_svc._tenant_company(user) or (user.business_name or "—"),
        "owner_name":          user.name or "—",
        "email":               user.email,
        "mobile":              user.phone or "",
        "plan_id":             str(plan.id) if plan else None,
        "plan_name":           getattr(plan, "name", "—"),
        "billing_cycle":       getattr(plan, "billing_cycle", ""),
        "subscription_status": tenant_status(user, sub),
        "account_status":      user.status,
        "is_trial":            bool(getattr(plan, "is_trial", False)),
        "branch_count":        _branch_count(user) if with_branches else None,
        "registration_date":   user.created_at.isoformat() if user.created_at else None,
        "expiry_date":         sub.next_billing_date.isoformat() if sub and sub.next_billing_date else None,
        "days_remaining":      sub_svc.days_remaining(sub) if sub else None,
        "subscription_id":     str(sub.id) if sub else None,
        "tenant_provisioned":  bool(getattr(getattr(user, "tenant", None), "is_provisioned", False)),
    }


def serialize_detail(user) -> dict:
    sub = latest_subscription(user)
    row = serialize_row(user, with_branches=True)
    tenant = getattr(user, "tenant", None)

    # Billing — master-DB Payment rows for this tenant.
    payments = []
    try:
        from .models import Payment  # noqa: PLC0415
        for p in Payment.objects.filter(user=user).select_related("subscription__plan").order_by("-created_at")[:100]:
            payments.append({
                "id":             str(p.id),
                "amount":         str(p.amount),
                "status":         p.status,
                "transaction_id": p.transaction_id,
                "plan_name":      getattr(getattr(p.subscription, "plan", None), "name", None),
                "paid_at":        p.paid_at.isoformat() if getattr(p, "paid_at", None) else None,
                "created_at":     p.created_at.isoformat() if getattr(p, "created_at", None) else None,
            })
    except Exception:
        payments = []

    # Recent activities + login history come from the subscription audit logs.
    activities, login_history = [], []
    if sub is not None:
        detail = sub_svc.serialize_detail(sub)
        # Merge history + status logs into one reverse-chronological timeline.
        for h in detail.get("history", []):
            activities.append({
                "kind": "history", "action": h["action"], "note": h.get("note") or "",
                "by": h.get("performed_by_email") or "system", "at": h["created_at"],
                "from_plan": h.get("from_plan"), "to_plan": h.get("to_plan"),
                "days_delta": h.get("days_delta"),
            })
        for s in detail.get("status_logs", []):
            activities.append({
                "kind": "status", "action": f"{s['from_status'] or '—'} → {s['to_status']}",
                "note": s.get("reason") or "", "by": s.get("performed_by_email") or "system",
                "at": s["created_at"],
            })
        activities.sort(key=lambda a: a["at"], reverse=True)

    # Login history — best-effort from the account's last_login + join date.
    last_login = getattr(user, "last_login", None)
    if last_login:
        login_history.append({"event": "Last login", "at": last_login.isoformat()})
    if user.created_at:
        login_history.append({"event": "Account created", "at": user.created_at.isoformat()})

    row.update({
        "company": {
            "company_name":   sub_svc._tenant_company(user) or (user.business_name or ""),
            "business_name":  user.business_name or "",
            "address":        getattr(user, "address", "") or "",
            "thana":          getattr(user, "thana", "") or "",
            "district":       getattr(user, "district", "") or "",
            "postal_code":    getattr(user, "postal_code", "") or "",
            "db_name":        getattr(tenant, "db_name", "") if tenant else "",
            "is_provisioned": bool(getattr(tenant, "is_provisioned", False)) if tenant else False,
        },
        "owner": {
            "name":     user.name or "",
            "email":    user.email,
            "phone":    user.phone or "",
            "username": getattr(user, "username", "") or "",
            "role":     getattr(user, "role", ""),
            "joined_at": user.created_at.isoformat() if user.created_at else None,
        },
        "subscription": {
            "id":            str(sub.id) if sub else None,
            "plan_name":     getattr(getattr(sub, "plan", None), "name", "—"),
            "plan_id":       str(sub.plan.id) if sub and sub.plan else None,
            "billing_cycle": getattr(getattr(sub, "plan", None), "billing_cycle", ""),
            "price":         str(sub_svc._plan_price(sub.plan)) if sub else "0",
            "status":        tenant_status(user, sub),
            "raw_status":    sub.status if sub else None,
            "start_date":    sub.start_date.isoformat() if sub and sub.start_date else None,
            "expiry_date":   sub.next_billing_date.isoformat() if sub and sub.next_billing_date else None,
            "days_remaining": sub_svc.days_remaining(sub) if sub else None,
        },
        "billing":        payments,
        "branches":       {"count": row.get("branch_count")},
        "activities":     activities[:100],
        "login_history":  login_history,
        "account_status": user.status,
    })
    return row


# ──────────────────────────────────────────────────────────────────────────────
# KPIs / analytics
# ──────────────────────────────────────────────────────────────────────────────

def kpis() -> dict:
    today = timezone.localdate()
    cutoff = timezone.now() - timedelta(days=NEW_REGISTRATION_DAYS)
    total = active = suspended = trial = expired = cancelled = new_regs = 0

    for user in tenant_owners_qs():
        total += 1
        if user.created_at and user.created_at >= cutoff:
            new_regs += 1
        st = tenant_status(user, latest_subscription(user))
        if st == "suspended":
            suspended += 1
        elif st == "trial":
            trial += 1
        elif st == "expired":
            expired += 1
        elif st == "cancelled":
            cancelled += 1
        else:  # active | expiring_soon
            active += 1

    return {
        "total_tenants":     total,
        "active_tenants":    active,
        "suspended_tenants": suspended,
        "trial_tenants":     trial,
        "expired_tenants":   expired,
        "cancelled_tenants": cancelled,
        "new_registrations": new_regs,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Admin actions
# ──────────────────────────────────────────────────────────────────────────────

class TenantAdminError(Exception):
    """Friendly error surfaced to the admin UI."""


def _require_subscription(user):
    sub = latest_subscription(user)
    if sub is None:
        raise TenantAdminError("This tenant has no subscription to act on.")
    return sub


def change_plan(user, *, plan_id, actor=None, reason=""):
    return sub_svc.change_plan(_require_subscription(user), new_plan_id=plan_id, actor=actor, reason=reason)


def extend_subscription(user, *, days, actor=None, reason="", bonus=False):
    return sub_svc.extend_subscription(_require_subscription(user), days=days, actor=actor, reason=reason, bonus=bonus)


def suspend_tenant(user, *, actor=None, reason=""):
    return sub_svc.suspend_subscription(_require_subscription(user), actor=actor, reason=reason)


def reactivate_tenant(user, *, actor=None, reason=""):
    return sub_svc.reactivate_subscription(_require_subscription(user), actor=actor, reason=reason)


@transaction.atomic
def update_tenant(user, *, data, actor=None):
    """Edit basic tenant/owner info. Only a safe allow-list is writable."""
    allowed = {"name", "phone", "business_name", "address", "thana", "district", "postal_code"}
    changed = []
    for field in allowed:
        if field in data:
            val = (data.get(field) or "").strip()
            if getattr(user, field, None) != val:
                setattr(user, field, val)
                changed.append(field)
    if changed:
        user.save(update_fields=changed)
    return user


def reset_password(user, *, actor=None):
    """Send a password-reset link to the tenant's registered MOBILE by SMS.

    (Previously this emailed the link.) A fresh single-use PasswordSetupToken
    is issued and the /set-password link is texted to the tenant's phone; their
    current password keeps working until they set a new one.
    """
    from .models import PasswordSetupToken  # noqa: PLC0415
    from . import emails, sms as sms_service  # noqa: PLC0415

    phone = (getattr(user, "phone", "") or "").strip()
    if not phone:
        raise TenantAdminError("This tenant has no registered mobile number on file.")

    token = PasswordSetupToken.issue(user)
    link = emails._set_password_url(token.token)
    msg = (
        "IFFAA: A password reset was requested for your account. Set a new "
        f"password here (valid 15 min): {link}"
    )
    if not sms_service.send_sms(phone, msg):
        raise TenantAdminError(
            "Could not send the reset SMS. Check the SMS gateway settings and the tenant's number."
        )
    return True


def impersonate(user):
    """Mint tenant JWTs so the admin can open the tenant portal as this owner.

    Uses the same token factory as the real login so the access token carries
    role / permission claims and the tenant DB resolves correctly.
    """
    if getattr(user, "status", "") == User.Status.SUSPENDED:
        # Allowed, but the tenant app will gate them to Pay Bill — surface a hint.
        logger.info("Impersonating a SUSPENDED tenant: %s", user.email)
    from .serializers import CustomTokenObtainPairSerializer, _build_billing_summary  # noqa: PLC0415
    from .permissions import get_user_permissions  # noqa: PLC0415

    refresh = CustomTokenObtainPairSerializer.get_token(user)
    try:
        permissions = sorted(get_user_permissions(user))
    except Exception:
        permissions = []
    try:
        billing = _build_billing_summary(user)
    except Exception:
        billing = None
    has_tenant = hasattr(user, "tenant") and getattr(user, "tenant", None) is not None

    # Mirrors the real login payload so the tenant portal hydrates fully.
    return {
        "access":        str(refresh.access_token),
        "refresh":       str(refresh),
        "user_id":       str(user.id),
        "email":         user.email,
        "name":          user.name,
        "role":          getattr(user, "role", ""),
        "status":        user.status,
        "is_staff":      bool(user.is_staff),
        "is_superuser":  bool(user.is_superuser),
        "has_tenant":    has_tenant,
        "permissions":   permissions,
        "billing":       billing,
        "user": {
            "id":       str(user.id),
            "email":    user.email,
            "name":     user.name,
            "username": getattr(user, "username", ""),
            "role":     getattr(user, "role", ""),
            "status":   user.status,
        },
    }
