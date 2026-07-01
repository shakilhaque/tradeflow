"""
Revenue & Billing Analytics — Super-Admin dashboard API.

One endpoint returns every KPI, chart series and insight the executive
dashboard needs, computed from the master-DB Payment / Subscription / Plan /
Tenant rows. Reuses subscription_admin.kpis() for the point-in-time
MRR / ARR / active / expiring / suspended figures so they always agree with
the Subscriptions and Tenants modules.

    GET /api/admin/revenue-analytics/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD

Auth: platform admin (is_staff / is_superuser).
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, Sum, F, DecimalField
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework import status as http
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Payment, Plan, Subscription, Tenant, User
from . import subscription_admin as sub_svc


# ── helpers ─────────────────────────────────────────────────────────────────

def _f(d) -> float:
    return float(Decimal(str(d or 0)).quantize(Decimal("0.01")))


def _months_between(start: date, end: date) -> list[date]:
    """First-of-month dates from start..end inclusive, oldest first."""
    out, y, m = [], start.year, start.month
    while (y < end.year) or (y == end.year and m <= end.month):
        out.append(date(y, m, 1))
        m += 1
        if m == 13:
            m, y = 1, y + 1
    return out


def _zero_fill(rows, key_field, value_field, months):
    bucket = OrderedDict(
        (d.strftime("%Y-%m"), {"key": d.strftime("%Y-%m"), "label": d.strftime("%b %Y"), "value": 0})
        for d in months
    )
    for r in rows:
        d = r[key_field]
        if d is None:
            continue
        k = d.strftime("%Y-%m")
        if k in bucket:
            bucket[k]["value"] = _f(r[value_field])
    return list(bucket.values())


def _parse_date(s, fallback):
    try:
        return date.fromisoformat((s or "").strip())
    except (ValueError, TypeError):
        return fallback


class AdminRevenueAnalyticsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not (request.user.is_staff or request.user.is_superuser):
            return Response({"detail": "Forbidden."}, status=http.HTTP_403_FORBIDDEN)

        today = timezone.localdate()
        date_to   = _parse_date(request.query_params.get("date_to"), today)
        date_from = _parse_date(request.query_params.get("date_from"), date(date_to.year - 1, date_to.month, 1))
        if date_from > date_to:
            date_from, date_to = date_to, date_from
        months = _months_between(date_from.replace(day=1), date_to)

        paid = Payment.objects.filter(status="success")
        paid_in_range = paid.filter(paid_at__date__gte=date_from, paid_at__date__lte=date_to)

        # ── KPI cards ────────────────────────────────────────────────────────
        sub_kpis = sub_svc.kpis()
        total_revenue     = paid.aggregate(t=Sum("amount"))["t"] or Decimal("0")
        collected_revenue = paid_in_range.aggregate(t=Sum("amount"))["t"] or Decimal("0")
        pending_revenue   = Payment.objects.filter(status="pending").aggregate(t=Sum("amount"))["t"] or Decimal("0")

        active_subs   = int(sub_kpis["active_subscriptions"]) + int(sub_kpis["trial_accounts"])
        total_tenants = User.objects.filter(tenant__isnull=False).count()
        arpt = (Decimal(total_revenue) / Decimal(total_tenants)) if total_tenants else Decimal("0")

        # Churn proxy: cancelled / (active + suspended + cancelled).
        cancelled = Subscription.objects.filter(status="cancelled").count()
        active_cnt = Subscription.objects.filter(status="active").count()
        suspended_cnt = Subscription.objects.filter(status="suspended").count()
        denom = active_cnt + suspended_cnt + cancelled
        churn_rate = round((cancelled / denom * 100), 2) if denom else 0.0

        kpis = {
            "total_revenue":          _f(total_revenue),
            "mrr":                    _f(sub_kpis["mrr"]),
            "arr":                    _f(sub_kpis["arr"]),
            "pending_revenue":        _f(pending_revenue),
            "collected_revenue":      _f(collected_revenue),
            "active_subscriptions":   active_subs,
            "expiring_subscriptions": int(sub_kpis["expiring_30_days"]),
            "suspended_accounts":     int(sub_kpis["suspended_subscriptions"]),
            "churn_rate":             churn_rate,
            "arpt":                   _f(arpt),
        }

        # ── Revenue analytics charts ─────────────────────────────────────────
        rev_rows = (
            paid_in_range.annotate(month=TruncMonth("paid_at"))
            .values("month").annotate(total=Sum("amount")).order_by("month")
        )
        monthly_revenue = _zero_fill(rev_rows, "month", "total", months)

        # Revenue growth — month-over-month % change.
        revenue_growth = []
        for i, row in enumerate(monthly_revenue):
            prev = monthly_revenue[i - 1]["value"] if i > 0 else 0
            pct = round(((row["value"] - prev) / prev * 100), 1) if prev else 0.0
            revenue_growth.append({"key": row["key"], "label": row["label"], "value": pct})

        # Subscription growth — subs created per month (in range).
        sub_rows = (
            Subscription.objects.filter(created_at__date__gte=date_from, created_at__date__lte=date_to)
            .annotate(month=TruncMonth("created_at")).values("month")
            .annotate(c=Count("id")).order_by("month")
        )
        subscription_growth = _zero_fill(sub_rows, "month", "c", months)

        # Tenant growth — tenants created per month (cumulative line).
        ten_rows = (
            Tenant.objects.filter(created_at__date__gte=date_from, created_at__date__lte=date_to)
            .annotate(month=TruncMonth("created_at")).values("month")
            .annotate(c=Count("id")).order_by("month")
        )
        tenant_growth = _zero_fill(ten_rows, "month", "c", months)
        running = 0
        for r in tenant_growth:
            running += r["value"]
            r["cumulative"] = running

        # New vs renewed — split success payments by metadata.type.
        new_rev = renew_rev = Decimal("0")
        for p in paid_in_range.only("amount", "metadata"):
            if (p.metadata or {}).get("type") == "renewal":
                renew_rev += p.amount or 0
            else:
                new_rev += p.amount or 0
        new_vs_renewed = [
            {"label": "New", "value": _f(new_rev)},
            {"label": "Renewed", "value": _f(renew_rev)},
        ]

        # Revenue by plan (in range).
        plan_rev_rows = (
            paid_in_range.filter(subscription__isnull=False)
            .values("subscription__plan__name")
            .annotate(value=Sum("amount")).order_by("-value")
        )
        revenue_by_plan = [
            {"label": r["subscription__plan__name"] or "—", "value": _f(r["value"])}
            for r in plan_rev_rows
        ]

        # Revenue by billing cycle.
        cycle_rev_rows = (
            paid_in_range.filter(subscription__isnull=False)
            .values("subscription__plan__billing_cycle")
            .annotate(value=Sum("amount")).order_by("-value")
        )
        revenue_by_cycle = [
            {"label": (r["subscription__plan__billing_cycle"] or "—").title(), "value": _f(r["value"])}
            for r in cycle_rev_rows
        ]

        # ── Billing analytics ────────────────────────────────────────────────
        paid_invoices   = paid.count()
        unpaid_invoices = Payment.objects.filter(status="pending").count()
        failed_payments = Payment.objects.filter(status="failed").count()
        # Overdue: active/suspended subs whose billing date has already passed.
        overdue_invoices = Subscription.objects.filter(
            next_billing_date__lt=today, status__in=["active", "suspended"]
        ).count()
        upcoming_renewals = Subscription.objects.filter(
            status="active", next_billing_date__gte=today,
            next_billing_date__lte=today + timedelta(days=30),
        ).count()
        settled = paid_invoices + failed_payments
        collection_rate = round((paid_invoices / settled * 100), 1) if settled else 0.0

        billing = {
            "paid_invoices":     paid_invoices,
            "unpaid_invoices":   unpaid_invoices,
            "overdue_invoices":  overdue_invoices,
            "upcoming_renewals": upcoming_renewals,
            "failed_payments":   failed_payments,
            "collection_rate":   collection_rate,
        }

        # ── Insights ─────────────────────────────────────────────────────────
        top_plans = [
            {"label": r["subscription__plan__name"] or "—", "value": _f(r["value"])}
            for r in (
                paid.filter(subscription__isnull=False)
                .values("subscription__plan__name")
                .annotate(value=Sum("amount")).order_by("-value")[:5]
            )
        ]

        top_tenant_rows = (
            paid.filter(user__isnull=False)
            .values("user__id", "user__business_name", "user__name", "user__email")
            .annotate(value=Sum("amount"), payments=Count("id")).order_by("-value")[:5]
        )
        top_tenants = [
            {
                "id":    str(r["user__id"]),
                "label": r["user__business_name"] or r["user__name"] or r["user__email"] or "—",
                "value": _f(r["value"]),
                "payments": r["payments"],
            }
            for r in top_tenant_rows
        ]

        # Revenue forecast — 3-month simple moving average projected forward.
        recent_vals = [m["value"] for m in monthly_revenue[-3:]] or [0]
        avg = sum(recent_vals) / len(recent_vals)
        forecast = []
        y, m = date_to.year, date_to.month
        for _ in range(3):
            m += 1
            if m == 13:
                m, y = 1, y + 1
            forecast.append({"label": date(y, m, 1).strftime("%b %Y"), "value": round(avg, 2)})

        # Renewal forecast — subs due in each of the next 3 months + expected revenue.
        renewal_forecast = []
        cur = today.replace(day=1)
        for _ in range(3):
            nxt = (cur.replace(day=28) + timedelta(days=10)).replace(day=1)
            due = Subscription.objects.filter(
                status="active", next_billing_date__gte=cur, next_billing_date__lt=nxt,
            ).select_related("plan")
            cnt = due.count()
            expected = sum((Decimal(str(s.plan.price or 0)) for s in due), Decimal("0"))
            renewal_forecast.append({"label": cur.strftime("%b %Y"), "count": cnt, "value": _f(expected)})
            cur = nxt

        return Response({
            "date_from": date_from.isoformat(),
            "date_to":   date_to.isoformat(),
            "kpis":      kpis,
            "charts": {
                "monthly_revenue":     monthly_revenue,
                "revenue_growth":      revenue_growth,
                "subscription_growth": subscription_growth,
                "new_vs_renewed":      new_vs_renewed,
                "revenue_by_plan":     revenue_by_plan,
                "revenue_by_cycle":    revenue_by_cycle,
                "tenant_growth":       tenant_growth,
            },
            "billing":  billing,
            "insights": {
                "top_plans":        top_plans,
                "top_tenants":      top_tenants,
                "revenue_forecast": forecast,
                "renewal_forecast": renewal_forecast,
            },
        })
