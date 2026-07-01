"""
Branch Comparison report (Phase 4 — consolidated owner analytics).

GET /api/reports/branch-comparison/?date_from=&date_to=

Owner-only. Returns one row per branch with its sales, purchases, expenses
and profit for the period, plus a consolidated TOTAL row — so the tenant
owner can compare branches side by side and see the all-branches roll-up.
Each branch is aggregated explicitly by location_id, so the result is the
same regardless of which branch the owner currently has active.
"""
import logging
from datetime import date as _date
from decimal import Decimal as _D

from django.db.models import Count, DecimalField, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger(__name__)

DEC  = DecimalField(max_digits=20, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _d(v) -> _D:
    return _D(str(v)) if v is not None else _D("0")


@extend_schema(tags=["Reports"])
class BranchComparisonReportView(APIView):
    """Per-branch sales / purchases / expenses / profit, plus a consolidated
    total. Tenant owner only (the only role that may see every branch)."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Branch comparison (consolidated)",
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE),
            OpenApiParameter("date_to",   OpenApiTypes.DATE),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from accounts.branch_context import is_tenant_owner  # noqa: PLC0415
        if not is_tenant_owner(request.user):
            return Response(
                {"detail": "Only the tenant owner can view the consolidated branch comparison."},
                status=drf_status.HTTP_403_FORBIDDEN,
            )

        date_from = _parse_date(request.query_params.get("date_from"))
        date_to   = _parse_date(request.query_params.get("date_to"))
        try:
            return Response(self._build(date_from, date_to))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Branch comparison failed")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

    def _build(self, date_from, date_to):
        from inventory.models import Location           # noqa: PLC0415
        branches = list(Location.objects.filter(is_active=True).order_by("name"))
        return compute_branch_metrics(branches, date_from, date_to)


def compute_branch_metrics(locations, date_from, date_to) -> dict:
    """Per-branch sales / paid / due / COGS / profit / purchases / expenses for
    the given Location list + date window, plus a consolidated TOTAL row.

    Shared by the Branch Comparison report and the all-branches dashboard.
    """
    from sales.models import Sale, SaleItem             # noqa: PLC0415
    from purchases.models import Purchase               # noqa: PLC0415
    from accounting.models import Expense               # noqa: PLC0415

    def _date_filter(qs, field):
        if date_from:
            qs = qs.filter(**{f"{field}__gte": date_from})
        if date_to:
            qs = qs.filter(**{f"{field}__lte": date_to})
        return qs

    rows = []
    tot = {k: _D("0") for k in
           ("sales", "paid", "due", "cogs", "gross_profit", "purchases", "expenses", "net_profit")}
    tot_orders = 0

    for loc in locations:
        sale_qs = _date_filter(
            Sale.objects.filter(status="FINAL", location_id=loc.id),
            "finalized_at__date",
        )
        s = sale_qs.aggregate(
            sales    = Coalesce(Sum("total_amount"), ZERO),
            paid     = Coalesce(Sum("amount_paid"),  ZERO),
            discount = Coalesce(Sum("discount"),     ZERO),
            orders   = Count("id"),
        )
        sales = _d(s["sales"]); paid = _d(s["paid"]); discount = _d(s["discount"])
        orders = s["orders"] or 0
        due = sales - paid
        cogs = _d(SaleItem.objects.filter(sale__in=sale_qs)
                  .aggregate(c=Coalesce(Sum("cogs"), ZERO))["c"])
        gross_profit = (sales - discount) - cogs

        purchases = _d(_date_filter(
            Purchase.objects.exclude(status="cancelled").filter(location_id=loc.id),
            "purchase_date",
        ).aggregate(p=Coalesce(Sum("grand_total"), ZERO))["p"])

        expenses = _d(_date_filter(
            Expense.objects.filter(location_id=loc.id), "expense_date",
        ).aggregate(e=Coalesce(Sum("amount"), ZERO))["e"])

        net_profit = gross_profit - expenses

        rows.append({
            "branch_id":    str(loc.id),
            "branch":       loc.name,
            "code":         loc.code,
            "orders":       orders,
            "sales":        str(sales),
            "paid":         str(paid),
            "due":          str(due),
            "cogs":         str(cogs),
            "gross_profit": str(gross_profit),
            "purchases":    str(purchases),
            "expenses":     str(expenses),
            "net_profit":   str(net_profit),
        })
        tot["sales"]        += sales
        tot["paid"]         += paid
        tot["due"]          += due
        tot["cogs"]         += cogs
        tot["gross_profit"] += gross_profit
        tot["purchases"]    += purchases
        tot["expenses"]     += expenses
        tot["net_profit"]   += net_profit
        tot_orders          += orders

    return {
        "period_from": date_from.isoformat() if date_from else None,
        "period_to":   date_to.isoformat()   if date_to   else None,
        "branches":    rows,
        "totals":      {**{k: str(v) for k, v in tot.items()}, "orders": tot_orders},
    }


@extend_schema(tags=["Reports"])
class BranchDashboardView(APIView):
    """All-branches dashboard — per-branch KPI snapshot for every branch the
    caller administers. Owner sees all branches; a branch manager (UserBranch
    with can_manage=True) sees only the branches they manage. Defaults to the
    current calendar month when no date range is supplied."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="All-branches dashboard",
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE),
            OpenApiParameter("date_to",   OpenApiTypes.DATE),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from accounts.branch_context import (            # noqa: PLC0415
            can_manage_any_branch, manageable_branches, is_tenant_owner,
        )
        if not can_manage_any_branch(request.user):
            return Response(
                {"detail": "You do not manage any branch."},
                status=drf_status.HTTP_403_FORBIDDEN,
            )

        date_from = _parse_date(request.query_params.get("date_from"))
        date_to   = _parse_date(request.query_params.get("date_to"))
        if not date_from and not date_to:
            today = _date.today()
            date_from = today.replace(day=1)
            date_to   = today

        try:
            from inventory.models import Location        # noqa: PLC0415
            allowed_ids = [b["id"] for b in manageable_branches(request.user)]
            locations = list(
                Location.objects.filter(id__in=allowed_ids, is_active=True).order_by("name")
            )
            payload = compute_branch_metrics(locations, date_from, date_to)
            payload["is_owner"] = is_tenant_owner(request.user)
            return Response(payload)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Branch dashboard failed")
            return Response(
                {"detail": f"Dashboard failed: {exc}"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
