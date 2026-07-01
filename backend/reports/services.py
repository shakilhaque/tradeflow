"""
Reports service layer — all heavy SQL lives here, never in views.

Public API
──────────
  get_sales_report(...)     Revenue, count, avg order, grouped by day/product/user.
  get_stock_report(...)     Current stock levels with FIFO valuation.
  get_expense_report(...)   Expense breakdown by category.
  get_tax_report(...)       Tax collected and remitted in a period.
  get_product_report(...)   Top-selling products, turnover rate.

All functions read from the current tenant DB via the TenantDatabaseRouter.
Date params are inclusive on both ends.
"""
import logging
from datetime import date as date_type
from decimal import Decimal
from typing import Optional

from django.db.models import (
    Avg, Count, DecimalField, ExpressionWrapper, F, Max, Min,
    Q, Sum,
)
from django.utils import timezone

from accounts.branch_context import branch_scope

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# 1. Sales Report
# ──────────────────────────────────────────────────────────────────────────────

def get_sales_report(
    *,
    date_from:   date_type,
    date_to:     date_type,
    location_id  = None,
    user_id      = None,
    product_id   = None,
    group_by: str = "day",   # "day" | "week" | "month" | "product" | "user"
) -> dict:
    """
    Revenue summary for a period with optional dimension breakdown.

    Returns
    ───────
    {
        period_from, period_to,
        summary: {total_revenue, total_discount, net_revenue, total_tax,
                  order_count, avg_order_value, total_items_sold},
        breakdown: [
            {dimension_key, label, order_count, revenue, discount, net, tax},
            ...
        ]
    }
    """
    from sales.models import Sale, SaleItem  # noqa: PLC0415

    # Base QS — only FINAL sales, scoped to the active branch (multi-branch
    # isolation; no-op for the owner's consolidated view).
    sale_qs = branch_scope(Sale.objects.filter(
        status                  = Sale.Status.FINAL,
        finalized_at__date__gte = date_from,
        finalized_at__date__lte = date_to,
    ))
    if location_id:
        sale_qs = sale_qs.filter(location_id=location_id)
    # For the service_staff breakdown the user_id scoping is applied
    # per-bucket below (a sub-user should see sales where THEY were the
    # service staff, not the finaliser), so skip the finaliser filter here.
    if user_id and group_by != "service_staff":
        sale_qs = sale_qs.filter(finalized_by_id=user_id)

    # Summary aggregates
    agg = sale_qs.aggregate(
        total_revenue   = Sum("total_amount"),
        total_discount  = Sum("discount"),
        total_tax       = Sum("tax_amount"),
        order_count     = Count("id"),
        avg_order_value = Avg("total_amount"),
    )

    total_revenue  = agg["total_revenue"]  or Decimal("0")
    total_discount = agg["total_discount"] or Decimal("0")
    total_tax      = agg["total_tax"]      or Decimal("0")
    order_count    = agg["order_count"]    or 0
    avg_order      = (agg["avg_order_value"] or Decimal("0")).quantize(Decimal("0.01"))

    # Items sold count
    item_qs = SaleItem.objects.filter(sale__in=sale_qs)
    if product_id:
        item_qs = item_qs.filter(product_id=product_id)
    total_items = item_qs.aggregate(t=Sum("quantity"))["t"] or Decimal("0")

    summary = {
        "total_revenue":   total_revenue,
        "total_discount":  total_discount,
        "net_revenue":     total_revenue - total_discount,
        "total_tax":       total_tax,
        "order_count":     order_count,
        "avg_order_value": avg_order,
        "total_items_sold": total_items,
    }

    # Breakdown by dimension
    breakdown = []
    if group_by == "day":
        from django.db.models.functions import TruncDate  # noqa: PLC0415
        rows = (
            sale_qs
            .annotate(day=TruncDate("finalized_at"))
            .values("day")
            .annotate(
                order_count = Count("id"),
                revenue     = Sum("total_amount"),
                discount    = Sum("discount"),
                tax         = Sum("tax_amount"),
            )
            .order_by("day")
        )
        # Per-day cost of goods in a SEPARATE query — joining items
        # into the aggregate above would duplicate every Sale row per
        # line item and inflate revenue/discount/tax. Powers the
        # dashboard's Sales / Cost / Profit comparison chart.
        cogs_by_day = {
            r["day"]: (r["c"] or Decimal("0"))
            for r in (
                sale_qs
                .annotate(day=TruncDate("finalized_at"))
                .values("day")
                .annotate(c=Sum("items__cogs"))
            )
        }
        for r in rows:
            rev  = r["revenue"] or Decimal("0")
            cogs = cogs_by_day.get(r["day"], Decimal("0"))
            breakdown.append({
                "key":         r["day"].isoformat(),
                "label":       r["day"].strftime("%Y-%m-%d"),
                "order_count": r["order_count"],
                "revenue":     r["revenue"],
                "discount":    r["discount"],
                "net":         rev - (r["discount"] or Decimal("0")),
                "tax":         r["tax"],
                "cogs":        cogs,
                "gross_profit": rev - cogs,
            })

    elif group_by == "month":
        from django.db.models.functions import TruncMonth  # noqa: PLC0415
        rows = (
            sale_qs
            .annotate(month=TruncMonth("finalized_at"))
            .values("month")
            .annotate(
                order_count = Count("id"),
                revenue     = Sum("total_amount"),
                discount    = Sum("discount"),
                tax         = Sum("tax_amount"),
            )
            .order_by("month")
        )
        for r in rows:
            breakdown.append({
                "key":         r["month"].strftime("%Y-%m"),
                "label":       r["month"].strftime("%B %Y"),
                "order_count": r["order_count"],
                "revenue":     r["revenue"],
                "discount":    r["discount"],
                "net":         (r["revenue"] or Decimal("0")) - (r["discount"] or Decimal("0")),
                "tax":         r["tax"],
            })

    elif group_by == "product":
        rows = (
            SaleItem.objects
            .filter(sale__in=sale_qs)
            .values("product_id", "product__name")
            .annotate(
                order_count  = Count("sale_id", distinct=True),
                qty_sold     = Sum("quantity"),
                revenue      = Sum("total_price"),
                cogs         = Sum("cogs"),
            )
            .order_by("-revenue")
        )
        for r in rows:
            gross_profit = (r["revenue"] or Decimal("0")) - (r["cogs"] or Decimal("0"))
            breakdown.append({
                "key":         str(r["product_id"]),
                "label":       r["product__name"],
                "order_count": r["order_count"],
                "qty_sold":    r["qty_sold"],
                "revenue":     r["revenue"],
                "cogs":        r["cogs"],
                "gross_profit": gross_profit,
            })

    elif group_by == "user":
        rows = (
            sale_qs
            .values("finalized_by_id")
            .annotate(
                order_count = Count("id"),
                revenue     = Sum("total_amount"),
                discount    = Sum("discount"),
            )
            .order_by("-revenue")
        )
        # Resolve user names from master DB
        user_ids = [str(r["finalized_by_id"]) for r in rows if r["finalized_by_id"]]
        user_names = {}
        if user_ids:
            try:
                from accounts.models import User  # noqa: PLC0415
                for u in User.objects.using("default").filter(id__in=user_ids).values("id", "name"):
                    user_names[str(u["id"])] = u["name"]
            except Exception:
                pass

        for r in rows:
            uid = str(r["finalized_by_id"]) if r["finalized_by_id"] else "system"
            breakdown.append({
                "key":         uid,
                "label":       user_names.get(uid, uid),
                "order_count": r["order_count"],
                "revenue":     r["revenue"],
                "discount":    r["discount"],
            })

    elif group_by == "service_staff":
        # Credit each sale to the SERVICE STAFF chosen at sale time
        # (Sale.meta["service_staff"] — a User UUID), NOT the account that
        # added it. Sales with no service_staff fall back to the finaliser,
        # mirroring the list/POS "Service Staff" column. Powers the
        # dashboard "Top Sellers" card. Legacy free-text staff is echoed.
        from collections import defaultdict
        import uuid as _uuid
        buckets = defaultdict(lambda: {"order_count": 0, "revenue": Decimal("0"), "discount": Decimal("0")})
        want = str(user_id) if user_id else None
        for s in sale_qs.values("finalized_by_id", "meta", "total_amount", "discount"):
            m  = s["meta"] if isinstance(s["meta"], dict) else {}
            ss = m.get("service_staff")
            key = str(ss) if ss else (str(s["finalized_by_id"]) if s["finalized_by_id"] else "system")
            if want and key != want:
                continue
            b = buckets[key]
            b["order_count"] += 1
            b["revenue"]  += s["total_amount"] or Decimal("0")
            b["discount"] += s["discount"] or Decimal("0")

        # Resolve UUID keys to user names; non-UUID keys echo as-is.
        uuid_keys = []
        for k in buckets:
            try:
                _uuid.UUID(k); uuid_keys.append(k)
            except (ValueError, TypeError):
                pass
        staff_names = {}
        if uuid_keys:
            try:
                from accounts.models import User  # noqa: PLC0415
                for u in User.objects.using("default").filter(id__in=uuid_keys).values("id", "name"):
                    staff_names[str(u["id"])] = u["name"]
            except Exception:
                pass

        for k, v in sorted(buckets.items(), key=lambda kv: kv[1]["revenue"], reverse=True):
            breakdown.append({
                "key":         k,
                "label":       staff_names.get(k, "System" if k == "system" else k),
                "order_count": v["order_count"],
                "revenue":     v["revenue"],
                "discount":    v["discount"],
            })

    return {
        "period_from": date_from.isoformat(),
        "period_to":   date_to.isoformat(),
        "summary":     summary,
        "group_by":    group_by,
        "breakdown":   breakdown,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 2. Stock Report
# ──────────────────────────────────────────────────────────────────────────────

def get_stock_report(
    *,
    location_id      = None,
    category_id      = None,
    subcategory_id   = None,
    brand_id         = None,
    unit_id          = None,
    product_id       = None,
    low_stock_only:   bool = False,
    as_of_date:       Optional[date_type] = None,
) -> dict:
    """
    Current stock snapshot with FIFO valuation + sale-price valuation +
    potential-profit headline.

    Returns
    ───────
    {
        generated_at, as_of_date,
        summary: {
            total_products, total_qty,
            closing_stock_purchase_value,   # SUM(qty × avg_cost)
            closing_stock_sale_value,       # SUM(qty × selling_price)
            potential_profit,               # sale_value − purchase_value
            profit_margin_pct,              # potential_profit / sale_value × 100
            low_stock_count,
            total_unit_sold,                # lifetime FINAL sales of all matched products
        },
        items: [
            {product_id, sku, name, category, subcategory, brand, unit,
             location, qty, unit_price (selling_price), avg_cost,
             stock_value_purchase, stock_value_sale, potential_profit,
             total_unit_sold, total_unit_transferred, total_unit_adjusted,
             reorder_level, is_low_stock},
            ...
        ],
        category_options, subcategory_options, brand_options, unit_options,
        location_options,
    }
    """
    from inventory.models import (  # noqa: PLC0415
        Brand, Category, FIFOLayer, Location, Product, ProductStock, Unit,
    )

    stock_qs = branch_scope(
        ProductStock.objects
        .select_related(
            "product", "product__category", "product__category__parent",
            "product__brand", "product__unit", "location",
        )
    )
    if location_id:
        stock_qs = stock_qs.filter(location_id=location_id)
    if category_id:
        # Match products in this category OR any sub-category that descends from it.
        stock_qs = stock_qs.filter(
            Q(product__category_id=category_id) |
            Q(product__category__parent_id=category_id)
        )
    if subcategory_id:
        stock_qs = stock_qs.filter(product__category_id=subcategory_id)
    if brand_id:
        stock_qs = stock_qs.filter(product__brand_id=brand_id)
    if unit_id:
        stock_qs = stock_qs.filter(product__unit_id=unit_id)
    if product_id:
        # Single-product scope — used by the View-product modal and
        # the Edit Product page's Stock tab (which always passed this
        # param; it was silently ignored until now).
        stock_qs = stock_qs.filter(product_id=product_id)
    if low_stock_only:
        stock_qs = stock_qs.filter(quantity__lte=F("product__reorder_level"))

    # FIFO layer valuation: weighted-avg cost per product (branch-scoped).
    fifo_qs = (
        branch_scope(FIFOLayer.objects.filter(remaining_qty__gt=0))
        .values("product_id")
        .annotate(
            total_remaining = Sum("remaining_qty"),
            total_cost      = Sum(
                ExpressionWrapper(
                    F("remaining_qty") * F("unit_cost"),
                    output_field=DecimalField(max_digits=14, decimal_places=6),
                )
            ),
        )
    )
    fifo_map = {
        str(r["product_id"]): {
            "remaining":  r["total_remaining"],
            "total_cost": r["total_cost"] or Decimal("0"),
        }
        for r in fifo_qs
    }

    # Lifetime FINAL sales per (product, location) — scoped to whatever the
    # matched stock rows reference. One bulk query, then dict lookup.
    try:
        from sales.models import SaleItem  # noqa: PLC0415
        product_ids  = {s.product_id for s in stock_qs}
        location_ids = {s.location_id for s in stock_qs}
        sold_rows = (
            SaleItem.objects
            .filter(
                product_id__in=product_ids,
                sale__status="FINAL",
                sale__location_id__in=location_ids,
            )
            .values("product_id", "sale__location_id")
            .annotate(sold=Sum("quantity"))
        )
        sold_map = {
            (str(r["product_id"]), str(r["sale__location_id"])): r["sold"] or Decimal("0")
            for r in sold_rows
        }
    except Exception:
        sold_map = {}

    items                        = []
    total_qty                    = Decimal("0")
    total_purchase_value         = Decimal("0")
    total_sale_value             = Decimal("0")
    low_count                    = 0
    total_sold_all               = Decimal("0")

    for stock in stock_qs:
        prod        = stock.product
        pid         = str(prod.id)
        qty         = stock.quantity or Decimal("0")
        # Stock can never be reported negative. Historical rows can
        # sit below zero (sales recorded before purchases posted
        # stock — pre-98a7d2d6 data); the sale-side guard now blocks
        # NEW oversells, and this clamp keeps the report (and every
        # valuation derived from qty) at a floor of zero instead of
        # showing nonsense negative stock values.
        if qty < 0:
            qty = Decimal("0")
        fifo_data   = fifo_map.get(pid, {})
        fifo_qty    = fifo_data.get("remaining", Decimal("0"))
        fifo_cost   = fifo_data.get("total_cost", Decimal("0"))
        avg_cost    = (
            (fifo_cost / fifo_qty).quantize(Decimal("0.0001"))
            if fifo_qty and fifo_qty > 0 else Decimal("0")
        )
        sale_price  = prod.selling_price or Decimal("0")
        purchase_v  = (qty * avg_cost).quantize(Decimal("0.01"))
        sale_v      = (qty * sale_price).quantize(Decimal("0.01"))
        row_profit  = sale_v - purchase_v
        reorder     = getattr(prod, "reorder_level", Decimal("0")) or Decimal("0")
        is_low      = qty <= reorder
        if is_low:
            low_count += 1

        sold_qty = sold_map.get((pid, str(stock.location_id)), Decimal("0"))

        cat        = prod.category
        sub_name   = cat.name if cat and cat.parent_id else None
        parent_cat = cat.parent.name if cat and cat.parent else (cat.name if cat else None)

        # Stock-management flag — false = service / non-stocked item.
        # The dashboard's Product Stock Alert shows N/A (not 0) for
        # services since they have no inventory.
        manage_stock = (prod.meta or {}).get("manage_stock", True) is not False

        items.append({
            "product_id":            pid,
            "sku":                   prod.sku,
            "name":                  prod.name,
            "category":              parent_cat,
            "subcategory":           sub_name,
            "brand":                 prod.brand.name if prod.brand else None,
            "unit":                  prod.unit.abbreviation if prod.unit else None,
            "manage_stock":          manage_stock,
            "location_id":           str(stock.location_id),
            "location":              stock.location.name,
            "qty":                   str(qty),
            "unit_price":            str(sale_price),
            "avg_cost":              str(avg_cost),
            "stock_value_purchase":  str(purchase_v),
            "stock_value_sale":      str(sale_v),
            "potential_profit":      str(row_profit),
            "total_unit_sold":       str(sold_qty),
            # Stock-Transfer + Stock-Adjustment models aren't wired into this
            # report yet — reserved placeholders so the UI can mirror the
            # source screenshot without breaking when no data is present.
            "total_unit_transferred": "0",
            "total_unit_adjusted":    "0",
            "reorder_level":          str(reorder),
            "is_low_stock":           is_low,
        })
        total_qty            += qty
        total_purchase_value += purchase_v
        total_sale_value     += sale_v
        total_sold_all       += sold_qty

    # ── Combo products — append rows with "available as bundle" qty ──────────
    # Combos don't have their own ProductStock rows; availability is derived
    # from min(component_stock_at_location / qty_in_combo). Components are
    # what get decremented at sale time (see sales.services._expand_combo_items).
    try:
        from inventory.models import ComboItem  # noqa: PLC0415
        combo_qs = (
            Product.objects.filter(product_type="combo", is_active=True)
            .select_related("category", "category__parent", "brand", "unit")
        )
        if category_id:
            combo_qs = combo_qs.filter(
                Q(category_id=category_id) | Q(category__parent_id=category_id)
            )
        if subcategory_id:
            combo_qs = combo_qs.filter(category_id=subcategory_id)
        if brand_id:
            combo_qs = combo_qs.filter(brand_id=brand_id)
        if unit_id:
            combo_qs = combo_qs.filter(unit_id=unit_id)

        # Stock map: per (component_id, location_id) → quantity. One bulk
        # query rather than N+1.
        stock_lookup = {}
        if combo_qs.exists():
            component_ids = set(
                ComboItem.objects.filter(combo__in=combo_qs)
                .values_list("component_id", flat=True)
            )
            ps_qs = branch_scope(ProductStock.objects.filter(product_id__in=component_ids))
            if location_id:
                ps_qs = ps_qs.filter(location_id=location_id)
            for ps in ps_qs:
                key = (str(ps.product_id), str(ps.location_id))
                stock_lookup[key] = stock_lookup.get(key, Decimal("0")) + (ps.quantity or Decimal("0"))

        # Determine which locations to materialise combo rows for. If a
        # specific location is filtered, only emit one row per combo at that
        # location. Otherwise, one row per (combo × active location).
        loc_targets = (
            [(str(l.id), l.name) for l in
             Location.objects.filter(is_active=True).order_by("name")]
            if not location_id
            else [(location_id,
                   next((l.name for l in
                         Location.objects.filter(id=location_id)),
                        "—"))]
        )

        for combo_p in combo_qs:
            cis = list(
                ComboItem.objects.filter(combo=combo_p)
                .select_related("component")
            )
            if not cis:
                continue

            # Component cost snapshot (combo's cost_price column may be stale).
            unit_cost_total = sum(
                ((ci.component.cost_price or Decimal("0")) * (ci.quantity or Decimal("0")))
                for ci in cis
            )
            sale_price = combo_p.selling_price or Decimal("0")

            for loc_id, loc_name in loc_targets:
                # min(component_stock / qty) across all components.
                bundles = None
                for ci in cis:
                    avail = stock_lookup.get((str(ci.component_id), str(loc_id)), Decimal("0"))
                    qty_per_bundle = ci.quantity or Decimal("1")
                    capacity = (avail // qty_per_bundle) if qty_per_bundle > 0 else Decimal("0")
                    bundles = capacity if bundles is None else min(bundles, capacity)
                bundles = bundles or Decimal("0")
                if bundles < 0:
                    # Negative component stock (legacy oversell rows)
                    # must not surface as negative combo capacity.
                    bundles = Decimal("0")
                if low_stock_only and bundles > (combo_p.reorder_level or Decimal("0")):
                    continue

                purchase_v = (bundles * unit_cost_total).quantize(Decimal("0.01"))
                sale_v     = (bundles * sale_price).quantize(Decimal("0.01"))

                cat = combo_p.category
                items.append({
                    "product_id":             str(combo_p.id),
                    "sku":                    combo_p.sku,
                    "name":                   combo_p.name + "  · combo",
                    "category":               (cat.parent.name if cat and cat.parent else (cat.name if cat else None)),
                    "subcategory":            (cat.name if cat and cat.parent_id else None),
                    "brand":                  combo_p.brand.name if combo_p.brand else None,
                    "unit":                   combo_p.unit.abbreviation if combo_p.unit else None,
                    # Combos derive their on-hand from component stock,
                    # so they're stock-tracked (never N/A).
                    "manage_stock":           True,
                    "location_id":            str(loc_id),
                    "location":               loc_name,
                    "qty":                    str(bundles),
                    "unit_price":             str(sale_price),
                    "avg_cost":               str(unit_cost_total),
                    "stock_value_purchase":   str(purchase_v),
                    "stock_value_sale":       str(sale_v),
                    "potential_profit":       str(sale_v - purchase_v),
                    "total_unit_sold":        "0",
                    "total_unit_transferred": "0",
                    "total_unit_adjusted":    "0",
                    "reorder_level":          str(combo_p.reorder_level or Decimal("0")),
                    "is_low_stock":           bundles <= (combo_p.reorder_level or Decimal("0")),
                    "is_combo":               True,
                })
                total_qty            += bundles
                total_purchase_value += purchase_v
                total_sale_value     += sale_v
    except Exception:
        # Combos are an enrichment — don't let an issue here break the core
        # stock report. Errors are logged via the surrounding view.
        logger.exception("Combo enrichment failed in stock report")

    potential_profit = total_sale_value - total_purchase_value
    profit_margin = (
        (potential_profit / total_sale_value * Decimal("100")).quantize(Decimal("0.01"))
        if total_sale_value > 0 else Decimal("0")
    )

    # ── Dropdown option lists ──────────────────────────────────────────────
    category_options = [
        {"id": str(c.id), "name": c.name}
        for c in Category.objects.filter(parent__isnull=True).order_by("name")
    ]
    subcategory_options = [
        {"id": str(c.id), "name": c.name, "parent_id": str(c.parent_id)}
        for c in Category.objects.filter(parent__isnull=False).order_by("name")
    ]
    brand_options = [
        {"id": str(b.id), "name": b.name}
        for b in Brand.objects.all().order_by("name")
    ]
    unit_options = [
        {"id": str(u.id), "name": u.name, "abbr": u.abbreviation}
        for u in Unit.objects.all().order_by("name")
    ]
    location_options = [
        {"id": str(l.id), "name": l.name}
        for l in Location.objects.filter(is_active=True).order_by("name")
    ]

    return {
        "generated_at": timezone.now().isoformat(),
        "as_of_date":   (as_of_date or timezone.localdate()).isoformat(),
        "summary": {
            "total_products":                len(items),
            "total_qty":                     str(total_qty),
            "closing_stock_purchase_value":  str(total_purchase_value.quantize(Decimal("0.01"))),
            "closing_stock_sale_value":      str(total_sale_value.quantize(Decimal("0.01"))),
            "potential_profit":              str(potential_profit.quantize(Decimal("0.01"))),
            "profit_margin_pct":             str(profit_margin),
            "low_stock_count":               low_count,
            "total_unit_sold":               str(total_sold_all),
        },
        "items":               items,
        "category_options":    category_options,
        "subcategory_options": subcategory_options,
        "brand_options":       brand_options,
        "unit_options":        unit_options,
        "location_options":    location_options,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 3. Expense Report
# ──────────────────────────────────────────────────────────────────────────────

def get_expense_report(
    *,
    date_from: date_type,
    date_to:   date_type,
    category:    Optional[str] = None,
    user_id                    = None,
    location_id: Optional[str] = None,
) -> dict:
    """
    Expense breakdown by category for a period.

    Returns
    ───────
    {
        period_from, period_to, total_expenses,
        by_category:        [{category, label, count, total}],   # Expense.Category enum
        by_expense_account: [{name, count, total}],              # for the bar chart
        items: [{id, date, category, amount, description, accounts…}],
        category_options:   [{value, label}],
        location_options:   [{id, name}],
    }
    """
    from accounting.models import Expense, PaymentAccount  # noqa: PLC0415

    qs = branch_scope(Expense.objects.select_related(
        "expense_account", "payment_account",
        "expense_category", "expense_sub_category",
    ).filter(
        expense_date__gte = date_from,
        expense_date__lte = date_to,
    ))
    if category:
        qs = qs.filter(category=category.upper())
    if user_id:
        qs = qs.filter(created_by_id=user_id)
    if location_id:
        qs = qs.filter(location_id=location_id)

    total = qs.aggregate(t=Sum("amount"))["t"] or Decimal("0")

    def _real_category(e):
        """The category the user actually picked (ExpenseCategory FK,
        with sub-category when set). The legacy `category` enum defaults
        to OTHER → 'Other', so prefer the FK and only fall back to the
        enum label for old rows that never set it."""
        if e.expense_category_id and e.expense_category:
            name = e.expense_category.name
            if e.expense_sub_category_id and e.expense_sub_category:
                return f"{name} › {e.expense_sub_category.name}"
            return name
        return e.get_category_display()

    # Resolve every picked PaymentAccount name in one query (the cashier's
    # real "paid from" — Cash on hand / Bank — lives in
    # payment_account_picked_id, not the chart-of-accounts credit account).
    rows = list(qs.order_by("-expense_date")[:500])
    picked_ids = {e.payment_account_picked_id for e in rows if e.payment_account_picked_id}
    picked_names = {
        str(pa.id): pa.name
        for pa in PaymentAccount.objects.filter(id__in=picked_ids).only("id", "name")
    } if picked_ids else {}

    def _paid_from(e):
        if e.payment_account_picked_id:
            nm = picked_names.get(str(e.payment_account_picked_id))
            if nm:
                return nm
        return e.payment_account.name if e.payment_account_id else "—"

    # Summary grouped by the REAL category (Python-side, since the label
    # comes from the FK with an enum fallback). Keyed by label so two old
    # "Other" rows still merge.
    cat_totals: dict = {}
    for e in qs:  # qs already select_relateds expense_category / sub
        label = _real_category(e)
        bucket = cat_totals.setdefault(label, {"count": 0, "total": Decimal("0")})
        bucket["count"] += 1
        bucket["total"] += (e.amount or Decimal("0"))
    by_category = sorted(
        ({"category": label, "label": label, "count": v["count"], "total": v["total"]}
         for label, v in cat_totals.items()),
        key=lambda r: r["total"], reverse=True,
    )

    # Group by expense-account name as well — the original screenshot shows
    # a bar chart of "expense names" (e.g. 'Paper Purchases', 'Rikshaw Rent')
    # which match the Account row, not the high-level Category enum.
    by_acc = (
        qs.values("expense_account__name")
        .annotate(count=Count("id"), total=Sum("amount"))
        .order_by("-total")
    )

    items = [
        {
            "id":              str(e.id),
            "date":            e.expense_date.isoformat(),
            "reference_no":    e.reference_no or "",
            "category":        e.category,
            "category_label":  _real_category(e),
            "amount":          e.amount,
            "description":     e.description,
            "expense_account": e.expense_account.name if e.expense_account_id else "—",
            "payment_account": _paid_from(e),
        }
        for e in rows
    ]

    # Dropdown options so the frontend doesn't need a second round-trip.
    category_options = [
        {"value": code, "label": label}
        for code, label in Expense.Category.choices
    ]
    try:
        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]
    except Exception:
        location_options = []

    return {
        "period_from":    date_from.isoformat(),
        "period_to":      date_to.isoformat(),
        "total_expenses": total,
        "by_category": by_category,
        "by_expense_account": [
            {
                "name":  r["expense_account__name"] or "—",
                "count": r["count"],
                "total": r["total"],
            }
            for r in by_acc
        ],
        "items":            items,
        "category_options": category_options,
        "location_options": location_options,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 4. Tax Report
# ──────────────────────────────────────────────────────────────────────────────

def get_tax_report(
    *,
    date_from:    date_type,
    date_to:      date_type,
    location_id   = None,
) -> dict:
    """
    Combined tax ledger for the period.

    Returns three tabs of data in one round-trip:
        rows.input    — per Purchase line  (tax paid to suppliers)
        rows.output   — per Sale line       (tax collected from customers)
        rows.expense  — per Expense line    (tax paid on operating expenses)
    Plus a summary block with output_tax, input_tax, expense_tax and the net.
    """
    from sales.models      import Sale, SalePayment  # noqa: PLC0415
    from purchases.models  import Purchase, PurchasePayment, Supplier  # noqa: PLC0415
    from accounting.models import Expense  # noqa: PLC0415

    # ── OUTPUT TAX (sales) ───────────────────────────────────────────────────
    sale_qs = branch_scope(Sale.objects.filter(
        status="FINAL",
        finalized_at__date__gte=date_from,
        finalized_at__date__lte=date_to,
    ).select_related("customer", "location"))
    if location_id:
        sale_qs = sale_qs.filter(location_id=location_id)

    output_total = sale_qs.aggregate(t=Sum("tax_amount"))["t"] or Decimal("0")

    # First-payment method per sale, in one bulk query.
    sale_pay_method = {}
    if sale_qs.exists():
        pay_rows = (
            SalePayment.objects
            .filter(sale__in=sale_qs)
            .order_by("sale_id", "created_at")
            .values_list("sale_id", "method")
        )
        for sid, method in pay_rows:
            sale_pay_method.setdefault(str(sid), method)

    output_rows = []
    for s in sale_qs.order_by("-finalized_at", "-id")[:500]:
        if (s.tax_amount or Decimal("0")) <= 0:
            continue
        output_rows.append({
            "id":             str(s.id),
            "date":           s.finalized_at,
            "reference_no":   s.invoice_number,
            "party_name":     s.customer.name if s.customer else "Walk-in",
            "tax_number":     getattr(s.customer, "tax_number", "") if s.customer else "",
            "tax_amount":     str(s.tax_amount or Decimal("0")),
            "total_amount":   str(s.total_amount or Decimal("0")),
            "payment_method": sale_pay_method.get(str(s.id), ""),
            "discount":       str(s.discount or Decimal("0")),
            "location":       s.location.name if s.location else "—",
            "sale_id":        str(s.id),
        })

    # ── INPUT TAX (purchases) ───────────────────────────────────────────────
    purchase_qs = branch_scope(
        Purchase.objects.exclude(status="cancelled")
        .filter(purchase_date__gte=date_from, purchase_date__lte=date_to)
        .select_related("supplier", "location")
    )
    if location_id:
        purchase_qs = purchase_qs.filter(location_id=location_id)

    input_total = purchase_qs.aggregate(t=Sum("tax_amount"))["t"] or Decimal("0")

    purchase_pay_method = {}
    if purchase_qs.exists():
        pp_rows = (
            PurchasePayment.objects
            .filter(purchase__in=purchase_qs)
            .order_by("purchase_id", "paid_at")
            .values_list("purchase_id", "method")
        )
        for pid, method in pp_rows:
            purchase_pay_method.setdefault(str(pid), method)

    input_rows = []
    for p in purchase_qs.order_by("-purchase_date", "-created_at")[:500]:
        if (p.tax_amount or Decimal("0")) <= 0:
            continue
        input_rows.append({
            "id":             str(p.id),
            "date":           p.purchase_date.isoformat() if p.purchase_date else None,
            "reference_no":   p.reference_no,
            "party_name":     p.supplier.name if p.supplier else "—",
            "tax_number":     getattr(p.supplier, "tax_number", "") if p.supplier else "",
            "tax_amount":     str(p.tax_amount or Decimal("0")),
            "total_amount":   str(p.grand_total or Decimal("0")),
            "payment_method": purchase_pay_method.get(str(p.id), ""),
            "discount":       str(p.discount_amount or Decimal("0")),
            "location":       p.location.name if p.location else "—",
            "purchase_id":    str(p.id),
        })

    # ── EXPENSE TAX ──────────────────────────────────────────────────────────
    expense_qs = branch_scope(Expense.objects.filter(
        expense_date__gte=date_from,
        expense_date__lte=date_to,
    ).select_related("payment_account"))
    if location_id:
        expense_qs = expense_qs.filter(location_id=location_id)

    expense_total = expense_qs.aggregate(t=Sum("tax_amount"))["t"] or Decimal("0")

    expense_rows = []
    for e in expense_qs.order_by("-expense_date", "-created_at")[:500]:
        if (e.tax_amount or Decimal("0")) <= 0:
            continue
        expense_rows.append({
            "id":             str(e.id),
            "date":           e.expense_date.isoformat() if e.expense_date else None,
            "reference_no":   e.reference_no or "",
            "party_name":     e.contact_name or e.expense_for or e.get_category_display(),
            "tax_number":     "",
            "tax_amount":     str(e.tax_amount or Decimal("0")),
            "total_amount":   str(e.amount or Decimal("0")),
            "payment_method": e.payment_account.name if e.payment_account else "",
            "discount":       "0",
            "category":       e.get_category_display(),
        })

    net_tax = output_total - input_total - expense_total

    # Tax number resolution — supplier model also has tax_number?
    # Probe defensively below at import time.

    # Location options for filter dropdown.
    try:
        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]
    except Exception:
        location_options = []

    return {
        "period": {
            "from": date_from.isoformat(),
            "to":   date_to.isoformat(),
        },
        "summary": {
            "output_tax":  str(output_total),
            "input_tax":   str(input_total),
            "expense_tax": str(expense_total),
            "net_tax":     str(net_tax),
        },
        "rows": {
            "input":   input_rows,
            "output":  output_rows,
            "expense": expense_rows,
        },
        "totals": {
            "input":   {"count": len(input_rows),   "tax": str(input_total)},
            "output":  {"count": len(output_rows),  "tax": str(output_total)},
            "expense": {"count": len(expense_rows), "tax": str(expense_total)},
        },
        "location_options": location_options,
        # Back-compat keys for any existing caller.
        "period_from":     date_from.isoformat(),
        "period_to":       date_to.isoformat(),
        "tax_collected":   output_total,
        "tax_on_expenses": expense_total,
        "net_tax_payable": net_tax,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 5. Product Performance Report
# ──────────────────────────────────────────────────────────────────────────────

def get_product_report(
    *,
    date_from:   date_type,
    date_to:     date_type,
    location_id  = None,
    category_id  = None,
    limit: int   = 20,
) -> dict:
    """
    Top-selling products ranked by revenue + gross-profit analysis.

    Returns
    ───────
    {
        period_from, period_to,
        products: [{rank, product_id, sku, name, qty_sold, revenue, cogs,
                    gross_profit, margin_pct}]
    }
    """
    from sales.models import Sale, SaleItem  # noqa: PLC0415

    sale_filter = Q(
        sale__status=Sale.Status.FINAL,
        sale__finalized_at__date__gte=date_from,
        sale__finalized_at__date__lte=date_to,
    )
    # Multi-branch: scope to the active branch (via the related sale).
    from accounts.branch_context import active_branch_id as _abid  # noqa: PLC0415
    if _bid := _abid():
        sale_filter &= Q(sale__location_id=_bid)
    if location_id:
        sale_filter &= Q(sale__location_id=location_id)

    item_qs = (
        SaleItem.objects
        .filter(sale_filter)
        .values("product_id", "product__sku", "product__name", "product__category__name")
        .annotate(
            qty_sold = Sum("quantity"),
            revenue  = Sum("total_price"),
            cogs     = Sum("cogs"),
        )
        .order_by("-revenue")[:limit]
    )

    products = []
    for rank, r in enumerate(item_qs, 1):
        rev    = r["revenue"]  or Decimal("0")
        cost   = r["cogs"]     or Decimal("0")
        gp     = rev - cost
        margin = (gp / rev * 100).quantize(Decimal("0.01")) if rev else Decimal("0")
        products.append({
            "rank":         rank,
            "product_id":   str(r["product_id"]),
            "sku":          r["product__sku"],
            "name":         r["product__name"],
            "category":     r["product__category__name"],
            "qty_sold":     r["qty_sold"],
            "revenue":      rev,
            "cogs":         cost,
            "gross_profit": gp,
            "margin_pct":   margin,
        })

    return {
        "period_from": date_from.isoformat(),
        "period_to":   date_to.isoformat(),
        "products":    products,
    }
