"""
Import orchestration services.

Public API
──────────
  validate_import(import_type, file, file_name, created_by_id) → ImportBatch
      Parse file, validate all rows, persist ImportBatch with results.
      NO writes to business tables.

  commit_import(batch_id, created_by_id) → dict
      Read validated_data from ImportBatch, write all business rows inside
      a single atomic transaction, mark batch COMMITTED.

Each import type's commit routine is in a private helper below.
"""

import logging
import uuid
from datetime import date
from decimal import Decimal
from typing import IO

from django.db import transaction
from django.utils import timezone

from accounts.tenant_db import get_current_db_alias
from .models import ImportBatch


def _current_db() -> str:
    """Return the active tenant DB alias, falling back to 'default'."""
    return get_current_db_alias() or "default"
from .parsers import parse_file
from .column_mapper import auto_map_headers, MappingResult
from .validators import (
    ProductImportValidator,
    ExpenseImportValidator,
    OrderImportValidator,
    SupplierImportValidator,
    ContactImportValidator,
)

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Step 1 — Validate
# ──────────────────────────────────────────────────────────────────────────────

def analyze_import(
    import_type: str,
    file: IO,
    file_name: str,
) -> dict:
    """
    Read just the header row + a sample of the data, run the column mapper,
    and return the suggested mapping + sample rows. No DB writes.

    Used by the frontend's "Map columns" wizard step BEFORE validation.
    The user can override any mapping; the chosen mapping is then sent
    back to /validate/ along with the file.
    """
    raw_rows = parse_file(file, file_name)
    headers  = list(raw_rows[0].keys()) if raw_rows else []
    mapping  = auto_map_headers(headers, import_type=import_type.upper())

    return {
        "headers":     headers,
        "row_count":   len(raw_rows),
        "sample_rows": raw_rows[:5],
        "mapping":     mapping.to_json(),
    }


def validate_import(
    import_type: str,
    file: IO,
    file_name: str,
    created_by_id,
    mapping_override: dict[str, str | None] | None = None,
) -> ImportBatch:
    """
    Parse `file`, run per-type validation, persist ImportBatch, return it.

    No business-table writes occur here.
    Raises ValueError for unknown import_type or unsupported file format.

    `mapping_override`, if supplied, is the operator-confirmed mapping from
    the wizard step: {our_field: source_header_or_None}. When omitted, we
    auto-detect via column_mapper.
    """
    db = _current_db()

    # Parse
    raw_rows = parse_file(file, file_name)
    headers  = list(raw_rows[0].keys()) if raw_rows else []

    # Mapping — either operator-confirmed or auto-detected.
    import_type_upper = import_type.upper()
    if mapping_override is None:
        auto = auto_map_headers(headers, import_type=import_type_upper)
        mapping     = {f: m.source_header for f, m in auto.matches.items()}
        extras_keys = auto.extras
    else:
        mapping     = dict(mapping_override)
        # Any header not chosen as a source for any field falls into extras.
        claimed     = {h for h in mapping.values() if h}
        extras_keys = [h for h in headers if h and h not in claimed]

    # Validate
    if import_type_upper == ImportBatch.ImportType.PRODUCT:
        validator = ProductImportValidator(db, mapping=mapping, extras_keys=extras_keys)
    elif import_type_upper == ImportBatch.ImportType.SUPPLIER:
        validator = SupplierImportValidator(db, mapping=mapping, extras_keys=extras_keys)
    elif import_type_upper == ImportBatch.ImportType.CONTACT:
        validator = ContactImportValidator(db, mapping=mapping, extras_keys=extras_keys)
    elif import_type_upper == ImportBatch.ImportType.EXPENSE:
        validator = ExpenseImportValidator(db)
    elif import_type_upper == ImportBatch.ImportType.ORDER:
        validator = OrderImportValidator(db)
    else:
        raise ValueError(
            f"Unknown import_type '{import_type}'. "
            f"Choices: {', '.join(ImportBatch.ImportType.values)}"
        )

    valid_rows, errors = validator.validate(raw_rows)

    # Determine status
    if errors:
        status = ImportBatch.Status.HAS_ERRORS
    else:
        status = ImportBatch.Status.VALIDATED

    batch = ImportBatch.objects.using(db).create(
        import_type=import_type_upper,
        status=status,
        file_name=file_name,
        total_rows=len(raw_rows),
        valid_rows=len(valid_rows),
        error_count=len(errors),
        errors=errors,
        validated_data=valid_rows,
        created_by_id=created_by_id,
    )
    logger.info(
        "ImportBatch %s created: type=%s total=%d valid=%d errors=%d",
        batch.pk, import_type_upper, batch.total_rows, batch.valid_rows, batch.error_count,
    )
    return batch


# ──────────────────────────────────────────────────────────────────────────────
# Step 2 — Commit
# ──────────────────────────────────────────────────────────────────────────────

def commit_import(batch_id, created_by_id) -> dict:
    """
    Commit a VALIDATED ImportBatch.

    All business writes happen inside a single atomic block on the tenant DB.
    Returns a summary dict:  {committed: int, import_type: str, batch_id: str}

    Raises:
        ImportBatch.DoesNotExist  — batch not found
        ValueError                — batch not in VALIDATED state
        RuntimeError              — commit already done / expired
    """
    db = _current_db()

    # The whole commit must be ONE atomic block. The original code had
    # `select_for_update()` outside the `with transaction.atomic(...)` —
    # that crashes on tenant DBs where AUTOCOMMIT=True (set in
    # accounts/tenant_db.py.register_tenant_db) because Django refuses
    # to issue SELECT … FOR UPDATE when there's no enclosing
    # transaction. Wrapping everything in atomic fixes the lock AND
    # keeps the all-or-nothing rollback semantics if the per-type
    # commit helper raises.
    committed = 0
    with transaction.atomic(using=db):
        try:
            batch = ImportBatch.objects.using(db).select_for_update().get(pk=batch_id)
        except ImportBatch.DoesNotExist:
            raise ImportBatch.DoesNotExist(f"ImportBatch '{batch_id}' not found.")

        if batch.status == ImportBatch.Status.COMMITTED:
            raise RuntimeError("This batch has already been committed.")
        if batch.status == ImportBatch.Status.EXPIRED or batch.is_expired:
            raise RuntimeError("This batch has expired. Please re-upload the file.")
        if batch.status != ImportBatch.Status.VALIDATED:
            raise ValueError(
                f"Cannot commit batch with status '{batch.status}'. "
                "Fix all validation errors first."
            )

        rows = batch.validated_data

        if batch.import_type == ImportBatch.ImportType.PRODUCT:
            committed = _commit_products(rows, created_by_id, db)
        elif batch.import_type == ImportBatch.ImportType.SUPPLIER:
            committed = _commit_suppliers(rows, created_by_id, db)
        elif batch.import_type == ImportBatch.ImportType.CONTACT:
            committed = _commit_contacts(rows, created_by_id, db)
        elif batch.import_type == ImportBatch.ImportType.EXPENSE:
            committed = _commit_expenses(rows, created_by_id, db)
        elif batch.import_type == ImportBatch.ImportType.ORDER:
            committed = _commit_orders(rows, created_by_id, db)

        batch.status = ImportBatch.Status.COMMITTED
        batch.committed_rows = committed
        batch.committed_at = timezone.now()
        batch.save(using=db, update_fields=["status", "committed_rows", "committed_at"])

    logger.info(
        "ImportBatch %s committed: type=%s rows=%d by_user=%s",
        batch.pk, batch.import_type, committed, created_by_id,
    )

    # Fire IMPORT_DONE notification (fire-and-forget, never breaks the response)
    try:
        from notifications.services import notify_import_done
        from notifications.tasks import _get_owner_recipients
        recipients = _get_owner_recipients(db)
        if recipients:
            notify_import_done(batch, recipients=recipients)
    except Exception as exc:
        logger.warning("Import-done notification failed: %s", exc)

    return {
        "committed": committed,
        "import_type": batch.import_type,
        "batch_id": str(batch.pk),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Commit helpers (all run inside the outer atomic block)
# ──────────────────────────────────────────────────────────────────────────────

def _get_or_create_unit(db: str, name: str) -> str:
    """Auto-create a Unit row for `name`, surviving legacy junk data.

    Returns the unit's PK as a string. Handles three failure modes that
    were causing import commits to crash:

      1. UNIQUE constraint on `abbreviation` fires because an older
         broken commit left a row with `abbreviation=""` (CharField
         default). Retry with a UUID-derived abbreviation.

      2. Case-insensitive collision on `name` (e.g. existing 'piece'
         vs. our 'Pc'). get_or_create uses exact match, so we fall back
         to a case-insensitive search.

      3. Other IntegrityErrors — re-raise so the outer atomic rolls
         back cleanly.
    """
    from inventory.models import Unit
    from django.db import IntegrityError, transaction as _t

    # Case-insensitive existing-row lookup first — avoids creating
    # duplicate Pc/PC/pc rows.
    existing = Unit.objects.using(db).filter(name__iexact=name).first()
    if existing:
        return str(existing.pk)

    # No existing row → create. Try with a clean abbreviation first; if
    # the unique constraint complains, retry with progressively more
    # unique abbreviations.
    for attempt in range(5):
        abbr = (
            _unique_abbrev(db, name) if attempt == 0
            else f"{_truncate(name, 6)}_{uuid.uuid4().hex[:3]}"
        )
        try:
            with _t.atomic(using=db):
                return str(Unit.objects.using(db).create(
                    name=name,
                    abbreviation=abbr,
                    allow_decimal=False,
                ).pk)
        except IntegrityError:
            # Re-check whether someone (or a stale row) is now matching
            # by name. If so, use that row instead of looping forever.
            existing = Unit.objects.using(db).filter(name__iexact=name).first()
            if existing:
                return str(existing.pk)
            continue   # try another abbreviation

    raise RuntimeError(f"Could not auto-create Unit '{name}' after 5 attempts.")


def _truncate(s: str, n: int) -> str:
    """alphanumeric-only truncate; falls back to 'u' for empty input."""
    cleaned = "".join(c for c in (s or "") if c.isalnum())[:n]
    return cleaned or "u"


def _unique_abbrev(db: str, name: str) -> str:
    """Generate a unique Unit.abbreviation from a name.

    Unit.abbreviation is UNIQUE + max 10 chars and the importer auto-creates
    units the tenant referenced (e.g. "Pc", "Kg", "Bag"). Strategy:
      1. Strip to alphanumerics and truncate to 10 chars — usually fine
         ("Pc" stays "Pc", "Kilogram" → "Kilogram", "Pack(10)" → "Pack10").
      2. If that's taken, append a numeric suffix (Pc → Pc2 → Pc3 …)
         until we find a free slot.
    """
    from inventory.models import Unit
    base = "".join(c for c in (name or "u") if c.isalnum())[:10] or "u"
    if not Unit.objects.using(db).filter(abbreviation__iexact=base).exists():
        return base
    for i in range(2, 1000):
        cand = f"{base[:9]}{i}" if i < 10 else f"{base[:8]}{i}"
        if not Unit.objects.using(db).filter(abbreviation__iexact=cand).exists():
            return cand
    # Wildly unlikely — but keep it deterministic.
    return f"u{uuid.uuid4().hex[:9]}"


def _get_or_create_location(db: str, name: str) -> str:
    """Mirror of _get_or_create_unit for Location (different unique col).

    Survives legacy rows with code='' that block fresh inserts.
    """
    from inventory.models import Location
    from django.db import IntegrityError, transaction as _t

    existing = Location.objects.using(db).filter(name__iexact=name).first()
    if existing:
        return str(existing.pk)

    for attempt in range(5):
        code = (
            _unique_location_code(db, name) if attempt == 0
            else f"{_truncate(name, 12)}_{uuid.uuid4().hex[:4]}"
        )
        try:
            with _t.atomic(using=db):
                return str(Location.objects.using(db).create(
                    name=name, code=code, is_active=True,
                ).pk)
        except IntegrityError:
            existing = Location.objects.using(db).filter(name__iexact=name).first()
            if existing:
                return str(existing.pk)
            continue

    raise RuntimeError(f"Could not auto-create Location '{name}' after 5 attempts.")


def _unique_location_code(db: str, name: str) -> str:
    """Generate a unique Location.code from a name.

    Same idea as _unique_abbrev but with a 20-char ceiling. We lowercase and
    underscore-collapse so codes look like 'ongko_printers', 'main', etc.
    """
    from inventory.models import Location
    base = "".join(c if c.isalnum() else "_" for c in (name or "loc").lower())
    base = "_".join(p for p in base.split("_") if p)[:20] or "loc"
    if not Location.objects.using(db).filter(code__iexact=base).exists():
        return base
    for i in range(2, 1000):
        cand = f"{base[:18]}_{i}" if i < 10 else f"{base[:17]}_{i}"
        if not Location.objects.using(db).filter(code__iexact=cand).exists():
            return cand
    return f"loc_{uuid.uuid4().hex[:14]}"

def _commit_products(rows: list[dict], created_by_id, db: str) -> int:
    """
    Create Product + FIFOLayer + StockMovement + ProductStock per row.

    Each validated row = one FIFO layer (one purchase batch).
    If the row omits SKU it is auto-generated.
    If Unit / Brand / Category / Location don't exist they are created
    on the fly — same pattern works whether the importer auto-detected
    the column or the operator pointed it manually via the wizard.
    """
    from inventory.models import (
        Product, FIFOLayer, StockMovement, ProductStock,
        Brand, Category, Location, Unit,
    )

    committed = 0
    skipped = 0
    for row in rows:
      # Each row commits in its own savepoint so one bad row (a stray
      # header/total line that slipped through as "valid", a duplicate SKU,
      # etc.) is skipped instead of rolling back the whole import.
      try:
        with transaction.atomic(using=db):
          committed += _commit_one_product(row, db)
      except Exception as exc:  # noqa: BLE001
        skipped += 1
        logger.warning("Skipped product import row %s: %s", row.get("row"), exc)
    if skipped:
        logger.info("Product import: %d committed, %d skipped.", committed, skipped)
    return committed


def _commit_one_product(row: dict, db: str) -> int:
    """Create one Product (+ FIFO layer / movement / stock) from a validated
    row. Returns 1 on success. Raised exceptions are caught per-row by the
    caller's savepoint."""
    from inventory.models import (
        Product, FIFOLayer, StockMovement, ProductStock,
        Brand, Category, Location, Unit,
    )
    if True:
        # Resolve FKs — auto-create when the validator flagged it. Note that
        # Unit + Location both have OTHER required-not-null columns beyond
        # `name` (abbreviation / code with their own UNIQUE constraints), so
        # we derive sensible defaults for them rather than letting the INSERT
        # fail with IntegrityError on a NOT NULL column.
        unit_pk = row.get("unit_pk")
        if not unit_pk and row.get("unit_create"):
            unit_pk = _get_or_create_unit(db, row["unit_create"])

        brand_pk = row.get("brand_pk")
        if not brand_pk and row.get("brand_create"):
            brand_obj, _ = Brand.objects.using(db).get_or_create(name=row["brand_create"])
            brand_pk = str(brand_obj.pk)

        category_pk = row.get("category_pk")
        if not category_pk and row.get("category_create"):
            cat_obj, _ = Category.objects.using(db).get_or_create(name=row["category_create"])
            category_pk = str(cat_obj.pk)

        # Location: from the row first, then fall back to a tenant default.
        location_pk = row.get("location_pk")
        if not location_pk and row.get("location_create"):
            location_pk = _get_or_create_location(db, row["location_create"])
        location_obj = None
        if location_pk:
            location_obj = Location.objects.using(db).get(pk=location_pk)
        if location_obj is None:
            location_obj = Location.objects.using(db).filter(is_active=True).first()
        if location_obj is None:
            location_obj = Location.objects.using(db).get(pk=_get_or_create_location(db, "Main"))

        product = Product.objects.using(db).create(
            name=row["name"],
            sku=row["sku"],                              # None → model default runs
            barcode=row.get("barcode"),
            unit_id=unit_pk,
            category_id=category_pk,
            brand_id=brand_pk or None,
            selling_price=Decimal(row["selling_price"]),
            reorder_level=Decimal(row.get("reorder_level", "0")),
            warranty_days=int(row.get("warranty_days", 0)),
            notes=row.get("notes", ""),
            extras=row.get("extras") or {},
        )

        qty = Decimal(row["opening_qty"])
        cost = Decimal(row["unit_cost"])
        stock_date = date.fromisoformat(row["stock_date"])

        if qty > 0:
            # FIFO layer
            layer = FIFOLayer.objects.using(db).create(
                product=product,
                location=location_obj,
                initial_qty=qty,
                remaining_qty=qty,
                unit_cost=cost,
                reference_type="import",
                created_at=timezone.make_aware(
                    timezone.datetime(stock_date.year, stock_date.month, stock_date.day)
                ),
            )

            # Stock movement (IN)
            StockMovement.objects.using(db).create(
                product=product,
                location=location_obj,
                movement_type=StockMovement.Type.IN,
                quantity=qty,
                unit_cost=cost,
                reference_type="import",
                reference_id=layer.pk,
                notes=f"Opening stock via import batch",
            )

            # ProductStock snapshot
            stock_obj, created = ProductStock.objects.using(db).get_or_create(
                product=product,
                location=location_obj,
                defaults={"quantity": qty},
            )
            if not created:
                from django.db.models import F
                ProductStock.objects.using(db).filter(pk=stock_obj.pk).update(
                    quantity=F("quantity") + qty
                )

        return 1


def _commit_suppliers(rows: list[dict], created_by_id, db: str) -> int:
    """Create Supplier rows from a validated supplier-import batch.

    Skips rows whose name already exists in the tenant DB (case-insensitive
    on `name`). Returns the number of NEW suppliers actually inserted —
    skipped duplicates are logged but don't fail the batch, so the
    operator can safely re-upload a partial list without manual cleanup.
    """
    from purchases.models import Supplier

    committed = 0
    skipped   = 0
    for row in rows:
        name = row["name"]
        if Supplier.objects.using(db).filter(name__iexact=name).exists():
            skipped += 1
            continue
        Supplier.objects.using(db).create(
            name            = name,
            business_name   = row.get("business_name", ""),
            contact         = row.get("contact", ""),
            email           = row.get("email", ""),
            phone           = row.get("phone", ""),
            address         = row.get("address", ""),
            tax_number      = row.get("tax_number", ""),
            pay_term_value  = row.get("pay_term_value"),
            opening_balance = Decimal(row.get("opening_balance", "0") or "0"),
            notes           = row.get("notes", ""),
            is_active       = True,
        )
        committed += 1

    if skipped:
        logger.info("Supplier import: %d duplicates skipped (name match).", skipped)
    return committed


def _commit_contacts(rows: list[dict], created_by_id, db: str) -> int:
    """Create sales.Customer rows from a validated contact-import batch.

    Skips rows whose phone OR composed name already exists in the tenant
    DB (case-insensitive). Returns the number of NEW contacts inserted.

    When contact_type is 'both' or 'supplier', also mirror the row into
    the purchases.Supplier table — same pattern as the manual Add
    Contact modal's `_mirror_supplier_if_both` serializer hook.
    """
    from sales.models import Customer
    from purchases.models import Supplier

    created = 0
    for row in rows:
        # Derive the canonical display name the way Customer.save() does, so
        # the dedupe check matches what the model would otherwise compute.
        if row["is_individual"]:
            display = " ".join(p for p in [
                row["first_name"], row["middle_name"], row["last_name"],
            ] if p).strip()
        else:
            display = row["business_name"]
        if not display:
            continue   # validator should have flagged, defensive skip

        # Dedupe: name OR phone collision → skip silently. Re-uploading
        # the same file is safe (matches the old import endpoint).
        existing_q = Customer.objects.using(db).filter(name__iexact=display)
        if row["phone"]:
            existing_q = Customer.objects.using(db).filter(name__iexact=display) \
                | Customer.objects.using(db).filter(phone=row["phone"])
        if existing_q.exists():
            continue

        cust = Customer.objects.using(db).create(
            contact_type     = row["contact_type"],
            is_individual    = row["is_individual"],
            prefix           = row["prefix"],
            first_name       = row["first_name"],
            middle_name      = row["middle_name"],
            last_name        = row["last_name"],
            business_name    = row["business_name"],
            email            = row["email"],
            phone            = row["phone"],
            alternate_phone  = row["alternate_phone"],
            landline         = row["landline"],
            address          = row["address"],
            address_line_2   = row["address_line_2"],
            city             = row["city"],
            state            = row["state"],
            country          = row["country"],
            zip_code         = row["zip_code"],
            tax_number       = row["tax_number"],
            pay_term_value   = row["pay_term_value"],
            opening_balance  = Decimal(row.get("opening_balance", "0") or "0"),
            credit_limit     = Decimal(row.get("credit_limit",    "0") or "0"),
            notes            = row["notes"],
            is_active        = True,
        )

        # contact_type 'both' or 'supplier' → also create matching Supplier row
        if row["contact_type"] in ("both", "supplier"):
            if not Supplier.objects.using(db).filter(phone=cust.phone, phone__gt="").exists():
                Supplier.objects.using(db).create(
                    name            = cust.name,
                    business_name   = cust.business_name,
                    email           = cust.email,
                    phone           = cust.phone,
                    address         = cust.address,
                    tax_number      = cust.tax_number,
                    pay_term_value  = cust.pay_term_value,
                    opening_balance = cust.opening_balance,
                    is_active       = True,
                )
        created += 1
    return created


def _commit_expenses(rows: list[dict], created_by_id, db: str) -> int:
    """
    Create Expense + JournalEntry + 2 JournalEntryLines per row.

    Mirrors accounting.services.post_expense_entry logic.
    """
    from accounting.models import Account, Expense, JournalEntry, JournalEntryLine

    committed = 0
    for row in rows:
        amount = Decimal(row["amount"])
        expense_date = date.fromisoformat(row["expense_date"])
        expense_account = Account.objects.using(db).get(pk=row["expense_account_pk"])
        payment_account = Account.objects.using(db).get(pk=row["payment_account_pk"])

        # Journal entry number: JE-YYYYMM-NNNN
        from accounting.services import _generate_entry_number
        entry_number = _generate_entry_number()

        je = JournalEntry.objects.using(db).create(
            entry_number=entry_number,
            reference_type=JournalEntry.ReferenceType.EXPENSE,
            date=expense_date,
            description=f"Import expense: {row.get('description', '')}",
            created_by_id=created_by_id,
        )

        JournalEntryLine.objects.using(db).bulk_create([
            JournalEntryLine(
                journal_entry=je,
                account=expense_account,
                description="Expense (import)",
                debit=amount,
                credit=Decimal("0"),
            ),
            JournalEntryLine(
                journal_entry=je,
                account=payment_account,
                description="Payment (import)",
                debit=Decimal("0"),
                credit=amount,
            ),
        ])

        Expense.objects.using(db).create(
            category=row["category"],
            expense_account=expense_account,
            payment_account=payment_account,
            amount=amount,
            description=row.get("description", ""),
            expense_date=expense_date,
            journal_entry=je,
            created_by_id=created_by_id,
        )

        committed += 1

    return committed


def _commit_orders(rows: list[dict], created_by_id, db: str) -> int:
    """
    Create Sale + SaleItem + consume FIFO stock per row.

    Reuses sales.services.finalize_sale internally so all FIFO/accounting
    hooks fire identically to a POS sale.
    """
    from sales.models import Sale, SaleItem, Customer
    from inventory.models import Product, Location
    from inventory.services import consume_stock_fifo

    # Use the first active location for stock deduction
    default_location = Location.objects.using(db).filter(is_active=True).first()
    if not default_location:
        raise RuntimeError("No active location found. Cannot import orders without a location.")

    committed = 0
    for row in rows:
        order_date = date.fromisoformat(row["order_date"])
        product = Product.objects.using(db).get(pk=row["product_pk"])
        qty = Decimal(row["quantity"])
        unit_price = Decimal(row["unit_price"])
        subtotal = Decimal(row["subtotal"])

        # Customer (get or create by name)
        customer = None
        if row.get("customer_name"):
            customer, _ = Customer.objects.using(db).get_or_create(
                name=row["customer_name"],
                defaults={"phone": "", "email": ""},
            )

        # Build a Sale record directly (bypassing finalize_sale to keep
        # import self-contained, but still call accounting hook manually)
        sale = Sale.objects.using(db).create(
            customer=customer,
            subtotal=subtotal,
            discount_amount=Decimal("0"),
            tax_amount=Decimal("0"),
            total_amount=subtotal,
            amount_paid=subtotal if row["payment_status"] == "PAID" else Decimal("0"),
            payment_status=row["payment_status"].lower(),
            status=Sale.Status.FINALIZED,
            notes=row.get("notes", "Import order"),
            finalized_by_id=created_by_id,
            finalized_at=timezone.make_aware(
                timezone.datetime(order_date.year, order_date.month, order_date.day)
            ),
        )

        SaleItem.objects.using(db).create(
            sale=sale,
            product=product,
            quantity=qty,
            unit_price=unit_price,
            discount_amount=Decimal("0"),
            subtotal=subtotal,
        )

        # Consume FIFO stock
        consume_stock_fifo(
            product_id=product.pk,
            location_id=default_location.pk,
            quantity=qty,
            reference_type="import_order",
            reference_id=sale.pk,
        )

        # Accounting hook
        try:
            from accounting.services import post_sale_entry
            post_sale_entry(sale=sale, created_by_id=created_by_id)
        except Exception as exc:
            logger.warning("Accounting hook failed for import order row %s: %s", row["row"], exc)

        committed += 1

    return committed
