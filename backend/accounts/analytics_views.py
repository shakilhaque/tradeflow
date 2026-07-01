"""
Platform-admin analytics — aggregated metrics across ALL tenants pulled from
the master database. Powers the admin dashboard graphs.

Endpoint: GET /api/admin/analytics/
Auth:     IsAuthenticated + is_staff or is_superuser
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, Sum
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Payment, Plan, Subscription, Tenant, User


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _last_n_months(n: int) -> list[date]:
    """Return the first day of each of the last `n` months, oldest first."""
    today = timezone.localdate()
    months = []
    y, m = today.year, today.month
    for _ in range(n):
        months.append(date(y, m, 1))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return list(reversed(months))


def _zero_fill_monthly(rows, key_field, value_field, months):
    """Pad a sparse month-bucketed queryset with zeros for missing months."""
    bucket = OrderedDict()
    for d in months:
        bucket[d.strftime("%Y-%m")] = {
            "key":   d.strftime("%Y-%m"),
            "label": d.strftime("%b %Y"),
            "value": 0,
        }
    for r in rows:
        d = r[key_field]
        if d is None:
            continue
        k = d.strftime("%Y-%m") if hasattr(d, "strftime") else str(d)
        if k in bucket:
            bucket[k]["value"] = float(r[value_field] or 0)
    return list(bucket.values())


# ──────────────────────────────────────────────────────────────────────────────
# View
# ──────────────────────────────────────────────────────────────────────────────

class AdminAnalyticsView(APIView):
    """Cross-tenant analytics for the platform admin dashboard."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not (request.user.is_staff or request.user.is_superuser):
            return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)

        months = _last_n_months(12)

        # ── Headline KPIs ────────────────────────────────────────────────────
        active_subs   = Subscription.objects.filter(status="active").select_related("plan")
        mrr = Decimal("0")
        for sub in active_subs:
            price = Decimal(str(sub.plan.price or 0))
            if sub.plan.billing_cycle == "yearly":
                # Convert yearly → monthly equivalent
                mrr += (price / Decimal("12"))
            else:
                mrr += price

        successful_total = Payment.objects.filter(status="success").aggregate(
            total=Sum("amount")
        )["total"] or Decimal("0")

        kpis = {
            "total_tenants":         User.objects.filter(tenant__isnull=False).count(),
            "active_subscriptions":  active_subs.count(),
            "suspended_users":       User.objects.filter(status="suspended").count(),
            "provisioned_tenants":   Tenant.objects.filter(is_provisioned=True).count(),
            "pending_tenants":       Tenant.objects.filter(is_provisioned=False).count(),
            "mrr":                   float(mrr.quantize(Decimal("0.01"))),
            "lifetime_revenue":      float(Decimal(successful_total).quantize(Decimal("0.01"))),
            "total_payments":        Payment.objects.count(),
            "successful_payments":   Payment.objects.filter(status="success").count(),
            "pending_payments":      Payment.objects.filter(status="pending").count(),
            "failed_payments":       Payment.objects.filter(status="failed").count(),
        }

        # ── Revenue by month (last 12 months, paid only) ─────────────────────
        cutoff = months[0]
        revenue_rows = (
            Payment.objects
            .filter(status="success", paid_at__isnull=False, paid_at__date__gte=cutoff)
            .annotate(month=TruncMonth("paid_at"))
            .values("month")
            .annotate(total=Sum("amount"))
            .order_by("month")
        )
        revenue_by_month = _zero_fill_monthly(revenue_rows, "month", "total", months)

        # ── New tenants per month (last 12) ──────────────────────────────────
        tenant_rows = (
            Tenant.objects
            .filter(created_at__date__gte=cutoff)
            .annotate(month=TruncMonth("created_at"))
            .values("month")
            .annotate(count=Count("id"))
            .order_by("month")
        )
        new_tenants_by_month = _zero_fill_monthly(tenant_rows, "month", "count", months)

        # ── Plan distribution among active subscriptions ─────────────────────
        plan_dist = (
            Subscription.objects.filter(status="active")
            .values("plan__name")
            .annotate(value=Count("id"))
            .order_by("-value")
        )
        plan_distribution = [
            {"label": r["plan__name"] or "Unnamed", "value": r["value"]}
            for r in plan_dist
        ]

        # ── Subscription status breakdown ────────────────────────────────────
        sub_status_rows = (
            Subscription.objects
            .values("status")
            .annotate(value=Count("id"))
            .order_by("-value")
        )
        STATUS_LABELS = {
            "active":    "Active",
            "suspended": "Suspended",
            "expired":   "Expired",
            "cancelled": "Cancelled",
        }
        subscription_status = [
            {"label": STATUS_LABELS.get(r["status"], r["status"].title()), "value": r["value"]}
            for r in sub_status_rows
        ]

        # ── Payment status breakdown (lifetime) ──────────────────────────────
        pay_status_rows = (
            Payment.objects
            .values("status")
            .annotate(value=Count("id"))
            .order_by("-value")
        )
        payment_status = [
            {"label": r["status"].title(), "value": r["value"]}
            for r in pay_status_rows
        ]

        # ── Top 5 plans by revenue (lifetime) ────────────────────────────────
        # Successful payments grouped by the subscription's plan.
        plan_revenue_rows = (
            Payment.objects
            .filter(status="success", subscription__isnull=False)
            .values("subscription__plan__name")
            .annotate(value=Sum("amount"))
            .order_by("-value")[:5]
        )
        top_plans_revenue = [
            {"label": r["subscription__plan__name"] or "Unnamed", "value": float(r["value"] or 0)}
            for r in plan_revenue_rows
        ]

        # ── Recent successful payments for the Recent Transactions feed ──────
        recent_paid = (
            Payment.objects.filter(status="success", paid_at__isnull=False)
            .select_related("user", "subscription__plan")
            .order_by("-paid_at")[:10]
        )
        recent_payments = [
            {
                "id":             str(p.id),
                "transaction_id": p.transaction_id,
                "user_email":     p.user.email if p.user else (p.metadata or {}).get("email"),
                "business_name":  (
                    (p.user.business_name if p.user and p.user.business_name else None)
                    or (p.metadata or {}).get("business_name")
                    or (p.user.name if p.user else None)
                    or (p.metadata or {}).get("name")
                ),
                "plan_name":      (
                    (p.subscription.plan.name if p.subscription and p.subscription.plan else None)
                    or (p.metadata or {}).get("plan_name")
                ),
                "amount":         float(p.amount or 0),
                "paid_at":        p.paid_at,
            }
            for p in recent_paid
        ]

        # ── Recently expired subscriptions (for the dashboard reminder card) ──
        today = timezone.localdate()
        recent_expired_qs = (
            Subscription.objects
            .filter(next_billing_date__lt=today)
            .exclude(status="cancelled")
            .select_related("user", "plan")
            .order_by("-next_billing_date")[:8]
        )
        recent_expired = [
            {
                "subscription_id": str(s.id),
                "user_id":         str(s.user_id) if s.user_id else None,
                "company_name":    (
                    (s.user.business_name if s.user and s.user.business_name else None)
                    or (s.user.name if s.user else None)
                    or (s.user.email if s.user else None)
                    or "—"
                ),
                "plan_name":       getattr(s.plan, "name", "—"),
                "expired_at":      s.next_billing_date,
                "status":          s.status,
            }
            for s in recent_expired_qs
        ]

        return Response({
            "kpis":                  kpis,
            "revenue_by_month":      revenue_by_month,
            "new_tenants_by_month":  new_tenants_by_month,
            "plan_distribution":     plan_distribution,
            "subscription_status":   subscription_status,
            "payment_status":        payment_status,
            "top_plans_revenue":     top_plans_revenue,
            "recent_payments":       recent_payments,
            "recent_expired":        recent_expired,
        })
