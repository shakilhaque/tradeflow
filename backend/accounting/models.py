"""
Accounting models — tenant database.

All tables live in the per-tenant PostgreSQL database.
No foreign keys cross to the master database (accounts.User is stored
as a bare UUIDField where an actor reference is needed).

Tables
──────
  chart_of_accounts     — hierarchical account tree
  journal_entries       — one header per financial event
  journal_entry_lines   — debit / credit lines (always balanced)
  expenses              — operational expense records
"""

import uuid
from decimal import Decimal

from django.db import models
from django.db.models import Q, Sum
from django.utils import timezone


# ──────────────────────────────────────────────────────────────────────────────
# 1. Account  (Chart of Accounts)
# ──────────────────────────────────────────────────────────────────────────────

class Account(models.Model):
    """
    One node in the Chart of Accounts.

    Normal-balance convention
    ─────────────────────────
      ASSET / COGS / EXPENSE  →  DEBIT  normal balance
      LIABILITY / EQUITY / INCOME  →  CREDIT  normal balance
      is_contra=True inverts the normal balance (e.g. Sales Discounts is an
      INCOME account with DEBIT normal balance).

    balance property
    ────────────────
      Returns the net balance in the direction of the normal balance.
      Positive  → account has a normal balance.
      Negative  → account has an abnormal balance (rare; signals data error).
    """

    class Type(models.TextChoices):
        ASSET     = "ASSET",     "Asset"
        LIABILITY = "LIABILITY", "Liability"
        EQUITY    = "EQUITY",    "Equity"
        INCOME    = "INCOME",    "Income"
        COGS      = "COGS",      "Cost of Goods Sold"
        EXPENSE   = "EXPENSE",   "Expense"

    _DEBIT_TYPES: frozenset = frozenset({"ASSET", "COGS", "EXPENSE"})

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code         = models.CharField(
        max_length=20, unique=True,
        help_text="Numeric code (e.g. 1001). Unique across the tenant.",
    )
    name         = models.CharField(max_length=200)
    account_type = models.CharField(max_length=20, choices=Type.choices, db_index=True)
    parent       = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="children",
    )
    is_contra    = models.BooleanField(
        default=False,
        help_text="Contra-accounts have the opposite normal balance of their type. "
                  "Example: Sales Discounts (INCOME type, DEBIT normal balance).",
    )
    is_system    = models.BooleanField(
        default=False,
        help_text="System accounts are seeded automatically and cannot be deleted.",
    )

    # ── Locality — global vs branch-scoped ───────────────────────────────────
    # Digital balances (central bank, central bKash) are GLOBAL: one ledger
    # serves every branch. Physical assets (Cash in Hand, Petty Cash) are
    # BRANCH-SCOPED: each branch owns its own row. A CHECK constraint
    # enforces the dichotomy — global ↔ location IS NULL.
    is_global    = models.BooleanField(
        default=True, db_index=True,
        help_text=(
            "True  = shared across every branch (digital funds, central "
            "bank/MFS accounts). One row, one balance.\n"
            "False = pinned to a specific branch. Cashiers at other branches "
            "cannot touch it. `location` must be set."
        ),
    )
    location     = models.ForeignKey(
        "inventory.Location",
        on_delete=models.PROTECT,
        null=True, blank=True,
        related_name="accounts",
        help_text="Branch this account belongs to. NULL when is_global=True.",
    )

    is_active    = models.BooleanField(default=True, db_index=True)
    description  = models.TextField(blank=True)
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "chart_of_accounts"
        ordering = ["code"]
        indexes  = [
            models.Index(fields=["account_type", "is_active"], name="acct_type_active_idx"),
            models.Index(fields=["is_global", "location"], name="acct_locality_idx"),
        ]
        constraints = [
            # Mutual exclusivity: global ⟺ NOT location-pinned.
            models.CheckConstraint(
                check=(Q(is_global=True, location__isnull=True)
                       | Q(is_global=False, location__isnull=False)),
                name="account_locality_consistent",
            ),
        ]

    def __str__(self):
        return f"{self.code} — {self.name}"

    # ── Normal balance ────────────────────────────────────────────────────────

    @property
    def normal_balance(self) -> str:
        """'DEBIT' or 'CREDIT' depending on account type and is_contra."""
        base_is_debit = self.account_type in self._DEBIT_TYPES
        if self.is_contra:
            base_is_debit = not base_is_debit
        return "DEBIT" if base_is_debit else "CREDIT"

    # ── Balance computation ───────────────────────────────────────────────────

    def get_balance(self, *, date_from=None, date_to=None, location_id=None) -> Decimal:
        """
        Net balance in the normal-balance direction.

        For DEBIT-normal accounts:  balance = Σ debit − Σ credit
        For CREDIT-normal accounts: balance = Σ credit − Σ debit

        When `location_id` is supplied, only journal lines tagged to that
        branch are aggregated. For GLOBAL accounts this gives the per-branch
        CONTRIBUTION to the shared balance (e.g. "how much did Branch A
        deposit into central bKash this period"). For BRANCH-SCOPED accounts
        the location_id is redundant — the account is already pinned to one
        branch — but passing it does no harm.
        """
        # Multi-branch: when the caller doesn't pin a location, fall back to
        # the active branch so accounting balances (trial balance, P&L,
        # balance sheet) are isolated per branch. None (owner consolidated)
        # leaves the balance tenant-wide.
        if location_id is None:
            from accounts.branch_context import active_branch_id  # noqa: PLC0415
            location_id = active_branch_id()

        qs = self.journal_lines.all()
        if date_from:
            qs = qs.filter(journal_entry__date__gte=date_from)
        if date_to:
            qs = qs.filter(journal_entry__date__lte=date_to)
        if location_id:
            qs = qs.filter(location_id=location_id)

        agg = qs.aggregate(dr=Sum("debit"), cr=Sum("credit"))
        dr  = agg["dr"] or Decimal("0")
        cr  = agg["cr"] or Decimal("0")
        return (dr - cr) if self.normal_balance == "DEBIT" else (cr - dr)


# ──────────────────────────────────────────────────────────────────────────────
# 2. JournalEntry  (transaction header)
# ──────────────────────────────────────────────────────────────────────────────

class JournalEntry(models.Model):
    """
    Immutable header for one balanced accounting transaction.

    Every financial event (sale, payment, expense, purchase receipt, …)
    creates exactly one or more JournalEntry rows, each with a set of
    JournalEntryLine rows that sum to zero (Σ debit = Σ credit).
    """

    class ReferenceType(models.TextChoices):
        SALE       = "SALE",       "Sale"
        PURCHASE   = "PURCHASE",   "Purchase"
        EXPENSE    = "EXPENSE",    "Expense"
        PAYMENT    = "PAYMENT",    "Payment"
        ADJUSTMENT = "ADJUSTMENT", "Adjustment"
        OPENING    = "OPENING",    "Opening Entry"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry_number   = models.CharField(
        max_length=30, unique=True,
        help_text="Sequential per-month identifier, e.g. JE-202604-0001.",
    )
    reference_type = models.CharField(
        max_length=20, choices=ReferenceType.choices, db_index=True,
    )
    reference_id   = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of the source document (Sale, Expense, …).",
    )
    date           = models.DateField(default=timezone.localdate, db_index=True)
    description    = models.TextField()
    is_posted      = models.BooleanField(
        default=True,
        help_text="Posted entries are final and cannot be edited.",
    )
    created_by_id  = models.UUIDField(
        null=True, blank=True,
        help_text="UUID of the User who triggered this entry.",
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "journal_entries"
        ordering = ["-date", "-created_at"]
        indexes  = [
            models.Index(fields=["reference_type", "reference_id"], name="je_ref_idx"),
            models.Index(fields=["date"],                            name="je_date_idx"),
        ]

    def __str__(self):
        return f"{self.entry_number} [{self.reference_type}] {self.date}"

    @property
    def total_debit(self) -> Decimal:
        return self.lines.aggregate(t=Sum("debit"))["t"] or Decimal("0")

    @property
    def total_credit(self) -> Decimal:
        return self.lines.aggregate(t=Sum("credit"))["t"] or Decimal("0")

    @property
    def is_balanced(self) -> bool:
        return self.total_debit == self.total_credit


# ──────────────────────────────────────────────────────────────────────────────
# 3. JournalEntryLine  (debit / credit legs)
# ──────────────────────────────────────────────────────────────────────────────

class JournalEntryLine(models.Model):
    """
    One debit or credit leg of a journal entry.

    Constraints
    ───────────
    • A line may not have both debit > 0 and credit > 0 simultaneously.
    • A line with both = 0 is allowed (rare but valid for zero-value splits).
    • The balancing constraint (Σ debit = Σ credit) is enforced in the
      service layer before bulk_create, not at the DB level.
    """

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    journal_entry = models.ForeignKey(
        JournalEntry, on_delete=models.CASCADE, related_name="lines",
    )
    account       = models.ForeignKey(
        Account, on_delete=models.PROTECT, related_name="journal_lines",
    )
    # ── Transaction-level branch tag ─────────────────────────────────────────
    # ALWAYS the branch where the transaction physically happened, regardless
    # of where the account "lives". When a Branch-A sale lands money in the
    # global bKash account, the credit line on bKash gets location=Branch-A
    # so reports can split the global balance by source branch.
    #
    # nullable in the schema (legacy rows pre-locality), required at the API /
    # service boundary for every new entry.
    location      = models.ForeignKey(
        "inventory.Location",
        on_delete=models.PROTECT,
        null=True, blank=True,
        related_name="journal_lines",
        db_index=True,
        help_text=(
            "Branch this debit/credit is attributed to — the source of truth "
            "for per-branch P&L. Set to the branch making the transaction, "
            "NOT the home branch of the account."
        ),
    )
    description   = models.CharField(max_length=300, blank=True)
    debit         = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
    )
    credit        = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("0"),
    )

    class Meta:
        db_table = "journal_entry_lines"
        constraints = [
            models.CheckConstraint(
                check=~Q(debit__gt=0, credit__gt=0),
                name="jel_no_simultaneous_debit_and_credit",
            ),
            models.CheckConstraint(
                check=Q(debit__gte=0) & Q(credit__gte=0),
                name="jel_non_negative_amounts",
            ),
        ]
        indexes = [
            models.Index(fields=["location", "account"], name="jel_loc_account_idx"),
        ]

    def __str__(self):
        if self.debit:
            return f"DR {self.account.code}  {self.debit}"
        return f"CR {self.account.code}  {self.credit}"


# ──────────────────────────────────────────────────────────────────────────────
# 4. Expense
# ──────────────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────────────
# Expense Category (master data)
# ──────────────────────────────────────────────────────────────────────────────

class ExpenseCategory(models.Model):
    """
    User-managed expense category master.

    Supports a single level of sub-categories via a self-referential `parent`.
    The catalog drives the dropdown on the Add Expense page.
    """

    id        = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name      = models.CharField(max_length=100)
    code      = models.CharField(max_length=40, blank=True, default="")
    parent    = models.ForeignKey(
        "self",
        null=True, blank=True,
        on_delete=models.PROTECT,
        related_name="children",
        help_text="Set when this row is a sub-category of another category.",
    )
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "expense_categories"
        ordering = ["parent_id", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["name", "parent"],
                name="uniq_expense_category_name_per_parent",
            ),
        ]

    def __str__(self):
        return self.name


def _generate_expense_ref(using: str | None = None) -> str:
    """Reference like EP2026/0001 (year + 4-digit serial).

    Pass `using=` when called from a tenant context — by default the query
    would hit the master DB, which doesn't have the `expenses` table.
    """
    yr = timezone.now().year
    qs = Expense.objects.using(using) if using else Expense.objects
    last = (
        qs.filter(reference_no__startswith=f"EP{yr}/")
        .order_by("-reference_no")
        .first()
    )
    serial = 1
    if last and last.reference_no:
        try:
            serial = int(last.reference_no.split("/")[-1]) + 1
        except (TypeError, ValueError):
            serial = 1
    return f"EP{yr}/{serial:04d}"


class Expense(models.Model):
    """
    Operational expense record.

    Each expense creates one balanced journal entry:
        DR  expense_account (6xxx)    amount
            CR  payment_account (1xxx)    amount
    """

    class Category(models.TextChoices):
        RENT      = "RENT",      "Rent"
        UTILITIES = "UTILITIES", "Utilities"
        SALARIES  = "SALARIES",  "Salaries"
        MARKETING = "MARKETING", "Marketing"
        SUPPLIES  = "SUPPLIES",  "Supplies"
        TRANSPORT = "TRANSPORT", "Transport"
        OTHER     = "OTHER",     "Other"

    class PaymentStatus(models.TextChoices):
        PAID    = "paid",    "Paid"
        PARTIAL = "partial", "Partial"
        DUE     = "due",     "Due"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_no    = models.CharField(
        max_length=40, unique=True, blank=True, null=True,
        help_text="Auto-generated like EP2026/0001 if left blank.",
    )
    category        = models.CharField(
        max_length=30, choices=Category.choices, db_index=True,
    )
    expense_account = models.ForeignKey(
        Account,
        on_delete=models.PROTECT,
        related_name="expenses_as_expense",
        help_text="Expense / COGS account that is debited.",
    )
    payment_account = models.ForeignKey(
        Account,
        on_delete=models.PROTECT,
        related_name="expenses_as_payment",
        help_text="Cash / Bank / Mobile account that is credited.",
    )
    amount          = models.DecimalField(max_digits=14, decimal_places=2)
    tax_amount      = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    paid_amount     = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    payment_status  = models.CharField(
        max_length=10, choices=PaymentStatus.choices, default=PaymentStatus.DUE, db_index=True,
    )

    # Cross-app refs stored as UUID (no FK constraint — Location lives in inventory app).
    location_id     = models.UUIDField(null=True, blank=True, db_index=True)

    expense_for     = models.CharField(max_length=200, blank=True, default="")
    contact_name    = models.CharField(max_length=200, blank=True, default="")
    # Customer FK so "Expense for contact" can be reported by tenant
    # contact later (UUID is stored without a hard FK constraint —
    # Customer lives in the sales app; we don't want a cross-app
    # cascade delete here).
    contact_id      = models.UUIDField(null=True, blank=True, db_index=True,
                                       help_text="Optional Customer this expense relates to.")
    # User-managed taxonomy reference (replaces the hardcoded
    # Category choices). Keeps the old `category` text column for
    # back-compat reads.
    expense_category = models.ForeignKey(
        ExpenseCategory, on_delete=models.PROTECT, null=True, blank=True,
        related_name="expenses",
    )
    expense_sub_category = models.ForeignKey(
        ExpenseCategory, on_delete=models.PROTECT, null=True, blank=True,
        related_name="sub_expenses",
    )
    # User-facing PaymentAccount the cashier picked (no hard FK — the
    # PaymentAccount model lives in the same app but we want a SET
    # NULL on delete via a soft UUID reference for simplicity).
    payment_account_picked_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="PaymentAccount UUID the cashier chose. Drives the "
                  "PaymentAccountTransaction row written on save.",
    )
    # Method-specific extras (Card / Cheque / Bank Transfer). All
    # optional — only filled when the cashier picks that method.
    payment_method  = models.CharField(max_length=20, blank=True, default="")
    card_holder_name = models.CharField(max_length=120, blank=True, default="")
    card_transaction_no = models.CharField(max_length=120, blank=True, default="")
    card_type        = models.CharField(max_length=20, blank=True, default="")
    card_month       = models.CharField(max_length=2, blank=True, default="")
    card_year        = models.CharField(max_length=4, blank=True, default="")
    cheque_no        = models.CharField(max_length=60, blank=True, default="")
    bank_account_no  = models.CharField(max_length=60, blank=True, default="")
    # Attached document URL after upload (stored in /media or S3).
    attach_document_url = models.URLField(max_length=500, blank=True, default="")

    recurring       = models.BooleanField(default=False)
    recurring_details = models.CharField(max_length=200, blank=True, default="")

    description     = models.TextField(blank=True)
    expense_date    = models.DateField(default=timezone.localdate, db_index=True)
    journal_entry   = models.OneToOneField(
        JournalEntry,
        on_delete=models.PROTECT,
        null=True, blank=True,
        related_name="expense",
    )
    created_by_id   = models.UUIDField(
        help_text="UUID of the User who recorded this expense.",
    )
    created_at      = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "expenses"
        ordering = ["-expense_date", "-created_at"]

    def __str__(self):
        return f"{self.reference_no or self.get_category_display()} — {self.amount}"

    def save(self, *args, **kwargs):
        if not self.reference_no:
            self.reference_no = _generate_expense_ref(using=kwargs.get("using"))
        super().save(*args, **kwargs)


class ExpensePayment(models.Model):
    """Cash-out payment against an Expense.

    The initial expense save writes one ExpensePayment row + the
    matching PaymentAccountTransaction (kind=EXPENSE, negative). The
    View Payments modal lets the operator add / edit / delete more
    payments — each mutation reverses the OLD ledger row and posts a
    fresh one so the linked PaymentAccount balance stays correct.
    """
    class Method(models.TextChoices):
        CASH          = "cash",          "Cash"
        CARD          = "card",          "Card"
        CHEQUE        = "cheque",        "Cheque"
        BANK_TRANSFER = "bank_transfer", "Bank Transfer"
        MOBILE        = "mobile",        "Mobile Money"
        OTHER         = "other",         "Other"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    expense       = models.ForeignKey(
        "Expense", on_delete=models.CASCADE, related_name="payments",
    )
    reference_no  = models.CharField(max_length=80, blank=True, default="")
    amount        = models.DecimalField(max_digits=14, decimal_places=2)
    method        = models.CharField(max_length=20, choices=Method.choices, default=Method.CASH)
    reference     = models.CharField(max_length=120, blank=True, default="")
    notes         = models.TextField(blank=True, default="")
    payment_account_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of the accounting.PaymentAccount the money came OUT of.",
    )
    paid_at       = models.DateTimeField(default=timezone.now)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "expense_payments"
        ordering = ["-paid_at"]


# ──────────────────────────────────────────────────────────────────────────────
# Payment Account (Cash / Bank / MFS accounts that POS payments land in)
# ──────────────────────────────────────────────────────────────────────────────

class PaymentAccount(models.Model):
    """
    Where money received from sales / payments lives.

    Distinct from the chart-of-accounts Account (which is for full
    double-entry bookkeeping). PaymentAccount is the user-facing list of
    cash boxes, bank accounts, and mobile-financial-service (bKash, Nagad)
    wallets — what the POS terminal credits when a sale is paid.
    """

    class AccountType(models.TextChoices):
        CASH = "CASH", "Cash Balance"
        BANK = "BANK", "Bank Balance"
        MFS  = "MFS",  "Mobile Banking"
        CARD = "CARD", "Card / Gateway"
        OTHER = "OTHER", "Other"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name            = models.CharField(max_length=120)
    account_number  = models.CharField(max_length=120, blank=True, default="")
    account_type    = models.CharField(
        max_length=12, choices=AccountType.choices, default=AccountType.CASH, db_index=True,
    )
    sub_type        = models.CharField(max_length=120, blank=True, default="")
    opening_balance = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    note            = models.TextField(blank=True, default="")
    details         = models.JSONField(default=list, blank=True, help_text="[{label, value}, …]")
    added_by_name   = models.CharField(max_length=120, blank=True, default="")
    is_active       = models.BooleanField(default=True)
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "payment_accounts"
        ordering = ["-is_active", "name"]

    def __str__(self):
        return f"{self.name} ({self.get_account_type_display()})"


# ──────────────────────────────────────────────────────────────────────────────
# PaymentAccountTransaction — ledger row for deposits / transfers / sales
# ──────────────────────────────────────────────────────────────────────────────

class PaymentAccountTransaction(models.Model):
    """
    Immutable ledger entry against a PaymentAccount.

    `amount` is signed:
        positive  → credit to the account (money in)
        negative  → debit  from the account (money out)

    A Fund Transfer creates TWO rows in a single transaction — one negative
    on the source account, one positive on the destination — linked by
    `counter_account` so the ledger is auditable.
    """

    class Kind(models.TextChoices):
        DEPOSIT      = "DEPOSIT",      "Deposit"
        WITHDRAWAL   = "WITHDRAWAL",   "Withdrawal"
        TRANSFER_IN  = "TRANSFER_IN",  "Transfer In"
        TRANSFER_OUT = "TRANSFER_OUT", "Transfer Out"
        SALE         = "SALE",         "Sale Payment"
        EXPENSE      = "EXPENSE",      "Expense Payment"
        ADJUSTMENT   = "ADJUSTMENT",   "Adjustment"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account         = models.ForeignKey(
        PaymentAccount, on_delete=models.CASCADE, related_name="transactions",
    )
    kind            = models.CharField(max_length=20, choices=Kind.choices, db_index=True)
    amount          = models.DecimalField(max_digits=14, decimal_places=2,
                                          help_text="Signed: positive=credit, negative=debit")
    reference       = models.CharField(max_length=120, blank=True, default="")
    note            = models.TextField(blank=True, default="")
    counter_account = models.ForeignKey(
        PaymentAccount, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="counter_transactions",
        help_text="The OTHER account in a fund-transfer pair.",
    )
    transaction_date = models.DateTimeField(default=timezone.now, db_index=True)
    created_by_name  = models.CharField(max_length=120, blank=True, default="")
    created_at       = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment_account_transactions"
        ordering = ["-transaction_date", "-created_at"]
        indexes  = [
            models.Index(fields=["account", "-transaction_date"], name="pa_txn_acct_date_idx"),
        ]

    def __str__(self):
        return f"{self.kind} {self.amount} on {self.account_id}"


# ──────────────────────────────────────────────────────────────────────────────
# PaymentLink — maps a payment reference (SP/EP/PP-…) to a PaymentAccount
# ──────────────────────────────────────────────────────────────────────────────

class PaymentLink(models.Model):
    """
    Lightweight mapping used by the Payment Account Report page.

    Every payment recorded in the system (sale, expense, purchase) gets a
    human-readable reference number. This table lets the tenant assign each
    of those references to one of their PaymentAccount rows so they can later
    answer "which cash box / bank account does this payment belong to?".

    The mapping is purely informational — it does NOT alter PaymentAccount
    balances. If/when we want to wire balances to these links, we'll
    create matching PaymentAccountTransaction rows on save.
    """

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_ref      = models.CharField(max_length=120, unique=True,
                                       help_text="Payment reference, e.g. SP2026/1722 or EP2026/0139.")
    source_type     = models.CharField(max_length=20, blank=True, default="",
                                       help_text="SALE_PAYMENT / EXPENSE / PURCHASE / OTHER")
    payment_account = models.ForeignKey(
        PaymentAccount, on_delete=models.CASCADE, related_name="payment_links",
    )
    note            = models.CharField(max_length=200, blank=True, default="")
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "payment_links"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["payment_account", "source_type"], name="pl_acct_type_idx"),
        ]

    def __str__(self):
        return f"{self.source_ref} → {self.payment_account_id}"
