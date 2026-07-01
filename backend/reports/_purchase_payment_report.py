"""
Purchase Payment Report — one row per PurchasePayment instalment paid to a
supplier. The inverse of the Sell Payment Report.

Endpoint: GET /api/reports/purchase-payment/
Query    supplier_id, location_id, method, date_from, date_to,
         search, page, limit

Columns surfaced to the frontend
    reference_no   — synthesised (PP-YYYY-<first 6 hex chars>) so the column
                     matches the "PP2026/0393"-style strings in the original
                     UI without needing a schema change.
    paid_on        — PurchasePayment.paid_at
    amount         — PurchasePayment.amount
    supplier_name  — Purchase.supplier.name
    method         — PurchasePayment.Method enum
    method_label   — human-readable display label
    purchase_id    — for the View deep-link
    purchase_ref   — Purchase.reference_no ("Purchase" column in the screenshot)

Permission: CAN_VIEW_REPORTS.
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
    """`PP-2026-AB12CD` — short, stable, year-prefixed."""
    when = payment.paid_at or payment.created_at
    yr = when.year if when else "????"
    return f"PP-{yr}-{str(payment.id).replace('-', '')[:6].upper()}"


@extend_schema(tags=["Reports"])
class PurchasePaymentReportView(APIView):
    """Purchase payment ledger — every PurchasePayment instalment."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Purchase payment report",
        description=(
            "One row per payment paid to a supplier against a Purchase. "
            "Filterable by supplier, location, method and date range. Returns "
            "a totals footer computed across the full filtered set."
        ),
        parameters=[
            OpenApiParameter("supplier_id", OpenApiTypes.UUID, description="Filter by supplier UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("method",      OpenApiTypes.STR,  description="cash | card | bank_transfer | mobile | other"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
            OpenApiParameter("search",      OpenApiTypes.STR,  description="Purchase ref / supplier / reference"),
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
        supplier_id = params.get("supplier_id") or ""
        location_id = params.get("location_id") or ""
        method      = (params.get("method") or "").lower() or ""
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

        from purchases.models import PurchasePayment, Supplier  # noqa: PLC0415

        from accounts.branch_context import branch_scope  # noqa: PLC0415
        qs = branch_scope(
            PurchasePayment.objects
            .select_related("purchase", "purchase__supplier", "purchase__location")
            .all(),
            field="purchase__location_id",
        )
        if date_from:    qs = qs.filter(paid_at__date__gte=date_from)
        if date_to:      qs = qs.filter(paid_at__date__lte=date_to)
        if supplier_id:  qs = qs.filter(purchase__supplier_id=supplier_id)
        if location_id:  qs = qs.filter(purchase__location_id=location_id)
        if method:       qs = qs.filter(method=method)
        if search:
            qs = qs.filter(
                Q(purchase__reference_no__icontains=search) |
                Q(purchase__supplier__name__icontains=search) |
                Q(reference__icontains=search)
            )

        qs = qs.order_by("-paid_at", "-id")

        # ── Footer totals + per-method roll-up ─────────────────────────────
        agg = qs.aggregate(
            count        = Count("id"),
            total_amount = Coalesce(Sum("amount"), ZERO),
        )
        footer = {
            "count":        agg["count"] or 0,
            "total_amount": str(agg["total_amount"] or _D("0")),
        }

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

        method_labels = dict(PurchasePayment.Method.choices)
        rows = []
        for p in page_rows:
            pur = p.purchase
            sup = pur.supplier if pur else None
            rows.append({
                "id":             str(p.id),
                "reference_no":   _synth_reference(p),
                "paid_on":        p.paid_at,
                "amount":         str(p.amount or _D("0")),
                "supplier_id":    str(sup.id) if sup else "",
                "supplier_name":  sup.name if sup else "—",
                "method":         p.method,
                "method_label":   method_labels.get(p.method, p.method),
                "reference":      p.reference or "",
                "purchase_id":    str(pur.id) if pur else "",
                "purchase_ref":   pur.reference_no if pur else "—",
                "location_name":  pur.location.name if (pur and pur.location) else "—",
            })

        # ── Dropdown options ───────────────────────────────────────────────
        supplier_options = list(
            Supplier.objects.filter(is_active=True)
            .order_by("name")
            .values("id", "name")[:500]
        )
        supplier_options = [
            {"id": str(s["id"]), "name": s["name"]} for s in supplier_options
        ]

        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        method_options = [
            {"value": code, "label": label}
            for code, label in PurchasePayment.Method.choices
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
            "supplier_options": supplier_options,
            "location_options": location_options,
            "method_options":   method_options,
        })
