"""
Per-import-type validation logic.

Design
──────
• Each validator receives the raw parsed rows (list of dicts) and the
  current DB alias (tenant database).
• Validation runs in memory — NO DB writes.
• FK existence checks hit the tenant DB read-only.
• Returns (valid_rows: list[dict], errors: list[dict])
  - valid_rows: cleaned / coerced dicts ready for commit
  - errors: [{row: int, field: str, message: str}, ...]

Row numbering starts at 2 (row 1 = header) to match Excel row numbers.
"""

import logging
from decimal import Decimal, InvalidOperation
from datetime import date, datetime
from typing import Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Helper coercions
# ──────────────────────────────────────────────────────────────────────────────

def _to_decimal(value: str, field: str, row: int, errors: list, *,
                min_value: Optional[Decimal] = None) -> Optional[Decimal]:
    """Coerce string to Decimal; append to errors on failure."""
    v = value.strip()
    if not v:
        errors.append({"row": row, "field": field, "message": "This field is required."})
        return None
    try:
        d = Decimal(v)
    except InvalidOperation:
        errors.append({"row": row, "field": field,
                        "message": f"'{v}' is not a valid number."})
        return None
    if min_value is not None and d < min_value:
        errors.append({"row": row, "field": field,
                        "message": f"Value must be >= {min_value}. Got {d}."})
        return None
    return d


def _to_date(value: str, field: str, row: int, errors: list) -> Optional[date]:
    """Coerce string to date using common formats; append to errors on failure."""
    v = value.strip()
    if not v:
        errors.append({"row": row, "field": field, "message": "This field is required."})
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    errors.append({"row": row, "field": field,
                    "message": f"'{v}' is not a recognised date. Use YYYY-MM-DD."})
    return None


def _require_str(value: str, field: str, row: int, errors: list,
                 max_length: int = 200) -> Optional[str]:
    v = value.strip()
    if not v:
        errors.append({"row": row, "field": field, "message": "This field is required."})
        return None
    if len(v) > max_length:
        errors.append({"row": row, "field": field,
                        "message": f"Max length is {max_length}. Got {len(v)} characters."})
        return None
    return v


# ──────────────────────────────────────────────────────────────────────────────
# Product import validator — column-mapper aware
# ──────────────────────────────────────────────────────────────────────────────
#
# The new pipeline:
#   1. caller (services.validate_import) builds a column mapping with
#      column_mapper.auto_map_headers (or accepts an operator-confirmed
#      mapping from the wizard step)
#   2. caller passes (our_field → source_header) mapping into this
#      validator's constructor along with the list of `extras_keys`
#      (source headers we couldn't classify — their cell values get
#      stashed into the row's `extras` JSON for later persistence)
#   3. value coercion uses imports.cleaners so the tenant's "৳ 1,500.00"
#      / "4.00 Pc(s)" / "--" cell values become clean Decimal / Unit /
#      None values instead of falling out as "not a valid number"
#
# The old code's required-columns idea is gone. If a field has no source
# header AND no default, we report the field as missing ONCE at the top
# of the batch (not per-row), so the operator sees a clear "you need to
# map Product Name to a column" message instead of 156 identical errors.

from .cleaners import (
    clean_currency, clean_qty_with_unit, clean_text,
    is_null, looks_like_total_row,
)


# Fields that MUST be mapped (or have a sensible per-row default) for the
# import to even start.
PRODUCT_REQUIRED_FIELDS = ("name",)

# Fields with sensible defaults — we don't error if they're unmapped.
PRODUCT_DEFAULTS = {
    "sku":            None,           # auto-generated on commit if missing
    "unit_cost":      Decimal("0"),   # derived from stock_value/qty if possible, else 0
    "selling_price":  Decimal("0"),
    "opening_qty":    Decimal("0"),
    "reorder_level":  Decimal("0"),
    "warranty_days":  0,
    "stock_date":     date.today,     # today if not supplied
    "barcode":        None,
    "notes":          "",
    "unit":           "Pc",           # default unit auto-created on commit
    "category":       None,
    "brand":          None,
    "location":       None,
}


class ProductImportValidator:
    """Validate rows for the PRODUCT import type.

    Constructor params:
      db_alias       — current tenant DB alias
      mapping        — {our_field: source_header_or_None} from column_mapper
      extras_keys    — list of source headers that didn't map (their
                       values get stored in row['extras'])
    """

    def __init__(self, db_alias: str, mapping: dict[str, str | None] | None = None,
                 extras_keys: list[str] | None = None):
        self._db          = db_alias
        self._mapping     = mapping or {}
        self._extras_keys = extras_keys or []
        self._seen_skus: set[str] = set()

    # ── Cell readers ─────────────────────────────────────────────────────────

    def _cell(self, raw_row: dict, our_field: str) -> str:
        """Return the raw string for `our_field` based on the mapping."""
        src = self._mapping.get(our_field)
        if src is None:
            return ""
        # Case-insensitive source-header lookup so Excel users mixing case
        # ('SKU' vs 'sku' vs 'Sku') all read correctly.
        if src in raw_row:
            v = raw_row[src]
        else:
            lower = src.lower()
            v = next((val for k, val in raw_row.items() if k.lower() == lower), "")
        return "" if v is None else (v if isinstance(v, str) else str(v))

    # ── FK helpers ───────────────────────────────────────────────────────────

    def _lookup_unit(self, name: str | None) -> tuple[str | None, bool]:
        """Return (unit_pk, was_created_marker). Auto-create if missing.

        was_created_marker is the unit name string — the commit step uses
        it to create the Unit row inside the same atomic block, just like
        the existing Brand auto-creation pattern.
        """
        if not name:
            name = PRODUCT_DEFAULTS["unit"]
        from inventory.models import Unit
        existing = Unit.objects.using(self._db).filter(name__iexact=name).first()
        if existing:
            return str(existing.pk), False
        return None, name   # second tuple member acts as "create me on commit"

    def _lookup_category(self, name: str | None) -> tuple[str | None, str | None]:
        if not name:
            return None, None
        from inventory.models import Category
        existing = Category.objects.using(self._db).filter(name__iexact=name).first()
        if existing:
            return str(existing.pk), None
        return None, name

    def _lookup_brand(self, name: str | None) -> tuple[str | None, str | None]:
        if not name:
            return None, None
        from inventory.models import Brand
        existing = Brand.objects.using(self._db).filter(name__iexact=name).first()
        if existing:
            return str(existing.pk), None
        return None, name

    def _lookup_location(self, name: str | None) -> tuple[str | None, str | None]:
        if not name:
            return None, None
        from inventory.models import Location
        existing = Location.objects.using(self._db).filter(name__iexact=name).first()
        if existing:
            return str(existing.pk), None
        return None, name

    def _check_sku_unique(self, sku: str, row: int, errors: list) -> bool:
        if sku in self._seen_skus:
            errors.append({"row": row, "field": "SKU",
                           "message": f"SKU '{sku}' appears more than once in this file."})
            return False
        self._seen_skus.add(sku)
        from inventory.models import Product
        if Product.all_objects.using(self._db).filter(sku__iexact=sku).exists():
            errors.append({"row": row, "field": "SKU",
                           "message": f"SKU '{sku}' already exists in this store."})
            return False
        return True

    # ── Main entry point ─────────────────────────────────────────────────────

    def validate(self, raw_rows: list[dict]) -> tuple[list[dict], list[dict]]:
        valid_rows: list[dict] = []
        all_errors: list[dict] = []

        # Pre-flight: did the caller map every required field?
        for required in PRODUCT_REQUIRED_FIELDS:
            if not self._mapping.get(required):
                all_errors.append({
                    "row":   1,
                    "field": required,
                    "message": (
                        f"No column in your file maps to '{required}'. "
                        f"Please add one or use the column-mapping step to point "
                        f"an existing column to this field."
                    ),
                })

        for idx, raw in enumerate(raw_rows):
            row_num = idx + 2
            if looks_like_total_row(raw):
                continue  # skip 'Total:' summary rows silently

            row_errors: list[dict] = []

            # ── Name (required) ──────────────────────────────────────────────
            name = clean_text(self._cell(raw, "name"), max_length=200)
            if not name:
                row_errors.append({"row": row_num, "field": "name",
                                   "message": "Product name is required."})

            # ── Numerics (default 0 if missing / unparseable) ────────────────
            unit_cost     = clean_currency(self._cell(raw, "unit_cost"))     or Decimal("0")
            selling_price = clean_currency(self._cell(raw, "selling_price")) or Decimal("0")
            qty, unit_from_qty = clean_qty_with_unit(self._cell(raw, "opening_qty"))
            opening_qty   = qty if qty is not None else Decimal("0")
            reorder_level = clean_currency(self._cell(raw, "reorder_level")) or Decimal("0")

            # Derive unit_cost from "stock value / qty" when both are present
            # but unit_cost itself is unmapped or zero — this is how the Ongko
            # Stationery file (and similar reports) effectively carries cost.
            # We look for an extras column whose normalised name contains both
            # "stock value" and "purchase" (or "cost"), e.g.
            #   "Current Stock Value (By purchase price)"
            if unit_cost == 0 and opening_qty > 0:
                sv = clean_currency(self._extras_value(raw, "stock value", "purchase"))
                if not sv:
                    sv = clean_currency(self._extras_value(raw, "stock value", "cost"))
                if sv and sv > 0:
                    unit_cost = sv / opening_qty

            # ── Stock date (default = today) ────────────────────────────────
            raw_date = clean_text(self._cell(raw, "stock_date"))
            stock_date = None
            if raw_date:
                stock_date = _try_parse_date(raw_date)
                if stock_date is None:
                    row_errors.append({"row": row_num, "field": "stock_date",
                                       "message": f"'{raw_date}' is not a recognised date. Use YYYY-MM-DD."})
            if stock_date is None and not row_errors:
                stock_date = date.today()

            # ── Warranty days (default 0) ───────────────────────────────────
            warranty_raw = clean_text(self._cell(raw, "warranty_days")) or "0"
            try:
                warranty_days = max(0, int(Decimal(warranty_raw.replace(",", ""))))
            except (InvalidOperation, ValueError):
                warranty_days = 0  # tolerate junk; don't fail the row

            # ── SKU (auto-generated if blank) ───────────────────────────────
            sku_raw = clean_text(self._cell(raw, "sku")) or ""
            if sku_raw and not self._check_sku_unique(sku_raw, row_num, row_errors):
                pass  # error already appended

            # ── FK lookups (each may flag "create me on commit") ────────────
            unit_name_cell = clean_text(self._cell(raw, "unit"))
            unit_name = unit_name_cell or unit_from_qty or PRODUCT_DEFAULTS["unit"]
            unit_pk, unit_create = self._lookup_unit(unit_name)

            cat_name      = clean_text(self._cell(raw, "category"))
            cat_pk, cat_create = self._lookup_category(cat_name)

            brand_name    = clean_text(self._cell(raw, "brand"))
            brand_pk, brand_create = self._lookup_brand(brand_name)

            loc_name      = clean_text(self._cell(raw, "location"))
            loc_pk, loc_create = self._lookup_location(loc_name)

            # ── Extras: stash every unrecognised column for this row ────────
            extras: dict[str, str] = {}
            for src in self._extras_keys:
                v = raw.get(src) if src in raw else next(
                    (val for k, val in raw.items() if k.lower() == src.lower()), "",
                )
                if v is None: v = ""
                if not isinstance(v, str): v = str(v)
                v = v.strip()
                if v and not is_null(v):
                    extras[src] = v

            if row_errors:
                all_errors.extend(row_errors)
                continue

            valid_rows.append({
                "row":            row_num,
                "name":           name,
                "sku":            sku_raw or None,
                "barcode":        clean_text(self._cell(raw, "barcode")),
                "unit_pk":        unit_pk,
                "unit_create":    unit_create,
                "category_pk":    cat_pk,
                "category_create": cat_create,
                "brand_pk":       brand_pk,
                "brand_create":   brand_create,
                "location_pk":    loc_pk,
                "location_create": loc_create,
                "opening_qty":    str(opening_qty),
                "unit_cost":      str(unit_cost),
                "selling_price":  str(selling_price),
                "reorder_level":  str(reorder_level),
                "stock_date":     stock_date.isoformat(),
                "warranty_days":  warranty_days,
                "notes":          clean_text(self._cell(raw, "notes")) or "",
                "extras":         extras,
            })

        return valid_rows, all_errors

    # ── Helpers for the stock-value derivation path ─────────────────────────

    @property
    def _extras_keys_lower(self) -> list[str]:
        # Used by the derivation heuristic — case-insensitive
        return [k.lower() for k in self._extras_keys]

    def _extras_value(self, raw: dict, *needles: str) -> str:
        """Return the first extras-column value whose normalised name contains
        any needle. e.g. ("stock value", "purchase") matches
        'Current Stock Value (By purchase price)'.
        """
        from .column_mapper import normalize_header
        for src in self._extras_keys:
            norm = normalize_header(src)
            if all(n in norm for n in needles):
                if src in raw:
                    return raw[src] or ""
                lower = src.lower()
                for k, v in raw.items():
                    if k.lower() == lower:
                        return v or ""
        return ""


def _try_parse_date(v: str):
    """Lift from _to_date but return None instead of appending an error."""
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Expense import validator
# ──────────────────────────────────────────────────────────────────────────────
# Required columns: Date, Category, Payment Account, Amount
# Optional: Note

EXPENSE_CATEGORIES = {c.lower() for c in
    ["RENT", "UTILITIES", "SALARIES", "MARKETING", "SUPPLIES", "TRANSPORT", "OTHER"]}


class ExpenseImportValidator:
    """Validate rows for the EXPENSE import type."""

    def __init__(self, db_alias: str):
        self._db = db_alias

    def _normalize_headers(self, row: dict) -> dict:
        return {k.lower().strip(): v for k, v in row.items()}

    def _lookup_account(self, name_or_code: str, field: str, row: int, errors: list):
        """Find Account by code or name."""
        from accounting.models import Account
        qs = Account.objects.using(self._db)
        obj = (qs.filter(code__iexact=name_or_code.strip()).first() or
               qs.filter(name__iexact=name_or_code.strip()).first())
        if not obj:
            errors.append({"row": row, "field": field,
                            "message": f"Account '{name_or_code}' not found. "
                                        "Use the account code (e.g. 1001) or exact name."})
            return None
        return obj

    def validate(self, raw_rows: list[dict]) -> tuple[list[dict], list[dict]]:
        valid_rows: list[dict] = []
        all_errors: list[dict] = []

        for idx, raw in enumerate(raw_rows):
            row_num = idx + 2
            n = self._normalize_headers(raw)
            row_errors: list[dict] = []

            expense_date = _to_date(n.get("date", ""), "Date", row_num, row_errors)
            amount = _to_decimal(n.get("amount", ""), "Amount", row_num, row_errors,
                                 min_value=Decimal("0.01"))
            category_raw = (n.get("category", "") or "").strip().upper()
            payment_raw = n.get("payment account", "").strip()
            note = n.get("note", "").strip()

            if not category_raw:
                row_errors.append({"row": row_num, "field": "Category",
                                   "message": "Category is required."})
            elif category_raw not in {c.upper() for c in EXPENSE_CATEGORIES}:
                row_errors.append({"row": row_num, "field": "Category",
                                   "message": f"'{category_raw}' is not a valid category. "
                                               f"Choices: {', '.join(sorted(EXPENSE_CATEGORIES)).upper()}"})
                category_raw = None

            if not payment_raw:
                row_errors.append({"row": row_num, "field": "Payment Account",
                                   "message": "Payment Account is required."})

            # Expense account is derived from category:
            # RENT→6100, UTILITIES→6200, SALARIES→6300, MARKETING→6400,
            # SUPPLIES→6500, TRANSPORT→6600, OTHER→6900
            CATEGORY_ACCOUNT_MAP = {
                "RENT": "6100", "UTILITIES": "6200", "SALARIES": "6300",
                "MARKETING": "6400", "SUPPLIES": "6500", "TRANSPORT": "6600",
                "OTHER": "6900",
            }
            expense_account = payment_account = None
            if not row_errors:
                acct_code = CATEGORY_ACCOUNT_MAP.get(category_raw, "6900")
                expense_account = self._lookup_account(acct_code, "Category", row_num, row_errors)
                payment_account = self._lookup_account(payment_raw, "Payment Account", row_num, row_errors)

            if row_errors:
                all_errors.extend(row_errors)
                continue

            valid_rows.append({
                "row": row_num,
                "expense_date": expense_date.isoformat(),
                "category": category_raw,
                "expense_account_pk": str(expense_account.pk),
                "payment_account_pk": str(payment_account.pk),
                "amount": str(amount),
                "description": note,
            })

        return valid_rows, all_errors


# ──────────────────────────────────────────────────────────────────────────────
# Order import validator
# ──────────────────────────────────────────────────────────────────────────────
# Required columns: Date, Product SKU, Quantity, Price
# Optional: Customer Name, Payment Status (PAID|UNPAID|PARTIAL)

VALID_PAYMENT_STATUSES = {"PAID", "UNPAID", "PARTIAL"}


class OrderImportValidator:
    """Validate rows for the ORDER import type."""

    def __init__(self, db_alias: str):
        self._db = db_alias

    def _normalize_headers(self, row: dict) -> dict:
        return {k.lower().strip(): v for k, v in row.items()}

    def _lookup_product(self, sku: str, row: int, errors: list):
        from inventory.models import Product
        try:
            return Product.objects.using(self._db).get(sku__iexact=sku)
        except Product.DoesNotExist:
            errors.append({"row": row, "field": "Product SKU",
                            "message": f"Product with SKU '{sku}' not found."})
            return None

    def _lookup_or_create_customer(self, name: str):
        """Return customer name string; creation happens at commit time."""
        return name.strip() if name else None

    def validate(self, raw_rows: list[dict]) -> tuple[list[dict], list[dict]]:
        valid_rows: list[dict] = []
        all_errors: list[dict] = []

        for idx, raw in enumerate(raw_rows):
            row_num = idx + 2
            n = self._normalize_headers(raw)
            row_errors: list[dict] = []

            order_date = _to_date(n.get("date", ""), "Date", row_num, row_errors)
            sku = (n.get("product sku", "") or n.get("sku", "")).strip()
            quantity = _to_decimal(n.get("quantity", ""), "Quantity", row_num, row_errors,
                                   min_value=Decimal("0.0001"))
            price = _to_decimal(n.get("price", ""), "Price", row_num, row_errors,
                                min_value=Decimal("0"))
            payment_status_raw = (n.get("payment status", "PAID") or "PAID").strip().upper()
            customer_name = n.get("customer name", "").strip()
            notes = n.get("notes", "").strip()

            if not sku:
                row_errors.append({"row": row_num, "field": "Product SKU",
                                   "message": "Product SKU is required."})

            if payment_status_raw not in VALID_PAYMENT_STATUSES:
                row_errors.append({"row": row_num, "field": "Payment Status",
                                   "message": f"'{payment_status_raw}' is invalid. "
                                               f"Choose from: {', '.join(sorted(VALID_PAYMENT_STATUSES))}"})
                payment_status_raw = "PAID"

            product = None
            if sku and not row_errors:
                product = self._lookup_product(sku, row_num, row_errors)
                if product:
                    # Check sufficient stock
                    avail = product.total_stock
                    if quantity and avail < quantity:
                        row_errors.append({
                            "row": row_num,
                            "field": "Quantity",
                            "message": (
                                f"Insufficient stock for SKU '{sku}'. "
                                f"Available: {avail}, Requested: {quantity}."
                            ),
                        })

            if row_errors:
                all_errors.extend(row_errors)
                continue

            valid_rows.append({
                "row": row_num,
                "order_date": order_date.isoformat(),
                "product_pk": str(product.pk),
                "product_sku": sku,
                "quantity": str(quantity),
                "unit_price": str(price),
                "subtotal": str((quantity * price).quantize(Decimal("0.01"))),
                "payment_status": payment_status_raw,
                "customer_name": customer_name or None,
                "notes": notes,
            })

        return valid_rows, all_errors


# ──────────────────────────────────────────────────────────────────────────────
# Supplier import validator — column-mapper aware
# ──────────────────────────────────────────────────────────────────────────────
#
# Same shape as ProductImportValidator: takes a mapping + extras_keys
# computed by column_mapper, applies cleaners, and emits cleaned rows the
# commit step writes straight into purchases.Supplier. `name` is the only
# truly required field — everything else (phone, email, address, etc.) is
# optional because tenant-supplied lists vary wildly in completeness.

SUPPLIER_REQUIRED_FIELDS = ("name",)


class SupplierImportValidator:
    """Validate rows for the SUPPLIER import type."""

    def __init__(self, db_alias: str, mapping: dict[str, str | None] | None = None,
                 extras_keys: list[str] | None = None):
        self._db          = db_alias
        self._mapping     = mapping or {}
        self._extras_keys = extras_keys or []
        self._seen_names: set[str] = set()

    def _cell(self, raw_row: dict, our_field: str) -> str:
        src = self._mapping.get(our_field)
        if src is None:
            return ""
        if src in raw_row:
            v = raw_row[src]
        else:
            lower = src.lower()
            v = next((val for k, val in raw_row.items() if k.lower() == lower), "")
        return "" if v is None else (v if isinstance(v, str) else str(v))

    def validate(self, raw_rows: list[dict]) -> tuple[list[dict], list[dict]]:
        valid_rows: list[dict] = []
        all_errors: list[dict] = []

        # Pre-flight: name must be mapped — without it we can't create a row.
        for required in SUPPLIER_REQUIRED_FIELDS:
            if not self._mapping.get(required):
                all_errors.append({
                    "row":   1,
                    "field": required,
                    "message": (
                        f"No column in your file maps to '{required}'. "
                        f"Pick one in the column-mapping step."
                    ),
                })

        for idx, raw in enumerate(raw_rows):
            row_num = idx + 2
            if looks_like_total_row(raw):
                continue
            row_errors: list[dict] = []

            name = clean_text(self._cell(raw, "name"), max_length=200)
            if not name:
                row_errors.append({"row": row_num, "field": "name",
                                   "message": "Supplier name is required."})

            # Intra-file dupes by name (case-insensitive) — second occurrence wins
            # silently is bad UX, but failing the whole file is worse. Flag the
            # row so the operator can decide.
            key = (name or "").lower()
            if key in self._seen_names:
                row_errors.append({"row": row_num, "field": "name",
                                   "message": f"Supplier '{name}' appears twice in this file."})
            self._seen_names.add(key)

            phone   = clean_text(self._cell(raw, "phone"),   max_length=30)
            email   = clean_text(self._cell(raw, "email"),   max_length=254)
            contact = clean_text(self._cell(raw, "contact"), max_length=150)
            address = clean_text(self._cell(raw, "address"), max_length=1000)
            tax     = clean_text(self._cell(raw, "tax_number"), max_length=50)
            biz     = clean_text(self._cell(raw, "business_name"), max_length=200)
            notes   = clean_text(self._cell(raw, "notes"))

            # Pay term — value is numeric, period is text. Accept either alone.
            pay_term_value = None
            ptv_raw = clean_text(self._cell(raw, "pay_term_value"))
            if ptv_raw:
                try:
                    pay_term_value = max(0, int(Decimal(ptv_raw.replace(",", ""))))
                except (InvalidOperation, ValueError):
                    pay_term_value = None  # tolerate junk silently

            opening = clean_currency(self._cell(raw, "opening_balance")) or Decimal("0")

            # Extras — same pattern as Product
            extras: dict[str, str] = {}
            for src in self._extras_keys:
                v = raw.get(src) if src in raw else next(
                    (val for k, val in raw.items() if k.lower() == src.lower()), "",
                )
                if v is None: v = ""
                if not isinstance(v, str): v = str(v)
                v = v.strip()
                if v and not is_null(v):
                    extras[src] = v

            if row_errors:
                all_errors.extend(row_errors)
                continue

            valid_rows.append({
                "row":             row_num,
                "name":            name,
                "business_name":   biz or "",
                "contact":         contact or "",
                "email":           email or "",
                "phone":           phone or "",
                "address":         address or "",
                "tax_number":      tax or "",
                "pay_term_value":  pay_term_value,
                "opening_balance": str(opening),
                "notes":           notes or "",
                "extras":          extras,
            })

        return valid_rows, all_errors


# ──────────────────────────────────────────────────────────────────────────────
# Contact import validator — Customers (+ optional Supplier mirror)
# ──────────────────────────────────────────────────────────────────────────────
#
# Same shape as SupplierImportValidator: mapping + extras_keys from the
# column_mapper, cleaners for currency / null sentinels, per-row dedupe
# on first+last or business_name. Contact type can be "customer",
# "supplier", "both" or any of 1/2/3. When BOTH, _commit_contacts mirrors
# the customer record into the suppliers table (matched by phone).

CONTACT_REQUIRED_FIELDS = ()   # nothing strictly required at the file level —
                               # per-row rules handle individual vs business.


def _normalise_contact_type(raw: str) -> str:
    """Map a free-form cell into 'customer' | 'supplier' | 'both'.

    Accepts:
      1 / customer / customers / cust / c        → 'customer'
      2 / supplier / suppliers / vendor / s      → 'supplier'
      3 / both / customer & supplier / b         → 'both'
    Defaults to 'customer' for blanks / unknowns — the most common case.
    """
    v = (raw or "").strip().lower()
    if v in ("2", "supplier", "suppliers", "vendor", "vendors", "s"):
        return "supplier"
    if v in ("3", "both", "customer & supplier", "supplier & customer",
             "customer and supplier", "b"):
        return "both"
    return "customer"   # default


class ContactImportValidator:
    """Validate rows for the CONTACT import type."""

    def __init__(self, db_alias: str, mapping: dict[str, str | None] | None = None,
                 extras_keys: list[str] | None = None):
        self._db          = db_alias
        self._mapping     = mapping or {}
        self._extras_keys = extras_keys or []
        self._seen_keys: set[str] = set()

    def _cell(self, raw_row: dict, our_field: str) -> str:
        src = self._mapping.get(our_field)
        if src is None:
            return ""
        if src in raw_row:
            v = raw_row[src]
        else:
            lower = src.lower()
            v = next((val for k, val in raw_row.items() if k.lower() == lower), "")
        return "" if v is None else (v if isinstance(v, str) else str(v))

    def validate(self, raw_rows: list[dict]) -> tuple[list[dict], list[dict]]:
        valid_rows: list[dict] = []
        all_errors: list[dict] = []

        for idx, raw in enumerate(raw_rows):
            row_num = idx + 2
            if looks_like_total_row(raw):
                continue
            row_errors: list[dict] = []

            contact_type = _normalise_contact_type(self._cell(raw, "contact_type"))

            first = clean_text(self._cell(raw, "first_name"), max_length=100)
            middle = clean_text(self._cell(raw, "middle_name"), max_length=100)
            last  = clean_text(self._cell(raw, "last_name"),  max_length=100)
            business = clean_text(self._cell(raw, "business_name"), max_length=200)
            phone = clean_text(self._cell(raw, "phone"), max_length=30)

            # Either an individual (first + last) OR a business name is
            # required — same rule as the manual Add Contact form.
            is_individual = bool(first or last)
            if not is_individual and not business:
                row_errors.append({
                    "row": row_num, "field": "first_name",
                    "message": "Need either first + last name OR a business name.",
                })

            # Intra-file duplicate detection — same rule as the original
            # POST /api/sales/contacts/import/: name + phone.
            display = (
                " ".join(p for p in [first, middle, last] if p) if is_individual
                else business
            )
            dedup_key = f"{(display or '').lower()}|{(phone or '').lower()}"
            if dedup_key in self._seen_keys and dedup_key != "|":
                row_errors.append({
                    "row": row_num, "field": "name",
                    "message": f"'{display}' with phone '{phone}' appears more than once in this file.",
                })
            else:
                self._seen_keys.add(dedup_key)

            email = clean_text(self._cell(raw, "email"), max_length=254)
            alt_phone = clean_text(self._cell(raw, "alternate_phone"), max_length=30)
            landline = clean_text(self._cell(raw, "landline"), max_length=30)
            prefix = clean_text(self._cell(raw, "prefix"), max_length=10)
            address = clean_text(self._cell(raw, "address"), max_length=1000)
            address_line_2 = clean_text(self._cell(raw, "address_line_2"), max_length=255)
            city = clean_text(self._cell(raw, "city"), max_length=100)
            state = clean_text(self._cell(raw, "state"), max_length=100)
            country = clean_text(self._cell(raw, "country"), max_length=100)
            zip_code = clean_text(self._cell(raw, "zip_code"), max_length=20)
            tax = clean_text(self._cell(raw, "tax_number"), max_length=50)
            notes = clean_text(self._cell(raw, "notes"))

            # Pay term — numeric, gracefully tolerate junk.
            pay_term_value = None
            ptv_raw = clean_text(self._cell(raw, "pay_term_value"))
            if ptv_raw:
                try:
                    pay_term_value = max(0, int(Decimal(ptv_raw.replace(",", ""))))
                except (InvalidOperation, ValueError):
                    pay_term_value = None

            opening = clean_currency(self._cell(raw, "opening_balance")) or Decimal("0")
            credit  = clean_currency(self._cell(raw, "credit_limit"))   or Decimal("0")

            # Extras — anything the mapper didn't claim
            extras: dict[str, str] = {}
            for src in self._extras_keys:
                v = raw.get(src) if src in raw else next(
                    (val for k, val in raw.items() if k.lower() == src.lower()), "",
                )
                if v is None: v = ""
                if not isinstance(v, str): v = str(v)
                v = v.strip()
                if v and not is_null(v):
                    extras[src] = v

            if row_errors:
                all_errors.extend(row_errors)
                continue

            valid_rows.append({
                "row":             row_num,
                "contact_type":    contact_type,
                "is_individual":   is_individual,
                "prefix":          prefix or "",
                "first_name":      first or "",
                "middle_name":     middle or "",
                "last_name":       last or "",
                "business_name":   business or "",
                "email":           email or "",
                "phone":           phone or "",
                "alternate_phone": alt_phone or "",
                "landline":        landline or "",
                "address":         address or "",
                "address_line_2":  address_line_2 or "",
                "city":            city or "",
                "state":           state or "",
                "country":         country or "",
                "zip_code":        zip_code or "",
                "tax_number":      tax or "",
                "pay_term_value":  pay_term_value,
                "opening_balance": str(opening),
                "credit_limit":    str(credit),
                "notes":           notes or "",
                "extras":          extras,
            })

        return valid_rows, all_errors
