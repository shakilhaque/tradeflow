"""
Sales & POS models — tenant database.

All models live in the per-tenant PostgreSQL database routed by
TenantDatabaseRouter.  Foreign keys to inventory models (Product, Location)
are real DB-level FKs because both apps share the same tenant DB.
Foreign keys to accounts.User are stored as bare UUIDs — cross-database
FKs are not supported in Django's multi-db setup.

Tables
──────
  customers       — buyer master data
  sales           — sale header (QUOTATION / DRAFT / FINAL / PENDING / VOIDED)
  sale_items      — line items (product, qty, price, per-row COGS after FIFO)
  sale_payments   — payment instalments against a finalized sale
  back_orders     — stock-shortfall records created when finalization fails
"""

import uuid
from decimal import Decimal

from django.db import models
from django.utils import timezone

from accounts.soft_delete import SoftDeleteMixin
from inventory.models import Location, Product


# Every registered customer starts with this credit ceiling so they can buy
# on credit out of the box. The operator can lower it (even to 0 for a
# strict cash-only customer) or raise it per customer. Walk-in / unregistered
# sales (customer=NULL) never get credit regardless of this value.
DEFAULT_CREDIT_LIMIT = Decimal("5000")


# ──────────────────────────────────────────────────────────────────────────────
# 1. Customer
# ──────────────────────────────────────────────────────────────────────────────

class Customer(SoftDeleteMixin, models.Model):
    """
    Buyer / walk-in customer master record.
    Soft-deleted customers are hidden from default querysets.

    A contact is either an Individual (first/middle/last/dob) or a
    Business (business_name). `is_individual` flips the shape; the
    serializer/view auto-composes `name` from the appropriate fields so
    the rest of the system (Sale.customer.name, invoices, reports) keeps
    working without per-call branching.
    """

    class ContactType(models.TextChoices):
        CUSTOMER = "customer", "Customer"
        SUPPLIER = "supplier", "Supplier"
        BOTH     = "both",     "Both (Supplier & Customer)"

    class Prefix(models.TextChoices):
        MR   = "Mr",   "Mr"
        MRS  = "Mrs",  "Mrs"
        MISS = "Miss", "Miss"
        MS   = "Ms",   "Ms"
        DR   = "Dr",   "Dr"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # ── Type discriminator ───────────────────────────────────────────────────
    contact_type  = models.CharField(
        max_length=10, choices=ContactType.choices, default=ContactType.CUSTOMER,
        db_index=True,
        help_text=(
            "What kind of contact this is. 'Both' means the same person/business "
            "appears in Customers AND Suppliers — a paired Supplier row is "
            "created/synced on save."
        ),
    )
    is_individual = models.BooleanField(
        default=True,
        help_text="True = person (first/middle/last/dob). False = company (business_name).",
    )
    contact_id    = models.CharField(
        max_length=40, blank=True, default="", db_index=True,
        help_text="Optional human ID printed on invoices. Auto-generated when blank.",
    )

    # ── Display name (authoritative; auto-composed on save) ─────────────────
    name          = models.CharField(max_length=200, db_index=True)
    business_name = models.CharField(
        max_length=200, blank=True, default="",
        help_text="Trading name printed on invoices. For individuals this is usually blank.",
    )

    # ── Individual breakdown (used when is_individual=True) ─────────────────
    prefix        = models.CharField(
        max_length=10, choices=Prefix.choices, blank=True, default="",
        help_text="Mr / Mrs / Miss / Ms / Dr (optional).",
    )
    first_name    = models.CharField(max_length=100, blank=True, default="")
    middle_name   = models.CharField(max_length=100, blank=True, default="")
    last_name     = models.CharField(max_length=100, blank=True, default="")
    date_of_birth = models.DateField(null=True, blank=True)

    # ── Contact ──────────────────────────────────────────────────────────────
    email         = models.EmailField(blank=True, db_index=True)
    phone         = models.CharField(max_length=30, blank=True, help_text="Primary mobile.")
    alternate_phone = models.CharField(max_length=30, blank=True, default="")
    landline      = models.CharField(max_length=30, blank=True, default="")

    # ── Address (structured) ────────────────────────────────────────────────
    address       = models.TextField(blank=True, help_text="Line 1 (billing).")
    address_line_2 = models.CharField(max_length=255, blank=True, default="")
    city          = models.CharField(max_length=100, blank=True, default="", db_index=True)
    state         = models.CharField(max_length=100, blank=True, default="")
    country       = models.CharField(max_length=100, blank=True, default="")
    zip_code      = models.CharField(max_length=20, blank=True, default="")
    shipping_address = models.TextField(
        blank=True, default="",
        help_text="Free-form shipping address. Blank = same as billing.",
    )

    tax_number    = models.CharField(
        max_length=50, blank=True,
        help_text="VAT / GST / TIN number for invoice.",
    )
    # ── Credit terms ────────────────────────────────────────────────────────
    pay_term_value  = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Number of days/months allowed to pay (e.g. 30 = Net 30).",
    )
    pay_term_period = models.CharField(
        max_length=10, blank=True, default="",
        choices=[("", "—"), ("days", "Days"), ("months", "Months")],
    )
    # ── Balances (in tenant currency, default BDT) ──────────────────────────
    opening_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="One-time anchor balance carried over at customer creation.",
    )
    advance_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Paid-ahead credit available to offset future invoices.",
    )
    credit_limit    = models.DecimalField(
        max_digits=14, decimal_places=2, default=DEFAULT_CREDIT_LIMIT,
        help_text=(
            "Maximum outstanding balance allowed for credit sales. Defaults "
            "to 5000 so a new customer can buy on credit immediately; set it "
            "to 0 to make a customer strictly CASH-ONLY. Walk-in sales "
            "(customer=NULL) never get credit regardless."
        ),
    )
    # ── Grouping ─────────────────────────────────────────────────────────────
    customer_group = models.ForeignKey(
        "CustomerGroup", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="customers",
        help_text="Optional customer group (pricing tier / segment).",
    )

    # ── Free-form custom fields ─────────────────────────────────────────────
    custom_field_1 = models.CharField(max_length=200, blank=True, default="")
    custom_field_2 = models.CharField(max_length=200, blank=True, default="")
    custom_field_3 = models.CharField(max_length=200, blank=True, default="")
    custom_field_4 = models.CharField(max_length=200, blank=True, default="")
    notes         = models.TextField(blank=True)
    is_active     = models.BooleanField(default=True, db_index=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "customers"
        ordering = ["name"]

    def __str__(self):
        return self.name

    # ── Auto-composed name & contact_id ──────────────────────────────────────
    # `name` is the single canonical display string used by invoices,
    # reports, and Sale.customer.name. We always derive it from the
    # individual/business inputs on save so callers can't desync them.
    def save(self, *args, **kwargs):
        self.name = self._composed_name() or self.name or "Unnamed"
        if not self.contact_id:
            self.contact_id = self._auto_contact_id()
        super().save(*args, **kwargs)

    def _composed_name(self) -> str:
        if self.is_individual:
            parts = [self.first_name, self.middle_name, self.last_name]
            joined = " ".join(p.strip() for p in parts if p and p.strip())
            return joined
        return (self.business_name or "").strip()

    def _auto_contact_id(self) -> str:
        # Short stable ID derived from name + 4 hex chars of the UUID — enough
        # to disambiguate two customers with the same name. The serializer
        # may overwrite this with whatever the operator typed in.
        from re import sub as _sub
        base = _sub(r"[^A-Za-z0-9]+", "", (self._composed_name() or "C")).upper()[:8] or "C"
        return f"{base}-{str(self.id).replace('-', '')[:4].upper()}"


# ──────────────────────────────────────────────────────────────────────────────
# 1b. CustomerGroup
# ──────────────────────────────────────────────────────────────────────────────

class CustomerGroup(models.Model):
    """
    A pricing / segmentation bucket customers can be assigned to.

    ``calc_percentage`` is a +/- adjustment applied to the product's default
    selling price for customers in this group (e.g. -5 = 5 % discount on
    every line; +10 = 10 % mark-up). Stored as a percentage so the UI shows
    "5", "10", etc. without juggling decimals.

    ``price_group`` is a free-text label that lets a tenant map this group
    to an external selling-price tier (e.g. "Retail", "Wholesale"). We do
    not enforce it as a FK yet — when we ship the dedicated Selling Price
    Group table this column will be migrated to an FK without UI churn.
    """
    class PriceCalculationType(models.TextChoices):
        PERCENTAGE = "percentage", "Percentage"
        FIXED      = "fixed",      "Fixed"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name            = models.CharField(max_length=120, unique=True, db_index=True)
    price_calculation_type = models.CharField(
        max_length=12,
        choices=PriceCalculationType.choices,
        default=PriceCalculationType.PERCENTAGE,
        help_text="How calc_percentage is interpreted: percent multiplier or flat per-line amount.",
    )
    calc_percentage = models.DecimalField(
        max_digits=12, decimal_places=4, default=Decimal("0"),
        help_text="Price adjustment value. Negative = discount, positive = mark-up. "
                  "Read as a %% when price_calculation_type=percentage, as a flat currency amount when fixed.",
    )
    price_group     = models.CharField(
        max_length=120, blank=True, default="",
        help_text="Optional selling-price group label (e.g. Retail, Wholesale).",
    )
    description     = models.TextField(blank=True, default="")
    is_active       = models.BooleanField(default=True, db_index=True)
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "customer_groups"
        ordering = ["name"]

    def __str__(self):
        return self.name


# ──────────────────────────────────────────────────────────────────────────────
# 2. Sale (header)
# ──────────────────────────────────────────────────────────────────────────────

class Sale(models.Model):
    """
    Sale header.  Controls the entire lifecycle of a transaction.

    Status flow
    ───────────
      QUOTATION ──► (can convert to DRAFT or be deleted)
      PROFORMA  ──► (can convert to DRAFT/FINAL)
      DRAFT     ──► FINAL   (if stock available)
                ──► PENDING (if stock short → back-order created)
      PENDING   ──► DRAFT   (when purchase-order restocks items)
      FINAL     ──► VOIDED  (admin only, within same day)

    Payment status (only meaningful when status=FINAL)
    ──────────────
      DUE → PARTIAL → PAID
    """

    class Status(models.TextChoices):
        QUOTATION = "QUOTATION", "Quotation"
        PROFORMA  = "PROFORMA",  "Proforma"
        DRAFT     = "DRAFT",     "Draft"
        FINAL     = "FINAL",     "Final"
        PENDING   = "PENDING",   "Pending (back-order)"
        VOIDED    = "VOIDED",    "Voided"

    class PaymentStatus(models.TextChoices):
        DUE     = "DUE",     "Due"
        PARTIAL = "PARTIAL", "Partial"
        PAID    = "PAID",    "Paid"

    # ── Identity ──────────────────────────────────────────────────────────────
    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    customer       = models.ForeignKey(
        Customer,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sales",
        help_text="NULL = walk-in / anonymous sale.",
    )
    location       = models.ForeignKey(
        Location,
        on_delete=models.PROTECT,
        related_name="sales",
        help_text="Which branch/warehouse this sale is fulfilled from.",
    )

    # ── Status ────────────────────────────────────────────────────────────────
    status         = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True,
    )
    payment_status = models.CharField(
        max_length=10, choices=PaymentStatus.choices,
        default=PaymentStatus.DUE, db_index=True,
    )
    sale_date      = models.DateTimeField(
        default=timezone.now,
        db_index=True,
        help_text="Business sale date/time selected from Add Sale screen.",
    )
    pay_term_days  = models.PositiveIntegerField(
        default=0,
        help_text="Credit term in days (0 means immediate payment).",
    )
    # Raw pay-term as entered on Add Sale / Add Quotation — value + unit — so
    # the original "30 days" / "2 months" is preserved (pay_term_days above is
    # the flattened day count used for due-date maths).
    pay_term_value  = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Credit term value as typed (paired with pay_term_period).",
    )
    pay_term_period = models.CharField(
        max_length=10, blank=True, default="",
        choices=[("", "—"), ("days", "Days"), ("months", "Months")],
        help_text="Unit for pay_term_value: days or months.",
    )

    # ── Amounts ───────────────────────────────────────────────────────────────
    subtotal       = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Sum of (unit_price × quantity) for all line items.",
    )
    discount       = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Total header-level discount applied to subtotal.",
    )
    tax_rate       = models.DecimalField(
        max_digits=5, decimal_places=2, default=Decimal("0"),
        help_text="Tax percentage (e.g. 15.00 = 15 %).",
    )
    tax_amount     = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
    )
    total_amount   = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="(subtotal − discount) + tax_amount",
    )
    shipping_charges = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
    )
    extra_charges    = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Sum of additional expense rows from Add Sale screen.",
    )
    amount_paid    = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
    )
    balance_due    = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="total_amount − amount_paid",
    )

    # ── Invoice ───────────────────────────────────────────────────────────────
    invoice_number = models.CharField(
        max_length=30, unique=True, null=True, blank=True,
        help_text="Set on finalization. Format: INV-YYYYMM-NNNN",
    )

    # ── Audit — stored as UUID, not FK, because User lives in master DB ───────
    created_by_id    = models.UUIDField(
        help_text="UUID of the User who created this sale.",
    )
    finalized_by_id  = models.UUIDField(
        null=True, blank=True,
        help_text="UUID of the User who finalized this sale.",
    )
    finalized_at     = models.DateTimeField(null=True, blank=True)
    meta             = models.JSONField(
        default=dict,
        blank=True,
        help_text="Extended Add Sale fields (invoice scheme, shipping details, service staff, docs, etc.)",
    )

    notes            = models.TextField(blank=True)
    created_at       = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "sales"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"],     name="sales_status_date_idx"),
            models.Index(fields=["payment_status"],            name="sales_pmt_status_idx"),
            models.Index(fields=["customer", "created_at"],   name="sales_customer_date_idx"),
        ]

    def __str__(self):
        ref = self.invoice_number or str(self.id)[:8]
        return f"Sale {ref} [{self.status}]"

    # ── Computed helpers ──────────────────────────────────────────────────────

    @property
    def is_editable(self) -> bool:
        """Only QUOTATION, PROFORMA and DRAFT sales can be modified."""
        return self.status in (self.Status.QUOTATION, self.Status.PROFORMA, self.Status.DRAFT)

    @property
    def can_be_finalized(self) -> bool:
        return self.status in (self.Status.QUOTATION, self.Status.PROFORMA, self.Status.DRAFT)


# ──────────────────────────────────────────────────────────────────────────────
# 3. SaleItem (line items)
# ──────────────────────────────────────────────────────────────────────────────

class SaleItem(models.Model):
    """
    One line item in a sale.

    unit_price      selling price per unit at time of sale
    item_discount   per-unit discount amount (flat, not %)
    total_price     (unit_price − item_discount) × quantity
    cogs            filled by FIFO engine at finalization;
                    NULL for QUOTATION / DRAFT
    """

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sale          = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="items")
    product       = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="sale_items")
    quantity      = models.DecimalField(max_digits=14, decimal_places=4)
    unit_price    = models.DecimalField(max_digits=14, decimal_places=2)
    item_discount = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Per-unit flat discount (reduces unit price before qty multiply).",
    )
    total_price   = models.DecimalField(
        max_digits=14, decimal_places=2,
        help_text="(unit_price − item_discount) × quantity",
    )
    cogs          = models.DecimalField(
        max_digits=14, decimal_places=4,
        null=True, blank=True,
        help_text="Cost of goods sold — computed by FIFO engine on finalization.",
    )
    note          = models.TextField(
        blank=True, default="",
        help_text="Per-line note (IMEI / serial / etc.) entered on POS or Add "
                  "Sale — printed on the invoice under this product.",
    )

    class Meta:
        db_table = "sale_items"

    def __str__(self):
        return f"{self.product.name} × {self.quantity} @ {self.unit_price}"

    @property
    def effective_unit_price(self) -> Decimal:
        return self.unit_price - self.item_discount

    @property
    def gross_profit(self):
        if self.cogs is None:
            return None
        return self.total_price - self.cogs


# ──────────────────────────────────────────────────────────────────────────────
# 4. SalePayment
# ──────────────────────────────────────────────────────────────────────────────

class SalePayment(models.Model):
    """
    One payment instalment against a finalized sale.

    Multiple payments are allowed (partial → partial → paid).
    Sum of all SalePayments for a sale must never exceed sale.total_amount.
    """

    class Method(models.TextChoices):
        CASH          = "CASH",          "Cash"
        CARD          = "CARD",          "Card"
        BANK_TRANSFER = "BANK_TRANSFER", "Bank Transfer"
        MOBILE        = "MOBILE",        "Mobile Payment"
        ADVANCE       = "ADVANCE",       "Advance Balance"
        OTHER         = "OTHER",         "Other"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sale           = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="sale_payments")
    amount         = models.DecimalField(max_digits=14, decimal_places=2)
    method         = models.CharField(max_length=20, choices=Method.choices)
    reference      = models.CharField(
        max_length=100, blank=True,
        help_text="Card auth code, bank ref, mobile transaction ID, etc.",
    )
    notes          = models.TextField(blank=True)
    received_by_id = models.UUIDField(
        help_text="UUID of the User (cashier/staff) who received this payment.",
    )
    # Which cash box / bank / MFS wallet the money landed in.
    # Stored as a bare UUID (no FK) because PaymentAccount lives in the
    # accounting app and Django's per-tenant routing already keeps them
    # in the same DB. Null = "not assigned to an account yet".
    payment_account_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of the accounting.PaymentAccount this payment landed in.",
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sale_payments"
        ordering = ["created_at"]

    def __str__(self):
        return f"Payment {self.amount} ({self.method}) → Sale {str(self.sale_id)[:8]}"


# ──────────────────────────────────────────────────────────────────────────────
# 5. BackOrder
# ──────────────────────────────────────────────────────────────────────────────

class BackOrder(models.Model):
    """
    Created when a sale cannot be finalized due to insufficient stock.

    One BackOrder row per product that is short.  The parent sale transitions
    to PENDING status.  Once the linked Purchase Order arrives and stock is
    replenished, the fulfilment flow marks BackOrder rows FULFILLED and
    transitions the parent sale back to DRAFT (ready to finalize).
    """

    class Status(models.TextChoices):
        OPEN      = "OPEN",      "Open"
        FULFILLED = "FULFILLED", "Fulfilled"
        CANCELLED = "CANCELLED", "Cancelled"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sale          = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="backorders")
    product       = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="backorders")
    location      = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="backorders")
    requested_qty = models.DecimalField(
        max_digits=14, decimal_places=4,
        help_text="Quantity the customer ordered.",
    )
    available_qty = models.DecimalField(
        max_digits=14, decimal_places=4,
        help_text="Stock on hand at the time the back-order was raised.",
    )
    shortfall_qty = models.DecimalField(
        max_digits=14, decimal_places=4,
        help_text="requested_qty − available_qty",
    )
    status        = models.CharField(
        max_length=20, choices=Status.choices, default=Status.OPEN, db_index=True,
    )
    notes         = models.TextField(blank=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    fulfilled_at  = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "back_orders"
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["status", "product"], name="bo_status_product_idx"),
        ]

    def __str__(self):
        return (
            f"BackOrder {str(self.id)[:8]} — "
            f"{self.product.name} short {self.shortfall_qty} [{self.status}]"
        )

    def mark_fulfilled(self):
        self.status       = self.Status.FULFILLED
        self.fulfilled_at = timezone.now()
        self.save(update_fields=["status", "fulfilled_at"])


# ──────────────────────────────────────────────────────────────────────────────
# 6. SellReturn
# ──────────────────────────────────────────────────────────────────────────────

class SellReturn(models.Model):
    """
    Customer sell return header linked to a previously created sale.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    parent_sale = models.ForeignKey(
        Sale,
        on_delete=models.PROTECT,
        related_name="sell_returns",
    )
    customer = models.ForeignKey(
        Customer,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sell_returns",
    )
    location = models.ForeignKey(
        Location,
        on_delete=models.PROTECT,
        related_name="sell_returns",
    )
    invoice_number = models.CharField(max_length=30, unique=True)
    payment_status = models.CharField(
        max_length=10,
        choices=Sale.PaymentStatus.choices,
        default=Sale.PaymentStatus.DUE,
        db_index=True,
    )
    return_date     = models.DateField(default=timezone.now, db_index=True)
    refund_method   = models.CharField(max_length=20, blank=True, default="")
    restocking_fee  = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    refunded_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    total_amount    = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    amount_paid     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    balance_due     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    created_by_id = models.UUIDField()
    meta = models.JSONField(default=dict, blank=True)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "sell_returns"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["created_at"], name="sell_ret_date_idx"),
            models.Index(fields=["payment_status"], name="sell_ret_pmt_idx"),
            models.Index(fields=["customer", "created_at"], name="sell_ret_cust_date_idx"),
        ]

    def __str__(self):
        return f"SellReturn {self.invoice_number}"


class SellReturnItem(models.Model):
    """Line item on a sell return (one row per returned product)."""

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sell_return  = models.ForeignKey(SellReturn, on_delete=models.CASCADE, related_name="items")
    product      = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="return_items")
    quantity     = models.DecimalField(max_digits=14, decimal_places=4)
    unit_price   = models.DecimalField(max_digits=14, decimal_places=2)
    line_total   = models.DecimalField(max_digits=14, decimal_places=2)
    reason       = models.CharField(max_length=30, blank=True, default="")
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sell_return_items"

    def __str__(self):
        return f"{self.product.name} × {self.quantity}"


# ──────────────────────────────────────────────────────────────────────────────
# 7. Discount
# ──────────────────────────────────────────────────────────────────────────────

class Discount(models.Model):
    """
    Configurable promotional discount rules.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=140, db_index=True)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    discount_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    # Fixed amount vs percentage rebate. Every legacy row gets FIXED
    # via the migration's IF NOT EXISTS column add.
    DISCOUNT_TYPE_FIXED      = "FIXED"
    DISCOUNT_TYPE_PERCENTAGE = "PERCENTAGE"
    DISCOUNT_TYPE_CHOICES    = [
        (DISCOUNT_TYPE_FIXED,      "Fixed"),
        (DISCOUNT_TYPE_PERCENTAGE, "Percentage"),
    ]
    discount_type = models.CharField(
        max_length=12, choices=DISCOUNT_TYPE_CHOICES, default=DISCOUNT_TYPE_FIXED,
    )
    # Optional segmentation — which selling-price tier the discount
    # applies to. 'ALL' (default) means the rebate fires regardless
    # of the row's price tier; tenants who price wholesale/retail
    # differently can scope a discount to one tier.
    selling_price_group = models.CharField(
        max_length=40, blank=True, default="ALL",
        help_text="Selling price group the discount applies to. 'ALL' = every tier.",
    )
    priority = models.PositiveIntegerField(default=1, db_index=True)
    brand = models.CharField(max_length=120, blank=True, default="")
    category = models.CharField(max_length=120, blank=True, default="")
    products = models.ManyToManyField(Product, blank=True, related_name="discount_rules")
    location = models.ForeignKey(
        Location,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="discount_rules",
    )
    is_active = models.BooleanField(default=True, db_index=True)
    created_by_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "discounts"
        ordering = ["-priority", "-created_at"]

    def __str__(self):
        return self.name


# ──────────────────────────────────────────────────────────────────────────────
# 9. RegisterClosure — POS cash-register close event
# ──────────────────────────────────────────────────────────────────────────────
#
# Iffaa synthesises register sessions from SalePayment rows (see
# reports/_register_report.py). The cashier closes a session by clicking
# "Close Register" on the POS — that POST lands here. The Register Details
# modal then uses the most-recent closure as the lower bound of the
# "current register" window, so a fresh session starts after every close.
#
# Persistent record means audit + replay — managers can pull the historic
# closures per cashier per location any time.
class RegisterClosure(models.Model):
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id       = models.UUIDField(db_index=True, help_text="UUID of the cashier who closed the register.")
    location      = models.ForeignKey(
        Location, on_delete=models.PROTECT, related_name="register_closures",
        null=True, blank=True,
    )
    closed_at     = models.DateTimeField(auto_now_add=True, db_index=True)

    # Expected totals (computed by the server from SalePayments since
    # the previous closure for the same user × location).
    expected_cash     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    expected_card     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    expected_cheque   = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    expected_total    = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    # Counted totals (whatever the cashier typed into the close
    # register modal).
    counted_cash      = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    counted_card      = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    counted_cheque    = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    closing_note  = models.TextField(blank=True, default="")

    class Meta:
        db_table = "register_closures"
        ordering = ["-closed_at"]
        indexes = [
            models.Index(fields=["user_id", "location", "closed_at"], name="rc_user_loc_date_idx"),
        ]

    def __str__(self):
        return f"Close {self.user_id} @ {self.closed_at:%Y-%m-%d %H:%M}"
