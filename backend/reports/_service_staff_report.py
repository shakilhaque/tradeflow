"""
Service Staff Report — sales grouped by the staff member who finalised them.

GET /api/reports/service-staff/?mode=orders|lines
                                &date_from=&date_to=
                                &location_id=&staff_id=
                                &page=&limit=&search=

mode:
  orders  (default) — one row per finalised Sale (Date / Invoice No / Service
                       staff / Location / Subtotal / Discount / Tax / Total).
  lines              — one row per SaleItem (adds Product / Qty / Unit price).

Returns
───────
  {
    "mode":            "orders" | "lines",
    "period":          {"from": "...", "to": "..."},
    "summary":         {"total_orders", "total_revenue", "total_discount",
                        "total_tax", "unique_staff"},
    "rows":            [...],
    "page", "limit", "total_pages", "count",
    "staff_options":   [{"id", "name"}],   # for the filter dropdown
    "location_options":[{"id", "name"}],
  }

Permission: CAN_VIEW_REPORTS. Cashiers are clamped to their own UUID.
"""
from datetime import date as _date, datetime as _dt, time as _time
from decimal import Decimal as _D

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
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


def _resolve_user_names(user_ids):
    """Look up display names for staff UUIDs from the master DB. Returns
    {uuid_str: name} — falls back to '—' when the user is missing."""
    if not user_ids:
        return {}
    try:
        from accounts.models import User  # noqa: PLC0415
        rows = (
            User.objects.using("default")
            .filter(id__in=user_ids)
            .values("id", "name", "email")
        )
        return {str(r["id"]): (r["name"] or r["email"] or "—") for r in rows}
    except Exception:
        return {}


@extend_schema(tags=["Reports"])
class ServiceStaffReportView(APIView):
    """Service-staff sales report — Orders + Line Orders tabs."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Service-staff report",
        description=(
            "Lists sales finalized by each service-staff user. Two modes:\n"
            "  • orders — one row per Sale\n"
            "  • lines  — one row per Sale item (broken out)\n\n"
            "Cashiers can only see their own sales (staff_id is forced to "
            "their own UUID). Owners / managers see all."
        ),
        parameters=[
            OpenApiParameter("mode",        OpenApiTypes.STR,  description="orders | lines (default orders)"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("staff_id",    OpenApiTypes.UUID, description="Filter by service-staff UUID"),
            OpenApiParameter("search",      OpenApiTypes.STR,  description="Invoice number, customer, or product name"),
            OpenApiParameter("page",        OpenApiTypes.INT,  description="Page (default 1)"),
            OpenApiParameter("limit",       OpenApiTypes.INT,  description="Per page (default 25, max 200)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        # ── Permission check ────────────────────────────────────────────────
        from accounts.permissions import Perm, has_permission  # noqa: PLC0415
        if not has_permission(request.user, Perm.CAN_VIEW_REPORTS):
            return Response(
                {"detail": "You do not have permission to view reports."},
                status=status.HTTP_403_FORBIDDEN,
            )

        params = request.query_params
        mode = (params.get("mode") or "orders").lower()
        if mode not in ("orders", "lines"):
            mode = "orders"

        # ── Filters ─────────────────────────────────────────────────────────
        date_from = _parse_date(params.get("date_from"))
        date_to   = _parse_date(params.get("date_to"))
        location_id = params.get("location_id") or ""
        staff_id    = params.get("staff_id") or ""
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

        # CASHIER clamp.
        role = getattr(request.user, "role", "")
        if role == "cashier":
            staff_id = str(request.user.id)

        # ── Build base sale queryset (finalised + staff present) ────────────
        from sales.models import Sale, SaleItem  # noqa: PLC0415

        from accounts.branch_context import branch_scope  # noqa: PLC0415
        sales_qs = branch_scope(
            Sale.objects
            .filter(status="FINAL", finalized_by_id__isnull=False)
            .select_related("location", "customer")
        )

        if date_from:
            sales_qs = sales_qs.filter(finalized_at__date__gte=date_from)
        if date_to:
            sales_qs = sales_qs.filter(finalized_at__date__lte=date_to)
        if location_id:
            sales_qs = sales_qs.filter(location_id=location_id)
        if staff_id:
            sales_qs = sales_qs.filter(finalized_by_id=staff_id)
        if search:
            sales_qs = sales_qs.filter(
                Q(invoice_number__icontains=search) |
                Q(customer__name__icontains=search) |
                Q(customer__phone__icontains=search)
            )

        # ── Summary cards — computed over the FULL filtered set ─────────────
        summary_agg = sales_qs.aggregate(
            total_orders   = Count("id"),
            total_revenue  = Coalesce(Sum("total_amount"), ZERO),
            total_discount = Coalesce(Sum("discount"),     ZERO),
            total_tax      = Coalesce(Sum("tax_amount"),   ZERO),
        )
        unique_staff = sales_qs.values("finalized_by_id").distinct().count()
        summary = {
            "total_orders":   summary_agg["total_orders"] or 0,
            "total_revenue":  str(summary_agg["total_revenue"]  or _D("0")),
            "total_discount": str(summary_agg["total_discount"] or _D("0")),
            "total_tax":      str(summary_agg["total_tax"]      or _D("0")),
            "unique_staff":   unique_staff,
        }

        # ── Filter dropdowns ────────────────────────────────────────────────
        # Full tenant roster (owner + every sub-user) from the master
        # DB. The old row-derived list had the classic Django
        # .distinct()-with-default-ordering bug (ORDER BY column joins
        # the DISTINCT clause), so the same person appeared once PER
        # SALE — "Ismail Hossain" dozens of times in the dropdown —
        # and staff with no finalised sale never showed up at all.
        from ._user_options import tenant_user_options  # noqa: PLC0415
        staff_options = tenant_user_options(request.user)

        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        # ── Footer totals — computed across the FULL filtered set so the
        #    bottom row matches what the user is filtering, not just one page.
        if mode == "orders":
            # subtotal = total - tax + discount (matches the per-row formula).
            footer_agg = sales_qs.aggregate(
                f_subtotal = Coalesce(
                    Sum(ExpressionWrapper(
                        F("total_amount") - F("tax_amount") + F("discount"),
                        output_field=DEC,
                    )), ZERO,
                ),
                f_discount = Coalesce(Sum("discount"),     ZERO),
                f_tax      = Coalesce(Sum("tax_amount"),   ZERO),
                f_total    = Coalesce(Sum("total_amount"), ZERO),
            )
            footer = {
                "subtotal": str(footer_agg["f_subtotal"] or _D("0")),
                "discount": str(footer_agg["f_discount"] or _D("0")),
                "tax":      str(footer_agg["f_tax"]      or _D("0")),
                "total":    str(footer_agg["f_total"]    or _D("0")),
            }
        else:
            from sales.models import SaleItem  # noqa: PLC0415  (re-import for the closure)
            line_totals = SaleItem.objects.filter(sale__in=sales_qs).aggregate(
                f_quantity = Coalesce(Sum("quantity"),                       ZERO),
                f_discount = Coalesce(Sum("discount"),                       ZERO),
                f_subtotal = Coalesce(
                    Sum(ExpressionWrapper(
                        F("unit_price") * F("quantity"),
                        output_field=DEC,
                    )), ZERO,
                ),
                f_total    = Coalesce(Sum("total_price"),                    ZERO),
            )
            footer = {
                "quantity": str(line_totals["f_quantity"] or _D("0")),
                "discount": str(line_totals["f_discount"] or _D("0")),
                "subtotal": str(line_totals["f_subtotal"] or _D("0")),
                "total":    str(line_totals["f_total"]    or _D("0")),
            }

        # ── Build rows ──────────────────────────────────────────────────────
        if mode == "orders":
            sales_qs = sales_qs.order_by("-finalized_at", "-created_at")
            total_count = sales_qs.count()
            total_pages = max((total_count + limit - 1) // limit, 1)
            page = min(page, total_pages)
            offset = (page - 1) * limit
            page_rows = list(sales_qs[offset: offset + limit])

            # Resolve staff names for just this page's set.
            staff_lookup = _resolve_user_names(
                [str(s.finalized_by_id) for s in page_rows if s.finalized_by_id]
            )

            rows = []
            for s in page_rows:
                staff_uid = str(s.finalized_by_id) if s.finalized_by_id else ""
                subtotal = (s.total_amount or _D("0")) \
                            + (s.discount or _D("0")) \
                            - (s.tax_amount or _D("0"))
                rows.append({
                    "id":              str(s.id),
                    "finalized_at":    s.finalized_at,
                    "invoice_number":  s.invoice_number,
                    "staff_id":        staff_uid,
                    "staff_name":      staff_lookup.get(staff_uid, "—"),
                    "location_name":   s.location.name if s.location else "—",
                    "customer_name":   s.customer.name if s.customer else "Walk-in",
                    "subtotal":        str(subtotal),
                    "discount":        str(s.discount    or _D("0")),
                    "tax":             str(s.tax_amount  or _D("0")),
                    "total":           str(s.total_amount or _D("0")),
                })
        else:
            # LINE ORDERS — one row per SaleItem of the matched sales.
            items_qs = (
                SaleItem.objects
                .filter(sale__in=sales_qs)
                .select_related("sale", "sale__location", "sale__customer", "product")
                .order_by("-sale__finalized_at", "-sale__created_at", "id")
            )
            if search:
                # Allow product-name search in lines mode too.
                items_qs = items_qs.filter(
                    Q(sale__invoice_number__icontains=search) |
                    Q(sale__customer__name__icontains=search) |
                    Q(product__name__icontains=search)
                )
            total_count = items_qs.count()
            total_pages = max((total_count + limit - 1) // limit, 1)
            page = min(page, total_pages)
            offset = (page - 1) * limit
            page_items = list(items_qs[offset: offset + limit])

            staff_lookup = _resolve_user_names(
                [str(i.sale.finalized_by_id) for i in page_items if i.sale.finalized_by_id]
            )

            rows = []
            for it in page_items:
                s = it.sale
                staff_uid = str(s.finalized_by_id) if s.finalized_by_id else ""
                line_subtotal = (it.unit_price or _D("0")) * (it.quantity or _D("0"))
                rows.append({
                    "id":             str(it.id),
                    "finalized_at":   s.finalized_at,
                    "invoice_number": s.invoice_number,
                    "staff_id":       staff_uid,
                    "staff_name":     staff_lookup.get(staff_uid, "—"),
                    "location_name":  s.location.name if s.location else "—",
                    "customer_name":  s.customer.name if s.customer else "Walk-in",
                    "product_name":   it.product.name if it.product else "—",
                    "quantity":       str(it.quantity or _D("0")),
                    "unit_price":     str(it.unit_price or _D("0")),
                    "discount":       str(it.discount   or _D("0")),
                    "subtotal":       str(line_subtotal),
                    "total":          str(it.total_price or _D("0")),
                })

        return Response({
            "mode":             mode,
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "summary":          summary,
            "footer":           footer,
            "rows":             rows,
            "page":             page,
            "limit":            limit,
            "total_pages":      total_pages,
            "count":            total_count,
            "staff_options":    staff_options,
            "location_options": location_options,
        })
