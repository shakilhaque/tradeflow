"""
Accounting service layer — double-entry engine + financial reports.

Public API — Transactions
─────────────────────────
  create_journal_entry(...)     Core engine: balanced JE creation.
  post_sale_entry(...)          Revenue + COGS entries when sale is FINAL.
  post_payment_entry(...)       Cash receipt when payment is recorded on a sale.
  post_purchase_entry(...)      Inventory + payable when goods are received.
  record_expense(...)           Expense record + debit-expense/credit-cash JE.
  post_void_entry(...)          Reversal entries when a sale is voided.

Public API — Reports
─────────────────────
  get_ledger(...)               Account statement with running balance.
  get_trial_balance(...)        All accounts — total DR, total CR, net balance.
  get_profit_and_loss(...)      Revenue − COGS − Expenses = Net Profit.
  get_balance_sheet(...)        Assets = Liabilities + Equity (as-of snapshot).
  get_cash_flow(...)            Cash inflows and outflows for a period.

DOUBLE-ENTRY RULES
──────────────────
  1. Every JE must be balanced: Σ debit = Σ credit (enforced before write).
  2. All JE creation is inside transaction.atomic(using=_current_db()).
  3. No account balance is updated directly — only via journal lines.
  4. Accounting failure rolls back the triggering business operation.

SYSTEM ACCOUNT CODES
────────────────────
  1001  Cash               (Asset)
  1002  Bank Account       (Asset)
  1003  Mobile Wallet      (Asset)
  1100  Accounts Receivable(Asset)
  1200  Inventory          (Asset)
  2100  Accounts Payable   (Liability)
  2200  Tax Payable        (Liability)
  4100  Sales Revenue      (Income)
  4900  Sales Discounts    (Income — contra, debit normal)
  5000  Cost of Goods Sold (COGS)
"""

import logging
import uuid
from datetime import date as date_type
from decimal import Decimal
from typing import Optional

from django.db import transaction
from django.db.models import F, Q, Sum
from django.utils import timezone

from accounts.branch_context import branch_scope
from .models import Account, Expense, JournalEntry, JournalEntryLine

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# System account codes — must match seed migration exactly
# ──────────────────────────────────────────────────────────────────────────────

CODE_CASH            = "1001"
CODE_BANK            = "1002"
CODE_MOBILE_WALLET   = "1003"
CODE_AR              = "1100"   # Accounts Receivable
CODE_INVENTORY       = "1200"
CODE_AP              = "2100"   # Accounts Payable
CODE_TAX_PAYABLE     = "2200"
CODE_SALES_REVENUE   = "4100"
CODE_SALES_DISCOUNTS = "4900"   # contra-revenue (debit-normal)
CODE_COGS            = "5000"   # Cost of Goods Sold

# Maps SalePayment.method → cash/bank account code
PAYMENT_METHOD_CODES: dict[str, str] = {
    "CASH":          CODE_CASH,
    "CARD":          CODE_BANK,
    "BANK_TRANSFER": CODE_BANK,
    "MOBILE":        CODE_MOBILE_WALLET,
    "OTHER":         CODE_CASH,
}


# ──────────────────────────────────────────────────────────────────────────────
# Custom exception
# ──────────────────────────────────────────────────────────────────────────────

class AccountingError(Exception):
    """Raised for accounting validation failures (unbalanced JE, missing account…)."""


# ──────────────────────────────────────────────────────────────────────────────
# DB alias helper
# ──────────────────────────────────────────────────────────────────────────────

def _current_db() -> str:
    try:
        from accounts.tenant_db import get_current_db_alias  # noqa: PLC0415
        return get_current_db_alias() or "default"
    except ImportError:
        return "default"


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _get_account(code: str) -> Account:
    """Fetch a system account by its code or raise AccountingError."""
    try:
        return Account.objects.get(code=code, is_active=True)
    except Account.DoesNotExist:
        raise AccountingError(
            f"System account '{code}' not found. "
            "Ensure the chart-of-accounts migration has been applied to this tenant DB."
        )


def _validate_balanced(lines: list[dict]) -> None:
    """Raise AccountingError if Σ debit ≠ Σ credit."""
    total_dr = sum(Decimal(str(l.get("debit",  0))) for l in lines)
    total_cr = sum(Decimal(str(l.get("credit", 0))) for l in lines)
    if total_dr != total_cr:
        raise AccountingError(
            f"Journal entry is not balanced — "
            f"Σ Debit = {total_dr:.2f},  Σ Credit = {total_cr:.2f}."
        )


def _generate_entry_number() -> str:
    """Sequential per-month JE number: JE-YYYYMM-NNNN."""
    now    = timezone.now()
    prefix = f"JE-{now.year}{now.month:02d}-"
    last   = (
        JournalEntry.objects
        .filter(entry_number__startswith=prefix)
        .order_by("-entry_number")
        .values_list("entry_number", flat=True)
        .first()
    )
    seq = 1
    if last:
        try:
            seq = int(last.split("-")[-1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f"{prefix}{seq:04d}"


# ──────────────────────────────────────────────────────────────────────────────
# 1. Core engine — create_journal_entry
# ──────────────────────────────────────────────────────────────────────────────

def create_journal_entry(
    *,
    reference_type: str,
    description: str,
    lines: list[dict],
    reference_id=None,
    date=None,
    created_by_id=None,
) -> JournalEntry:
    """
    Create a balanced journal entry (the core double-entry engine).

    Parameters
    ──────────
    reference_type   One of JournalEntry.ReferenceType choices.
    description      Human-readable summary of the transaction.
    lines            List of dicts:
                     [
                       {"account_id": UUID, "debit": Decimal, "credit": 0,
                        "description": "..."},
                       {"account_id": UUID, "debit": 0, "credit": Decimal},
                       ...
                     ]
                     Each line must have either debit > 0 or credit > 0
                     (not both simultaneously — enforced by DB constraint).
    reference_id     UUID of the source document (optional).
    date             Defaults to today.
    created_by_id    UUID of the acting user (optional).

    Raises
    ──────
    AccountingError  — if the entry is not balanced.
    """
    if not lines:
        raise AccountingError("A journal entry must have at least one line.")

    _validate_balanced(lines)

    with transaction.atomic(using=_current_db()):
        je = JournalEntry.objects.create(
            entry_number   = _generate_entry_number(),
            reference_type = reference_type,
            reference_id   = reference_id,
            date           = date or timezone.localdate(),
            description    = description,
            created_by_id  = created_by_id,
        )
        JournalEntryLine.objects.bulk_create([
            JournalEntryLine(
                journal_entry = je,
                account_id    = line["account_id"],
                description   = line.get("description", ""),
                debit         = Decimal(str(line.get("debit",  0))),
                credit        = Decimal(str(line.get("credit", 0))),
            )
            for line in lines
        ])

        logger.info(
            "JE created: %s  ref=%s/%s  lines=%d  Σ=%.2f",
            je.entry_number, reference_type, reference_id,
            len(lines),
            sum(Decimal(str(l.get("debit", 0))) for l in lines),
        )
        return je


# ──────────────────────────────────────────────────────────────────────────────
# 2. Sales integration
# ──────────────────────────────────────────────────────────────────────────────

def post_sale_entry(*, sale, created_by_id=None) -> list[JournalEntry]:
    """
    Create two balanced journal entries when a sale is finalised.

    Entry 1 — Revenue recognition
    ─────────────────────────────
    DR  Accounts Receivable (1100)    sale.total_amount
    DR  Sales Discounts (4900)        sale.discount        ← only if discount > 0
        CR  Sales Revenue (4100)          sale.subtotal
        CR  Tax Payable (2200)            sale.tax_amount

    Balance proof (discount D, subtotal S, tax T, total = S−D+T):
      DR side = (S−D+T) + D = S+T
      CR side = S + T  ✓

    Entry 2 — Cost of Goods Sold
    ────────────────────────────
    DR  Cost of Goods Sold (5000)    Σ SaleItem.cogs
        CR  Inventory (1200)              Σ SaleItem.cogs

    Returns list of created JournalEntry objects (1 or 2).
    """
    ar_acct       = _get_account(CODE_AR)
    disc_acct     = _get_account(CODE_SALES_DISCOUNTS)
    rev_acct      = _get_account(CODE_SALES_REVENUE)
    tax_acct      = _get_account(CODE_TAX_PAYABLE)
    cogs_acct     = _get_account(CODE_COGS)
    inv_acct      = _get_account(CODE_INVENTORY)

    total_cogs = (
        sale.items.aggregate(total=Sum("cogs"))["total"] or Decimal("0")
    )

    # Shipping + extra charges were ADDED to sale.total_amount on the
    # AR (debit) side by create_sale_advanced, but they're not part of
    # subtotal/tax. Without a matching credit line the journal would be
    # imbalanced by exactly the addon amount (the "Σ Debit ≠ Σ Credit"
    # error tenants hit when a sale had shipping or an extra charge).
    # We credit them to Sales Revenue so the entry balances and the
    # income is recognised.
    addons = (
        (sale.shipping_charges or Decimal("0"))
        + (sale.extra_charges or Decimal("0"))
    ).quantize(Decimal("0.01"))

    # ── Entry 1: Revenue recognition ─────────────────────────────────────────
    lines_1 = [
        {
            "account_id":  ar_acct.id,
            "debit":       sale.total_amount,
            "credit":      Decimal("0"),
            "description": f"Receivable — {sale.invoice_number}",
        },
        {
            "account_id":  rev_acct.id,
            "debit":       Decimal("0"),
            "credit":      sale.subtotal,
            "description": f"Gross sales — {sale.invoice_number}",
        },
        {
            "account_id":  tax_acct.id,
            "debit":       Decimal("0"),
            "credit":      sale.tax_amount,
            "description": "Tax collected",
        },
    ]
    if sale.discount > Decimal("0"):
        lines_1.append({
            "account_id":  disc_acct.id,
            "debit":       sale.discount,
            "credit":      Decimal("0"),
            "description": f"Header discount — {sale.invoice_number}",
        })
    if addons > Decimal("0"):
        lines_1.append({
            "account_id":  rev_acct.id,
            "debit":       Decimal("0"),
            "credit":      addons,
            "description": f"Shipping & extra charges — {sale.invoice_number}",
        })

    je1 = create_journal_entry(
        reference_type = JournalEntry.ReferenceType.SALE,
        reference_id   = sale.id,
        description    = f"Revenue recognition — {sale.invoice_number}",
        lines          = lines_1,
        created_by_id  = created_by_id,
    )

    entries = [je1]

    # ── Entry 2: COGS (only when FIFO produced non-zero cost) ─────────────────
    if total_cogs > Decimal("0"):
        je2 = create_journal_entry(
            reference_type = JournalEntry.ReferenceType.SALE,
            reference_id   = sale.id,
            description    = f"Cost of Goods Sold — {sale.invoice_number}",
            lines          = [
                {
                    "account_id":  cogs_acct.id,
                    "debit":       total_cogs,
                    "credit":      Decimal("0"),
                    "description": "COGS from FIFO deduction",
                },
                {
                    "account_id":  inv_acct.id,
                    "debit":       Decimal("0"),
                    "credit":      total_cogs,
                    "description": "Inventory reduction",
                },
            ],
            created_by_id = created_by_id,
        )
        entries.append(je2)

    return entries


def post_payment_entry(*, payment, sale, created_by_id=None) -> JournalEntry:
    """
    Record a cash receipt when a payment instalment is added to a sale.

    DR  Cash / Bank / Mobile  (based on payment.method)   payment.amount
        CR  Accounts Receivable (1100)                         payment.amount

    The debit account is resolved from PAYMENT_METHOD_CODES mapping.
    """
    account_code  = PAYMENT_METHOD_CODES.get(payment.method, CODE_CASH)
    debit_account = _get_account(account_code)
    ar_account    = _get_account(CODE_AR)

    return create_journal_entry(
        reference_type = JournalEntry.ReferenceType.PAYMENT,
        reference_id   = sale.id,
        description    = (
            f"Payment received ({payment.method}) "
            f"— {sale.invoice_number}"
        ),
        lines = [
            {
                "account_id":  debit_account.id,
                "debit":       payment.amount,
                "credit":      Decimal("0"),
                "description": f"Payment via {payment.method}",
            },
            {
                "account_id":  ar_account.id,
                "debit":       Decimal("0"),
                "credit":      payment.amount,
                "description": f"AR cleared — {sale.invoice_number}",
            },
        ],
        created_by_id = created_by_id,
    )


def post_void_entry(*, sale, voided_by_id=None) -> list[JournalEntry]:
    """
    Reverse the revenue + COGS entries when a sale is voided.

    Mirrors post_sale_entry() with DR/CR swapped (reversal method).
    Stock is re-added by void_sale() in sales.services independently.
    """
    ar_acct   = _get_account(CODE_AR)
    disc_acct = _get_account(CODE_SALES_DISCOUNTS)
    rev_acct  = _get_account(CODE_SALES_REVENUE)
    tax_acct  = _get_account(CODE_TAX_PAYABLE)
    cogs_acct = _get_account(CODE_COGS)
    inv_acct  = _get_account(CODE_INVENTORY)

    total_cogs = (
        sale.items.aggregate(total=Sum("cogs"))["total"] or Decimal("0")
    )
    # Same addon (shipping + extra) handling as post_sale_entry, so the
    # reversal balances too.
    addons = (
        (sale.shipping_charges or Decimal("0"))
        + (sale.extra_charges or Decimal("0"))
    ).quantize(Decimal("0.01"))

    # Reversal of Entry 1 (swap DR/CR)
    lines_rev = [
        {
            "account_id":  ar_acct.id,
            "debit":       Decimal("0"),
            "credit":      sale.total_amount,
            "description": f"VOID receivable — {sale.invoice_number}",
        },
        {
            "account_id":  rev_acct.id,
            "debit":       sale.subtotal,
            "credit":      Decimal("0"),
            "description": f"VOID sales — {sale.invoice_number}",
        },
        {
            "account_id":  tax_acct.id,
            "debit":       sale.tax_amount,
            "credit":      Decimal("0"),
            "description": "VOID tax",
        },
    ]
    if sale.discount > Decimal("0"):
        lines_rev.append({
            "account_id":  disc_acct.id,
            "debit":       Decimal("0"),
            "credit":      sale.discount,
            "description": f"VOID discount reversal — {sale.invoice_number}",
        })
    if addons > Decimal("0"):
        lines_rev.append({
            "account_id":  rev_acct.id,
            "debit":       addons,
            "credit":      Decimal("0"),
            "description": f"VOID shipping & extra charges — {sale.invoice_number}",
        })

    je_rev1 = create_journal_entry(
        reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
        reference_id   = sale.id,
        description    = f"VOID revenue reversal — {sale.invoice_number}",
        lines          = lines_rev,
        created_by_id  = voided_by_id,
    )

    entries = [je_rev1]

    if total_cogs > Decimal("0"):
        je_rev2 = create_journal_entry(
            reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
            reference_id   = sale.id,
            description    = f"VOID COGS reversal — {sale.invoice_number}",
            lines          = [
                {
                    "account_id":  cogs_acct.id,
                    "debit":       Decimal("0"),
                    "credit":      total_cogs,
                    "description": "VOID COGS reversal",
                },
                {
                    "account_id":  inv_acct.id,
                    "debit":       total_cogs,
                    "credit":      Decimal("0"),
                    "description": "VOID inventory restored",
                },
            ],
            created_by_id = voided_by_id,
        )
        entries.append(je_rev2)

    return entries


# ──────────────────────────────────────────────────────────────────────────────
# 3. Purchase integration (called by future Purchase module)
# ──────────────────────────────────────────────────────────────────────────────

def post_return_entry(
    *,
    sell_return,
    total_return_cogs,
    refunded_amount=Decimal("0"),
    payment_account_id=None,
    created_by_id=None,
) -> list:
    """
    Post journal entries for a sell return (credit note).

      JE 1 — revenue/AR reversal (proportional to return amount):
        DR Sales Revenue  (gross_return_total)
        CR Accounts Receivable (gross_return_total)

      JE 2 — inventory restoration (only if any line had COGS):
        DR Inventory      (total_return_cogs)
        CR COGS           (total_return_cogs)

      JE 3 — actual cash refund (only if refunded_amount > 0):
        DR AR             (refunded_amount)
        CR Cash or Bank   (refunded_amount)
    """
    ar_acct   = _get_account(CODE_AR)
    rev_acct  = _get_account(CODE_SALES_REVENUE)
    cogs_acct = _get_account(CODE_COGS)
    inv_acct  = _get_account(CODE_INVENTORY)
    cash_acct = _get_account(CODE_CASH)
    bank_acct = _get_account(CODE_BANK)

    gross    = Decimal(sell_return.total_amount)
    cogs_amt = Decimal(total_return_cogs or 0)
    refunded = Decimal(refunded_amount or 0)
    inv_no   = sell_return.invoice_number

    entries = []

    if gross > Decimal("0"):
        entries.append(create_journal_entry(
            reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
            reference_id   = sell_return.id,
            description    = f"SELL RETURN revenue reversal — {inv_no}",
            lines = [
                {"account_id": rev_acct.id, "debit": gross,         "credit": Decimal("0"),
                 "description": f"RETURN revenue reversal — {inv_no}"},
                {"account_id": ar_acct.id,  "debit": Decimal("0"),  "credit": gross,
                 "description": f"RETURN AR adjustment — {inv_no}"},
            ],
            created_by_id = created_by_id,
        ))

    if cogs_amt > Decimal("0"):
        entries.append(create_journal_entry(
            reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
            reference_id   = sell_return.id,
            description    = f"SELL RETURN inventory restored — {inv_no}",
            lines = [
                {"account_id": inv_acct.id,  "debit": cogs_amt,     "credit": Decimal("0"),
                 "description": "RETURN inventory restored"},
                {"account_id": cogs_acct.id, "debit": Decimal("0"), "credit": cogs_amt,
                 "description": "RETURN COGS reversal"},
            ],
            created_by_id = created_by_id,
        ))

    if refunded > Decimal("0"):
        method = (sell_return.refund_method or "").upper()
        # Prefer the specific Payment Account the cashier picked (e.g.
        # "City Bank" vs the generic "Bank" ledger). This is how the
        # refund actually decrements the right sub-ledger on the
        # tenant's List Accounts page. Falls back to CODE_CASH /
        # CODE_BANK when the caller didn't pass one — preserves the
        # legacy behaviour for older clients.
        cash_target = None
        if payment_account_id:
            try:
                cash_target = Account.objects.get(pk=payment_account_id)
            except (Account.DoesNotExist, ValueError, TypeError):
                cash_target = None
        if cash_target is None:
            cash_target = bank_acct if method in ("BANK_TRANSFER", "BANK", "CHEQUE") else cash_acct
        entries.append(create_journal_entry(
            reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
            reference_id   = sell_return.id,
            description    = f"SELL RETURN refund payment — {inv_no}",
            lines = [
                {"account_id": ar_acct.id,    "debit": refunded,     "credit": Decimal("0"),
                 "description": "RETURN refund settles AR"},
                {"account_id": cash_target.id,"debit": Decimal("0"), "credit": refunded,
                 "description": f"RETURN refund paid via {cash_target.name or method or 'CASH'}"},
            ],
            created_by_id = created_by_id,
        ))

    return entries


def post_purchase_entry(
    *,
    reference_id,
    amount: Decimal,
    description: str,
    created_by_id=None,
) -> JournalEntry:
    """
    Record stock receipt from a supplier (Purchase module hook).

    DR  Inventory (1200)          amount
        CR  Accounts Payable (2100)   amount
    """
    inv_acct = _get_account(CODE_INVENTORY)
    ap_acct  = _get_account(CODE_AP)
    amount   = Decimal(str(amount))

    return create_journal_entry(
        reference_type = JournalEntry.ReferenceType.PURCHASE,
        reference_id   = reference_id,
        description    = description,
        lines = [
            {
                "account_id":  inv_acct.id,
                "debit":       amount,
                "credit":      Decimal("0"),
                "description": "Inventory received from supplier",
            },
            {
                "account_id":  ap_acct.id,
                "debit":       Decimal("0"),
                "credit":      amount,
                "description": "Payable to supplier",
            },
        ],
        created_by_id = created_by_id,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 4. Expense system
# ──────────────────────────────────────────────────────────────────────────────

def record_expense(
    *,
    category: str,
    amount: Decimal,
    expense_account_id,
    payment_account_id,
    description: str = "",
    expense_date=None,
    created_by_id,
) -> Expense:
    """
    Record an operational expense and create its journal entry.

    DR  Expense Account (6xxx)   amount
        CR  Payment Account (1xxx)   amount   (Cash / Bank / Mobile)

    Parameters
    ──────────
    category              One of Expense.Category choices.
    amount                Positive decimal.
    expense_account_id    UUID of an Account with type EXPENSE (or COGS).
    payment_account_id    UUID of an Account with type ASSET (cash / bank).
    description           Free text.
    expense_date          Defaults to today.
    created_by_id         UUID of acting user (required).
    """
    amount = Decimal(str(amount))
    if amount <= 0:
        raise AccountingError("Expense amount must be positive.")

    with transaction.atomic(using=_current_db()):
        try:
            exp_acct = Account.objects.get(id=expense_account_id, is_active=True)
        except Account.DoesNotExist:
            raise AccountingError(f"Expense account {expense_account_id} not found.")

        try:
            pay_acct = Account.objects.get(id=payment_account_id, is_active=True)
        except Account.DoesNotExist:
            raise AccountingError(f"Payment account {payment_account_id} not found.")

        if exp_acct.account_type not in (Account.Type.EXPENSE, Account.Type.COGS):
            raise AccountingError(
                f"'{exp_acct.name}' (type={exp_acct.account_type}) "
                "is not an expense account."
            )
        if pay_acct.account_type != Account.Type.ASSET:
            raise AccountingError(
                f"'{pay_acct.name}' (type={pay_acct.account_type}) "
                "is not an asset/payment account."
            )

        je = create_journal_entry(
            reference_type = JournalEntry.ReferenceType.EXPENSE,
            description    = description or exp_acct.name,
            lines = [
                {
                    "account_id":  exp_acct.id,
                    "debit":       amount,
                    "credit":      Decimal("0"),
                    "description": exp_acct.name,
                },
                {
                    "account_id":  pay_acct.id,
                    "debit":       Decimal("0"),
                    "credit":      amount,
                    "description": f"Paid via {pay_acct.name}",
                },
            ],
            created_by_id = created_by_id,
        )

        expense = Expense.objects.create(
            category        = category,
            expense_account = exp_acct,
            payment_account = pay_acct,
            amount          = amount,
            description     = description,
            expense_date    = expense_date or timezone.localdate(),
            journal_entry   = je,
            created_by_id   = created_by_id,
        )

        logger.info(
            "Expense recorded: id=%s  category=%s  amount=%s  je=%s",
            expense.id, category, amount, je.entry_number,
        )
        return expense


# ──────────────────────────────────────────────────────────────────────────────
# 5. Ledger
# ──────────────────────────────────────────────────────────────────────────────

def get_ledger(
    *,
    account_id,
    date_from: Optional[date_type] = None,
    date_to:   Optional[date_type] = None,
) -> dict:
    """
    Account statement: list of all journal lines with a running balance.

    Running balance starts at zero (no opening-balance concept yet).
    Use date_from to limit to a period (entries before date_from raise the
    opening balance if needed — future enhancement).

    Returns
    ───────
    {
        account_id, account_code, account_name, account_type, normal_balance,
        total_debit, total_credit, closing_balance,
        entries: [
            {entry_number, date, description, line_description,
             debit, credit, balance},
            ...
        ]
    }
    """
    try:
        account = Account.objects.get(id=account_id)
    except Account.DoesNotExist:
        raise AccountingError(f"Account {account_id} not found.")

    qs = branch_scope(
        JournalEntryLine.objects
        .filter(account_id=account_id)
        .select_related("journal_entry")
        .order_by("journal_entry__date", "journal_entry__created_at", "id")
    )
    if date_from:
        qs = qs.filter(journal_entry__date__gte=date_from)
    if date_to:
        qs = qs.filter(journal_entry__date__lte=date_to)

    is_debit_normal = account.normal_balance == "DEBIT"
    running_balance = Decimal("0")
    entries         = []

    for line in qs:
        delta = (line.debit - line.credit) if is_debit_normal else (line.credit - line.debit)
        running_balance += delta
        entries.append({
            "journal_entry_id": str(line.journal_entry_id),
            "entry_number":     line.journal_entry.entry_number,
            "date":             line.journal_entry.date.isoformat(),
            "description":      line.journal_entry.description,
            "line_description": line.description,
            "debit":            line.debit,
            "credit":           line.credit,
            "balance":          running_balance,
        })

    agg = qs.aggregate(total_debit=Sum("debit"), total_credit=Sum("credit"))

    return {
        "account_id":      str(account.id),
        "account_code":    account.code,
        "account_name":    account.name,
        "account_type":    account.account_type,
        "normal_balance":  account.normal_balance,
        "total_debit":     agg["total_debit"]  or Decimal("0"),
        "total_credit":    agg["total_credit"] or Decimal("0"),
        "closing_balance": running_balance,
        "entries":         entries,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 6. Trial Balance
# ──────────────────────────────────────────────────────────────────────────────

def get_trial_balance(
    *,
    date_from: Optional[date_type] = None,
    date_to:   Optional[date_type] = None,
) -> dict:
    """
    List every active account with total debits, total credits, and net balance.

    grand_debit == grand_credit confirms double-entry integrity.

    Returns
    ───────
    {
        accounts: [{code, name, account_type, normal_balance,
                    total_debit, total_credit, balance}],
        grand_debit, grand_credit, is_balanced
    }
    """
    accounts    = Account.objects.filter(is_active=True).order_by("code")
    grand_debit  = Decimal("0")
    grand_credit = Decimal("0")
    rows         = []

    for acct in accounts:
        qs = branch_scope(acct.journal_lines.all())   # multi-branch isolation
        if date_from:
            qs = qs.filter(journal_entry__date__gte=date_from)
        if date_to:
            qs = qs.filter(journal_entry__date__lte=date_to)

        agg = qs.aggregate(dr=Sum("debit"), cr=Sum("credit"))
        dr  = agg["dr"] or Decimal("0")
        cr  = agg["cr"] or Decimal("0")
        bal = (dr - cr) if acct.normal_balance == "DEBIT" else (cr - dr)

        rows.append({
            "code":           acct.code,
            "name":           acct.name,
            "account_type":   acct.account_type,
            "normal_balance": acct.normal_balance,
            "total_debit":    dr,
            "total_credit":   cr,
            "balance":        bal,
        })
        grand_debit  += dr
        grand_credit += cr

    return {
        "date_from":    date_from.isoformat() if date_from else None,
        "date_to":      date_to.isoformat()   if date_to   else None,
        "accounts":     rows,
        "grand_debit":  grand_debit,
        "grand_credit": grand_credit,
        "is_balanced":  grand_debit == grand_credit,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 7. Profit & Loss
# ──────────────────────────────────────────────────────────────────────────────

def get_profit_and_loss(
    *,
    date_from: date_type,
    date_to:   date_type,
) -> dict:
    """
    Income Statement for the given period.

    Net Profit = (Gross Revenue − Discounts) − COGS − Operating Expenses

    Returns
    ───────
    {
        period_from, period_to,
        gross_revenue, total_discounts, net_revenue,
        cogs, gross_profit,
        operating_expenses, net_profit,
        revenue_breakdown: [{code, name, amount}],
        expense_breakdown:  [{code, name, amount}],
    }
    """
    def _aggregate(account_type, is_contra=None):
        qs = branch_scope(JournalEntryLine.objects.filter(
            account__account_type = account_type,
            journal_entry__date__gte = date_from,
            journal_entry__date__lte = date_to,
        ))
        if is_contra is not None:
            qs = qs.filter(account__is_contra=is_contra)
        agg = qs.aggregate(dr=Sum("debit"), cr=Sum("credit"))
        return agg["dr"] or Decimal("0"), agg["cr"] or Decimal("0")

    def _per_account(account_type, is_contra=None):
        """Break down totals by individual account."""
        accts = Account.objects.filter(
            account_type=account_type, is_active=True,
        )
        if is_contra is not None:
            accts = accts.filter(is_contra=is_contra)
        rows = []
        for acct in accts.order_by("code"):
            qs  = branch_scope(acct.journal_lines.filter(
                journal_entry__date__gte=date_from,
                journal_entry__date__lte=date_to,
            ))
            agg = qs.aggregate(dr=Sum("debit"), cr=Sum("credit"))
            dr  = agg["dr"] or Decimal("0")
            cr  = agg["cr"] or Decimal("0")
            bal = (dr - cr) if acct.normal_balance == "DEBIT" else (cr - dr)
            if bal:
                rows.append({"code": acct.code, "name": acct.name, "amount": bal})
        return rows

    # Revenue (INCOME, not contra) — credit-normal
    rev_dr, rev_cr   = _aggregate("INCOME", is_contra=False)
    gross_revenue    = rev_cr - rev_dr

    # Discounts (INCOME, contra) — debit-normal
    disc_dr, disc_cr = _aggregate("INCOME", is_contra=True)
    total_discounts  = disc_dr - disc_cr

    net_revenue      = gross_revenue - total_discounts

    # COGS — debit-normal
    cogs_dr, cogs_cr = _aggregate("COGS")
    total_cogs       = cogs_dr - cogs_cr

    gross_profit     = net_revenue - total_cogs

    # Operating Expenses — debit-normal
    exp_dr, exp_cr   = _aggregate("EXPENSE")
    total_expenses   = exp_dr - exp_cr

    net_profit       = gross_profit - total_expenses

    return {
        "period_from":         date_from.isoformat(),
        "period_to":           date_to.isoformat(),
        "gross_revenue":       gross_revenue,
        "total_discounts":     total_discounts,
        "net_revenue":         net_revenue,
        "cogs":                total_cogs,
        "gross_profit":        gross_profit,
        "operating_expenses":  total_expenses,
        "net_profit":          net_profit,
        "revenue_breakdown":   _per_account("INCOME", is_contra=False),
        "expense_breakdown":   _per_account("EXPENSE"),
    }


# ──────────────────────────────────────────────────────────────────────────────
# 8. Balance Sheet
# ──────────────────────────────────────────────────────────────────────────────

def get_balance_sheet(*, as_of_date: date_type) -> dict:
    """
    Snapshot of financial position as of a given date.

    Assets = Liabilities + Equity

    Equity includes current-period net income (P&L from Jan 1 to as_of_date).

    Returns
    ───────
    {
        as_of_date,
        assets:      {accounts: [...], total},
        liabilities: {accounts: [...], total},
        equity:      {accounts: [...], current_net_income, total},
        total_liabilities_and_equity,
        is_balanced
    }
    """
    def _section(account_type):
        accts = (
            Account.objects
            .filter(account_type=account_type, is_active=True)
            .annotate(
                total_dr=Sum(
                    "journal_lines__debit",
                    filter=Q(journal_lines__journal_entry__date__lte=as_of_date),
                ),
                total_cr=Sum(
                    "journal_lines__credit",
                    filter=Q(journal_lines__journal_entry__date__lte=as_of_date),
                ),
            )
            .order_by("code")
        )
        rows  = []
        total = Decimal("0")
        for acct in accts:
            dr  = acct.total_dr or Decimal("0")
            cr  = acct.total_cr or Decimal("0")
            bal = (dr - cr) if acct.normal_balance == "DEBIT" else (cr - dr)
            rows.append({"code": acct.code, "name": acct.name, "balance": bal})
            total += bal
        return rows, total

    asset_rows,     total_assets      = _section("ASSET")
    liability_rows, total_liabilities = _section("LIABILITY")
    equity_rows,    total_equity_base = _section("EQUITY")

    # Add current-year net income to equity
    year_start         = date_type(as_of_date.year, 1, 1)
    pl                 = get_profit_and_loss(date_from=year_start, date_to=as_of_date)
    current_net_income = pl["net_profit"]
    total_equity       = total_equity_base + current_net_income
    total_l_plus_e     = total_liabilities + total_equity

    return {
        "as_of_date": as_of_date.isoformat(),
        "assets": {
            "accounts": asset_rows,
            "total":    total_assets,
        },
        "liabilities": {
            "accounts": liability_rows,
            "total":    total_liabilities,
        },
        "equity": {
            "accounts":            equity_rows,
            "current_net_income":  current_net_income,
            "total":               total_equity,
        },
        "total_liabilities_and_equity": total_l_plus_e,
        # Strict `==` on Decimals can falsely report unbalanced when
        # the line-by-line quantize() steps drift by ≤ 1 paisa.
        # Treat the sheet as balanced inside that tolerance window.
        "is_balanced": abs(total_assets - total_l_plus_e) < Decimal("0.01"),
    }


# ──────────────────────────────────────────────────────────────────────────────
# 9. Cash Flow
# ──────────────────────────────────────────────────────────────────────────────

def get_cash_flow(
    *,
    date_from: date_type,
    date_to:   date_type,
) -> dict:
    """
    Cash-basis flow statement for the period.

    For ASSET accounts (Cash, Bank, Mobile):
      DR lines = cash coming IN  (sales payments received, etc.)
      CR lines = cash going OUT  (expenses paid, etc.)

    Returns
    ───────
    {
        period_from, period_to,
        total_inflow, total_outflow, net_cash_flow,
        by_account: [{code, name, inflow, outflow, net}],
        by_type:    [{type_label, inflow, outflow}]
    }
    """
    cash_codes = [CODE_CASH, CODE_BANK, CODE_MOBILE_WALLET]

    cash_accounts = Account.objects.filter(code__in=cash_codes, is_active=True)
    base_qs = branch_scope(JournalEntryLine.objects.filter(
        account__code__in     = cash_codes,
        journal_entry__date__gte = date_from,
        journal_entry__date__lte = date_to,
    ).select_related("account", "journal_entry"))

    agg = base_qs.aggregate(total_in=Sum("debit"), total_out=Sum("credit"))
    total_in  = agg["total_in"]  or Decimal("0")
    total_out = agg["total_out"] or Decimal("0")

    # Per-account breakdown
    by_account = []
    for acct in cash_accounts.order_by("code"):
        agg_a = base_qs.filter(account=acct).aggregate(
            inflow=Sum("debit"), outflow=Sum("credit")
        )
        inflow  = agg_a["inflow"]  or Decimal("0")
        outflow = agg_a["outflow"] or Decimal("0")
        by_account.append({
            "code":    acct.code,
            "name":    acct.name,
            "inflow":  inflow,
            "outflow": outflow,
            "net":     inflow - outflow,
        })

    # Inflow by reference_type (sales receipts vs. other)
    by_type = []
    for ref_type in JournalEntry.ReferenceType.values:
        agg_t = base_qs.filter(
            journal_entry__reference_type=ref_type
        ).aggregate(inflow=Sum("debit"), outflow=Sum("credit"))
        inflow  = agg_t["inflow"]  or Decimal("0")
        outflow = agg_t["outflow"] or Decimal("0")
        if inflow or outflow:
            by_type.append({
                "reference_type": ref_type,
                "inflow":         inflow,
                "outflow":        outflow,
            })

    return {
        "period_from":   date_from.isoformat(),
        "period_to":     date_to.isoformat(),
        "total_inflow":  total_in,
        "total_outflow": total_out,
        "net_cash_flow": total_in - total_out,
        "by_account":    by_account,
        "by_type":       by_type,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Branch-aware journal posting helper
# ──────────────────────────────────────────────────────────────────────────────

class JournalLocalityError(Exception):
    """Raised when a journal entry violates the branch-locality contract.

    Two distinct failure modes — both surface as a single HTTP 400 from the
    API but the message is specific enough that the operator knows what to
    fix:

      1. A line touches a BRANCH-SCOPED account from a different branch.
         Example: cashier at Branch B tries to debit "Cash in Hand (Branch A)".
         The system MUST refuse — physical drawers don't share.

      2. A line is missing a `location_id` tag. Required for every new
         entry so the per-branch reports give correct numbers.
    """


def post_balanced_entry(
    *,
    entry_number: str,
    reference_type: str,
    reference_id,
    description: str,
    date,
    created_by_id,
    location_id,
    lines: list[dict],
) -> "JournalEntry":
    """Post one balanced journal entry, tagging every line with `location_id`.

    `lines` is a list of dicts: {account_id, debit, credit, description?}.
    Σ debit MUST equal Σ credit — caller is responsible. We re-check here
    too because the alternative is silently writing an unbalanced ledger.

    `location_id` is the BRANCH where the underlying transaction physically
    happened — the source of truth for per-branch P&L. Every line gets it
    stamped on (overrideable per-line via `location_id` in the line dict
    for the rare cross-branch transfer case).

    Locality contract enforced here:
      • For every line whose Account.is_global=False, the line's location
        MUST match the account's home location. Refused otherwise.
      • Lines on global accounts can carry any location_id — that's the
        whole point of the design: a Branch-A sale lands credit on the
        central bKash account with location_id=Branch-A.

    Raises JournalLocalityError on contract violations; the caller wraps
    these as a clean 400 for the API.
    """
    from decimal import Decimal as _D
    from .models import Account, JournalEntry, JournalEntryLine

    if not location_id:
        raise JournalLocalityError(
            "Every journal entry must be tagged to a branch — pass location_id. "
            "Use the central admin location for cross-tenant adjustments."
        )

    if not lines:
        raise JournalLocalityError("Journal entry has no lines.")

    # ── Pull every referenced account in one query, validate locality ────────
    account_ids = {ln["account_id"] for ln in lines}
    accounts = {a.id: a for a in Account.objects.filter(id__in=account_ids)}
    missing  = account_ids - set(accounts)
    if missing:
        raise JournalLocalityError(f"Unknown account_id(s): {sorted(map(str, missing))}.")

    total_dr = _D("0")
    total_cr = _D("0")

    for ln in lines:
        acct = accounts[ln["account_id"]]
        line_loc = ln.get("location_id") or location_id

        # Branch-scoped account → line.location must match acct.location.
        # No exceptions: this is the rule that protects Branch A's cash drawer
        # from being touched by Branch B.
        if not acct.is_global and acct.location_id != line_loc:
            raise JournalLocalityError(
                f"Account '{acct.code} {acct.name}' is locked to branch "
                f"{acct.location_id}; cannot post a line from branch {line_loc}."
            )

        total_dr += _D(str(ln.get("debit", 0)  or 0))
        total_cr += _D(str(ln.get("credit", 0) or 0))

    if total_dr != total_cr:
        raise JournalLocalityError(
            f"Journal entry is unbalanced: Σdebit={total_dr} ≠ Σcredit={total_cr}."
        )

    # ── Persist header + lines in one transaction on the tenant DB ──────────
    db = _current_db()
    with transaction.atomic(using=db):
        entry = JournalEntry.objects.using(db).create(
            entry_number   = entry_number,
            reference_type = reference_type,
            reference_id   = reference_id,
            description    = description,
            date           = date,
            created_by_id  = created_by_id,
        )

        JournalEntryLine.objects.using(db).bulk_create([
            JournalEntryLine(
                journal_entry_id = entry.id,
                account_id       = ln["account_id"],
                location_id      = ln.get("location_id") or location_id,
                description      = ln.get("description", ""),
                debit            = _D(str(ln.get("debit", 0)  or 0)),
                credit           = _D(str(ln.get("credit", 0) or 0)),
            )
            for ln in lines
        ])

    return entry
