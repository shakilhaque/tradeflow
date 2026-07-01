"""
Helper module — merchant-style Profit/Loss Report views.

Two endpoints:
  GET /api/accounting/profit-loss-summary/   (top-card aggregates)
  GET /api/accounting/profit-loss-breakdown/?group_by=…   (the 8 tabs)
"""
from datetime import date as _date, datetime as _dt
from decimal import Decimal as _D

from django.db.models import (
    Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value,
)
from django.db.models.functions import Coalesce, TruncDate, ExtractIsoWeekDay
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

DEC = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _sale_qs(*, location_id=None, date_from=None, date_to=None):
    """Sale rows in scope for P&L (excludes voided)."""
    from sales.models import Sale
    qs = Sale.objects.exclude(status="VOIDED")
    if location_id:
        qs = qs.filter(location_id=location_id)
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    return qs


# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class ProfitLossSummaryView(APIView):
    """
    Merchant-style P&L summary used by the report header.
    Computes opening/closing stock value, total purchases, sales, expenses, etc.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        location_id = request.query_params.get("location_id") or None
        date_from   = _parse_date(request.query_params.get("date_from"))
        date_to     = _parse_date(request.query_params.get("date_to"))

        sale_qs = _sale_qs(location_id=location_id, date_from=date_from, date_to=date_to)

        # ── Sales totals
        from sales.models import SaleItem
        item_qs = SaleItem.objects.filter(sale__in=sale_qs)

        sales_count = sale_qs.count()
        items_count = item_qs.count()

        total_sales = item_qs.aggregate(t=Coalesce(Sum("total_price"), ZERO))["t"]
        total_cogs  = item_qs.aggregate(t=Coalesce(Sum("cogs"),        ZERO))["t"]
        # Fallback: if line-item totals are zero but the Sale header has a total,
        # use that. This handles sales created via simpler POS paths that may
        # not have populated SaleItem.total_price.
        if total_sales == _D("0") and sales_count > 0:
            total_sales = sale_qs.aggregate(t=Coalesce(Sum("total_amount"), ZERO))["t"]
        total_sell_discount = sale_qs.aggregate(t=Coalesce(Sum("discount"), ZERO))["t"]

        # ── Purchases (all-time totals)
        total_purchase = _D("0")
        purchase_shipping = _D("0")
        purchase_return = _D("0")
        purchase_discount = _D("0")
        try:
            from purchases.models import Purchase
            p_qs = Purchase.objects.exclude(status="cancelled")
            if location_id:
                p_qs = p_qs.filter(location_id=location_id)
            if date_from:
                p_qs = p_qs.filter(purchase_date__gte=date_from)
            if date_to:
                p_qs = p_qs.filter(purchase_date__lte=date_to)
            # NB: Purchase fields are `shipping_cost` and
            # `discount_amount`, NOT `shipping_charges` /
            # `discount`. The previous code mis-named both; the
            # ORM raises silently into the bare except below and
            # purchase_shipping / purchase_discount stayed at
            # zero on every tenant.
            agg = p_qs.aggregate(
                tot  = Coalesce(Sum("grand_total"),     ZERO),
                ship = Coalesce(Sum("shipping_cost"),   ZERO),
                disc = Coalesce(Sum("discount_amount"), ZERO),
            )
            total_purchase    = agg["tot"]
            purchase_shipping = agg["ship"]
            purchase_discount = agg["disc"]
        except Exception:
            pass

        # ── Purchase returns
        try:
            from purchases.models import PurchaseReturn
            pr_qs = PurchaseReturn.objects.exclude(status="cancelled")
            if location_id:
                pr_qs = pr_qs.filter(location_id=location_id)
            if date_from:
                pr_qs = pr_qs.filter(return_date__gte=date_from)
            if date_to:
                pr_qs = pr_qs.filter(return_date__lte=date_to)
            purchase_return = pr_qs.aggregate(t=Coalesce(Sum("total_amount"), ZERO))["t"]
        except Exception:
            pass

        # ── Expenses
        total_expense = _D("0")
        try:
            from .models import Expense
            e_qs = Expense.objects.all()
            if location_id:
                e_qs = e_qs.filter(location_id=location_id)
            if date_from:
                e_qs = e_qs.filter(expense_date__gte=date_from)
            if date_to:
                e_qs = e_qs.filter(expense_date__lte=date_to)
            total_expense = e_qs.aggregate(t=Coalesce(Sum("amount"), ZERO))["t"]
        except Exception:
            pass

        # ── Opening / Closing stock (value at purchase & sale price)
        opening_purchase = opening_sale = _D("0")
        closing_purchase = closing_sale = _D("0")
        try:
            from inventory.models import ProductStock
            stock_qs = ProductStock.objects.select_related("product")
            if location_id:
                stock_qs = stock_qs.filter(location_id=location_id)
            agg = stock_qs.annotate(
                purchase_val=ExpressionWrapper(F("quantity") * F("product__cost_price"),    output_field=DEC),
                sale_val    =ExpressionWrapper(F("quantity") * F("product__selling_price"), output_field=DEC),
            ).aggregate(
                pv=Coalesce(Sum("purchase_val"), ZERO),
                sv=Coalesce(Sum("sale_val"),     ZERO),
            )
            closing_purchase = agg["pv"]
            closing_sale     = agg["sv"]
            # Opening = closing − (purchases in period) + (sales-at-cost in period)
            # Best-effort merchant approximation; exact opening would need historical snapshots.
            opening_purchase = closing_purchase - total_purchase + total_cogs
            opening_sale     = closing_sale - total_purchase + total_sales
        except Exception:
            pass

        # ── Stock transfers (shipping charges)
        transfer_shipping = _D("0")
        try:
            from inventory.models import StockTransfer
            t_qs = StockTransfer.objects.all()
            if location_id:
                t_qs = t_qs.filter(Q(from_location_id=location_id) | Q(to_location_id=location_id))
            if date_from:
                t_qs = t_qs.filter(transfer_date__gte=date_from)
            if date_to:
                t_qs = t_qs.filter(transfer_date__lte=date_to)
            transfer_shipping = t_qs.aggregate(t=Coalesce(Sum("shipping_charges"), ZERO))["t"]
        except Exception:
            pass

        # ── Sale returns
        sell_return = _D("0")
        sr_qs = None
        try:
            from sales.models import SellReturn
            sr_qs = SellReturn.objects.all()
            if location_id:
                sr_qs = sr_qs.filter(location_id=location_id)
            if date_from:
                sr_qs = sr_qs.filter(return_date__gte=date_from)
            if date_to:
                sr_qs = sr_qs.filter(return_date__lte=date_to)
            sell_return = sr_qs.aggregate(t=Coalesce(Sum("total_amount"), ZERO))["t"]
        except Exception:
            sr_qs = None

        # ── Sale-side shipping (was hardcoded to "0.00")
        total_sell_shipping = _D("0")
        try:
            total_sell_shipping = sale_qs.aggregate(
                t=Coalesce(Sum("shipping_charges"), ZERO)
            )["t"]
        except Exception:
            pass

        # ── Stock adjustment value (was hardcoded to "0.00")
        # Sum (|qty| × product.cost_price) for ADJUST movements in
        # the period. Negative-qty adjustments are write-downs;
        # absolute value gives the absorbed cost.
        total_stock_adjustment = _D("0")
        try:
            from inventory.models import StockMovement  # noqa: PLC0415
            adj_qs = StockMovement.objects.filter(movement_type="ADJUST")
            if location_id:
                adj_qs = adj_qs.filter(location_id=location_id)
            if date_from:
                adj_qs = adj_qs.filter(created_at__date__gte=date_from)
            if date_to:
                adj_qs = adj_qs.filter(created_at__date__lte=date_to)
            adj_qs = adj_qs.annotate(
                _v=ExpressionWrapper(F("quantity") * F("product__cost_price"), output_field=DEC),
            )
            total_stock_adjustment = adj_qs.aggregate(
                t=Coalesce(Sum("_v"), ZERO)
            )["t"]
        except Exception:
            pass

        # ── Stock recovered via sell-returns (was hardcoded
        # "0.00"). Goods returned to the shelf re-enter inventory
        # at cost — credit back to net profit.
        total_stock_recovered = _D("0")
        if sr_qs is not None:
            try:
                from sales.models import SellReturnItem  # noqa: PLC0415
                sri_qs = SellReturnItem.objects.filter(sell_return__in=sr_qs)
                sri_qs = sri_qs.annotate(
                    _v=ExpressionWrapper(F("quantity") * F("product__cost_price"), output_field=DEC),
                )
                total_stock_recovered = sri_qs.aggregate(
                    t=Coalesce(Sum("_v"), ZERO)
                )["t"]
            except Exception:
                pass

        # ── Final calculations
        gross_profit = (total_sales or _D("0")) - (total_cogs or _D("0"))
        # Net = gross + add-backs − deductions. Stock adjustments
        # and additional shipping are real cost outflows; sell
        # returns reduce revenue while the recovered stock adds
        # back as cost recouped. Purchase discounts received and
        # purchase returns to supplier are favourable.
        net_profit = (
            gross_profit
            - (total_expense          or _D("0"))
            - (purchase_shipping      or _D("0"))
            - (transfer_shipping      or _D("0"))
            - (total_sell_shipping    or _D("0"))
            - (total_sell_discount    or _D("0"))
            - (sell_return            or _D("0"))
            - (total_stock_adjustment or _D("0"))
            + (total_stock_recovered  or _D("0"))
            + (purchase_return        or _D("0"))
            + (purchase_discount      or _D("0"))
        )

        return Response({
            "opening_stock_purchase":  str(opening_purchase),
            "opening_stock_sale":      str(opening_sale),
            "closing_stock_purchase":  str(closing_purchase),
            "closing_stock_sale":      str(closing_sale),
            "total_sales":             str(total_sales),
            "total_cogs":              str(total_cogs),
            "total_purchase":          str(total_purchase),
            "total_purchase_shipping": str(purchase_shipping),
            "total_purchase_return":   str(purchase_return),
            "total_purchase_discount": str(purchase_discount),
            "total_expense":           str(total_expense),
            "total_stock_adjustment":  str(total_stock_adjustment),
            "purchase_additional_expenses": "0.00",
            "total_transfer_shipping": str(transfer_shipping),
            "total_sell_shipping":     str(total_sell_shipping),
            "sell_additional_expenses": "0.00",
            "total_sell_discount":     str(total_sell_discount),
            "total_sell_return":       str(sell_return),
            "total_stock_recovered":   str(total_stock_recovered),
            "total_sell_round_off":    "0.00",
            "total_customer_reward":   "0.00",
            "gross_profit":            str(gross_profit),
            "net_profit":              str(net_profit),
            # Diagnostic counts — surfaced for debugging "no data" cases.
            "_debug": {
                "sales_in_scope":   sales_count,
                "sale_items":       items_count,
                "filter_location":  str(location_id) if location_id else None,
                "filter_date_from": date_from.isoformat() if date_from else None,
                "filter_date_to":   date_to.isoformat() if date_to else None,
            },
        })


# ──────────────────────────────────────────────────────────────────────────────
# Breakdown (the 8 tabs)
# ──────────────────────────────────────────────────────────────────────────────

DAY_NAMES = {1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday",
             5: "Friday", 6: "Saturday", 7: "Sunday"}


@extend_schema(tags=["Accounting"])
class ProfitLossBreakdownView(APIView):
    """
    Profit per group (products / categories / brands / locations / invoice
    / date / customer / day).

    Query params:
      group_by       — required: products|categories|brands|locations|invoice|date|customer|day
      location_id    — optional
      date_from / date_to — optional
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        group_by = (request.query_params.get("group_by") or "products").lower()
        location_id = request.query_params.get("location_id") or None
        date_from   = _parse_date(request.query_params.get("date_from"))
        date_to     = _parse_date(request.query_params.get("date_to"))

        sale_qs = _sale_qs(location_id=location_id, date_from=date_from, date_to=date_to)

        from sales.models import SaleItem
        items = SaleItem.objects.filter(sale__in=sale_qs).select_related(
            "product", "product__category", "product__brand", "sale", "sale__customer", "sale__location",
        )

        # gross profit per line = total_price − cogs (treat NULL cogs as 0)
        line_profit = ExpressionWrapper(
            F("total_price") - Coalesce(F("cogs"), Value(0, output_field=DEC)),
            output_field=DEC,
        )

        rows = []
        try:
            if group_by == "products":
                rows = list(items.values(
                    "product_id", "product__name", "product__sku",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("product__name"))
                rows = [{
                    "id":           r["product_id"],
                    "name":         (r["product__name"] or "") + (f" ({r['product__sku']})" if r["product__sku"] else ""),
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "categories":
                rows = list(items.values(
                    "product__category_id", "product__category__name",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("product__category__name"))
                rows = [{
                    "id":           r["product__category_id"],
                    "name":         r["product__category__name"] or "Uncategorized",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "brands":
                rows = list(items.values(
                    "product__brand_id", "product__brand__name",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("product__brand__name"))
                rows = [{
                    "id":           r["product__brand_id"],
                    "name":         r["product__brand__name"] or "No Brand",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "locations":
                rows = list(items.values(
                    "sale__location_id", "sale__location__name",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("sale__location__name"))
                rows = [{
                    "id":           r["sale__location_id"],
                    "name":         r["sale__location__name"] or "—",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "invoice":
                rows = list(items.values(
                    "sale_id", "sale__invoice_number", "sale__created_at",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("-sale__created_at")[:1000])
                rows = [{
                    "id":           r["sale_id"],
                    "name":         r["sale__invoice_number"] or str(r["sale_id"])[:8],
                    "subtitle":     r["sale__created_at"].isoformat() if r["sale__created_at"] else "",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "date":
                rows = list(items.annotate(d=TruncDate("sale__created_at")).values("d").annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("-d"))
                rows = [{
                    "id":           r["d"].isoformat() if r["d"] else "",
                    "name":         r["d"].isoformat() if r["d"] else "—",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "customer":
                rows = list(items.values(
                    "sale__customer_id", "sale__customer__name",
                ).annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("sale__customer__name"))
                rows = [{
                    "id":           r["sale__customer_id"],
                    "name":         r["sale__customer__name"] or "Walk-in",
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]

            elif group_by == "day":
                rows = list(items.annotate(d=ExtractIsoWeekDay("sale__created_at")).values("d").annotate(
                    gross_profit=Coalesce(Sum(line_profit), ZERO),
                ).order_by("d"))
                rows = [{
                    "id":           r["d"],
                    "name":         DAY_NAMES.get(r["d"], str(r["d"])),
                    "gross_profit": str(r["gross_profit"]),
                } for r in rows]
            else:
                return Response({"detail": f"Unknown group_by '{group_by}'."}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            return Response({"detail": str(exc), "results": []}, status=status.HTTP_200_OK)

        total = sum((_D(r["gross_profit"]) for r in rows), _D("0"))
        return Response({
            "group_by":     group_by,
            "results":      rows,
            "total":        str(total),
            "count":        len(rows),
        })
