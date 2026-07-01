# Helper module — CashFlowLedgerView. Imported by views.py.
#
# Source-of-truth refactor (2026-06):
#
#   The previous implementation enumerated SalePayment, Expense, and
#   Purchase rows AND PaymentAccountTransaction. Because every cash
#   movement also writes a PaymentAccountTransaction row, each
#   transaction was being counted TWICE — inflating the running
#   balance and the total debit/credit footers, which broke the
#   Cash Flow page numbers for every tenant.
#
#   This rewrite uses ONLY PaymentAccountTransaction as the source.
#   `kind` already partitions the rows the operator filters on (SALE
#   / EXPENSE / WITHDRAWAL aka Purchase / DEPOSIT / TRANSFER_* /
#   ADJUSTMENT). The account_id on each row is the actual ledger the
#   money landed in / came out of, so picking "City Bank" no longer
#   silently shows Cash on Hand rows (the prior code hardcoded the
#   first CASH account as fallback for sale payments / expenses /
#   purchases).
#
#   Running balance is now computed correctly:
#     • Start with the account's opening_balance + Σ amount BEFORE
#       date_from (so jumping into a mid-period view resumes from
#       the real opening balance for the period).
#     • Walk through the period in chronological order, applying
#       transaction signs (positive=credit, negative=debit).
#
#   Grand-total balance line removed — it was the sum of seeded
#   opening balances across every account that happened to appear
#   in `rows`, which is a meaningless figure (accounts with zero
#   activity in the period were skipped). The page already shows
#   per-account totals + a real-time refresh via Account Book.

from datetime import date
from decimal import Decimal as _D

from django.db.models import Sum
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PaymentAccount, PaymentAccountTransaction


@extend_schema(tags=["Accounting"])
class CashFlowLedgerView(APIView):
    """
    GET /api/accounting/cash-flow-ledger/

    Returns a paginated, sorted cash-flow timeline backed entirely by
    PaymentAccountTransaction. Every sale payment / expense /
    purchase payment / deposit / transfer / adjustment already writes
    one row there so this is the single source of truth — no risk of
    double-counting.

    Filters: account_id, location_id (unused — PA rows aren't
    location-scoped; kept for API compat), date_from, date_to,
    txn_type, page, limit
    """

    permission_classes = [IsAuthenticated]

    # Map txn_type query value → PaymentAccountTransaction.Kind value
    # (or None to mean "no filter"). The frontend's PURCHASE filter
    # is mapped onto WITHDRAWAL because supplier payments post as
    # WITHDRAWAL kind.
    KIND_ALIASES = {
        "ALL":          None,
        "":             None,
        "SELL":         "SALE",
        "SALE":         "SALE",
        "EXPENSE":      "EXPENSE",
        "PURCHASE":     "WITHDRAWAL",
        "WITHDRAWAL":   "WITHDRAWAL",
        "DEPOSIT":      "DEPOSIT",
        "TRANSFER_IN":  "TRANSFER_IN",
        "TRANSFER_OUT": "TRANSFER_OUT",
        "ADJUSTMENT":   "ADJUSTMENT",
    }

    def get(self, request):
        # ── Parse query params ───────────────────────────────────────────
        try:
            page  = max(int(request.query_params.get("page", 1)), 1)
            limit = max(min(int(request.query_params.get("limit", 25)), 200), 1)
        except (TypeError, ValueError):
            page, limit = 1, 25

        account_id = request.query_params.get("account_id") or ""
        date_from  = request.query_params.get("date_from")
        date_to    = request.query_params.get("date_to")
        txn_type   = (request.query_params.get("txn_type") or "").upper()

        df = date.fromisoformat(date_from) if date_from else None
        dt = date.fromisoformat(date_to)   if date_to   else None

        if account_id:
            if not PaymentAccount.objects.filter(id=account_id).exists():
                return Response({"detail": "Account not found."}, status=status.HTTP_404_NOT_FOUND)

        kind_filter = self.KIND_ALIASES.get(txn_type, None)

        # ── Build the queryset ───────────────────────────────────────────
        qs = (
            PaymentAccountTransaction.objects
            .select_related("account", "counter_account")
            .order_by("transaction_date", "created_at")
        )
        if account_id:
            qs = qs.filter(account_id=account_id)
        if kind_filter is not None:
            qs = qs.filter(kind=kind_filter)
        if df:
            qs = qs.filter(transaction_date__date__gte=df)
        if dt:
            qs = qs.filter(transaction_date__date__lte=dt)

        # ── Period-opening balance per account ──────────────────────────
        # = opening_balance + Σ amount across all rows BEFORE date_from.
        # When account_id is set we only need the one row; otherwise
        # build a map for every active account.
        period_opening = {}  # account_id (str) → Decimal
        pa_qs = PaymentAccount.objects.all()
        if account_id:
            pa_qs = pa_qs.filter(id=account_id)
        for acct in pa_qs:
            opening = _D(str(acct.opening_balance or 0))
            if df:
                prev = (
                    PaymentAccountTransaction.objects
                    .filter(account_id=acct.id, transaction_date__date__lt=df)
                    .aggregate(s=Sum("amount"))["s"]
                ) or _D("0")
                opening += _D(str(prev or 0))
            period_opening[str(acct.id)] = opening

        # ── Materialise rows (oldest → newest), computing per-account
        # running balance ─────────────────────────────────────────────────
        rows = []
        running = dict(period_opening)  # carries per-acct running balance
        period_debit  = _D("0")
        period_credit = _D("0")

        for tx in qs.iterator():
            aid = str(tx.account_id)
            amt = _D(str(tx.amount or 0))
            debit_str  = str(-amt) if amt < 0 else "0"
            credit_str = str(amt)  if amt > 0 else "0"
            running[aid] = running.get(aid, _D("0")) + amt
            if amt < 0: period_debit  += -amt
            else:       period_credit += amt
            rows.append({
                "id":            "tx-" + str(tx.id),
                "kind":          tx.kind,
                "date":          tx.transaction_date.isoformat() if tx.transaction_date else None,
                "account_id":    aid,
                "account_name":  tx.account.name if tx.account else "—",
                "description":   tx.get_kind_display(),
                "details": {
                    "reference":       tx.reference or "",
                    "note":            tx.note or "",
                    "counter_account": tx.counter_account.name if tx.counter_account_id else "",
                },
                "debit":           debit_str,
                "credit":          credit_str,
                "account_balance": str(running.get(aid, _D("0"))),
            })

        # ── Reverse for newest-first display, paginate ─────────────────
        rows.reverse()
        total_count = len(rows)
        offset = (page - 1) * limit
        page_rows = rows[offset: offset + limit]
        total_pages = max((total_count + limit - 1) // limit, 1)

        # Closing balance per account = period_opening + Σ in-range
        closing_by_account = {
            aid: str(running.get(aid, period_opening.get(aid, _D("0"))))
            for aid in period_opening
        }

        return Response({
            "results":     page_rows,
            "count":       total_count,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "summary": {
                "total_debit":      str(period_debit),
                "total_credit":     str(period_credit),
                "net_cash_flow":    str(period_credit - period_debit),
                "opening_balances": {k: str(v) for k, v in period_opening.items()},
                "closing_balances": closing_by_account,
            },
        })
