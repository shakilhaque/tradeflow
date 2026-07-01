"""
Sell Payment Report — one row per SalePayment instalment.

Endpoint: GET /api/reports/sell-payment/
Query    customer_id, location_id, method, date_from, date_to,
         search, page, limit

Columns surfaced to the frontend:
    reference_no   — synthesised (SP-YYYY-<first 6 hex chars>) since SalePayment
                     has no system-issued reference number column. Stable per
                     payment row.
    paid_on        — SalePayment.created_at
    amount         — SalePayment.amount
    customer_name  — Sale.customer.name (or 'Walk-in')
    customer_group — '' (no CustomerGroup model exists yet)
    method         — SalePayment.Method enum
    method_label   — human-readable display label
    sale_id        — for the 'View' button on the action column
    invoice_number — Sale.invoice_number ('Sell' column in the screenshot)

Permission: CAN_VIEW_REPORTS. Cashiers are clamped to their own UUID.
"""
from datetime import date as _date
from decimal import Decimal as _D

from django.db.models import Count, DecimalField, Q, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _synth_reference(payment) -> str:
    """`SP-2026-ab12cd` — short, stable, year-prefixed."""
    yr = (payment.created_at.year if payment.created_at else "????")
    return f"SP-{yr}-{str(payment.id).replace('-', '')[:6].upper()}"


@extend_schema(tags=["Reports"])
class SellPaymentReportView(APIView):
    """Sell payment ledger — every SalePayment instalment, with filters."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Sell payment report",
        description=(
            "One row per customer payment received against a Sale. Filterable "
            "by customer, location, payment method and date range. Returns "
            "a totals footer computed across the full filtered set."
        ),
        parameters=[
            OpenApiParameter("customer_id", OpenApiTypes.UUID, description="Filter by customer UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("method",      OpenApiTypes.STR,  description="CASH | CARD | BANK_TRANSFER | MOBILE | OTHER"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
            OpenApiParameter("search",      OpenApiTypes.STR,  description="Invoice no / customer name / phone / reference"),
            OpenApiParameter("page",        OpenApiTypes.INT,  description="Page (default 1)"),
            OpenApiParameter("limit",       OpenApiTypes.INT,  description="Per page (default 25, max 200)"),
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

        params      = request.query_params
        customer_id = params.get("customer_id") or ""
        location_id = params.get("location_id") or ""
        method      = (params.get("method") or "").upper() or ""
        date_from   = _parse_date(params.get("date_from"))
        date_to     = _parse_date(params.get("date_to"))
        search      = (params.get("search") or "").strip()

        try:
            page = max(int(params.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1
        try:
            limit = int(params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        limit = min(max(limit, 5), 200)

        # CASHIER clamp — only show payments they received.
        cashier_clamp = (getattr(request.user, "role", "") == "cashier")

        from sales.models import SalePayment, Customer  # noqa: PLC0415

        from accounts.branch_context import branch_scope  # noqa: PLC0415
        qs = branch_scope(
            SalePayment.objects
            .select_related("sale", "sale__customer", "sale__location")
            .all(),
            field="sale__location_id",
        )
        if date_from:    qs = qs.filter(created_at__date__gte=date_from)
        if date_to:      qs = qs.filter(created_at__date__lte=date_to)
        if customer_id:  qs = qs.filter(sale__customer_id=customer_id)
        if location_id:  qs = qs.filter(sale__location_id=location_id)
        if method:       qs = qs.filter(method=method)
        if cashier_clamp:
            qs = qs.filter(received_by_id=request.user.id)
        if search:
            qs = qs.filter(
                Q(sale__invoice_number__icontains=search) |
                Q(sale__customer__name__icontains=search) |
                Q(sale__customer__phone__icontains=search) |
                Q(reference__icontains=search)
            )

        qs = qs.order_by("-created_at", "-id")

        # ── Footer totals over the FULL filtered set ───────────────────────
        agg = qs.aggregate(
            count        = Count("id"),
            total_amount = Coalesce(Sum("amount"), ZERO),
        )
        footer = {
            "count":        agg["count"] or 0,
            "total_amount": str(agg["total_amount"] or _D("0")),
        }

        # Per-method roll-up — useful for the KPI strip (and a tiny chart later).
        by_method = list(
            qs.values("method")
              .annotate(count=Count("id"), total=Coalesce(Sum("amount"), ZERO))
              .order_by("-total")
        )

        # ── Pagination ─────────────────────────────────────────────────────
        count = agg["count"] or 0
        total_pages = max((count + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = list(qs[offset: offset + limit])

        rows = []
        method_labels = dict(SalePayment.Method.choices)
        for p in page_rows:
            sale = p.sale
            customer = sale.customer if sale else None
            rows.append({
                "id":             str(p.id),
                "reference_no":   _synth_reference(p),
                "paid_on":        p.created_at,
                "amount":         str(p.amount or _D("0")),
                "customer_id":    str(customer.id) if customer else "",
                "customer_name":  customer.name if customer else "Walk-in",
                "customer_group": "",   # placeholder — no CustomerGroup model yet
                "method":         p.method,
                "method_label":   method_labels.get(p.method, p.method),
                "reference":      p.reference or "",
                "sale_id":        str(sale.id) if sale else "",
                "invoice_number": sale.invoice_number if sale else "—",
                "location_name":  sale.location.name if (sale and sale.location) else "—",
            })

        # ── Dropdown options ────────────────────────────────────────────────
        customer_options = list(
            Customer.objects.filter(is_active=True)
            .order_by("name")
            .values("id", "name")[:500]
        )
        customer_options = [
            {"id": str(c["id"]), "name": c["name"]} for c in customer_options
        ]

        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        method_options = [
            {"value": code, "label": label}
            for code, label in SalePayment.Method.choices
        ]

        return Response({
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "rows":             rows,
            "footer":           footer,
            "by_method":        [
                {"method": r["method"],
                 "label":  method_labels.get(r["method"], r["method"]),
                 "count":  r["count"],
                 "total":  str(r["total"])}
                for r in by_method
            ],
            "page":             page,
            "limit":            limit,
            "total_pages":      total_pages,
            "count":            count,
            "customer_options": customer_options,
            "location_options": location_options,
            "method_options":   method_options,
        })
