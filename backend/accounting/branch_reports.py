"""Branch-aware reports (P&L, Branch Contribution, Cash Reconciliation).

All three reports share the same underlying mechanism: filter
JournalEntryLine by location, then aggregate by account_type or
account. Lives on the tenant DB (current alias resolved by
TenantMiddleware), so reporting is automatically scoped per tenant —
no cross-tenant leak.

Each public function returns a plain JSON-serialisable dict; the
matching view in views.py just wraps it in a Response.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from django.db.models import Q, Sum, Value, DecimalField, ExpressionWrapper, F
from django.db.models.functions import Coalesce
from django.utils import timezone

from .models import Account, JournalEntryLine


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

_DEC  = DecimalField(max_digits=14, decimal_places=2)
_ZERO = Value(Decimal("0"), output_field=_DEC)


def _line_qs(*, location_id=None, date_from=None, date_to=None):
    qs = JournalEntryLine.objects.select_related("account")
    if location_id:
        qs = qs.filter(location_id=location_id)
    if date_from:
        qs = qs.filter(journal_entry__date__gte=date_from)
    if date_to:
        qs = qs.filter(journal_entry__date__lte=date_to)
    return qs


def _net_per_type(qs, account_type: str, *, debit_normal: bool) -> Decimal:
    """Aggregate (debit, credit) for one account_type and return the net
    balance in the normal-balance direction. ASSET/COGS/EXPENSE are
    debit-normal; LIABILITY/EQUITY/INCOME are credit-normal.
    """
    agg = qs.filter(account__account_type=account_type).aggregate(
        dr=Coalesce(Sum("debit"),  _ZERO),
        cr=Coalesce(Sum("credit"), _ZERO),
    )
    dr, cr = agg["dr"] or Decimal("0"), agg["cr"] or Decimal("0")
    return (dr - cr) if debit_normal else (cr - dr)


# ──────────────────────────────────────────────────────────────────────────────
# 1. Branch P&L
# ──────────────────────────────────────────────────────────────────────────────

def branch_profit_and_loss(*, location_id, date_from=None, date_to=None) -> dict:
    """Localized P&L for one branch.

      Revenue                = Σ INCOME  (credit-normal)
      Cost of Goods Sold     = Σ COGS    (debit-normal)
      Gross Profit           = Revenue − COGS
      Operating Expenses     = Σ EXPENSE (debit-normal)
      Net Profit             = Gross Profit − Operating Expenses

    Every figure is computed from journal_entry_lines.location_id == X —
    the account itself may be global (e.g. central sales-tax payable),
    but the revenue/expense for THIS report is attributed to the branch
    that made the transaction.
    """
    qs = _line_qs(location_id=location_id, date_from=date_from, date_to=date_to)

    revenue           = _net_per_type(qs, "INCOME",  debit_normal=False)
    cogs              = _net_per_type(qs, "COGS",    debit_normal=True)
    expenses          = _net_per_type(qs, "EXPENSE", debit_normal=True)
    gross_profit      = revenue - cogs
    net_profit        = gross_profit - expenses
    gross_margin_pct  = (gross_profit / revenue * 100) if revenue else Decimal("0")
    net_margin_pct    = (net_profit   / revenue * 100) if revenue else Decimal("0")

    # Per-account breakdown for the drilldown
    by_account = (
        qs.values(
            "account_id", "account__code", "account__name", "account__account_type",
        )
        .annotate(
            dr=Coalesce(Sum("debit"),  _ZERO),
            cr=Coalesce(Sum("credit"), _ZERO),
        )
        .order_by("account__code")
    )
    accounts = [
        {
            "id":         str(row["account_id"]),
            "code":       row["account__code"],
            "name":       row["account__name"],
            "type":       row["account__account_type"],
            "debit":      str(row["dr"]),
            "credit":     str(row["cr"]),
        }
        for row in by_account
    ]

    return {
        "location_id":     str(location_id),
        "date_from":       date_from.isoformat() if date_from else None,
        "date_to":         date_to.isoformat()   if date_to   else None,
        "revenue":         str(revenue),
        "cogs":            str(cogs),
        "gross_profit":    str(gross_profit),
        "operating_expenses": str(expenses),
        "net_profit":      str(net_profit),
        "gross_margin_pct": str(gross_margin_pct.quantize(Decimal("0.01"))),
        "net_margin_pct":   str(net_margin_pct.quantize(Decimal("0.01"))),
        "accounts":        accounts,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 2. Branch Contribution to global accounts
# ──────────────────────────────────────────────────────────────────────────────

def branch_contribution_to_global(*, location_id, date_from=None, date_to=None) -> dict:
    """How much did this branch contribute INTO each global account?

    A "contribution" is the net inflow tagged to this branch on a global
    account. For credit-normal global accounts (Income, central MFS
    payables) → credits MINUS debits. For debit-normal global accounts
    (central bank, central bKash that's classified ASSET) → debits MINUS
    credits.

    Example output row:
      "Central bKash"  ASSET  → ৳5,000  (this branch deposited 5k)
      "Central Bank"   ASSET  → ৳2,500  (this branch deposited 2.5k)
    """
    qs = _line_qs(location_id=location_id, date_from=date_from, date_to=date_to)
    qs = qs.filter(account__is_global=True)

    rows = (
        qs.values(
            "account_id", "account__code", "account__name", "account__account_type",
        )
        .annotate(
            dr=Coalesce(Sum("debit"),  _ZERO),
            cr=Coalesce(Sum("credit"), _ZERO),
        )
        .order_by("account__code")
    )

    debit_types = Account._DEBIT_TYPES
    out = []
    for r in rows:
        is_debit_normal = r["account__account_type"] in debit_types
        net = (r["dr"] - r["cr"]) if is_debit_normal else (r["cr"] - r["dr"])
        out.append({
            "account_id":   str(r["account_id"]),
            "account_code": r["account__code"],
            "account_name": r["account__name"],
            "account_type": r["account__account_type"],
            "debit":        str(r["dr"]),
            "credit":       str(r["cr"]),
            "net_contribution": str(net),
        })

    return {
        "location_id":  str(location_id),
        "date_from":    date_from.isoformat() if date_from else None,
        "date_to":      date_to.isoformat()   if date_to   else None,
        "contributions": out,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 3. Cash Reconciliation (end-of-day branch cash audit)
# ──────────────────────────────────────────────────────────────────────────────

def cash_reconciliation(*, location_id, date_to=None) -> dict:
    """Current balance of every BRANCH-SCOPED asset account at one branch.

    Default is Cash in Hand / Petty Cash / any other physical-asset
    account pinned to this branch. The manager runs this at close of
    day, then physically counts the drawer and reconciles the
    difference.

    Walks through every account whose location == this branch AND
    account_type == ASSET, and reports the running balance up to
    `date_to` (default: today end of day).
    """
    date_to = date_to or timezone.localdate()
    accounts = (
        Account.objects
        .filter(location_id=location_id, account_type="ASSET", is_active=True)
        .order_by("code")
    )
    rows = []
    total = Decimal("0")
    for a in accounts:
        bal = a.get_balance(date_to=date_to)   # already accounts for normal-balance direction
        total += bal
        rows.append({
            "account_id":   str(a.id),
            "account_code": a.code,
            "account_name": a.name,
            "balance":      str(bal),
        })

    return {
        "location_id":  str(location_id),
        "date_to":      date_to.isoformat(),
        "accounts":     rows,
        "total_balance": str(total),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Convenience: total global balance of one shared account (no branch filter)
# ──────────────────────────────────────────────────────────────────────────────

def global_account_balance(*, account_id, date_to=None) -> dict:
    """Current total balance of a global account across ALL branches.

    For the central bKash / central bank reporting. Sums every journal
    line on the account regardless of location tag.
    """
    acct = Account.objects.get(id=account_id)
    if not acct.is_global:
        raise ValueError(f"Account {acct.code} is not global — has no cross-branch balance.")
    return {
        "account_id":   str(acct.id),
        "account_code": acct.code,
        "account_name": acct.name,
        "balance":      str(acct.get_balance(date_to=date_to)),
        "date_to":      (date_to.isoformat() if date_to else None),
    }
