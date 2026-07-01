"""
Sales service layer — all POS and sale lifecycle operations.

Public API
──────────
  create_sale(...)         Create a QUOTATION, PROFORMA or DRAFT sale.
  update_sale(...)         Edit items / header on an editable sale.
  finalize_sale(...)       Convert to FINAL: FIFO deduction + invoice.
  add_payment(...)         Record a payment instalment against a FINAL sale.
  void_sale(...)           Void a FINAL sale (admin only, reverses stock).
  create_backorder(...)    Persist stock-shortfall records; sale → PENDING.
  mark_backorder_fulfilled(...)  Stock arrived; sale → DRAFT (ready to retry).

RULES
─────
  • QUOTATION / PROFORMA / DRAFT  — no stock impact, no accounting entries.
  • FINAL              — FIFO deduction, invoice number, payment tracking.
  • PENDING            — blocked on back-order; no stock deducted yet.
  • No negative stock  — finalize_sale raises BackOrderRequiredError if short.
  • All DB writes are wrapped in transaction.atomic(using=_current_db()).
"""

import logging
import uuid
from decimal import Decimal, InvalidOperation
from typing import Optional

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from inventory.models import Location, Product, ProductStock
from inventory.services import InsufficientStockError, StockServiceError, consume_stock_fifo

from .models import BackOrder, Customer, Sale, SaleItem, SalePayment, SellReturn, SellReturnItem

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# DB alias helper (mirrors inventory.services)
# ──────────────────────────────────────────────────────────────────────────────

def _current_db() -> str:
    try:
        from accounts.tenant_db import get_current_db_alias  # noqa: PLC0415
        return get_current_db_alias() or "default"
    except ImportError:
        return "default"


# ──────────────────────────────────────────────────────────────────────────────
# Custom exceptions
# ──────────────────────────────────────────────────────────────────────────────

class SalesServiceError(Exception):
    """General validation error in the sales layer."""


class DiscountPermissionError(SalesServiceError):
    """Raised when a cashier tries to apply a discount without supervisor approval."""


class BackOrderRequiredError(Exception):
    """
    Raised by finalize_sale() when one or more items are short on stock.

    Attributes
    ──────────
    shortfalls : list[dict]  — one entry per short product:
        {
            "product_id":   str,
            "product_name": str,
            "requested":    Decimal,
            "available":    Decimal,
            "shortfall":    Decimal,
        }
    """
    def __init__(self, message: str, shortfalls: list):
        super().__init__(message)
        self.shortfalls = shortfalls


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _check_discount_permission(
    discount: Decimal,
    user_id,
    supervisor_password: Optional[str] = None,
) -> None:
    """
    Enforce the discount-authorisation rule:

      • discount == 0        → always allowed.
      • OWNER / ADMIN / MGR  → allowed without any extra check.
      • CASHIER              → must supply supervisor_password from a user
                               whose role is OWNER, ADMIN or MANAGER.

    Queries the MASTER database (accounts.User lives in 'default').
    """
    if not discount or discount == Decimal("0"):
        return

    from accounts.models import User  # noqa: PLC0415 — master-DB model

    try:
        actor = User.objects.using("default").get(id=user_id)
    except User.DoesNotExist:
        raise SalesServiceError(f"User {user_id} not found.")

    # Honour the granular CAN_APPLY_DISCOUNT permission, not just the
    # hardcoded owner/admin/manager role check. Cashiers now hold this
    # permission by default (see accounts.permissions._ROLE_PERMISSIONS),
    # and any custom TenantRole that grants it also passes — so a cashier
    # can apply a discount on POS without a supervisor password.
    from accounts.permissions import has_permission, Perm  # noqa: PLC0415
    if has_permission(actor, Perm.CAN_APPLY_DISCOUNT):
        return

    # ── CASHIER path: require supervisor override ─────────────────────────────
    if not supervisor_password:
        raise DiscountPermissionError(
            "Discount requires supervisor approval. "
            "Include 'supervisor_password' in the request."
        )

    # Find any active supervisor and validate their password
    supervisor = (
        User.objects.using("default")
        .filter(
            role__in=[User.Role.OWNER, User.Role.ADMIN, User.Role.MANAGER],
            is_active=True,
        )
        .first()
    )
    if not supervisor or not supervisor.check_password(supervisor_password):
        raise DiscountPermissionError("Invalid supervisor credentials.")

    logger.info(
        "Discount %.2f approved by supervisor %s for cashier %s",
        discount, supervisor.id, user_id,
    )


def _compute_totals(
    items_data: list[dict],
    header_discount: Decimal,
    tax_rate: Decimal,
) -> tuple[Decimal, Decimal, Decimal]:
    """
    Return (subtotal, tax_amount, total_amount).

    subtotal     = Σ (unit_price − item_discount) × quantity
    taxable_base = subtotal − header_discount
    tax_amount   = taxable_base × tax_rate / 100
    total_amount = taxable_base + tax_amount
    """
    subtotal = sum(
        (Decimal(str(item["unit_price"])) - Decimal(str(item.get("item_discount", 0))))
        * Decimal(str(item["quantity"]))
        for item in items_data
    )
    taxable  = max(subtotal - header_discount, Decimal("0"))
    tax      = (taxable * tax_rate / Decimal("100")).quantize(Decimal("0.01"))
    total    = (taxable + tax).quantize(Decimal("0.01"))
    return subtotal.quantize(Decimal("0.01")), tax, total


def _compute_payment_status(total: Decimal, paid: Decimal) -> str:
    if paid >= total:
        return Sale.PaymentStatus.PAID
    if paid > Decimal("0"):
        return Sale.PaymentStatus.PARTIAL
    return Sale.PaymentStatus.DUE


def _invoice_company_code(location=None) -> str:
    """Return the 3-char uppercase code embedded in the invoice number.

    Priority:
      1. The branch / location code (e.g. 'MAIN', 'DHK01') if a Location
         was passed in — multi-branch tenants want their branch in the
         invoice number so two branches can't collide.
      2. The tenant's Company Name from SystemSetting[COMPANY_NAME]
         (first word, first 3 chars uppercased — 'Ongko Printing' → 'ONG').
      3. The literal 'INV' as a last-resort placeholder.
    """
    if location is not None:
        code = (getattr(location, "code", "") or getattr(location, "name", "") or "").strip()
        if code:
            cleaned = "".join(ch for ch in code.upper() if ch.isalnum())
            if cleaned:
                return cleaned[:5]
    try:
        from system_config.services import get_setting, SettingKeys
        name = (get_setting(SettingKeys.COMPANY_NAME) or "").strip()
    except Exception:
        name = ""
    if name:
        first = name.split()[0]
        cleaned = "".join(ch for ch in first.upper() if ch.isalpha())
        if cleaned:
            return cleaned[:3]
    return "INV"


def _generate_invoice_number(location=None) -> str:
    """
    Per-tenant invoice number, customisable from Business Settings.

    Layout: <PREFIX>[-<BRANCH>][-<DATE>]-<SERIAL>

      INV-260606-001           (defaults, single-branch tenant — short)
      INV-MAIN-260606-001      (defaults, multi-branch tenant)
      BILL-260606-0001         (custom prefix + YYMMDD + 4 digits)
      INV-001                  (branch + date disabled)

    Settings read from SystemSetting:
      invoice.prefix             (str,  default "INV")
      invoice.use_branch_code    (bool, default: ON only for multi-branch)
      invoice.date_format        ("DDMMYYYY"|"DDMMYY"|"YYYYMMDD"|
                                  "YYMMDD"|"NONE", default "YYMMDD")
      invoice.serial_digits      (int 2..8, default 3)

    Sequence resets daily per (prefix, branch, date). Safe under
    the SELECT FOR UPDATE lock held by finalize_sale().
    """
    now = timezone.now()

    # Load tenant-configurable knobs (all optional). The system_config
    # SettingKeys enum only knows about a few canonical keys; the new
    # invoice.* keys are looked up by string so they don't require an
    # enum change.
    try:
        from system_config.services import get_setting
        prefix_raw       = get_setting("invoice.prefix") or "INV"
        use_branch_raw   = get_setting("invoice.use_branch_code")
        # Shorter default date (YYMMDD, 6 digits) so invoice numbers aren't
        # so long, e.g. 14062026 -> 260614. Tenants can still pick a longer
        # format in Business Settings.
        date_format      = (get_setting("invoice.date_format") or "YYMMDD").upper()
        serial_digits_raw = get_setting("invoice.serial_digits") or "3"
    except Exception:
        prefix_raw, use_branch_raw, date_format, serial_digits_raw = "INV", None, "YYMMDD", "3"

    # Keep only alnum + dash so a typo can't produce an invalid prefix.
    leading = "".join(ch for ch in str(prefix_raw).strip().upper() if ch.isalnum() or ch == "-")[:10] or "INV"

    # Branch code default: ONLY include it for multi-branch tenants (where it
    # prevents two branches colliding). A single-branch tenant — e.g. free
    # tier — doesn't need it, which keeps the number short (drops "MAIN").
    # An explicit Business Settings value always wins.
    if use_branch_raw is not None:
        use_branch = str(use_branch_raw).strip().lower() in ("true", "1", "yes", "y")
    else:
        try:
            from inventory.models import Location  # noqa: PLC0415
            use_branch = Location.objects.filter(is_active=True).count() > 1
        except Exception:
            use_branch = False
    try:
        digits = max(2, min(8, int(serial_digits_raw)))
    except (TypeError, ValueError):
        digits = 3

    yy = f"{now.year % 100:02d}"
    yyyy = f"{now.year}"
    mm = f"{now.month:02d}"
    dd = f"{now.day:02d}"
    date_str = {
        "DDMMYYYY": f"{dd}{mm}{yyyy}",
        "DDMMYY":   f"{dd}{mm}{yy}",
        "YYYYMMDD": f"{yyyy}{mm}{dd}",
        "YYMMDD":   f"{yy}{mm}{dd}",
        "NONE":     "",
    }.get(date_format, f"{yy}{mm}{dd}")

    parts = [leading]
    if use_branch:
        parts.append(_invoice_company_code(location))
    if date_str:
        parts.append(date_str)
    prefix_for_match = "-".join(parts) + "-"

    last = (
        Sale.objects
        .filter(invoice_number__startswith=prefix_for_match)
        .order_by("-invoice_number")
        .values_list("invoice_number", flat=True)
        .first()
    )
    seq = 1
    if last:
        try:
            seq = int(last.split("-")[-1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f"{prefix_for_match}{seq:0{digits}d}"


def _validate_and_build_items(items_data: list[dict]) -> list[dict]:
    """
    Validate item payload and return normalised list.

    Each item dict must have: product_id, quantity, unit_price.
    Optional:                  item_discount (default 0).
    """
    if not items_data:
        raise SalesServiceError("A sale must have at least one item.")

    result = []
    for i, raw in enumerate(items_data):
        try:
            product_id    = raw["product_id"]
            quantity      = Decimal(str(raw["quantity"]))
            unit_price    = Decimal(str(raw["unit_price"]))
            item_discount = Decimal(str(raw.get("item_discount", 0)))
        except (KeyError, Exception) as exc:
            raise SalesServiceError(f"Item {i}: invalid data — {exc}") from exc

        if quantity <= 0:
            raise SalesServiceError(f"Item {i}: quantity must be positive.")
        if unit_price < 0:
            raise SalesServiceError(f"Item {i}: unit_price cannot be negative.")
        if item_discount < 0:
            raise SalesServiceError(f"Item {i}: item_discount cannot be negative.")
        if item_discount > unit_price:
            raise SalesServiceError(f"Item {i}: item_discount exceeds unit_price.")

        if not Product.objects.filter(id=product_id, is_active=True).exists():
            raise SalesServiceError(f"Item {i}: product {product_id} not found or inactive.")

        # Per-line note (IMEI / serial / free text). Accept a top-level
        # `note` or the POS shape `meta.description`.
        note = raw.get("note")
        if note in (None, ""):
            note = (raw.get("meta") or {}).get("description", "") if isinstance(raw.get("meta"), dict) else ""
        note = str(note or "").strip()

        result.append({
            "product_id":    product_id,
            "quantity":      quantity,
            "unit_price":    unit_price,
            "item_discount": item_discount,
            "total_price":   (unit_price - item_discount) * quantity,
            "note":          note,
        })
    return result


def _is_stock_managed(product) -> bool:
    """
    Returns True if the product should have its stock tracked/deducted.

    The frontend's "Manage Stock?" toggle on Add/Edit Product is persisted
    into ``Product.meta["manage_stock"]``. Service / non-stocked items
    (False) bypass stock-availability checks and FIFO deduction — they
    sell freely from any location regardless of recorded quantity.
    Default (key missing) is True so legacy products keep tracking stock.
    """
    if product is None:
        return True
    meta = getattr(product, "meta", None) or {}
    return meta.get("manage_stock", True) is not False


def _record_oversell_movement(*, sale, product_id, quantity, notes: str) -> None:
    """Used by finalize_sale when overselling is allowed but the product has
    no FIFO layer / no ProductStock row at this location.

    Records a zero-cost StockMovement so the sale shows up in the ledger,
    and creates / decrements ProductStock so the running quantity reflects
    the oversell (going negative is fine — Settings → Sale → Allow
    Overselling is what got us here). COGS for the line stays at 0 and
    will catch up the next time the tenant receives stock and finalises a
    sale against the new FIFO layer.
    """
    from decimal import Decimal as _D
    from inventory.models import ProductStock, StockMovement
    from django.db.models import F as _F

    db = _current_db()
    qty = _D(str(quantity))

    # get_or_create on (product, location) — race-safe under the outer
    # finalize_sale atomic since both Sale.location and product_id are
    # fixed for this iteration.
    stock, created = ProductStock.objects.using(db).get_or_create(
        product_id=product_id,
        location_id=sale.location_id,
        defaults={"quantity": _D("0")},
    )
    ProductStock.objects.using(db).filter(pk=stock.pk).update(
        quantity=_F("quantity") - qty,
    )

    StockMovement.objects.using(db).create(
        product_id     = product_id,
        location_id    = sale.location_id,
        movement_type  = StockMovement.Type.OUT,
        quantity       = qty,
        unit_cost      = _D("0"),
        reference_type = "sale",
        reference_id   = sale.id,
        notes          = notes,
    )


def _expand_combo_items(items: list) -> list[dict]:
    """
    Expand each line item into the underlying stock-bearing rows.

    - Single / variable products pass through unchanged.
    - Combo products are replaced by their component lines, each with
      quantity multiplied by the parent line's quantity.

    Returns a list of dicts:
        {
          "product_id":   UUID,
          "product_name": str,
          "quantity":     Decimal,
          "parent_item":  the original SaleItem (or dict),
          "component_unit_cost": Decimal | None,
        }
    """
    from inventory.models import ComboItem, Product  # noqa: PLC0415

    expanded = []
    for item in items:
        # Accept both SaleItem instances (with .product preloaded) and raw
        # dicts (used by _check_stock_availability when called from the
        # API/serializer layer).
        if hasattr(item, "product") and item.product is not None:
            product = item.product
        else:
            pid = getattr(item, "product_id", None) or (
                item.get("product_id") if isinstance(item, dict) else None
            )
            product = Product.objects.filter(id=pid).first()
            if product is None:
                # Pass the row through unchanged — the FIFO loop will surface
                # its own clearer error.
                expanded.append({
                    "product_id":   pid,
                    "product_name": str(pid),
                    "quantity":     getattr(item, "quantity", None) or (
                        item.get("quantity") if isinstance(item, dict) else Decimal("0")
                    ),
                    "parent_item":  item,
                    "component_unit_cost": None,
                    "manage_stock": True,
                })
                continue

        parent_qty = getattr(item, "quantity", None) or (
            item.get("quantity") if isinstance(item, dict) else Decimal("0")
        )

        if product.product_type == "combo":
            combo_lines = list(
                ComboItem.objects
                .filter(combo=product)
                .select_related("component")
                .order_by("sort_order")
            )
            if not combo_lines:
                # Combo with no components configured — treat like a normal
                # product so the FIFO call surfaces a clear stock error.
                expanded.append({
                    "product_id":   product.id,
                    "product_name": product.name,
                    "quantity":     parent_qty,
                    "parent_item":  item,
                    "component_unit_cost": None,
                    "manage_stock": _is_stock_managed(product),
                })
                continue
            for ci in combo_lines:
                expanded.append({
                    "product_id":   ci.component_id,
                    "product_name": ci.component.name,
                    "quantity":     (parent_qty or Decimal("0")) * (ci.quantity or Decimal("0")),
                    "parent_item":  item,
                    "component_unit_cost": ci.component.cost_price,
                    "manage_stock": _is_stock_managed(ci.component),
                })
        else:
            expanded.append({
                "product_id":   product.id,
                "product_name": product.name,
                "quantity":     parent_qty,
                "parent_item":  item,
                "component_unit_cost": None,
                "manage_stock": _is_stock_managed(product),
            })

    return expanded


def _check_stock_availability(items: list, location_id) -> list[dict]:
    """
    Return a list of shortfall dicts for items that don't have enough stock.
    Empty list means all items are available.

    Combo products are expanded into their components first — a shortfall on
    one component blocks the parent combo line from being sold.
    """
    expanded = _expand_combo_items(items)

    # Multiple parent lines can reference the same component (e.g. two
    # combos both containing a Pen). Sum required quantities by product so
    # we don't double-count stock.
    required = {}
    for row in expanded:
        # Service / non-stocked products bypass the availability check —
        # they sell freely from any location regardless of recorded qty.
        if row.get("manage_stock") is False:
            continue
        pid = row["product_id"]
        required[pid] = required.get(pid, Decimal("0")) + (row["quantity"] or Decimal("0"))
        # Cache one display name per product.
        required.setdefault(f"_name_{pid}", row["product_name"])

    shortfalls = []
    for pid, qty in [(k, v) for k, v in required.items() if not str(k).startswith("_name_")]:
        available = (
            ProductStock.objects
            .filter(product_id=pid, location_id=location_id)
            .aggregate(total=Sum("quantity"))["total"]
            or Decimal("0")
        )
        if available < qty:
            shortfalls.append({
                "product_id":   str(pid),
                "product_name": required.get(f"_name_{pid}", str(pid)),
                "requested":    qty,
                "available":    available,
                "shortfall":    qty - available,
            })
    return shortfalls


# ──────────────────────────────────────────────────────────────────────────────
# 1. create_sale
# ──────────────────────────────────────────────────────────────────────────────

def create_sale(
    *,
    location_id,
    items: list[dict],
    created_by_id,
    status: str = Sale.Status.DRAFT,
    customer_id=None,
    discount: Decimal = Decimal("0"),
    tax_rate: Decimal = Decimal("0"),
    notes: str = "",
    meta: Optional[dict] = None,
    supervisor_password: Optional[str] = None,
) -> Sale:
    """
    Create a new sale in QUOTATION, PROFORMA or DRAFT status.

    No stock is reserved or deducted.  Call finalize_sale() to commit.

    Parameters
    ──────────
    location_id         Branch/warehouse the sale will be fulfilled from.
    items               List of item dicts (product_id, quantity, unit_price,
                        item_discount?).
    created_by_id       UUID of the requesting user.
    status              QUOTATION, PROFORMA or DRAFT (default DRAFT).
    customer_id         Optional FK to Customer.
    discount            Header-level discount applied to subtotal.
    tax_rate            Tax percentage (e.g. 15.0 = 15 %).
    notes               Free-text.
    supervisor_password Required only when a CASHIER applies a non-zero discount.
    """
    if status not in (Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT):
        raise SalesServiceError(
            "create_sale only accepts QUOTATION, PROFORMA or DRAFT status."
        )

    discount = Decimal(str(discount))
    tax_rate = Decimal(str(tax_rate))

    _check_discount_permission(discount, created_by_id, supervisor_password)

    with transaction.atomic(using=_current_db()):
        # Validate location
        if not Location.objects.filter(id=location_id, is_active=True).exists():
            raise SalesServiceError(f"Location {location_id} not found or inactive.")

        # Validate items
        validated = _validate_and_build_items(items)

        # Compute financial totals
        subtotal, tax_amount, total_amount = _compute_totals(
            validated, discount, tax_rate
        )

        if discount > subtotal:
            raise SalesServiceError(
                f"Header discount ({discount}) exceeds subtotal ({subtotal})."
            )

        # Create sale header. `meta` is a JSON dict the UI populates with
        # source ("POS" / "ADD_SALE"), table reference, service-staff id,
        # shipping flags etc. The Sales-list endpoints (PosSaleListView,
        # QuotationSaleListView, etc.) filter on meta.source so it MUST
        # round-trip cleanly from request → DB.
        sale_meta = meta if isinstance(meta, dict) else {}
        sale = Sale.objects.create(
            location_id     = location_id,
            customer_id     = customer_id,
            status          = status,
            subtotal        = subtotal,
            discount        = discount,
            tax_rate        = tax_rate,
            tax_amount      = tax_amount,
            total_amount    = total_amount,
            balance_due     = total_amount,
            notes           = notes,
            meta            = sale_meta,
            created_by_id   = created_by_id,
        )

        # Create line items
        SaleItem.objects.bulk_create([
            SaleItem(
                sale_id       = sale.id,
                product_id    = item["product_id"],
                quantity      = item["quantity"],
                unit_price    = item["unit_price"],
                item_discount = item["item_discount"],
                total_price   = item["total_price"],
                note          = item.get("note", ""),
            )
            for item in validated
        ])

        logger.info(
            "Sale created: id=%s  status=%s  total=%s  items=%d  by=%s",
            sale.id, sale.status, sale.total_amount, len(validated), created_by_id,
        )
        return sale


# ──────────────────────────────────────────────────────────────────────────────
# 2. update_sale
# ──────────────────────────────────────────────────────────────────────────────

def update_sale(
    *,
    sale_id,
    updated_by_id,
    items: Optional[list[dict]] = None,
    customer_id=None,
    discount: Optional[Decimal] = None,
    tax_rate: Optional[Decimal] = None,
    notes: Optional[str] = None,
    supervisor_password: Optional[str] = None,
) -> Sale:
    """
    Update a QUOTATION, PROFORMA or DRAFT sale.

    Passing items replaces ALL existing line items atomically.
    Omitted fields are left unchanged.
    """
    with transaction.atomic(using=_current_db()):
        sale = Sale.objects.select_for_update().get(id=sale_id)

        if not sale.is_editable:
            raise SalesServiceError(
                f"Sale is {sale.status} and cannot be edited. "
                "Only QUOTATION, PROFORMA and DRAFT sales are editable."
            )

        # Apply scalar updates
        if customer_id is not None:
            sale.customer_id = customer_id
        if notes is not None:
            sale.notes = notes

        eff_discount = Decimal(str(discount)) if discount is not None else sale.discount
        eff_tax_rate = Decimal(str(tax_rate)) if tax_rate is not None else sale.tax_rate

        _check_discount_permission(eff_discount, updated_by_id, supervisor_password)

        if items is not None:
            validated = _validate_and_build_items(items)
            subtotal, tax_amount, total_amount = _compute_totals(
                validated, eff_discount, eff_tax_rate
            )
            if eff_discount > subtotal:
                raise SalesServiceError(
                    f"Header discount ({eff_discount}) exceeds subtotal ({subtotal})."
                )
            # Replace line items
            sale.items.all().delete()
            SaleItem.objects.bulk_create([
                SaleItem(
                    sale_id       = sale.id,
                    product_id    = item["product_id"],
                    quantity      = item["quantity"],
                    unit_price    = item["unit_price"],
                    item_discount = item["item_discount"],
                    total_price   = item["total_price"],
                    note          = item.get("note", ""),
                )
                for item in validated
            ])
            sale.subtotal      = subtotal
            sale.tax_amount    = tax_amount
            sale.total_amount  = total_amount
            sale.balance_due   = total_amount  # no payments yet on editable sale
        else:
            # Recompute if discount / tax_rate changed
            if discount is not None or tax_rate is not None:
                current_items = list(
                    sale.items.values("unit_price", "item_discount", "quantity")
                )
                subtotal, tax_amount, total_amount = _compute_totals(
                    current_items, eff_discount, eff_tax_rate
                )
                sale.subtotal     = subtotal
                sale.tax_amount   = tax_amount
                sale.total_amount = total_amount
                sale.balance_due  = total_amount

        sale.discount  = eff_discount
        sale.tax_rate  = eff_tax_rate
        sale.save()

        logger.info("Sale updated: id=%s  by=%s", sale.id, updated_by_id)
        return sale


# ──────────────────────────────────────────────────────────────────────────────
# 3. finalize_sale
# ──────────────────────────────────────────────────────────────────────────────

def finalize_sale(
    *,
    sale_id,
    finalized_by_id,
    expected_payment=None,
) -> Sale:
    """
    Commit a QUOTATION / PROFORMA / DRAFT sale to FINAL.

    Algorithm
    ─────────
    1. Lock the sale row.
    2. Check every item against location stock.
    3. If any shortfall → raise BackOrderRequiredError (nothing written).
    4. Deduct stock via FIFO for every item.
    5. Stamp COGS on each SaleItem.
    6. Generate sequential invoice number.
    7. Transition sale → FINAL, set finalized_at, compute payment_status.

    Raises
    ──────
    BackOrderRequiredError  — call create_backorder() on this error.
    SalesServiceError       — invalid sale state.
    InsufficientStockError  — should not normally occur (pre-checked above),
                              but bubbles up if a race condition slips through.
    """
    with transaction.atomic(using=_current_db()):
        try:
            sale = Sale.objects.select_for_update().get(id=sale_id)
        except Sale.DoesNotExist:
            raise SalesServiceError(f"Sale {sale_id} not found.")

        if sale.status == Sale.Status.FINAL:
            raise SalesServiceError("Sale is already finalized.")
        if sale.status == Sale.Status.VOIDED:
            raise SalesServiceError("Cannot finalize a voided sale.")
        if sale.status == Sale.Status.PENDING:
            raise SalesServiceError(
                "Sale is pending a back-order. "
                "Receive the purchase order first, then retry finalization."
            )
        if not sale.can_be_finalized:
            raise SalesServiceError(f"Cannot finalize a sale in status '{sale.status}'.")

        items = list(sale.items.select_related("product").all())
        if not items:
            raise SalesServiceError("Cannot finalize a sale with no items.")

        # ── Credit-sale gating ────────────────────────────────────────────────
        # A sale is "on credit" if any portion is still owed at finalisation
        # time (amount_paid < total). The product rules say:
        #
        #   • Walk-in customers (customer=NULL) NEVER get credit. Cash-only.
        #   • Registered customers need credit_limit > 0 AND enough headroom.
        #
        # We rely on amount_paid being current. POS, however, has to
        # finalise BEFORE it can record payments (add_payment refuses
        # non-FINAL sales), so it passes its intended payment amount via
        # `expected_payment` so the credit gate can evaluate the sale as
        # if that payment had already landed. Without this, every walk-in
        # cash sale would be rejected as "credit to a walk-in customer".
        try:
            expected = Decimal(str(expected_payment)) if expected_payment is not None else Decimal("0")
        except (TypeError, ValueError, InvalidOperation):
            expected = Decimal("0")
        if expected < 0:
            expected = Decimal("0")
        already_paid = Decimal(str(sale.amount_paid or 0))
        total        = Decimal(str(sale.total_amount or 0))
        owed = total - already_paid - expected
        if owed > 0:
            if sale.customer is None:
                raise SalesServiceError(
                    "Walk-in customers cannot buy on credit. "
                    "Either collect full payment or select a registered customer "
                    "with a credit limit before finalising this sale."
                )
            if (sale.customer.credit_limit or 0) <= 0:
                raise SalesServiceError(
                    f"{sale.customer.name} is set up as cash-only "
                    "(no credit limit configured). Set a credit limit on the "
                    "customer record first, or collect full payment for this sale."
                )

        # ── 1. Stock availability pre-check ───────────────────────────────────
        # Settings → Sale → "Allow Overselling" controls whether finalisation
        # is blocked when a product's tracked stock would go negative.
        # The default is now FALSE (strict): stock can never go negative
        # from a sale — the operator gets an out-of-stock error listing
        # the short products instead. Tenants that explicitly want the
        # old oversell behaviour can enable it in Business Settings →
        # Sale; the per-tenant setting still wins.
        from system_config.services import get_setting  # noqa: PLC0415
        allow_overselling = bool(
            get_setting("sale.allow_overselling", False)
            or get_setting("sales.allow_negative_stock", False)
        )
        if not allow_overselling:
            shortfalls = _check_stock_availability(items, sale.location_id)
            if shortfalls:
                names = ", ".join(s.get("product_name", "?") for s in shortfalls[:3])
                if len(shortfalls) > 3:
                    names += f", and {len(shortfalls) - 3} more"
                raise BackOrderRequiredError(
                    f"Not enough stock for: {names}. Enable Allow Overselling "
                    "in Business Settings → Sale, or top up stock first.",
                    shortfalls=shortfalls,
                )

        # ── 2. FIFO deduction for every item (combos expanded to components) ──
        # For combo lines, deduct each component's stock individually but
        # accumulate the COGS back onto the parent SaleItem so the invoice
        # row still shows a single combined cost.
        items_to_update = []
        cogs_by_item    = {item.id: Decimal("0") for item in items}

        for row in _expand_combo_items(items):
            parent = row["parent_item"]
            # Skip FIFO/COGS for service or non-stocked items — there are no
            # FIFO layers to consume and the cost defaults to 0.
            if row.get("manage_stock") is False:
                continue
            try:
                result = consume_stock_fifo(
                    product_id     = row["product_id"],
                    location_id    = sale.location_id,
                    quantity       = row["quantity"],
                    reference_type = "sale",
                    reference_id   = sale.id,
                    notes          = (
                        f"Sale {sale.id}"
                        + (f"  (combo component of {parent.product.name})"
                           if parent.product.product_type == "combo" else "")
                    ),
                )
            except (InsufficientStockError, StockServiceError) as exc:
                # When overselling is allowed (default), zero-stock and
                # missing-FIFO-layer cases must NOT crash the sale. We
                # record a zero-cost OUT movement so the product's stock
                # ledger reflects the sale (going negative if needed) and
                # COGS catches up on next purchase. This handles freshly
                # imported products that have no opening stock layer yet.
                if not allow_overselling:
                    raise SalesServiceError(
                        f"FIFO deduction failed for product '{row['product_name']}': {exc}"
                    ) from exc
                _record_oversell_movement(
                    sale=sale,
                    product_id=row["product_id"],
                    quantity=row["quantity"],
                    notes=f"Sale {sale.id} (oversell — no FIFO layer at location)",
                )
                continue
            cogs_by_item[parent.id] = cogs_by_item.get(parent.id, Decimal("0")) + (
                result["cogs"] or Decimal("0")
            )

        for item in items:
            item.cogs = cogs_by_item.get(item.id, Decimal("0"))
            items_to_update.append(item)
        SaleItem.objects.bulk_update(items_to_update, ["cogs"])

        # ── 3. Invoice number ──────────────────────────────────────────────────
        # Pass the sale's Location so the invoice number includes the
        # branch code for multi-branch tenants. Single-branch tenants
        # fall back to the company-name code.
        invoice_number = _generate_invoice_number(location=sale.location)

        # ── 4. Finalise sale header ────────────────────────────────────────────
        now = timezone.now()
        sale.status          = Sale.Status.FINAL
        sale.invoice_number  = invoice_number
        sale.finalized_by_id = finalized_by_id
        sale.finalized_at    = now
        sale.payment_status  = _compute_payment_status(
            sale.total_amount, sale.amount_paid
        )
        sale.save(update_fields=[
            "status", "invoice_number", "finalized_by_id", "finalized_at",
            "payment_status", "updated_at",
        ])

        # ── 5. Accounting: revenue recognition + COGS entries ─────────────────
        try:
            from accounting.services import post_sale_entry  # noqa: PLC0415
            post_sale_entry(sale=sale, created_by_id=finalized_by_id)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Accounting entry failed for sale %s: %s — rolling back.",
                sale.id, exc,
            )
            # Friendly, non-technical message for the operator. The raw
            # "Σ Debit ≠ Σ Credit" wording confused tenants; the full
            # technical detail is still in the logs above.
            low = str(exc).lower()
            if "not balanced" in low or "balance" in low:
                friendly = (
                    "We couldn't post this sale to the accounts because the "
                    "totals didn't add up. Please check the discount, tax and "
                    "shipping/extra charges, then try again. If it keeps "
                    "happening, contact support."
                )
            elif "does not exist" in low and "account" in low:
                friendly = (
                    "Your chart of accounts is missing a required account "
                    "(Receivable, Sales Revenue, Tax Payable, Inventory or "
                    "COGS). Ask your administrator to add it, then try again."
                )
            else:
                friendly = (
                    "We couldn't record the accounting for this sale. "
                    "Please try again, or contact support with the time of "
                    "the attempt."
                )
            raise SalesServiceError(friendly) from exc

        logger.info(
            "Sale finalized: id=%s  invoice=%s  total=%s  by=%s",
            sale.id, sale.invoice_number, sale.total_amount, finalized_by_id,
        )
        return sale


# ──────────────────────────────────────────────────────────────────────────────
# 4. add_payment
# ──────────────────────────────────────────────────────────────────────────────

def add_payment(
    *,
    sale_id,
    amount: Decimal,
    method: str,
    received_by_id,
    reference: str = "",
    notes: str = "",
    payment_account_id=None,
) -> SalePayment:
    """
    Record a payment instalment against a FINAL sale.

    Rules
    ─────
    • Sale must be FINAL.
    • amount must be > 0 and ≤ balance_due.
    • balance_due and payment_status are updated atomically via F() expressions.

    Payment status transitions
    ──────────────────────────
      balance_due > 0  → PARTIAL
      balance_due == 0 → PAID
    """
    amount = Decimal(str(amount))
    if amount <= 0:
        raise SalesServiceError("Payment amount must be positive.")

    with transaction.atomic(using=_current_db()):
        try:
            sale = Sale.objects.select_for_update().get(id=sale_id)
        except Sale.DoesNotExist:
            raise SalesServiceError(f"Sale {sale_id} not found.")

        if sale.status != Sale.Status.FINAL:
            raise SalesServiceError(
                "Payments can only be recorded against FINAL sales. "
                f"This sale is {sale.status}."
            )
        if sale.payment_status == Sale.PaymentStatus.PAID:
            raise SalesServiceError("Sale is already fully paid.")
        if amount > sale.balance_due:
            raise SalesServiceError(
                f"Payment amount {amount} exceeds balance due {sale.balance_due}."
            )

        # ── Advance balance settlement ─────────────────────────────────────────
        # When the cashier pays from the customer's advance, no new cash comes
        # in (the money was banked when the advance was first paid). We just
        # draw the sale's balance down from the customer's advance_balance —
        # no PaymentAccount credit, no cash/AR receipt journal.
        if method == SalePayment.Method.ADVANCE:
            if not sale.customer_id:
                raise SalesServiceError("Advance payment requires a customer on the sale.")
            cust = Customer.objects.select_for_update().get(id=sale.customer_id)
            avail = cust.advance_balance or Decimal("0")
            if amount > avail:
                raise SalesServiceError(
                    f"Advance balance ({avail}) is less than the requested {amount}."
                )
            payment = SalePayment.objects.create(
                sale_id=sale.id, amount=amount, method=method,
                reference=reference, notes=notes, received_by_id=received_by_id,
                payment_account_id=None,
            )
            cust.advance_balance = avail - amount
            cust.save(update_fields=["advance_balance"])
            Sale.objects.filter(id=sale.id).update(
                amount_paid=F("amount_paid") + amount,
                balance_due=F("balance_due") - amount,
                updated_at=timezone.now(),
            )
            sale.refresh_from_db(fields=["amount_paid", "balance_due"])
            Sale.objects.filter(id=sale.id).update(
                payment_status=_compute_payment_status(sale.total_amount, sale.amount_paid)
            )
            logger.info("Advance payment: sale=%s amount=%s advance_left=%s",
                        sale_id, amount, cust.advance_balance)
            return payment

        payment = SalePayment.objects.create(
            sale_id            = sale.id,
            amount             = amount,
            method             = method,
            reference          = reference,
            notes              = notes,
            received_by_id     = received_by_id,
            payment_account_id = payment_account_id,
        )

        # If the cashier chose a Payment Account (cash box / bank / MFS),
        # mirror this payment into the account's transaction ledger so the
        # balance on Account Book / Cash Flow ledger / Balance Summary
        # reflects it immediately. Best-effort: failures here log + bubble
        # the exception so the surrounding transaction rolls back.
        if payment_account_id:
            try:
                from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
                acct = (
                    PaymentAccount.objects
                    .filter(id=payment_account_id, is_active=True)
                    .first()
                )
                if acct:
                    PaymentAccountTransaction.objects.create(
                        account=acct,
                        kind=PaymentAccountTransaction.Kind.SALE,
                        amount=amount,           # positive — money in
                        reference=reference or "",
                        note=f"Sale payment (invoice {sale.invoice_number or sale.id})",
                    )
                else:
                    logger.warning(
                        "Sale payment %s references missing/inactive PaymentAccount %s — "
                        "no ledger row written.",
                        payment.id, payment_account_id,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "Failed to write PaymentAccountTransaction for sale payment %s: %s",
                    payment.id, exc,
                )
                raise

        # Atomic increment / decrement — no read-modify-write race
        Sale.objects.filter(id=sale.id).update(
            amount_paid = F("amount_paid") + amount,
            balance_due = F("balance_due") - amount,
            updated_at  = timezone.now(),
        )
        sale.refresh_from_db(fields=["amount_paid", "balance_due"])

        # Recompute and persist payment_status
        new_status = _compute_payment_status(sale.total_amount, sale.amount_paid)
        Sale.objects.filter(id=sale.id).update(payment_status=new_status)

        # ── Accounting: cash/bank receipt vs AR ───────────────────────────────
        try:
            from accounting.services import post_payment_entry  # noqa: PLC0415
            sale.refresh_from_db()  # pick up latest amount_paid / balance_due
            post_payment_entry(
                payment=payment, sale=sale, created_by_id=received_by_id
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Accounting entry failed for payment on sale %s: %s — rolling back.",
                sale_id, exc,
            )
            raise SalesServiceError(
                f"Accounting error during payment recording: {exc}"
            ) from exc

        logger.info(
            "Payment recorded: sale=%s  amount=%s  method=%s  status_now=%s",
            sale_id, amount, method, new_status,
        )
        return payment


# ──────────────────────────────────────────────────────────────────────────────
# 4b. record_customer_payment — collect against dues, overflow → advance
# ──────────────────────────────────────────────────────────────────────────────

def record_customer_payment(
    *, customer_id, amount, method="CASH", payment_account_id=None,
    note="", received_by_id=None,
) -> dict:
    """
    Collect a payment from a customer (Customers page → Pay).

    The amount first settles the customer's outstanding FINAL sales, oldest
    first (each instalment credits the chosen Payment Account via add_payment).
    Anything left over is added to the customer's `advance_balance` and the
    same Payment Account is credited for that leftover — so the List Accounts
    balance reflects the full amount received.
    """
    amount = Decimal(str(amount))
    if amount <= 0:
        raise SalesServiceError("Payment amount must be positive.")
    if method not in dict(SalePayment.Method.choices):
        method = SalePayment.Method.OTHER

    with transaction.atomic(using=_current_db()):
        try:
            customer = Customer.objects.select_for_update().get(id=customer_id)
        except Customer.DoesNotExist:
            raise SalesServiceError("Customer not found.")

        remaining = amount
        sales = (
            Sale.objects
            .filter(customer_id=customer_id, status=Sale.Status.FINAL)
            .exclude(payment_status=Sale.PaymentStatus.PAID)
            .order_by("created_at")
        )
        for s in sales:
            if remaining <= 0:
                break
            s.refresh_from_db(fields=["balance_due"])
            due = s.balance_due or Decimal("0")
            if due <= 0:
                continue
            pay = min(remaining, due)
            add_payment(
                sale_id=s.id, amount=pay, method=method,
                received_by_id=received_by_id, payment_account_id=payment_account_id,
                notes=note,
            )
            remaining -= pay

        # Overflow → advance balance + credit the Payment Account for it.
        if remaining > 0:
            customer.advance_balance = (customer.advance_balance or Decimal("0")) + remaining
            customer.save(update_fields=["advance_balance"])
            if payment_account_id:
                try:
                    from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
                    acct = PaymentAccount.objects.filter(id=payment_account_id, is_active=True).first()
                    if acct:
                        PaymentAccountTransaction.objects.create(
                            account=acct,
                            kind=PaymentAccountTransaction.Kind.DEPOSIT,
                            amount=remaining,
                            reference="",
                            note=f"Advance from {customer.name}",
                        )
                except Exception:  # noqa: BLE001
                    logger.exception("Failed to credit advance deposit for customer %s", customer_id)

        customer.refresh_from_db(fields=["advance_balance"])
        return {
            "customer_id":      str(customer.id),
            "amount":           str(amount),
            "applied_to_due":   str(amount - remaining),
            "added_to_advance": str(remaining),
            "advance_balance":  str(customer.advance_balance or Decimal("0")),
        }


# ──────────────────────────────────────────────────────────────────────────────
# 5. void_sale
# ──────────────────────────────────────────────────────────────────────────────

def void_sale(*, sale_id, voided_by_id) -> Sale:
    """
    Void a FINAL sale.  Reverses all FIFO deductions via stock-in adjustments
    AND reverses every PaymentAccount ledger row this sale created, so the
    affected cash boxes / banks / wallets return to their pre-sale balance.

    Rules
    ─────
    • Only FINAL sales can be voided.
    • Fully or partially paid sales can be voided (payment reversal happens
      on PaymentAccount balances; if the customer was actually charged
      externally via a gateway, the operator must handle that refund).
    • Each SaleItem's original quantity is returned to stock as an ADJUST
      movement at the original unit_cost (average of COGS / qty).
    """
    from inventory.services import add_stock_fifo  # noqa: PLC0415

    with transaction.atomic(using=_current_db()):
        try:
            sale = Sale.objects.select_for_update().get(id=sale_id)
        except Sale.DoesNotExist:
            raise SalesServiceError(f"Sale {sale_id} not found.")

        if sale.status != Sale.Status.FINAL:
            raise SalesServiceError(
                f"Only FINAL sales can be voided (current status: {sale.status})."
            )

        # Expand combos before putting stock back — the FIFO movements were
        # against component products, so the reversal needs to mirror that.
        # Edge case: if a combo's component list was edited between finalize
        # and void, the reversal uses the CURRENT definition. Combos are
        # rarely edited mid-life, but worth a note in the audit log.
        items = list(sale.items.select_related("product").all())
        expanded = _expand_combo_items(items)

        # For pure (non-combo) items use the original COGS-derived unit_cost.
        # For combo components use the component's current cost_price as the
        # best-effort unit cost (FIFO doesn't care about precise reversal
        # cost — what matters is that quantity comes back into the layer).
        for row in expanded:
            parent     = row["parent_item"]
            is_combo   = parent.product.product_type == "combo"
            qty        = row["quantity"]
            if not is_combo:
                unit_cost = (
                    (parent.cogs / parent.quantity).quantize(Decimal("0.000001"))
                    if parent.cogs and parent.quantity else Decimal("0")
                )
            else:
                unit_cost = row.get("component_unit_cost") or Decimal("0")
            add_stock_fifo(
                product_id     = row["product_id"],
                location_id    = sale.location_id,
                quantity       = qty,
                unit_cost      = unit_cost,
                reference_type = "void",
                reference_id   = sale.id,
            )

        # ── Reverse PaymentAccount ledger rows ───────────────────────────
        # Every SalePayment that was linked to a PaymentAccount in the
        # POS flow (express Cash + Multiple Pay) wrote a +amount SALE
        # transaction on that account. Mirror each with a -amount
        # ADJUSTMENT so the account balance returns to its pre-sale state.
        try:
            from accounting.models import PaymentAccountTransaction  # noqa: PLC0415
            for sp in sale.sale_payments.all():
                if not sp.payment_account_id:
                    continue
                PaymentAccountTransaction.objects.create(
                    account_id  = sp.payment_account_id,
                    kind        = PaymentAccountTransaction.Kind.ADJUSTMENT,
                    amount      = -Decimal(str(sp.amount or 0)),
                    reference   = sp.reference or "",
                    note        = (
                        f"Reversal of sale payment "
                        f"(invoice {sale.invoice_number or sale.id})"
                    ),
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "Failed to reverse PaymentAccount ledger for sale %s: %s",
                sale.id, exc,
            )
            raise SalesServiceError(
                f"Could not reverse payment-account balance: {exc}"
            ) from exc

        sale.status = Sale.Status.VOIDED
        sale.save(update_fields=["status", "updated_at"])

        # ── Accounting: reversal entries ───────────────────────────────────────
        try:
            from accounting.services import post_void_entry  # noqa: PLC0415
            post_void_entry(sale=sale, voided_by_id=voided_by_id)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Accounting reversal failed for voided sale %s: %s — rolling back.",
                sale.id, exc,
            )
            raise SalesServiceError(
                f"Accounting error during void: {exc}"
            ) from exc

        logger.info("Sale voided: id=%s  by=%s", sale.id, voided_by_id)
        return sale


def delete_sale(*, sale_id, deleted_by_id) -> None:
    """Hard-delete a sale, fully reversing every side-effect first so the
    row disappears from All Sales (not just flipped to VOIDED) while stock,
    cash-account balances and the books stay consistent.

    • DRAFT / QUOTATION / PROFORMA — never touched stock or cash, so they
      go straight to delete with nothing to reverse.
    • FINAL — routed through void_sale() which returns FIFO stock, posts the
      reversing PaymentAccount adjustments and the accounting reversal
      entry (all inside one atomic block); then the row itself is removed.
    • VOIDED — already reversed, so just remove the row.

    Deleting the Sale cascades its SaleItem / SalePayment children. The
    StockMovement audit rows and PaymentAccountTransaction adjustments left
    behind net to zero against the originals, so balances are untouched.
    """
    with transaction.atomic(using=_current_db()):
        try:
            sale = Sale.objects.get(id=sale_id)
        except Sale.DoesNotExist:
            raise SalesServiceError(f"Sale {sale_id} not found.")

        if sale.status == Sale.Status.FINAL:
            # Reverse stock + cash + accounting, then fall through to delete.
            void_sale(sale_id=sale.id, voided_by_id=deleted_by_id)

        deleted_count, _ = Sale.objects.filter(id=sale_id).delete()
        logger.info("Sale deleted: id=%s  by=%s  rows=%s",
                    sale_id, deleted_by_id, deleted_count)


# ──────────────────────────────────────────────────────────────────────────────
# 6. create_backorder
# ──────────────────────────────────────────────────────────────────────────────

def create_backorder(
    *,
    sale_id,
    shortfalls: Optional[list[dict]] = None,
) -> list[BackOrder]:
    """
    Create BackOrder records for items that are short on stock.
    Transitions the sale → PENDING.

    Typically called immediately after catching BackOrderRequiredError from
    finalize_sale().  The `shortfalls` list from that error is passed directly.
    If shortfalls is None, the function re-checks stock itself.

    Returns the list of created BackOrder objects.
    """
    with transaction.atomic(using=_current_db()):
        try:
            sale = Sale.objects.select_for_update().get(id=sale_id)
        except Sale.DoesNotExist:
            raise SalesServiceError(f"Sale {sale_id} not found.")

        if sale.status not in (Sale.Status.DRAFT, Sale.Status.PROFORMA, Sale.Status.QUOTATION):
            raise SalesServiceError(
                f"Back-orders can only be created for DRAFT, PROFORMA or QUOTATION sales "
                f"(current status: {sale.status})."
            )

        # If shortfalls not provided, re-derive from current stock
        if shortfalls is None:
            items = list(sale.items.select_related("product").all())
            shortfalls = _check_stock_availability(items, sale.location_id)

        if not shortfalls:
            raise SalesServiceError(
                "No stock shortfalls detected — back-order is not needed."
            )

        created = BackOrder.objects.bulk_create([
            BackOrder(
                sale_id       = sale.id,
                product_id    = sf["product_id"],
                location_id   = sale.location_id,
                requested_qty = sf["requested"],
                available_qty = sf["available"],
                shortfall_qty = sf["shortfall"],
            )
            for sf in shortfalls
        ])

        sale.status = Sale.Status.PENDING
        sale.save(update_fields=["status", "updated_at"])

        logger.info(
            "Back-order created: sale=%s  shortfall_items=%d",
            sale_id, len(created),
        )
        return created


# ──────────────────────────────────────────────────────────────────────────────
# 7. mark_backorder_fulfilled
# ──────────────────────────────────────────────────────────────────────────────

def mark_backorder_fulfilled(*, backorder_id) -> BackOrder:
    """
    Mark a single BackOrder row as FULFILLED.

    If ALL BackOrder rows for the parent sale are now FULFILLED,
    the sale transitions back to DRAFT (ready to finalize).

    Called by the Purchase Order receipt flow (future module).
    """
    with transaction.atomic(using=_current_db()):
        try:
            bo = BackOrder.objects.select_for_update().get(id=backorder_id)
        except BackOrder.DoesNotExist:
            raise SalesServiceError(f"BackOrder {backorder_id} not found.")

        if bo.status == BackOrder.Status.FULFILLED:
            raise SalesServiceError("BackOrder is already fulfilled.")

        bo.mark_fulfilled()

        # Check if all sibling backorders are resolved
        pending_count = (
            BackOrder.objects
            .filter(sale_id=bo.sale_id, status=BackOrder.Status.OPEN)
            .count()
        )
        if pending_count == 0:
            Sale.objects.filter(id=bo.sale_id).update(
                status     = Sale.Status.DRAFT,
                updated_at = timezone.now(),
            )
            logger.info(
                "All back-orders fulfilled for sale=%s — sale back to DRAFT.",
                bo.sale_id,
            )

        return bo


# ──────────────────────────────────────────────────────────────────────────────
# 8. Read helpers
# ──────────────────────────────────────────────────────────────────────────────

def get_sale_detail(*, sale_id) -> Sale:
    """Return a sale with all related data pre-fetched.

    Accepts either:
      • a UUID  → looks up by Sale.id
      • a string starting with 'INV-' (or anything that's not a valid
        UUID) → looks up by Sale.invoice_number, case-insensitive

    The frontend uses the human-readable invoice number in the URL
    (/sales/INV-ONG-06062026-001) so an operator can copy/paste it.
    """
    import uuid as _uuid

    qs = (
        Sale.objects
        .prefetch_related(
            "items__product",
            "sale_payments",
            "backorders__product",
        )
        .select_related("customer", "location")
    )

    # Try UUID first; fall back to invoice_number.
    try:
        _uuid.UUID(str(sale_id))
        lookup_q = {"id": sale_id}
    except (ValueError, AttributeError, TypeError):
        lookup_q = {"invoice_number__iexact": str(sale_id)}

    try:
        return qs.get(**lookup_q)
    except Sale.DoesNotExist:
        raise SalesServiceError(f"Sale {sale_id} not found.")


def create_sale_advanced(
    *,
    location_id,
    items: list[dict],
    created_by_id,
    customer_id=None,
    pay_term_days: int = 0,
    pay_term_value=None,
    pay_term_period: str = "",
    sale_date=None,
    status: str = Sale.Status.DRAFT,
    invoice_no: Optional[str] = None,
    invoice_scheme: str = "",
    service_staff: str = "",
    table_ref: str = "",
    source: str = "POS",
    attach_document_name: str = "",
    sell_note: str = "",
    staff_note: str = "",
    discount_type: str = "FIXED",
    discount_value: Decimal = Decimal("0"),
    order_tax: Decimal = Decimal("0"),
    shipping_details: str = "",
    shipping_address: str = "",
    shipping_charges: Decimal = Decimal("0"),
    shipping_status: str = "",
    delivered_to: str = "",
    shipping_documents: Optional[list] = None,
    additional_expenses: Optional[list] = None,
    payment: Optional[dict] = None,
    notes: str = "",
    supervisor_password: Optional[str] = None,
) -> Sale:
    """
    Create a full-featured sale from the Add Sale screen.
    Supports DRAFT and FINAL in one endpoint, with optional immediate payment.
    """
    discount_value = Decimal(str(discount_value or 0))
    order_tax = Decimal(str(order_tax or 0))
    shipping_charges = Decimal(str(shipping_charges or 0))
    expenses = additional_expenses or []
    extra_total = sum(Decimal(str(e.get("amount", 0))) for e in expenses)
    # JSONField cannot store Decimal directly; normalize to primitives.
    normalized_expenses = [
        {
            "name": str(e.get("name", "")).strip(),
            "amount": str(Decimal(str(e.get("amount", 0))).quantize(Decimal("0.01"))),
        }
        for e in expenses
    ]

    # Build discount amount
    validated_items = _validate_and_build_items(items)
    subtotal = sum(
        (Decimal(str(i["unit_price"])) - Decimal(str(i.get("item_discount", 0))))
        * Decimal(str(i["quantity"]))
        for i in validated_items
    ).quantize(Decimal("0.01"))
    if str(discount_type).upper() == "PERCENTAGE":
        header_discount = (subtotal * discount_value / Decimal("100")).quantize(Decimal("0.01"))
    else:
        header_discount = discount_value.quantize(Decimal("0.01"))

    sale = create_sale(
        location_id=location_id,
        items=validated_items,
        created_by_id=created_by_id,
        status=Sale.Status.DRAFT,
        customer_id=customer_id,
        discount=header_discount,
        tax_rate=order_tax,
        notes=notes,
        supervisor_password=supervisor_password,
    )

    # Apply shipping/extra totals on header
    total_addons = (shipping_charges + extra_total).quantize(Decimal("0.01"))
    if total_addons > 0:
        sale.total_amount = (sale.total_amount + total_addons).quantize(Decimal("0.01"))
        sale.balance_due = (sale.balance_due + total_addons).quantize(Decimal("0.01"))

    # Persist the raw value + unit, and derive the flattened day count from
    # them when the caller didn't send one (months → ×30).
    pt_days = max(int(pay_term_days or 0), 0)
    if not pt_days and pay_term_value:
        pt_days = int(pay_term_value) * (30 if pay_term_period == "months" else 1)
    sale.pay_term_days = pt_days
    sale.pay_term_value = int(pay_term_value) if pay_term_value else None
    sale.pay_term_period = pay_term_period or ""
    sale.shipping_charges = shipping_charges
    sale.extra_charges = extra_total
    sale.sale_date = sale_date or timezone.now()

    # Service-staff attribution rule: only the tenant OWNER may attribute a
    # sale to an arbitrary team member. Every sub-user (admin / manager /
    # cashier) is locked to themselves — whatever id the client sends is
    # overridden with their own user id. Mirrors the frontend lock and
    # closes the door on a crafted request. Role comes from the DB.
    from accounts.models import User as _User  # noqa: PLC0415 — master-DB model
    _actor = _User.objects.using("default").filter(id=created_by_id).first()
    if _actor is not None and _actor.role != _User.Role.OWNER:
        service_staff = str(created_by_id)

    sale.meta = {
        "invoice_scheme": invoice_scheme,
        "service_staff": service_staff,
        "table_ref": table_ref,
        "source": source,
        "attach_document_name": attach_document_name,
        "sell_note": sell_note,
        "staff_note": staff_note,
        "shipping_details": shipping_details,
        "shipping_address": shipping_address,
        "shipping_status": shipping_status,
        "delivered_to": delivered_to,
        "shipping_documents": shipping_documents or [],
        "additional_expenses": normalized_expenses,
    }
    # Apply the requested non-FINAL status. create_sale() always makes
    # a DRAFT first; without this a QUOTATION/PROFORMA save stayed a
    # DRAFT and leaked onto the Drafts + Sales-List-POS pages instead
    # of the Quotation list. We also auto-generate an invoice number
    # for quotations when the operator left it blank (so the List
    # Quotation page shows a real reference, not '—').
    save_fields = [
        "total_amount", "balance_due", "pay_term_days",
        "pay_term_value", "pay_term_period", "shipping_charges",
        "extra_charges", "sale_date", "meta", "updated_at",
    ]
    if status in (Sale.Status.QUOTATION, Sale.Status.PROFORMA) and status != sale.status:
        sale.status = status
        save_fields.append("status")
        if not invoice_no and not sale.invoice_number:
            gen = _generate_invoice_number(location=sale.location)
            if not Sale.objects.filter(invoice_number=gen).exclude(id=sale.id).exists():
                sale.invoice_number = gen
                save_fields.append("invoice_number")
        elif invoice_no and not sale.invoice_number:
            if Sale.objects.filter(invoice_number=invoice_no).exclude(id=sale.id).exists():
                raise SalesServiceError("Invoice No already exists.")
            sale.invoice_number = invoice_no
            save_fields.append("invoice_number")

    sale.save(update_fields=save_fields)

    # Finalize if requested
    if status == Sale.Status.FINAL:
        try:
            sale = finalize_sale(sale_id=sale.id, finalized_by_id=created_by_id)
            if invoice_no:
                if Sale.objects.filter(invoice_number=invoice_no).exclude(id=sale.id).exists():
                    raise SalesServiceError("Invoice No already exists.")
                sale.invoice_number = invoice_no
                sale.save(update_fields=["invoice_number", "updated_at"])
        except BackOrderRequiredError as exc:
            # Auto-convert to PENDING via backorder records for better UX.
            create_backorder(sale_id=sale.id, shortfalls=exc.shortfalls)
            exc.sale_id = str(sale.id)
            exc.backorder_created = True
            raise

    # Optional immediate payment
    if payment:
        pay_amount = Decimal(str(payment.get("amount", 0)))
        if pay_amount > 0:
            if sale.status != Sale.Status.FINAL:
                try:
                    sale = finalize_sale(sale_id=sale.id, finalized_by_id=created_by_id)
                except BackOrderRequiredError as exc:
                    create_backorder(sale_id=sale.id, shortfalls=exc.shortfalls)
                    exc.sale_id = str(sale.id)
                    exc.backorder_created = True
                    raise
            # Reference falls back through the method-specific extras
            # (card_transaction_no for CARD, bank_account_no for
            # BANK_TRANSFER) so the recorded payment carries something
            # auditable into the Account Book row.
            reference = (
                payment.get("reference")
                or payment.get("card_transaction_no")
                or payment.get("bank_account_no")
                or payment.get("payment_account")
                or ""
            )
            # payment_account_id is the FK to the tenant's PaymentAccount.
            # Without it the entry would post to the default cash ledger,
            # not the specific bank / mobile-wallet account the cashier
            # picked on the Add Sale page.
            pa_id = payment.get("payment_account_id") or None
            if not pa_id:
                # Legacy clients may still send `payment_account` as the
                # selected ID (the new frontend already populates it
                # from payment_account_id, but be defensive).
                legacy = payment.get("payment_account") or ""
                if legacy and isinstance(legacy, str) and len(legacy) >= 8:
                    pa_id = legacy
            add_payment(
                sale_id            = sale.id,
                amount             = pay_amount,
                method             = payment["method"],
                received_by_id     = created_by_id,
                payment_account_id = pa_id,
                reference          = reference,
                notes              = payment.get("note", ""),
            )
            sale.refresh_from_db()

    return sale


# ──────────────────────────────────────────────────────────────────────────────
# Sell Return — Phase B (MVP): header + items only.
# Stock put-back and reversal journal entry are deferred to Phase 2.
# ──────────────────────────────────────────────────────────────────────────────

def _next_credit_note_number(db: str) -> str:
    """CRN-YYYYMM-NNNN, scoped to the tenant DB and current month."""
    today = timezone.now()
    prefix = f"CRN-{today:%Y%m}-"
    last = (
        SellReturn.objects.using(db)
        .filter(invoice_number__startswith=prefix)
        .order_by("-invoice_number")
        .first()
    )
    if last:
        try:
            seq = int(last.invoice_number.rsplit("-", 1)[1]) + 1
        except (IndexError, ValueError):
            seq = 1
    else:
        seq = 1
    return f"{prefix}{seq:04d}"


def create_sell_return(
    *,
    parent_sale_id,
    location_id,
    items: list,
    return_date=None,
    refund_method: str = "",
    refunded_amount=Decimal("0"),
    payment_account_id=None,
    restocking_fee=Decimal("0"),
    notes: str = "",
    created_by_id,
) -> SellReturn:
    """
    Create a sell return (credit note) against an existing sale.

    items = [{"product_id": uuid, "quantity": Decimal, "unit_price": Decimal,
              "reason": str (optional)}, ...]

    Phase 2 scope:
      - Persist header + line items
      - Generate CRN invoice number
      - Compute totals + payment_status from refunded_amount vs total
      - Put stock back via FIFO (add_stock_fifo) at the original COGS unit_cost
      - Post reversal journal entry (revenue reversal, inventory restoration,
        optional cash refund) via accounting.services.post_return_entry.
    """
    from inventory.services import add_stock_fifo  # noqa: PLC0415

    if not items:
        raise SalesServiceError("At least one return item is required.")

    db = _current_db()

    try:
        parent = Sale.objects.using(db).get(pk=parent_sale_id)
    except Sale.DoesNotExist:
        raise SalesServiceError(f"Parent sale {parent_sale_id} not found.")
    try:
        location = Location.objects.using(db).get(pk=location_id)
    except Location.DoesNotExist:
        raise SalesServiceError(f"Location {location_id} not found.")

    if parent.status != Sale.Status.FINAL:
        raise SalesServiceError(
            f"Returns can only be created against FINAL sales (current: {parent.status})."
        )

    # Aggregate parent-sale items by product so we can derive the unit cost
    # for the returned quantity (proportional FIFO put-back at original cost).
    parent_items_by_product: dict = {}
    for pi in parent.items.all():
        agg = parent_items_by_product.setdefault(
            str(pi.product_id), {"qty": Decimal("0"), "cogs": Decimal("0")},
        )
        agg["qty"] += Decimal(pi.quantity or 0)
        agg["cogs"] += Decimal(pi.cogs or 0)

    refunded = Decimal(refunded_amount or 0)
    fee = Decimal(restocking_fee or 0)

    with transaction.atomic(using=db):
        invoice_no = _next_credit_note_number(db)

        ret = SellReturn(
            parent_sale=parent,
            customer=parent.customer,
            location=location,
            invoice_number=invoice_no,
            return_date=return_date or timezone.now().date(),
            refund_method=refund_method or "",
            restocking_fee=fee,
            refunded_amount=refunded,
            notes=notes or "",
            created_by_id=created_by_id,
        )
        ret.save(using=db)

        gross = Decimal("0")
        total_return_cogs = Decimal("0")

        for it in items:
            qty = Decimal(str(it["quantity"]))
            price = Decimal(str(it["unit_price"]))
            line_total = (qty * price).quantize(Decimal("0.01"))
            gross += line_total
            try:
                product = Product.objects.using(db).get(pk=it["product_id"])
            except Product.DoesNotExist:
                raise SalesServiceError(
                    f"Product {it.get('product_id')} not found in inventory."
                )

            agg = parent_items_by_product.get(str(product.id))
            if not agg or agg["qty"] <= 0:
                raise SalesServiceError(
                    f"Product {product.name} was not part of the original sale."
                )
            if qty > agg["qty"]:
                raise SalesServiceError(
                    f"Cannot return {qty} of {product.name}; only {agg['qty']} were sold."
                )

            unit_cost = (
                (agg["cogs"] / agg["qty"]).quantize(Decimal("0.000001"))
                if agg["cogs"] else Decimal("0")
            )
            line_cogs = (qty * unit_cost).quantize(Decimal("0.01"))
            total_return_cogs += line_cogs

            SellReturnItem(
                sell_return=ret,
                product=product,
                quantity=qty,
                unit_price=price,
                line_total=line_total,
                reason=(it.get("reason") or "")[:30],
            ).save(using=db)

            # Put stock back via FIFO at original unit cost. Surface
            # inventory failures as a clean SalesServiceError so the
            # operator sees the real reason instead of a generic 500.
            try:
                add_stock_fifo(
                    product_id     = product.id,
                    location_id    = location.id,
                    quantity       = qty,
                    unit_cost      = unit_cost,
                    reference_type = "sell_return",
                    reference_id   = ret.id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "add_stock_fifo failed during sell return %s: %s", ret.id, exc,
                )
                raise SalesServiceError(
                    f"Inventory restock failed for {product.name}: {exc}"
                )

        net_owed = (gross - fee).quantize(Decimal("0.01"))
        ret.total_amount = gross
        ret.amount_paid = refunded
        ret.balance_due = (net_owed - refunded).quantize(Decimal("0.01"))

        if refunded <= 0:
            ret.payment_status = Sale.PaymentStatus.DUE
        elif refunded >= net_owed:
            ret.payment_status = Sale.PaymentStatus.PAID
        else:
            ret.payment_status = Sale.PaymentStatus.PARTIAL

        ret.save(
            using=db,
            update_fields=["total_amount", "amount_paid", "balance_due", "payment_status"],
        )

        # ── Accounting: reversal entries ──────────────────────────────────────
        try:
            from accounting.services import post_return_entry  # noqa: PLC0415
            post_return_entry(
                sell_return        = ret,
                total_return_cogs  = total_return_cogs,
                refunded_amount    = refunded,
                # Forward the cashier's choice so the refund credits
                # the specific chart-of-accounts sub-ledger.
                payment_account_id = payment_account_id,
                created_by_id      = created_by_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Accounting reversal failed for sell return %s: %s — rolling back.",
                ret.id, exc,
            )
            raise SalesServiceError(f"Accounting error during return: {exc}")

        # ── User-facing PaymentAccount balance ───────────────────────────────
        # The List Accounts page reads its balance from
        # PaymentAccountTransaction rows (NOT from the chart-of-accounts
        # journal). The original sale created a +amount row on the
        # chosen PaymentAccount; without a matching -amount row here
        # the City Bank balance stayed the same after a refund — the
        # exact bug the cashier reported.
        if refunded > Decimal("0") and payment_account_id:
            try:
                from accounting.models import (  # noqa: PLC0415
                    PaymentAccount, PaymentAccountTransaction,
                )
                pa = (
                    PaymentAccount.objects.using(db)
                    .filter(id=payment_account_id, is_active=True)
                    .first()
                )
                if pa is not None:
                    PaymentAccountTransaction.objects.using(db).create(
                        account     = pa,
                        kind        = PaymentAccountTransaction.Kind.ADJUSTMENT,
                        amount      = -refunded,   # negative = money OUT
                        reference   = ret.invoice_number or "",
                        note        = f"Sell return refund (CN {ret.invoice_number})",
                    )
                else:
                    logger.warning(
                        "Sell return %s refunded against missing/inactive "
                        "PaymentAccount %s — balance not decremented.",
                        ret.id, payment_account_id,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "Failed to write PaymentAccountTransaction for return %s: %s",
                    ret.id, exc,
                )
                # Don't bubble up — the return itself is valid; the
                # admin can repair the balance manually if needed.

    return ret

