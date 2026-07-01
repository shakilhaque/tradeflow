"""
Purchase & Sale Report — single-period financial summary comparing what we
bought against what we sold.

Endpoint: GET /api/reports/purchase-sale/
Query    location_id, date_from, date_to

Permission: CAN_VIEW_REPORTS.
"""
import logging
from datetime import date as _date
from decimal import Decimal as _D

from django.db.models import DecimalField, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.branch_context import branch_scope


logger = logging.getLogger(__name__)

DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _D0(v) -> _D:
    """Decimalize a possibly-None value safely."""
    if v is None:
        return _D("0")
    return _D(str(v))


@extend_schema(tags=["Reports"])
class PurchaseSaleReportView(APIView):
    """Single-screen overview of purchases vs sales for a date range."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Purchase & Sale report",
        description=(
            "Side-by-side totals for purchases and sales in a period, plus "
            "an overall net sale-minus-purchase line and a customer-due "
            "minus supplier-due line."
        ),
        parameters=[
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from accounts.permissions import Perm, has_permission  # noqa: PLC0415
        if not has_permission(request.user, Perm.CAN_VIEW_REPORTS):
            return Response(
                {"detail": "You do not have permission to view reports."},
                status=drf_status.HTTP_403_FORBIDDEN,
            )

        p = request.query_params
        location_id = p.get("location_id") or ""
        date_from   = _parse_date(p.get("date_from"))
        date_to     = _parse_date(p.get("date_to"))

        try:
            payload = self._build(location_id, date_from, date_to)
        except Exception as exc:
            logger.exception("Purchase & Sale report failed")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(payload)

    # ── Internal ────────────────────────────────────────────────────────────

    def _build(self, location_id, date_from, date_to):
        from purchases.models import Purchase, PurchaseReturn  # noqa: PLC0415
        from sales.models     import Sale, SellReturn          # noqa: PLC0415

        # ── Purchases ──────────────────────────────────────────────────────
        purchase_qs = branch_scope(Purchase.objects.exclude(status="cancelled"))
        if date_from:   purchase_qs = purchase_qs.filter(purchase_date__gte=date_from)
        if date_to:     purchase_qs = purchase_qs.filter(purchase_date__lte=date_to)
        if location_id: purchase_qs = purchase_qs.filter(location_id=location_id)

        # Use neutral aliases so they can never collide with field names.
        pur_agg = purchase_qs.aggregate(
            sum_subtotal    = Coalesce(Sum("subtotal"),    ZERO),
            sum_grand_total = Coalesce(Sum("grand_total"), ZERO),
            sum_paid        = Coalesce(Sum("paid_amount"), ZERO),
        )
        total_purchase          = _D0(pur_agg["sum_subtotal"])
        total_purchase_with_tax = _D0(pur_agg["sum_grand_total"])
        purchase_paid_total     = _D0(pur_agg["sum_paid"])
        purchase_due            = total_purchase_with_tax - purchase_paid_total

        purchase_return_qs = branch_scope(PurchaseReturn.objects.exclude(status="cancelled"))
        if date_from:   purchase_return_qs = purchase_return_qs.filter(return_date__gte=date_from)
        if date_to:     purchase_return_qs = purchase_return_qs.filter(return_date__lte=date_to)
        if location_id: purchase_return_qs = purchase_return_qs.filter(location_id=location_id)
        purchase_return_total = _D0(
            purchase_return_qs.aggregate(v=Coalesce(Sum("total_amount"), ZERO))["v"]
        )

        # ── Sales (only FINAL contribute to revenue) ───────────────────────
        sale_qs = branch_scope(Sale.objects.filter(status="FINAL"))
        if date_from:   sale_qs = sale_qs.filter(created_at__date__gte=date_from)
        if date_to:     sale_qs = sale_qs.filter(created_at__date__lte=date_to)
        if location_id: sale_qs = sale_qs.filter(location_id=location_id)

        sale_agg = sale_qs.aggregate(
            sum_total_amount = Coalesce(Sum("total_amount"), ZERO),
            sum_tax_amount   = Coalesce(Sum("tax_amount"),   ZERO),
            sum_amount_paid  = Coalesce(Sum("amount_paid"),  ZERO),
        )
        total_sale_with_tax = _D0(sale_agg["sum_total_amount"])
        sale_tax_total      = _D0(sale_agg["sum_tax_amount"])
        sale_paid_total     = _D0(sale_agg["sum_amount_paid"])
        total_sale          = total_sale_with_tax - sale_tax_total
        sale_due            = total_sale_with_tax - sale_paid_total

        sell_return_qs = branch_scope(SellReturn.objects.all())
        if date_from:   sell_return_qs = sell_return_qs.filter(return_date__gte=date_from)
        if date_to:     sell_return_qs = sell_return_qs.filter(return_date__lte=date_to)
        if location_id: sell_return_qs = sell_return_qs.filter(location_id=location_id)
        sell_return_total = _D0(
            sell_return_qs.aggregate(v=Coalesce(Sum("total_amount"), ZERO))["v"]
        )

        # ── Overall ────────────────────────────────────────────────────────
        net_sale            = total_sale_with_tax    - sell_return_total
        net_purchase        = total_purchase_with_tax - purchase_return_total
        sale_minus_purchase = net_sale - net_purchase
        due_amount          = sale_due - purchase_due

        # ── Dropdown options ───────────────────────────────────────────────
        try:
            from inventory.models import Location  # noqa: PLC0415
            location_options = [
                {"id": str(l.id), "name": l.name}
                for l in Location.objects.filter(is_active=True).order_by("name")
            ]
        except Exception:
            # Don't let a missing inventory table block the rest of the report.
            location_options = []

        return {
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "purchases": {
                "total_purchase":          str(total_purchase),
                "total_purchase_with_tax": str(total_purchase_with_tax),
                "total_return_with_tax":   str(purchase_return_total),
                "purchase_due":            str(purchase_due),
            },
            "sales": {
                "total_sale":            str(total_sale),
                "total_sale_with_tax":   str(total_sale_with_tax),
                "total_return_with_tax": str(sell_return_total),
                "sale_due":              str(sale_due),
            },
            "overall": {
                "net_sale":            str(net_sale),
                "net_purchase":        str(net_purchase),
                "sale_minus_purchase": str(sale_minus_purchase),
                "due_amount":          str(due_amount),
            },
            "location_options": location_options,
        }
