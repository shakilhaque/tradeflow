"""
Inventory service layer — all FIFO and stock operations.

Public API
──────────
  create_product(...)         Create a new product master record.
  add_stock_fifo(...)         Receive stock; create a new FIFO cost layer.
  consume_stock_fifo(...)     Sell / dispatch stock using global FIFO.
  transfer_stock(...)         Move stock between locations (paired IN/OUT).
  import_stock_rows(...)      Bulk import: each row → separate FIFO layer.
  get_stock_report(...)       Per-location quantity + FIFO valuation snapshot.
  get_fifo_layers(...)        Inspect raw FIFO layers for a product.

FIFO CONTRACT
─────────────
  1. FIFOLayer rows are GLOBAL per product — the FIFO queue is company-wide,
     NOT split by location.
  2. consume_stock_fifo() always deducts from the OLDEST layer first
     (smallest created_at), regardless of which location the sale is at.
  3. All deductions run inside SELECT FOR UPDATE to prevent concurrent
     overselling — two concurrent sales for the same product will serialize.
  4. COGS = Σ (qty_taken_from_layer × layer.unit_cost) across touched layers.
  5. ProductStock (per-location snapshot) is kept in sync via atomic
     F() expressions — never set directly.
  6. NEVER subtract from ProductStock without going through consume_stock_fifo().
"""

import datetime
import logging
from decimal import Decimal, InvalidOperation
from typing import Optional

from django.db import transaction
from django.db.models import F, Sum

from .models import (
    Brand,
    Category,
    FIFOLayer,
    Location,
    Product,
    ProductStock,
    StockMovement,
    Unit,
    generate_ean13,
)

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Default master-data bootstrap
# ──────────────────────────────────────────────────────────────────────────────

# Canonical starter unit list every tenant gets out of the box. After
# this list lands, tenants can add their own from Settings → Units →
# + Add. The bootstrap below also prunes any leftover non-canonical
# units that are NOT referenced by products, so existing tenants
# converge to exactly these 5 on the next master-data load.
DEFAULT_UNITS = [
    ("Box", "box"),
    ("Kilogram", "kg"),
    ("Litre", "ltr"),
    ("Piece", "pc"),
    ("Nos", "nos"),
]
DEFAULT_BRANDS = ["Generic"]
DEFAULT_CATEGORIES = ["General"]
DEFAULT_LOCATIONS = [
    # Code must be unique (see Location.code unique=True)
    ("Main Location", "MAIN"),
]


def ensure_default_master_data(*, db_alias: Optional[str] = None) -> None:
    """
    Ensure every tenant has baseline inventory master data.

    This is idempotent and safe to run repeatedly. It supports explicit DB alias
    usage for provisioning flows and falls back to routed managers for request
    flows where TenantMiddleware already set the active alias.
    """
    unit_qs = Unit.objects.using(db_alias) if db_alias else Unit.objects
    brand_qs = Brand.objects.using(db_alias) if db_alias else Brand.objects
    category_qs = Category.objects.using(db_alias) if db_alias else Category.objects
    location_qs = Location.objects.using(db_alias) if db_alias else Location.objects

    # 1. Make sure the canonical baseline units EXIST. We only ADD what's
    #    missing — we must NOT delete anything else. An earlier version
    #    "forcefully converged" every tenant to exactly these 5 units,
    #    deleting any custom unit on every list load — which silently wiped
    #    a unit (e.g. "sft") the moment the tenant added it. Custom units
    #    are first-class; only seed defaults, never prune.
    for name, abbr in DEFAULT_UNITS:
        unit_qs.get_or_create(name=name, defaults={"abbreviation": abbr})

    for name in DEFAULT_BRANDS:
        brand_qs.get_or_create(name=name)

    for name in DEFAULT_CATEGORIES:
        category_qs.get_or_create(name=name, parent=None)

    for name, code in DEFAULT_LOCATIONS:
        location_qs.get_or_create(
            code=code,
            defaults={"name": name, "address": "", "is_active": True},
        )


# ──────────────────────────────────────────────────────────────────────────────
# DB alias helper — multi-tenant aware
# ──────────────────────────────────────────────────────────────────────────────

def _current_db() -> str:
    """
    Return the active tenant DB alias set by TenantMiddleware.
    Falls back to 'default' for management commands / tests that haven't
    set a tenant context.

    Used to open transactions on the CORRECT database.  Django's
    @transaction.atomic defaults to 'default', which would make
    select_for_update() fail on tenant-DB queries.
    """
    try:
        from accounts.tenant_db import get_current_db_alias  # noqa: PLC0415
        return get_current_db_alias() or "default"
    except ImportError:
        return "default"


# ──────────────────────────────────────────────────────────────────────────────
# Custom exceptions
# ──────────────────────────────────────────────────────────────────────────────

class InsufficientStockError(Exception):
    """Raised when the FIFO queue cannot satisfy the requested quantity."""


class StockServiceError(Exception):
    """General inventory service validation error."""


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _ensure_stock_row(product_id, location_id) -> ProductStock:
    """
    Get-or-create the ProductStock row for (product, location).
    Uses get_or_create so concurrent requests don't race to insert.
    """
    stock, _ = ProductStock.objects.get_or_create(
        product_id=product_id,
        location_id=location_id,
        defaults={"quantity": Decimal("0")},
    )
    return stock


def _parse_layer_date(raw) -> Optional[datetime.datetime]:
    """
    Parse a layer date from various input types.
    Returns an aware datetime or None.
    """
    if raw is None:
        return None
    if isinstance(raw, datetime.datetime):
        from django.utils.timezone import is_aware, make_aware
        return raw if is_aware(raw) else make_aware(raw)
    if isinstance(raw, datetime.date):
        from django.utils.timezone import make_aware
        return make_aware(datetime.datetime.combine(raw, datetime.time.min))
    # String — try datetime then date
    from django.utils.dateparse import parse_datetime, parse_date
    from django.utils.timezone import make_aware
    parsed = parse_datetime(str(raw))
    if parsed:
        return parsed
    parsed = parse_date(str(raw))
    if parsed:
        return make_aware(datetime.datetime.combine(parsed, datetime.time.min))
    return None


# ──────────────────────────────────────────────────────────────────────────────
# 1. create_product
# ──────────────────────────────────────────────────────────────────────────────

def create_product(
    *,
    name: str,
    unit_id,
    selling_price: Decimal = Decimal("0"),
    category_id=None,
    brand_id=None,
    sku: Optional[str] = None,
    barcode: Optional[str] = None,
    generate_barcode: bool = False,
    warranty_days: int = 0,
    warranty_id=None,
    notes: str = "",
    cost_price: Decimal = Decimal("0"),
    tax_rate: Decimal = Decimal("0"),
    tax_type: str = "exclusive",
    product_type: str = "single",
    barcode_type: str = "C128",
    not_for_selling: bool = False,
    weight=None,
    image_url: str = "",
    meta=None,
    reorder_level: Decimal = Decimal("0"),
    # Optional opening-stock rows: list of dicts
    # [{"location_id": uuid, "quantity": Decimal, "unit_cost": Decimal}]
    # Each row is converted to a FIFO layer + ProductStock increment
    # after the Product itself is saved.
    opening_stock=None,
    variation_type: str = "",
    variations=None,
    combo_items=None,
) -> Product:
    """
    Create and return a new Product.

    Parameters
    ──────────
    name             Product display name.
    unit_id          FK to Unit (required).
    selling_price    Default retail price (informational).
    category_id      FK to Category (optional).
    brand_id         FK to Brand (optional).
    sku              Custom SKU; auto-generated if omitted.
    barcode          EAN-13 or custom barcode; auto-generated if
                     generate_barcode=True and barcode is not provided.
    generate_barcode If True and barcode is None, generate a unique EAN-13.
    warranty_days    0 = no warranty.
    notes            Free-text notes.
    """
    with transaction.atomic(using=_current_db()):
        # Validate FK existence
        if not Unit.objects.filter(id=unit_id).exists():
            raise StockServiceError(f"Unit {unit_id} does not exist.")
        if category_id and not Category.objects.filter(id=category_id).exists():
            raise StockServiceError(f"Category {category_id} does not exist.")
        if brand_id and not Brand.objects.filter(id=brand_id).exists():
            raise StockServiceError(f"Brand {brand_id} does not exist.")

        # Auto-generate EAN-13 barcode if requested
        if barcode is None and generate_barcode:
            for _ in range(10):
                candidate = generate_ean13()
                if not Product.objects.filter(barcode=candidate).exists():
                    barcode = candidate
                    break
            else:
                raise StockServiceError(
                    "Could not generate a unique EAN-13 barcode after 10 attempts."
                )

        product = Product(
            name            = name,
            unit_id         = unit_id,
            selling_price   = selling_price,
            cost_price      = cost_price or Decimal("0"),
            tax_rate        = tax_rate or Decimal("0"),
            tax_type        = tax_type or "exclusive",
            product_type    = product_type or "single",
            barcode_type    = barcode_type or "C128",
            not_for_selling = bool(not_for_selling),
            weight          = weight,
            image_url       = image_url or "",
            meta            = meta or {},
            category_id     = category_id,
            brand_id        = brand_id,
            barcode         = barcode or None,
            warranty_days   = warranty_days,
            warranty_id     = warranty_id or None,
            notes           = notes,
            reorder_level   = Decimal(str(reorder_level or 0)),
        )
        if sku:
            product.sku = sku   # override auto-generated value

        product.full_clean()    # run model-level validation
        product.save()

        # ── Variations (variable products only) ────────────────────────────
        # Each row becomes a real Variation DB row. Skipped silently when
        # product_type isn't 'variable' or the array is empty.
        if (product_type or "") == "variable" and variations:
            from .models import Variation  # noqa: PLC0415
            for idx, row in enumerate(variations):
                if not isinstance(row, dict):
                    continue
                value = (row.get("value") or "").strip()
                # Skip totally-empty rows so the user can leave blank
                # trailing rows in the UI without polluting the DB.
                if not value and not row.get("sku") and not row.get("selling_price"):
                    continue
                Variation.objects.create(
                    product       = product,
                    type          = (variation_type or "")[:50],
                    value         = value[:100],
                    sku           = (row.get("sku") or "")[:50],
                    cost_price    = Decimal(str(row.get("cost_price")    or "0")),
                    selling_price = Decimal(str(row.get("selling_price") or "0")),
                    image_url     = (row.get("image_url") or "")[:500],
                    sort_order    = idx,
                    is_active     = True,
                )

        # ── Combo items (combo products only) ──────────────────────────────
        if (product_type or "") == "combo" and combo_items:
            from .models import ComboItem  # noqa: PLC0415
            seen = set()
            for idx, row in enumerate(combo_items):
                if not isinstance(row, dict):
                    continue
                comp_id = row.get("component_id")
                qty     = row.get("quantity")
                if not comp_id:
                    continue
                # Skip duplicates within the same payload (unique constraint
                # would error otherwise).
                if comp_id in seen:
                    continue
                seen.add(comp_id)
                if not Product.objects.filter(id=comp_id).exists():
                    raise StockServiceError(f"Combo component {comp_id} does not exist.")
                ComboItem.objects.create(
                    combo       = product,
                    component_id = comp_id,
                    quantity    = Decimal(str(qty if qty not in (None, "") else "1")),
                    sort_order  = idx,
                )

        # ── Opening stock ─────────────────────────────────────────────────
        # Each row creates a FIFO layer + ProductStock increment via
        # add_stock_fifo. Skipped silently for rows with zero quantity
        # so the cashier can leave blank trailing rows in the UI
        # without polluting the DB.
        if opening_stock:
            for row in opening_stock:
                if not isinstance(row, dict):
                    continue
                qty = row.get("quantity")
                loc = row.get("location_id")
                if not loc:
                    continue
                try:
                    qty_d = Decimal(str(qty)) if qty not in (None, "") else Decimal("0")
                except (InvalidOperation, ValueError, TypeError):
                    qty_d = Decimal("0")
                if qty_d <= 0:
                    continue
                try:
                    unit_cost = Decimal(str(row.get("unit_cost") or row.get("cost") or 0))
                except (InvalidOperation, ValueError, TypeError):
                    unit_cost = Decimal("0")
                try:
                    add_stock_fifo(
                        product_id     = product.id,
                        location_id    = loc,
                        quantity       = qty_d,
                        unit_cost      = unit_cost,
                        reference_type = "opening_stock",
                        reference_id   = product.id,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "Opening stock row failed for new product %s (loc=%s, qty=%s): %s",
                        product.id, loc, qty_d, exc,
                    )
                    raise StockServiceError(
                        f"Couldn't record opening stock for location {loc}: {exc}"
                    )

        logger.info(
            "Product created: id=%s  name=%s  sku=%s  product_type=%s  variations=%d  combo_items=%d  opening_stock_rows=%d",
            product.id, product.name, product.sku,
            product_type or "single",
            len(variations) if variations else 0,
            len(combo_items) if combo_items else 0,
            len(opening_stock) if opening_stock else 0,
        )
        return product


def replace_combo_items(*, product, items) -> None:
    """Atomically replace a combo's component list (delete-then-recreate)."""
    from .models import ComboItem  # noqa: PLC0415
    with transaction.atomic(using=_current_db()):
        ComboItem.objects.filter(combo=product).delete()
        if not items:
            return
        seen = set()
        for idx, row in enumerate(items):
            if not isinstance(row, dict):
                continue
            comp_id = row.get("component_id")
            if not comp_id or comp_id in seen:
                continue
            seen.add(comp_id)
            if not Product.objects.filter(id=comp_id).exists():
                raise StockServiceError(f"Combo component {comp_id} does not exist.")
            qty = row.get("quantity")
            ComboItem.objects.create(
                combo        = product,
                component_id = comp_id,
                quantity     = Decimal(str(qty if qty not in (None, "") else "1")),
                sort_order   = idx,
            )


def replace_variations(*, product, variation_type: str, variations) -> None:
    """
    Replace a product's full variation set in one shot. The Add/Edit Product
    page sends the complete list each save, so the simplest correct strategy
    is: delete-then-recreate. Stock-level references to Variation don't exist
    yet, so this is safe.
    """
    from .models import Variation  # noqa: PLC0415
    with transaction.atomic(using=_current_db()):
        Variation.objects.filter(product=product).delete()
        if not variations:
            return
        for idx, row in enumerate(variations):
            if not isinstance(row, dict):
                continue
            value = (row.get("value") or "").strip()
            if not value and not row.get("sku") and not row.get("selling_price"):
                continue
            Variation.objects.create(
                product       = product,
                type          = (variation_type or "")[:50],
                value         = value[:100],
                sku           = (row.get("sku") or "")[:50],
                cost_price    = Decimal(str(row.get("cost_price")    or "0")),
                selling_price = Decimal(str(row.get("selling_price") or "0")),
                image_url     = (row.get("image_url") or "")[:500],
                sort_order    = idx,
                is_active     = True,
            )


# ──────────────────────────────────────────────────────────────────────────────
# 2. add_stock_fifo  (STOCK IN)
# ──────────────────────────────────────────────────────────────────────────────

def add_stock_fifo(
    *,
    product_id,
    location_id,
    quantity: Decimal,
    unit_cost: Decimal,
    reference_type: str = "purchase",
    reference_id=None,
    layer_date=None,
) -> FIFOLayer:
    """
    Receive stock into inventory (STOCK IN).

    Steps (all-or-nothing inside one DB transaction):
      1. Validate inputs.
      2. Create a new FIFOLayer (created_at = layer_date or now).
      3. Upsert ProductStock for the receiving location (atomic F() increment).
      4. Record an immutable StockMovement (type=IN).

    layer_date
        Override the layer's created_at.  Used for backdated imports so that
        old purchase layers sit correctly in the FIFO queue.

    Returns the newly created FIFOLayer.
    """
    quantity  = Decimal(str(quantity))
    unit_cost = Decimal(str(unit_cost))

    if quantity <= 0:
        raise StockServiceError("Quantity must be greater than zero.")
    if unit_cost < 0:
        raise StockServiceError("Unit cost cannot be negative.")

    with transaction.atomic(using=_current_db()):
        # Validate FK existence
        if not Product.objects.filter(id=product_id).exists():
            raise StockServiceError(f"Product {product_id} does not exist.")
        if not Location.objects.filter(id=location_id, is_active=True).exists():
            raise StockServiceError(
                f"Location {location_id} does not exist or is inactive."
            )

        # ── 1. Create FIFO layer ──────────────────────────────────────────────
        layer_kwargs = dict(
            product_id     = product_id,
            location_id    = location_id,
            initial_qty    = quantity,
            remaining_qty  = quantity,
            unit_cost      = unit_cost,
            reference_type = reference_type,
            reference_id   = reference_id,
        )
        parsed_date = _parse_layer_date(layer_date)
        if parsed_date:
            layer_kwargs["created_at"] = parsed_date

        layer = FIFOLayer.objects.create(**layer_kwargs)

        # ── 2. Upsert + atomically increment ProductStock ─────────────────────
        _ensure_stock_row(product_id, location_id)
        ProductStock.objects.filter(
            product_id=product_id, location_id=location_id
        ).update(quantity=F("quantity") + quantity)

        # ── 3. Audit trail ────────────────────────────────────────────────────
        StockMovement.objects.create(
            product_id     = product_id,
            location_id    = location_id,
            movement_type  = StockMovement.Type.IN,
            quantity       = quantity,
            unit_cost      = unit_cost,
            reference_type = reference_type,
            reference_id   = reference_id,
        )

        logger.info(
            "Stock IN: product=%s  location=%s  qty=%s  cost=%s  layer=%s",
            product_id, location_id, quantity, unit_cost, layer.id,
        )
        return layer


# ──────────────────────────────────────────────────────────────────────────────
# 3. consume_stock_fifo  (STOCK OUT — CRITICAL FIFO ENGINE)
# ──────────────────────────────────────────────────────────────────────────────

def consume_stock_fifo(
    *,
    product_id,
    location_id,
    quantity: Decimal,
    reference_type: str = "sale",
    reference_id=None,
    notes: str = "",
) -> dict:
    """
    Consume stock using the global FIFO queue (STOCK OUT).

    Algorithm
    ─────────
      Pre-check:  location has enough physical stock.
      Lock:       SELECT FOR UPDATE on all available FIFO layers for the product.
      Validate:   global FIFO supply >= requested quantity.
      Loop:       while qty_remaining > 0:
                      take = min(layer.remaining_qty, qty_remaining)
                      COGS += take × layer.unit_cost
                      layer.remaining_qty -= take
      Update:     ProductStock for location (atomic decrement).
      Audit:      Create StockMovement (type=OUT) with COGS.

    Returns
    ───────
    {
        "cogs":           Decimal   — total cost of goods sold
        "qty":            Decimal   — quantity consumed (== input quantity)
        "avg_unit_cost":  Decimal   — COGS / qty
        "layers_touched": int       — number of FIFO layers partially/fully consumed
    }

    Raises
    ──────
    InsufficientStockError  — if location stock or global FIFO is insufficient.
    StockServiceError       — if inputs are invalid.
    """
    quantity = Decimal(str(quantity))
    if quantity <= 0:
        raise StockServiceError("Quantity must be greater than zero.")

    with transaction.atomic(using=_current_db()):
        # ── Location-level stock check ────────────────────────────────────────
        # Lock the location stock row to prevent concurrent oversell at this branch.
        try:
            loc_stock = (
                ProductStock.objects
                .select_for_update()
                .get(product_id=product_id, location_id=location_id)
            )
        except ProductStock.DoesNotExist:
            raise InsufficientStockError(
                f"No stock found for product={product_id} at location={location_id}."
            )

        if loc_stock.quantity < quantity:
            raise InsufficientStockError(
                f"Insufficient stock at this location. "
                f"Available: {loc_stock.quantity}, Requested: {quantity}."
            )

        # ── Global FIFO layer lock ────────────────────────────────────────────
        # Lock ALL available layers for this product (global, not per-location).
        # Ordering by created_at ASC = oldest-first FIFO.
        layers = list(
            FIFOLayer.objects
            .select_for_update()
            .filter(product_id=product_id, remaining_qty__gt=0)
            .order_by("created_at")
        )

        global_available = sum(l.remaining_qty for l in layers)
        if global_available < quantity:
            raise InsufficientStockError(
                f"Global FIFO stock insufficient. "
                f"Global available: {global_available}, Requested: {quantity}."
            )

        # ── FIFO deduction loop ───────────────────────────────────────────────
        total_cogs     = Decimal("0")
        qty_remaining  = quantity
        layers_touched = 0
        layers_to_save = []

        for layer in layers:
            if qty_remaining <= 0:
                break

            take = min(layer.remaining_qty, qty_remaining)

            total_cogs     += take * layer.unit_cost
            qty_remaining  -= take
            layers_touched += 1

            layer.remaining_qty -= take
            layers_to_save.append(layer)

        # Bulk-save all modified layers in one round-trip
        FIFOLayer.objects.bulk_update(layers_to_save, ["remaining_qty", "updated_at"])

        # ── Decrement location stock (atomic) ─────────────────────────────────
        ProductStock.objects.filter(
            product_id=product_id, location_id=location_id
        ).update(quantity=F("quantity") - quantity)

        # ── Audit movement ────────────────────────────────────────────────────
        avg_unit_cost = (total_cogs / quantity).quantize(Decimal("0.000001"))
        cogs_rounded  = total_cogs.quantize(Decimal("0.0001"))

        StockMovement.objects.create(
            product_id     = product_id,
            location_id    = location_id,
            movement_type  = StockMovement.Type.OUT,
            quantity       = quantity,
            unit_cost      = avg_unit_cost,
            cogs           = cogs_rounded,
            reference_type = reference_type,
            reference_id   = reference_id,
            notes          = notes,
        )

        logger.info(
            "Stock OUT (FIFO): product=%s  location=%s  qty=%s  cogs=%s  layers=%d",
            product_id, location_id, quantity, cogs_rounded, layers_touched,
        )

        result = {
            "cogs":           cogs_rounded,
            "qty":            quantity,
            "avg_unit_cost":  avg_unit_cost,
            "layers_touched": layers_touched,
        }

        # ── Low-stock alert (fire-and-forget, never breaks the sale) ──────────
        try:
            _maybe_notify_low_stock(product_id)
        except Exception as exc:
            logger.warning("Low-stock notification failed for product %s: %s", product_id, exc)

        return result


def _maybe_notify_low_stock(product_id) -> None:
    """
    After a stock consumption, check if the product has dropped at or below
    its reorder_level and, if so, fire a LOW_STOCK notification.

    Called inside consume_stock_fifo() but outside the atomic block so that
    notification failures never roll back the stock deduction.
    """
    try:
        product = Product.objects.get(pk=product_id)
    except Product.DoesNotExist:
        return

    reorder_level = getattr(product, "reorder_level", None)
    if not reorder_level or reorder_level <= 0:
        return

    total_qty = product.total_stock
    if total_qty > reorder_level:
        return

    # Build owner recipients from the master DB
    from notifications.tasks import _get_owner_recipients
    db = _current_db()
    recipients = _get_owner_recipients(db)
    if not recipients:
        return

    from notifications.services import notify_low_stock
    notify_low_stock(
        product=product,
        current_qty=total_qty,
        reorder_level=reorder_level,
        owner_recipients=recipients,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 4. transfer_stock
# ──────────────────────────────────────────────────────────────────────────────

def transfer_stock(
    *,
    product_id,
    from_location_id,
    to_location_id,
    quantity: Decimal,
    notes: str = "",
) -> dict:
    """
    Transfer stock from one location to another.

    Internally:
      • Decrements from_location ProductStock (no FIFO layer consumed — stock
        stays in the global pool; only the location snapshot changes).
      • Increments to_location ProductStock.
      • Creates two StockMovement records: OUT (from) + IN (to).

    Note: Transfers do NOT change the global FIFO layers because the stock
    is still in the company — it just moved branches.  FIFO layers remain
    linked to their original receiving location.

    Returns {"from_qty": ..., "to_qty": ..., "qty_transferred": ...}
    """
    quantity = Decimal(str(quantity))
    if quantity <= 0:
        raise StockServiceError("Transfer quantity must be greater than zero.")
    if from_location_id == to_location_id:
        raise StockServiceError("Source and destination locations must differ.")

    with transaction.atomic(using=_current_db()):
        # Lock both stock rows
        try:
            from_stock = (
                ProductStock.objects
                .select_for_update()
                .get(product_id=product_id, location_id=from_location_id)
            )
        except ProductStock.DoesNotExist:
            raise InsufficientStockError(
                f"No stock at source location={from_location_id}."
            )

        if from_stock.quantity < quantity:
            raise InsufficientStockError(
                f"Insufficient stock at source. "
                f"Available: {from_stock.quantity}, Requested: {quantity}."
            )

        # Decrement source
        ProductStock.objects.filter(
            product_id=product_id, location_id=from_location_id
        ).update(quantity=F("quantity") - quantity)

        # Increment destination (create row if first stock arrival)
        _ensure_stock_row(product_id, to_location_id)
        ProductStock.objects.filter(
            product_id=product_id, location_id=to_location_id
        ).update(quantity=F("quantity") + quantity)

        # Paired audit movements
        StockMovement.objects.bulk_create([
            StockMovement(
                product_id    = product_id,
                location_id   = from_location_id,
                movement_type = StockMovement.Type.TRANSFER,
                quantity      = quantity,
                notes         = f"Transfer OUT → location {to_location_id}. {notes}".strip(),
            ),
            StockMovement(
                product_id    = product_id,
                location_id   = to_location_id,
                movement_type = StockMovement.Type.TRANSFER,
                quantity      = quantity,
                notes         = f"Transfer IN ← location {from_location_id}. {notes}".strip(),
            ),
        ])

        # Refresh for return values
        from_stock.refresh_from_db()
        to_qty = ProductStock.objects.get(
            product_id=product_id, location_id=to_location_id
        ).quantity

        logger.info(
            "Transfer: product=%s  from=%s  to=%s  qty=%s",
            product_id, from_location_id, to_location_id, quantity,
        )
        return {
            "qty_transferred": quantity,
            "from_qty":        from_stock.quantity,
            "to_qty":          to_qty,
        }


# ──────────────────────────────────────────────────────────────────────────────
# 5. import_stock_rows  (bulk import — each row = one FIFO layer)
# ──────────────────────────────────────────────────────────────────────────────

def import_stock_rows(
    *,
    product_id,
    location_id,
    rows: list,
) -> list:
    """
    Bulk stock import. Each row in `rows` creates one FIFO layer
    (BRD requirement: "Each row = separate FIFO layer").

    rows format:
        [
            {"quantity": 100, "unit_cost": 12.50, "date": "2026-01-15"},
            {"quantity":  50, "unit_cost": 13.00, "date": "2026-02-01"},
            ...
        ]

    `date` is optional; if provided it sets the FIFO layer's created_at
    so that historical imports sit correctly in the cost queue.

    Returns a list of created FIFOLayer objects.
    """
    if not rows:
        raise StockServiceError("Import rows list cannot be empty.")

    # Validate all rows before touching the DB
    parsed_rows = []
    for i, row in enumerate(rows):
        try:
            qty  = Decimal(str(row["quantity"]))
            cost = Decimal(str(row["unit_cost"]))
        except (KeyError, Exception) as exc:
            raise StockServiceError(f"Row {i}: invalid data — {exc}") from exc

        if qty <= 0:
            raise StockServiceError(f"Row {i}: quantity must be positive (got {qty}).")
        if cost < 0:
            raise StockServiceError(f"Row {i}: unit_cost cannot be negative (got {cost}).")

        parsed_rows.append({"quantity": qty, "unit_cost": cost, "date": row.get("date")})

    # All rows valid — create layers inside a single transaction
    with transaction.atomic(using=_current_db()):
        created_layers = []
        for row in parsed_rows:
            layer = add_stock_fifo(
                product_id     = product_id,
                location_id    = location_id,
                quantity       = row["quantity"],
                unit_cost      = row["unit_cost"],
                reference_type = "import",
                layer_date     = row["date"],
            )
            created_layers.append(layer)

    logger.info(
        "Import complete: product=%s  location=%s  rows=%d  total_qty=%s",
        product_id,
        location_id,
        len(rows),
        sum(l.initial_qty for l in created_layers),
    )
    return created_layers


# ──────────────────────────────────────────────────────────────────────────────
# 6. get_stock_report
# ──────────────────────────────────────────────────────────────────────────────

def get_stock_report(
    *,
    product_id=None,
    location_id=None,
    include_zero: bool = False,
) -> list:
    """
    Return a per-location stock snapshot with FIFO valuation.

    Each entry:
    {
        product_id, product_name, product_sku, product_barcode,
        location_id, location_name, location_code,
        quantity,          ← location-level snapshot
        fifo_total_qty,    ← global FIFO remaining qty for this product
        fifo_value,        ← global FIFO value (remaining × cost, all layers)
        avg_unit_cost,     ← fifo_value / fifo_total_qty
    }
    """
    from django.db.models import ExpressionWrapper, DecimalField as DF

    qs = ProductStock.objects.select_related("product", "location")

    if not include_zero:
        qs = qs.filter(quantity__gt=0)
    if product_id:
        qs = qs.filter(product_id=product_id)
    if location_id:
        qs = qs.filter(location_id=location_id)

    report = []
    for stock in qs.order_by("product__name", "location__name"):
        # Global FIFO aggregates for this product (not filtered by location)
        fifo_agg = FIFOLayer.objects.filter(
            product_id=stock.product_id,
            remaining_qty__gt=0,
        ).aggregate(
            total_qty=Sum("remaining_qty"),
            total_value=Sum(
                ExpressionWrapper(
                    F("remaining_qty") * F("unit_cost"),
                    output_field=DF(max_digits=20, decimal_places=6),
                )
            ),
        )

        fifo_qty   = fifo_agg["total_qty"]   or Decimal("0")
        fifo_value = fifo_agg["total_value"] or Decimal("0")
        avg_cost   = (
            (fifo_value / fifo_qty).quantize(Decimal("0.0001"))
            if fifo_qty else Decimal("0")
        )

        report.append({
            "product_id":      str(stock.product_id),
            "product_name":    stock.product.name,
            "product_sku":     stock.product.sku,
            "product_barcode": stock.product.barcode,
            "location_id":     str(stock.location_id),
            "location_name":   stock.location.name,
            "location_code":   stock.location.code,
            "quantity":        stock.quantity,
            "fifo_total_qty":  fifo_qty,
            "fifo_value":      fifo_value.quantize(Decimal("0.0001")),
            "avg_unit_cost":   avg_cost,
        })

    return report


# ──────────────────────────────────────────────────────────────────────────────
# 7. get_fifo_layers  (inspection / debugging)
# ──────────────────────────────────────────────────────────────────────────────

def get_fifo_layers(*, product_id, include_exhausted: bool = False) -> list:
    """
    Return FIFO layers for a product in FIFO order (oldest first).
    Used for audit / debugging the cost queue.
    """
    qs = FIFOLayer.objects.filter(product_id=product_id).order_by("created_at")
    if not include_exhausted:
        qs = qs.filter(remaining_qty__gt=0)

    return [
        {
            "id":             str(l.id),
            "location_id":    str(l.location_id) if l.location_id else None,
            "initial_qty":    l.initial_qty,
            "remaining_qty":  l.remaining_qty,
            "consumed_qty":   l.consumed_qty,
            "unit_cost":      l.unit_cost,
            "layer_value":    l.layer_value,
            "reference_type": l.reference_type,
            "created_at":     l.created_at.isoformat(),
        }
        for l in qs
    ]
