"""
Product Sell Report — multiple views of SaleItem data.

GET /api/sales/product-sell-report/?mode=…&search=&customer_id=&location_id=
                                  &category_id=&brand_id=
                                  &date_from=&date_to=&time_from=&time_to=
                                  &page=&limit=

mode:
  detailed              raw per-item rows (default)
  detailed_purchase     raw + last purchase cost
  grouped               grouped by product
  by_category           grouped by category
  by_brand              grouped by brand
"""
from datetime import date as _date, datetime as _dt, time as _time
from decimal import Decimal as _D

from django.db.models import (
    DecimalField, ExpressionWrapper, F, Q, Sum, Value,
)
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s: return None
    try: return _date.fromisoformat(s)
    except (ValueError, TypeError): return None


def _parse_time(s):
    """Accepts 'HH:MM' or 'HH:MM:SS'."""
    if not s: return None
    try:
        parts = s.split(":")
        h = int(parts[0]); m = int(parts[1])
        return _time(h, m)
    except (ValueError, IndexError):
        return None


@extend_schema(tags=["Sales"])
class ProductSellReportView(APIView):
    """Product Sell Report with multiple group-by modes."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from sales.models import SaleItem

        mode         = (request.query_params.get("mode") or "detailed").lower()
        search       = (request.query_params.get("search") or "").strip()
        customer_id  = request.query_params.get("customer_id") or None
        location_id  = request.query_params.get("location_id") or None
        category_id  = request.query_params.get("category_id") or None
        brand_id     = request.query_params.get("brand_id")    or None
        date_from    = _parse_date(request.query_params.get("date_from"))
        date_to      = _parse_date(request.query_params.get("date_to"))
        time_from    = _parse_time(request.query_params.get("time_from"))
        time_to      = _parse_time(request.query_params.get("time_to"))

        try:
            page  = max(int(request.query_params.get("page",  1)), 1)
            limit = max(min(int(request.query_params.get("limit", 25)), 500), 1)
        except (TypeError, ValueError):
            page, limit = 1, 25

        # ── Base queryset
        qs = (
            SaleItem.objects
            .select_related(
                "product",
                "product__category", "product__brand",
                "sale", "sale__customer", "sale__location",
            )
            .exclude(sale__status="VOIDED")
        )

        if customer_id:  qs = qs.filter(sale__customer_id=customer_id)
        if location_id:  qs = qs.filter(sale__location_id=location_id)
        if category_id:  qs = qs.filter(product__category_id=category_id)
        if brand_id:     qs = qs.filter(product__brand_id=brand_id)
        if date_from:    qs = qs.filter(sale__created_at__date__gte=date_from)
        if date_to:      qs = qs.filter(sale__created_at__date__lte=date_to)
        if time_from:    qs = qs.filter(sale__created_at__time__gte=time_from)
        if time_to:      qs = qs.filter(sale__created_at__time__lte=time_to)

        if search:
            qs = qs.filter(
                Q(product__name__icontains=search)
                | Q(product__sku__icontains=search)
                | Q(product__barcode__icontains=search)
            )

        # ── Helper expressions
        tax_per_line = ExpressionWrapper(
            F("total_price") * Coalesce(F("sale__tax_rate"), Value(0, output_field=DEC)) / Value(100, output_field=DEC),
            output_field=DEC,
        )

        # ── DETAILED / DETAILED_PURCHASE
        if mode in ("detailed", "detailed_purchase"):
            ordered = qs.order_by("-sale__created_at")
            total_count = ordered.count()
            offset = (page - 1) * limit
            rows = list(ordered[offset:offset + limit])

            results = []
            for it in rows:
                line_disc = _D(str(it.item_discount or 0)) * _D(str(it.quantity or 0))
                tax_amt   = _D("0")
                if it.sale and (it.sale.tax_rate or 0):
                    tax_amt = (_D(str(it.total_price or 0)) * _D(str(it.sale.tax_rate)) / _D("100")).quantize(_D("0.01"))
                # Per-unit price including tax — must use the
                # post-discount unit price, not the raw
                # unit_price, otherwise the "Inc. Tax" column
                # over-reports for any discounted line.
                eff_unit  = _D(str(it.unit_price or 0)) - _D(str(it.item_discount or 0))
                tax_mult  = (_D("1") + _D(str(it.sale.tax_rate or 0)) / _D("100"))
                price_inc_tax = (eff_unit * tax_mult).quantize(_D("0.01"))

                row = {
                    "id":           str(it.id),
                    "product":      it.product.name if it.product else "—",
                    "sku":          it.product.sku  if it.product else "",
                    "customer_name": (it.sale.customer.name if (it.sale and it.sale.customer) else "Walk-In Customer"),
                    "contact_id":   (getattr(it.sale.customer, "contact_id", "") or "") if (it.sale and it.sale.customer) else "",
                    "invoice_no":   it.sale.invoice_number if it.sale else "",
                    "invoice_id":   str(it.sale_id) if it.sale_id else "",
                    "date":         it.sale.created_at.isoformat() if it.sale else "",
                    "unit_label":   getattr(it.product, "unit_label", "") or getattr(it.product, "unit_name", "") or "",
                    "quantity":     str(it.quantity or 0),
                    "unit_price":   str(it.unit_price or 0),
                    "discount":     str(line_disc),
                    "tax":          str(tax_amt),
                    "price_inc_tax": str(price_inc_tax),
                    "total":        str(it.total_price or 0),
                }
                if mode == "detailed_purchase":
                    # Best-effort last-purchase cost — falls back to product.cost_price
                    cost = _D(str(getattr(it.product, "cost_price", 0) or 0))
                    row["purchase_price"] = str(cost)
                    row["profit"]         = str((_D(str(it.total_price or 0)) - cost * _D(str(it.quantity or 0))).quantize(_D("0.01")))
                results.append(row)

            agg = qs.aggregate(
                qty   = Coalesce(Sum("quantity"),    ZERO),
                total = Coalesce(Sum("total_price"), ZERO),
            )

            return Response({
                "mode":         mode,
                "results":      results,
                "count":        total_count,
                "page":         page,
                "limit":        limit,
                "total_pages":  max((total_count + limit - 1) // limit, 1),
                "summary": {
                    "total_quantity": str(agg["qty"]),
                    "total_sale":     str(agg["total"]),
                },
            })

        # ── GROUPED / BY_CATEGORY / BY_BRAND
        if mode == "grouped":
            group_fields = ["product_id", "product__name", "product__sku"]
            order_field  = "product__name"
            map_row = lambda r: {
                "id":   r["product_id"],
                "name": r["product__name"] or "—",
                "sku":  r["product__sku"]  or "",
            }
        elif mode == "by_category":
            group_fields = ["product__category_id", "product__category__name"]
            order_field  = "product__category__name"
            map_row = lambda r: {
                "id":   r["product__category_id"],
                "name": r["product__category__name"] or "Uncategorized",
            }
        elif mode == "by_brand":
            group_fields = ["product__brand_id", "product__brand__name"]
            order_field  = "product__brand__name"
            map_row = lambda r: {
                "id":   r["product__brand_id"],
                "name": r["product__brand__name"] or "No Brand",
            }
        else:
            return Response({"detail": f"Unknown mode '{mode}'."}, status=status.HTTP_400_BAD_REQUEST)

        agg_rows = list(
            qs.values(*group_fields)
            .annotate(
                quantity = Coalesce(Sum("quantity"),    ZERO),
                total    = Coalesce(Sum("total_price"), ZERO),
            )
            .order_by(order_field)
        )
        results = []
        for r in agg_rows:
            base = map_row(r)
            base["quantity"] = str(r["quantity"])
            base["total"]    = str(r["total"])
            results.append(base)

        return Response({
            "mode":     mode,
            "results":  results,
            "count":    len(results),
        })
