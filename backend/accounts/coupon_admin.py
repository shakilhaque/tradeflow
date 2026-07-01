"""
Coupon & Promotion management — service layer (master DB).

Status derivation, discount computation, validation rules, serialization,
KPIs / analytics and audit logging. Shared by the admin coupon views and the
public coupon-validation endpoint.
"""
from __future__ import annotations

import logging
from decimal import Decimal

from django.db.models import Count, Sum
from django.utils import timezone

from .models import Coupon, CouponAuditLog, CouponRedemption, Payment

logger = logging.getLogger(__name__)


# ── audit ───────────────────────────────────────────────────────────────────

def audit(action, *, coupon=None, campaign=None, actor=None, note="", metadata=None):
    try:
        CouponAuditLog.objects.create(
            coupon=coupon, campaign=campaign, action=action, note=note or "",
            metadata=metadata or {},
            actor=getattr(actor, "id", None), actor_email=getattr(actor, "email", "") or "",
        )
    except Exception:
        logger.exception("Failed to write coupon audit log (%s)", action)


# ── status / usage ──────────────────────────────────────────────────────────

def usage_count(c) -> int:
    return c.redemptions.count()


def status(c, *, uses=None) -> str:
    today = timezone.localdate()
    if not c.is_active:
        return "disabled"
    if c.start_date and c.start_date > today:
        return "scheduled"
    if c.end_date and c.end_date < today:
        return "expired"
    uses = uses if uses is not None else usage_count(c)
    if c.max_usage_limit and uses >= c.max_usage_limit:
        return "expired"
    return "active"


# ── discount computation ────────────────────────────────────────────────────

def compute_discount(c, amount) -> Decimal:
    amount = Decimal(str(amount or 0))
    if amount <= 0:
        return Decimal("0")
    if c.discount_type == Coupon.Type.FREE_TRIAL:
        return Decimal("0")   # value is in free_trial_days, not money
    if c.is_percentage:
        disc = (amount * Decimal(str(c.discount_value)) / Decimal("100"))
    else:  # fixed
        disc = Decimal(str(c.discount_value))
    disc = disc.quantize(Decimal("0.01"))
    return min(disc, amount)


# ── validation ──────────────────────────────────────────────────────────────

class CouponError(Exception):
    pass


def validate(code, *, amount=Decimal("0"), plan_id=None, user=None, email="", is_renewal=False):
    """Return (coupon, discount, message) or raise CouponError."""
    amount = Decimal(str(amount or 0))
    try:
        c = Coupon.objects.get(code__iexact=(code or "").strip())
    except Coupon.DoesNotExist:
        raise CouponError("Invalid coupon code.")

    st = status(c)
    if st == "disabled":
        raise CouponError("This coupon is disabled.")
    if st == "scheduled":
        raise CouponError("This coupon is not active yet.")
    if st == "expired":
        raise CouponError("This coupon has expired or reached its usage limit.")

    if c.min_purchase_amount and amount < c.min_purchase_amount:
        raise CouponError(f"Minimum purchase of {c.min_purchase_amount} required for this coupon.")

    # Plan eligibility (empty applicable_plans = all plans).
    plan_ids = set(str(p) for p in c.applicable_plans.values_list("id", flat=True))
    if plan_ids and plan_id and str(plan_id) not in plan_ids:
        raise CouponError("This coupon does not apply to the selected plan.")

    # Type eligibility.
    resolved_user = user
    if resolved_user is None and email:
        from .models import User
        resolved_user = User.objects.filter(email__iexact=email).first()

    if c.discount_type == Coupon.Type.FIRST_TIME:
        has_paid = resolved_user and Payment.objects.filter(user=resolved_user, status="success").exists()
        if has_paid:
            raise CouponError("This coupon is for first-time customers only.")
    if c.discount_type == Coupon.Type.RENEWAL and not is_renewal:
        raise CouponError("This coupon applies to renewals only.")

    # Per-tenant usage limit.
    if c.per_tenant_limit and resolved_user:
        used = c.redemptions.filter(user=resolved_user).count()
        if used >= c.per_tenant_limit:
            raise CouponError("You have already used this coupon the maximum number of times.")

    discount = compute_discount(c, amount)
    if c.discount_type == Coupon.Type.FREE_TRIAL:
        msg = f"Adds {c.free_trial_days} free trial days."
    else:
        msg = f"Discount of {discount} applied."
    return c, discount, msg


def record_redemption(coupon, *, user=None, payment=None, subscription=None,
                      amount_discounted=Decimal("0"), gross_amount=Decimal("0"), is_new=True):
    red = CouponRedemption.objects.create(
        coupon=coupon, user=user, payment=payment, subscription=subscription,
        amount_discounted=amount_discounted, gross_amount=gross_amount, is_new_subscription=is_new,
    )
    audit("redeemed", coupon=coupon, actor=user, note=f"Redeemed; -{amount_discounted}")
    return red


# ── serialization ───────────────────────────────────────────────────────────

def serialize_row(c, *, uses=None) -> dict:
    uses = uses if uses is not None else usage_count(c)
    plan_names = list(c.applicable_plans.values_list("name", flat=True))
    return {
        "id":              str(c.id),
        "code":            c.code,
        "name":            c.name,
        "description":     c.description,
        "discount_type":   c.discount_type,
        "discount_type_label": c.get_discount_type_display(),
        "discount_value":  str(c.discount_value),
        "free_trial_days": c.free_trial_days,
        "is_percentage":   c.is_percentage,
        "applicable_plans": plan_names,
        "applicable_plan_ids": [str(p) for p in c.applicable_plans.values_list("id", flat=True)],
        "usage_count":     uses,
        "max_usage_limit": c.max_usage_limit,
        "per_tenant_limit": c.per_tenant_limit,
        "min_purchase_amount": str(c.min_purchase_amount),
        "start_date":      c.start_date.isoformat() if c.start_date else None,
        "end_date":        c.end_date.isoformat() if c.end_date else None,
        "is_active":       c.is_active,
        "status":          status(c, uses=uses),
        "created_at":      c.created_at.isoformat(),
    }


# ── KPIs / analytics ────────────────────────────────────────────────────────

def kpis() -> dict:
    coupons = list(Coupon.objects.prefetch_related("redemptions"))
    total = len(coupons)
    active = expired = scheduled = 0
    for c in coupons:
        st = status(c, uses=c.redemptions.count())
        if st == "active":
            active += 1
        elif st == "expired":
            expired += 1
        elif st == "scheduled":
            scheduled += 1
    agg = CouponRedemption.objects.aggregate(
        total=Count("id"), disc=Sum("amount_discounted"), rev=Sum("gross_amount"))
    return {
        "total_coupons":     total,
        "active_coupons":    active,
        "expired_coupons":   expired,
        "scheduled_coupons": scheduled,
        "total_redemptions": agg["total"] or 0,
        "discount_given":    float(agg["disc"] or 0),
        "revenue_generated": float(agg["rev"] or 0),
    }


def analytics() -> dict:
    from django.db.models.functions import TruncMonth
    from datetime import date
    today = timezone.localdate()
    month_start = date(today.year - 1, today.month, 1)

    trend_rows = (
        CouponRedemption.objects.filter(created_at__date__gte=month_start)
        .annotate(m=TruncMonth("created_at")).values("m")
        .annotate(c=Count("id")).order_by("m")
    )
    redemption_trend = [{"label": r["m"].strftime("%b %Y"), "value": r["c"]} for r in trend_rows if r["m"]]

    most_used = [
        {"label": r["coupon__code"], "value": r["c"]}
        for r in CouponRedemption.objects.values("coupon__code").annotate(c=Count("id")).order_by("-c")[:8]
    ]

    new_cnt = CouponRedemption.objects.filter(is_new_subscription=True).count()
    renew_cnt = CouponRedemption.objects.filter(is_new_subscription=False).count()

    total_red = new_cnt + renew_cnt
    revenue = float(CouponRedemption.objects.aggregate(s=Sum("gross_amount"))["s"] or 0)
    discount = float(CouponRedemption.objects.aggregate(s=Sum("amount_discounted"))["s"] or 0)

    return {
        "redemption_trend": redemption_trend,
        "most_used": most_used,
        "revenue_impact": {"revenue": revenue, "discount": discount},
        "conversions": [
            {"label": "New Subscriptions", "value": new_cnt},
            {"label": "Renewals", "value": renew_cnt},
        ],
        "conversion_rate": round((new_cnt / total_red * 100), 1) if total_red else 0.0,
    }
