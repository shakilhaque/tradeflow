"""
Product Purchase Report — one row per PurchaseItem (received goods line).

GET /api/reports/product-purchases/?search=&supplier_id=&location_id=
                                   &date_from=&date_to=&page=&limit=

Columns
    product_name        — PurchaseItem.product.name (uses snapshot when set)
    sku                 — PurchaseItem.sku snapshot, falls back to product.sku
    supplier_name       — Purchase.supplier.name
    reference_no        — Purchase.reference_no
    purchase_date       — Purchase.purchase_date
    quantity            — PurchaseItem.quantity (ordered)
    total_unit_adjusted — PurchaseItem.quantity − received_qty
                          (the unfilled/adjusted portion of the line)
    unit_price          — PurchaseItem.unit_cost
    subtotal            — line_total (or quantity × unit_cost as fallback)
    purchase_id         — for the View deep-link

Footer totals across the full filtered set: quantity, adjustments, subtotal.

Permission: CAN_VIEW_REPORTS.
"""
from datetime import date as _date
from decimal import Decimal as _D

from django.db.models import (
    Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value,
)
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=4)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


@extend_schema(tags=["Reports"])
class ProductPurchaseReportView(APIView):
    """One row per received purchase line — product × supplier × purchase × date."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Product purchase report",
        description=(
            "Detail-level view of every purchase line item. Useful for "
            "answering 'what did we buy of this product, when, from whom "
            "and at what price?'."
        ),
        parameters=[
            OpenApiParameter("search",      OpenApiTypes.STR,  description="Product name / SKU / barcode"),
            OpenApiParameter("supplier_id", OpenApiTypes.UUID, description="Filter by supplier UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
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

        p = request.query_params
        search      = (p.get("search") or "").strip()
        supplier_id = p.get("supplier_id") or ""
        location_id = p.get("location_id") or ""
        date_from   = _parse_date(p.get("date_from"))
        date_to     = _parse_date(p.get("date_to"))

        try:
            page = max(int(p.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1
        try:
            limit = int(p.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        limit = min(max(limit, 5), 200)

        from purchases.models import PurchaseItem, Supplier  # noqa: PLC0415

        # Exclude DRAFT purchases — they haven't been finalised so the line
        # is provisional. Cancelled purchases also excluded.
        qs = (
            PurchaseItem.objects
            .select_related("purchase", "purchase__supplier", "purchase__location",
                            "product")
            .exclude(purchase__status__in=("cancelled",))
        )
        if date_from:    qs = qs.filter(purchase__purchase_date__gte=date_from)
        if date_to:      qs = qs.filter(purchase__purchase_date__lte=date_to)
        if supplier_id:  qs = qs.filter(purchase__supplier_id=supplier_id)
        if location_id:  qs = qs.filter(purchase__location_id=location_id)
        if search:
            qs = qs.filter(
                Q(product_name__icontains=search) |
                Q(product__name__icontains=search) |
                Q(sku__icontains=search) |
                Q(product__sku__icontains=search) |
                Q(product__barcode__icontains=search)
            )

        # Annotate the line-level "adjustment" — what was ordered but not
        # received. PurchaseItem already carries both columns.
        qs = qs.annotate(
            adjustment = ExpressionWrapper(
                F("quantity") - F("received_qty"),
                output_field=DEC,
            ),
        ).order_by("-purchase__purchase_date", "-purchase__created_at", "id")

        # ── Footer totals ─────────────────────────────────────────────────
        agg = qs.aggregate(
            count           = Count("id"),
            f_quantity      = Coalesce(Sum("quantity"),    ZERO),
            f_adjustment    = Coalesce(Sum("adjustment"),  ZERO),
            f_subtotal      = Coalesce(Sum("line_total"),  ZERO),
        )
        footer = {
            "row_count":           agg["count"] or 0,
            "total_quantity":      str(agg["f_quantity"]   or _D("0")),
            "total_adjustment":    str(agg["f_adjustment"] or _D("0")),
            "total_subtotal":      str(agg["f_subtotal"]   or _D("0")),
        }

        # ── Pagination ─────────────────────────────────────────────────────
        count = agg["count"] or 0
        total_pages = max((count + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = list(qs[offset: offset + limit])

        rows = []
        for it in page_rows:
            pur = it.purchase
            sup = pur.supplier if pur else None
            line_subtotal = it.line_total or (
                (it.unit_cost or _D("0")) * (it.quantity or _D("0"))
            )
            rows.append({
                "id":                  str(it.id),
                "product_name":        it.product_name or (it.product.name if it.product else "—"),
                "sku":                 it.sku or (it.product.sku if it.product else ""),
                "supplier_id":         str(sup.id) if sup else "",
                "supplier_name":       sup.name if sup else "—",
                "purchase_id":         str(pur.id) if pur else "",
                "reference_no":        pur.reference_no if pur else "—",
                "purchase_date":       pur.purchase_date.isoformat() if pur else None,
                "location_name":       pur.location.name if (pur and pur.location) else "—",
                "quantity":            str(it.quantity or _D("0")),
                "received_qty":        str(it.received_qty or _D("0")),
                "total_unit_adjusted": str((it.quantity or _D("0")) - (it.received_qty or _D("0"))),
                "unit_price":          str(it.unit_cost or _D("0")),
                "subtotal":            str(line_subtotal),
            })

        # ── Dropdown options ───────────────────────────────────────────────
        supplier_options = [
            {"id": str(s["id"]), "name": s["name"]}
            for s in Supplier.objects.filter(is_active=True)
                                     .order_by("name")
                                     .values("id", "name")[:500]
        ]

        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        return Response({
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "rows":             rows,
            "footer":           footer,
            "page":             page,
            "limit":            limit,
            "total_pages":      total_pages,
            "count":            count,
            "supplier_options": supplier_options,
            "location_options": location_options,
        })
