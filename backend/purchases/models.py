"""
Purchases — tenant database.

Tables
──────
  suppliers             — vendor master data
  purchases             — purchase header (DRAFT / RECEIVED / PARTIAL / CANCELLED)
  purchase_items        — line items
  purchase_payments     — payment instalments
  purchase_returns      — return header
  purchase_return_items — return line items
"""
import uuid
from decimal import Decimal

from django.db import models
from django.utils import timezone

from accounts.soft_delete import SoftDeleteMixin
from inventory.models import Location, Product


# ──────────────────────────────────────────────────────────────────────────────
# Supplier
# ──────────────────────────────────────────────────────────────────────────────

class Supplier(SoftDeleteMixin, models.Model):
    """Supplier master. Same Individual / Business shape as sales.Customer
    so the Add / Edit Supplier modal mirrors the Add / Edit Contact modal.
    """

    class Prefix(models.TextChoices):
        MR   = "Mr",   "Mr"
        MRS  = "Mrs",  "Mrs"
        MISS = "Miss", "Miss"
        MS   = "Ms",   "Ms"
        DR   = "Dr",   "Dr"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    is_individual = models.BooleanField(default=False)
    contact_id    = models.CharField(
        max_length=40, blank=True, default="", db_index=True,
        help_text="Optional human ID printed on POs. Auto-generated when blank.",
    )

    # ── Canonical display name (auto-composed on save) ──────────────────────
    name          = models.CharField(max_length=200, db_index=True)
    business_name = models.CharField(
        max_length=200, blank=True, default="",
        help_text="Trading name printed on POs. For individuals this is usually blank.",
    )

    # ── Individual breakdown ────────────────────────────────────────────────
    prefix        = models.CharField(max_length=10, choices=Prefix.choices, blank=True, default="")
    first_name    = models.CharField(max_length=100, blank=True, default="")
    middle_name   = models.CharField(max_length=100, blank=True, default="")
    last_name     = models.CharField(max_length=100, blank=True, default="")
    date_of_birth = models.DateField(null=True, blank=True)

    # ── Contact ─────────────────────────────────────────────────────────────
    contact       = models.CharField(max_length=150, blank=True, help_text="Contact person.")
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
    shipping_address = models.TextField(blank=True, default="")

    tax_number    = models.CharField(max_length=50, blank=True)
    # ── Credit terms ────────────────────────────────────────────────────────
    pay_term_value  = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Number of days/months we have to pay the supplier.",
    )
    pay_term_period = models.CharField(
        max_length=10, blank=True, default="",
        choices=[("", "—"), ("days", "Days"), ("months", "Months")],
    )
    # ── Balances ────────────────────────────────────────────────────────────
    opening_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="One-time anchor balance carried over at supplier creation.",
    )
    advance_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
        help_text="Paid-ahead credit available to offset future purchase bills.",
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
        db_table = "suppliers"
        ordering = ["name"]

    def __str__(self):
        return self.name

    # ── Auto-composed name & contact_id (mirrors sales.Customer.save) ───────
    def save(self, *args, **kwargs):
        self.name = self._composed_name() or self.name or "Unnamed"
        if not self.contact_id:
            self.contact_id = self._auto_contact_id()
        super().save(*args, **kwargs)

    def _composed_name(self) -> str:
        if self.is_individual:
            parts = [self.first_name, self.middle_name, self.last_name]
            return " ".join(p.strip() for p in parts if p and p.strip())
        return (self.business_name or "").strip()

    def _auto_contact_id(self) -> str:
        from re import sub as _sub
        base = _sub(r"[^A-Za-z0-9]+", "", (self._composed_name() or "S")).upper()[:8] or "S"
        return f"{base}-{str(self.id).replace('-', '')[:4].upper()}"


# ──────────────────────────────────────────────────────────────────────────────
# Purchase (header)
# ──────────────────────────────────────────────────────────────────────────────

class Purchase(models.Model):
    """
    Purchase order header.

    Status flow
    ───────────
      DRAFT     ──► RECEIVED (full receipt — creates FIFO layers)
                ──► PARTIAL  (partial receipt)
                ──► CANCELLED

    Payment status
    ──────────────
      DUE → PARTIAL → PAID
    """

    class Status(models.TextChoices):
        DRAFT     = "draft",     "Draft"
        RECEIVED  = "received",  "Received"
        PARTIAL   = "partial",   "Partial"
        CANCELLED = "cancelled", "Cancelled"

    class PaymentStatus(models.TextChoices):
        DUE     = "due",     "Due"
        PARTIAL = "partial", "Partial"
        PAID    = "paid",    "Paid"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_no    = models.CharField(max_length=80, unique=True, db_index=True)
    supplier        = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="purchases")
    location        = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="purchases")
    purchase_date   = models.DateField(default=timezone.localdate)

    status          = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT, db_index=True,
    )
    payment_status  = models.CharField(
        max_length=20, choices=PaymentStatus.choices, default=PaymentStatus.DUE, db_index=True,
    )

    # Money totals
    subtotal        = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    discount_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    tax_amount      = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    shipping_cost   = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    grand_total     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    paid_amount     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    notes           = models.TextField(blank=True)
    # Shipping details — free-text "deliver to / packed by" copy the
    # tenant types on Add Purchase. Surfaced on the View modal.
    shipping_details = models.TextField(blank=True, default="")

    # Audit log of edits — list of {at, by, action, summary} dicts.
    # Each PATCH appends one row; the action menu's History modal
    # reads this column directly.
    edit_history    = models.JSONField(default=list, blank=True)

    # Bare UUID — accounts.User lives in master DB
    added_by_id     = models.UUIDField(null=True, blank=True, db_index=True)
    added_by_name   = models.CharField(max_length=200, blank=True)

    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "purchases"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["purchase_date"]),
            models.Index(fields=["status", "payment_status"]),
        ]

    def __str__(self):
        return f"{self.reference_no} — {self.supplier.name}"

    @property
    def payment_due(self) -> Decimal:
        return (self.grand_total or Decimal("0")) - (self.paid_amount or Decimal("0"))

    def recompute_payment_status(self):
        due = self.payment_due
        if due <= Decimal("0"):
            self.payment_status = self.PaymentStatus.PAID
        elif self.paid_amount and self.paid_amount > Decimal("0"):
            self.payment_status = self.PaymentStatus.PARTIAL
        else:
            self.payment_status = self.PaymentStatus.DUE


class PurchaseItem(models.Model):
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    purchase      = models.ForeignKey(Purchase, on_delete=models.CASCADE, related_name="items")
    product       = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="purchase_items")
    product_name  = models.CharField(max_length=200, blank=True)  # snapshot
    sku           = models.CharField(max_length=50, blank=True)   # snapshot

    quantity      = models.DecimalField(max_digits=14, decimal_places=4)
    unit_cost     = models.DecimalField(max_digits=14, decimal_places=4)
    tax_rate      = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal("0"))
    discount      = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    line_total    = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    received_qty  = models.DecimalField(max_digits=14, decimal_places=4, default=Decimal("0"))

    class Meta:
        db_table = "purchase_items"
        ordering = ["id"]


class PurchasePayment(models.Model):
    class Method(models.TextChoices):
        CASH          = "cash",          "Cash"
        CARD          = "card",          "Card"
        BANK_TRANSFER = "bank_transfer", "Bank Transfer"
        MOBILE        = "mobile",        "Mobile Money"
        OTHER         = "other",         "Other"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    purchase      = models.ForeignKey(Purchase, on_delete=models.CASCADE, related_name="payments")
    amount        = models.DecimalField(max_digits=14, decimal_places=2)
    method        = models.CharField(max_length=20, choices=Method.choices, default=Method.CASH)
    reference     = models.CharField(max_length=120, blank=True)
    notes         = models.TextField(blank=True)
    # Which cash box / bank / MFS wallet the supplier payment came
    # OUT of. Bare UUID (no FK) because PaymentAccount lives in the
    # accounting app — same pattern as sales.SalePayment.
    payment_account_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of the accounting.PaymentAccount this payment was made from.",
    )
    paid_at       = models.DateTimeField(default=timezone.now)
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "purchase_payments"
        ordering = ["-paid_at"]


# ──────────────────────────────────────────────────────────────────────────────
# Purchase Return
# ──────────────────────────────────────────────────────────────────────────────

class PurchaseReturn(models.Model):
    class Status(models.TextChoices):
        DRAFT     = "draft",     "Draft"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_no  = models.CharField(max_length=80, unique=True, db_index=True)
    purchase      = models.ForeignKey(Purchase, on_delete=models.PROTECT, related_name="returns",
                                       null=True, blank=True)
    supplier      = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="returns")
    location      = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="purchase_returns")
    return_date   = models.DateField(default=timezone.localdate)
    status        = models.CharField(max_length=20, choices=Status.choices, default=Status.COMPLETED)
    total_amount  = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    notes         = models.TextField(blank=True)

    added_by_id   = models.UUIDField(null=True, blank=True)
    added_by_name = models.CharField(max_length=200, blank=True)

    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "purchase_returns"
        ordering = ["-created_at"]


class PurchaseReturnPayment(models.Model):
    """Refund payment from a supplier against a PurchaseReturn.

    Each row debits the chosen PaymentAccount via a
    PaymentAccountTransaction (DEPOSIT, positive amount), since a
    return refund is money IN. Edits reverse the prior ledger row
    and post a fresh one; deletes reverse cleanly so the operator
    can correct mistakes without messing up the account balances.
    """
    class Method(models.TextChoices):
        CASH          = "cash",          "Cash"
        CARD          = "card",          "Card"
        CHEQUE        = "cheque",        "Cheque"
        BANK_TRANSFER = "bank_transfer", "Bank Transfer"
        MOBILE        = "mobile",        "Mobile Money"
        OTHER         = "other",         "Other"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    purchase_return = models.ForeignKey(
        "PurchaseReturn", on_delete=models.CASCADE, related_name="payments",
    )
    reference_no  = models.CharField(max_length=80, blank=True, default="")
    amount        = models.DecimalField(max_digits=14, decimal_places=2)
    method        = models.CharField(max_length=20, choices=Method.choices, default=Method.CASH)
    reference     = models.CharField(max_length=120, blank=True, default="")
    notes         = models.TextField(blank=True, default="")
    payment_account_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of accounting.PaymentAccount that received the refund.",
    )
    paid_at       = models.DateTimeField(default=timezone.now)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "purchase_return_payments"
        ordering = ["-paid_at"]


class PurchaseReturnItem(models.Model):
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    purchase_return = models.ForeignKey(PurchaseReturn, on_delete=models.CASCADE, related_name="items")
    product       = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="purchase_return_items")
    product_name  = models.CharField(max_length=200, blank=True)
    sku           = models.CharField(max_length=50, blank=True)
    quantity      = models.DecimalField(max_digits=14, decimal_places=4)
    unit_cost     = models.DecimalField(max_digits=14, decimal_places=4)
    line_total    = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    class Meta:
        db_table = "purchase_return_items"
        ordering = ["id"]
