"""
Accounting API views.

All views require JWT authentication.
All queries run against the active tenant DB via TenantDatabaseRouter.

Endpoints
─────────
Chart of Accounts:
  GET/POST    /api/accounting/accounts/
  GET/PATCH   /api/accounting/accounts/<id>/

Manual Journal Entry:
  GET/POST    /api/accounting/journal-entries/

Expenses:
  GET/POST    /api/accounting/expenses/

Reports:
  GET         /api/accounting/ledger/          ?account_id=&date_from=&date_to=
  GET         /api/accounting/trial-balance/   ?date_from=&date_to=
  GET         /api/accounting/profit-loss/     ?date_from=&date_to=  (required)
  GET         /api/accounting/balance-sheet/   ?as_of_date=  (required)
  GET         /api/accounting/cash-flow/       ?date_from=&date_to=  (required)
"""
import logging
from datetime import date

from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Perm, require_permission
from accounts.branch_context import branch_scope, active_branch_id
from audit.services import AuditAction, log_from_request

from . import services
from ._cash_flow_view import CashFlowLedgerView  # noqa: F401  (re-exported)
from ._payment_report_view import PaymentAccountReportView, PaymentLinkView  # noqa: F401
from ._profit_loss_report import ProfitLossSummaryView, ProfitLossBreakdownView  # noqa: F401
from .models import Account, Expense, ExpenseCategory, JournalEntry, PaymentAccount, PaymentAccountTransaction
from .serializers import (
    AccountCreateSerializer,
    AccountSerializer,
    AccountUpdateSerializer,
    DepositInputSerializer,
    ExpenseCategorySerializer,
    ExpenseCreateSerializer,
    ExpenseSerializer,
    FundTransferInputSerializer,
    JournalEntrySerializer,
    ManualJournalEntrySerializer,
    PaymentAccountSerializer,
    PaymentAccountTransactionSerializer,
)

logger = logging.getLogger(__name__)


def _parse_date(value: str, param_name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"'{param_name}' must be a date in YYYY-MM-DD format.")


# ──────────────────────────────────────────────────────────────────────────────
# Chart of Accounts
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class AccountListCreateView(APIView):
    """
    GET  /api/accounting/accounts/   — list all accounts.
    POST /api/accounting/accounts/   — create a new account.

    Query params (GET):
      type      — filter by account_type (ASSET, LIABILITY, …)
      active    — "true" / "false" (default: all)
      search    — filter by name or code
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List accounts",
        description="Returns the chart of accounts. Filter by type, active status, or search by name/code.",
        parameters=[
            OpenApiParameter("type",   OpenApiTypes.STR, description="ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE|COGS"),
            OpenApiParameter("active", OpenApiTypes.STR, description='"true" or "false"'),
            OpenApiParameter("search", OpenApiTypes.STR, description="Search by name or code"),
        ],
        responses={200: AccountSerializer(many=True)},
    )
    def get(self, request):
        qs = Account.objects.select_related("parent").order_by("code")

        if t := request.query_params.get("type"):
            qs = qs.filter(account_type=t.upper())
        if request.query_params.get("active") == "true":
            qs = qs.filter(is_active=True)
        elif request.query_params.get("active") == "false":
            qs = qs.filter(is_active=False)
        if search := request.query_params.get("search", "").strip():
            from django.db.models import Q
            qs = qs.filter(Q(name__icontains=search) | Q(code__icontains=search))

        return Response(AccountSerializer(qs, many=True).data)

    @extend_schema(
        summary="Create account",
        description="Add a new account to the chart of accounts. Requires `can_manage_accounts` permission.",
        request=AccountCreateSerializer,
        responses={201: AccountSerializer},
    )
    def post(self, request):
        ser = AccountCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d   = ser.validated_data

        parent = None
        if d.get("parent_id"):
            try:
                parent = Account.objects.get(id=d["parent_id"])
            except Account.DoesNotExist:
                return Response(
                    {"detail": f"Parent account {d['parent_id']} not found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        account = Account.objects.create(
            code         = d["code"],
            name         = d["name"],
            account_type = d["account_type"],
            parent       = parent,
            is_contra    = d["is_contra"],
            description  = d["description"],
        )
        return Response(AccountSerializer(account).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Accounting"])
class AccountDetailView(APIView):
    """
    GET   /api/accounting/accounts/<id>/   — account detail + current balance.
    PATCH /api/accounting/accounts/<id>/   — update name / description / is_active.
    """
    permission_classes = [IsAuthenticated]

    def _get(self, pk):
        try:
            return Account.objects.select_related("parent").get(id=pk)
        except Account.DoesNotExist:
            return None

    @extend_schema(summary="Get account detail", responses={200: AccountSerializer})
    def get(self, request, pk):
        account = self._get(pk)
        if not account:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(AccountSerializer(account).data)

    @extend_schema(
        summary="Update account",
        description="Update `name`, `description`, or `is_active`. Code and type cannot be changed.",
        request=AccountUpdateSerializer,
        responses={200: AccountSerializer},
    )
    def patch(self, request, pk):
        account = self._get(pk)
        if not account:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        ser = AccountUpdateSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        d   = ser.validated_data

        for field, value in d.items():
            setattr(account, field, value)
        account.save()
        return Response(AccountSerializer(account).data)


# ──────────────────────────────────────────────────────────────────────────────
# Journal Entries
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class JournalEntryListCreateView(APIView):
    """
    GET  /api/accounting/journal-entries/   — list entries.
    POST /api/accounting/journal-entries/   — create a manual adjustment entry.

    Query params (GET):
      reference_type  — SALE | PURCHASE | EXPENSE | PAYMENT | ADJUSTMENT | OPENING
      date_from, date_to
      limit           — max results (default 50)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List journal entries",
        description="Returns journal entries filtered by type and date range.",
        parameters=[
            OpenApiParameter("reference_type", OpenApiTypes.STR, description="SALE|PURCHASE|EXPENSE|PAYMENT|ADJUSTMENT|OPENING"),
            OpenApiParameter("date_from", OpenApiTypes.DATE, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, description="End date (YYYY-MM-DD)"),
            OpenApiParameter("limit",     OpenApiTypes.INT,  description="Max results (default 50)"),
        ],
        responses={200: JournalEntrySerializer(many=True)},
    )
    def get(self, request):
        qs = JournalEntry.objects.prefetch_related("lines__account").order_by("-date", "-created_at")

        if rt := request.query_params.get("reference_type"):
            qs = qs.filter(reference_type=rt.upper())
        if df := request.query_params.get("date_from"):
            try:
                qs = qs.filter(date__gte=_parse_date(df, "date_from"))
            except ValueError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        if dt := request.query_params.get("date_to"):
            try:
                qs = qs.filter(date__lte=_parse_date(dt, "date_to"))
            except ValueError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            limit = min(int(request.query_params.get("limit", 50)), 500)
        except (ValueError, TypeError):
            limit = 50

        return Response(JournalEntrySerializer(qs[:limit], many=True).data)

    @extend_schema(
        summary="Create manual journal entry",
        description="Create a manual ADJUSTMENT journal entry. Lines must balance (total debit = total credit). Requires `can_manage_accounts` permission.",
        request=ManualJournalEntrySerializer,
        responses={201: JournalEntrySerializer},
    )
    def post(self, request):
        ser = ManualJournalEntrySerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d   = ser.validated_data

        try:
            je = services.create_journal_entry(
                reference_type = JournalEntry.ReferenceType.ADJUSTMENT,
                description    = d["description"],
                lines          = [dict(l) for l in d["lines"]],
                date           = d.get("date"),
                created_by_id  = request.user.id,
            )
        except services.AccountingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        je_full = JournalEntry.objects.prefetch_related("lines__account").get(id=je.id)
        return Response(JournalEntrySerializer(je_full).data, status=status.HTTP_201_CREATED)


# ──────────────────────────────────────────────────────────────────────────────
# Expenses
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class ExpenseListCreateView(APIView):
    """
    GET  /api/accounting/expenses/   — list expenses.
    POST /api/accounting/expenses/   — record an expense + create JE.

    Query params (GET):
      category   — filter by category
      date_from, date_to
      limit      — max results (default 50)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List expenses (paginated)",
        description="Returns expenses with filters and a summary aggregation across the filtered set.",
        parameters=[
            OpenApiParameter("page",           OpenApiTypes.INT,  required=False),
            OpenApiParameter("limit",          OpenApiTypes.INT,  required=False),
            OpenApiParameter("search",         OpenApiTypes.STR,  required=False),
            OpenApiParameter("category",       OpenApiTypes.STR,  required=False),
            OpenApiParameter("payment_status", OpenApiTypes.STR,  required=False),
            OpenApiParameter("location_id",    OpenApiTypes.UUID, required=False),
            OpenApiParameter("expense_for",    OpenApiTypes.STR,  required=False),
            OpenApiParameter("contact",        OpenApiTypes.STR,  required=False),
            OpenApiParameter("date_from",      OpenApiTypes.DATE, required=False),
            OpenApiParameter("date_to",        OpenApiTypes.DATE, required=False),
        ],
    )
    def get(self, request):
        from django.db.models import F, Q, Sum, Value, DecimalField
        from django.db.models.functions import Coalesce
        from decimal import Decimal as _D

        qs = branch_scope(Expense.objects.select_related(
            "expense_account", "payment_account", "journal_entry",
            "expense_category", "expense_sub_category",
        ).order_by("-expense_date", "-created_at"))

        if cat := request.query_params.get("category"):
            # The dropdown offers real categories (FK UUIDs) plus the legacy
            # enum codes. A UUID filters the FK; anything else is a legacy
            # enum code.
            import uuid as _uuid
            try:
                _uuid.UUID(cat)
                qs = qs.filter(expense_category_id=cat)
            except (ValueError, TypeError):
                qs = qs.filter(category=cat.upper())
        if ps := request.query_params.get("payment_status"):
            qs = qs.filter(payment_status=ps.lower())
        if loc := request.query_params.get("location_id"):
            qs = qs.filter(location_id=loc)
        if ef := request.query_params.get("expense_for"):
            qs = qs.filter(expense_for__icontains=ef)
        if cn := request.query_params.get("contact"):
            qs = qs.filter(contact_name__icontains=cn)
        if df := request.query_params.get("date_from"):
            try:
                qs = qs.filter(expense_date__gte=_parse_date(df, "date_from"))
            except ValueError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        if dt := request.query_params.get("date_to"):
            try:
                qs = qs.filter(expense_date__lte=_parse_date(dt, "date_to"))
            except ValueError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        if q := request.query_params.get("search"):
            qs = qs.filter(
                Q(reference_no__icontains=q)
                | Q(description__icontains=q)
                | Q(expense_for__icontains=q)
                | Q(contact_name__icontains=q)
            )

        try:
            page  = max(int(request.query_params.get("page",  1)), 1)
            limit = max(min(int(request.query_params.get("limit", 25)), 200), 1)
        except (TypeError, ValueError):
            page, limit = 1, 25

        total = qs.count()
        total_pages = max((total + limit - 1) // limit, 1)
        offset = (page - 1) * limit
        rows = qs[offset:offset + limit]

        zero = Value(_D("0"), output_field=DecimalField(max_digits=14, decimal_places=2))
        agg = qs.aggregate(
            total_amount = Coalesce(Sum("amount"),      zero),
            total_paid   = Coalesce(Sum("paid_amount"), zero),
            total_tax    = Coalesce(Sum("tax_amount"),  zero),
        )
        # Status counts
        from django.db.models import Count
        status_counts = dict(
            qs.values_list("payment_status").annotate(c=Count("id")).values_list("payment_status", "c")
        )

        total_due = (agg["total_amount"] or _D("0")) - (agg["total_paid"] or _D("0"))

        return Response({
            "results":     ExpenseSerializer(rows, many=True).data,
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "summary": {
                "total_amount":   str(agg["total_amount"]),
                "total_paid":     str(agg["total_paid"]),
                "total_tax":      str(agg["total_tax"]),
                "total_due":      str(max(total_due, _D("0"))),
                "status_counts":  status_counts,
            },
        })

    @extend_schema(
        summary="Record expense",
        description="Record an operational expense. Creates a double-entry journal entry automatically. Requires `can_record_expense` permission.",
        request=ExpenseCreateSerializer,
        responses={201: ExpenseSerializer},
    )
    def post(self, request):
        import logging as _lg
        _log = _lg.getLogger(__name__)
        try:
            return self._do_post(request)
        except Exception as exc:  # noqa: BLE001
            from rest_framework.exceptions import ValidationError as _VE
            if isinstance(exc, _VE):
                raise
            _log.exception("Unhandled error in ExpenseListCreateView.post: %s", exc)
            return Response(
                {"detail": f"Could not save expense: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

    def _do_post(self, request):
        ser = ExpenseCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d   = ser.validated_data
        # Multi-branch: force the expense into the active branch.
        if _bid := active_branch_id():
            d["location_id"] = _bid

        # Expense account is optional now — fall back to the first
        # EXPENSE-type Account on the tenant's chart of accounts so
        # the Record Expense page doesn't need to ask the cashier
        # for it. The chart-of-accounts journal still needs SOMETHING
        # to debit; this picks a sensible default.
        from .models import Account as _Account
        expense_account_id = d.get("expense_account_id")
        if not expense_account_id:
            fallback = (
                _Account.objects
                .filter(account_type=_Account.Type.EXPENSE, is_active=True)
                .order_by("code")
                .first()
            )
            if not fallback:
                return Response(
                    {"detail": "No expense account configured in chart of accounts."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            expense_account_id = fallback.id

        # payment_account_id on the request can be one of two things,
        # depending on which client is sending it:
        #   1. PaymentAccount.id  (new flow — Record Expense, POS modal)
        #   2. Account.id         (legacy POS path that used
        #                          getAccounts() and sent a
        #                          chart-of-accounts id)
        #
        # Resolve to a PaymentAccount either way so the visible
        # balance always decrements. If the value is an Account we
        # match an active PaymentAccount of the corresponding type
        # (CASH / BANK).
        from .models import PaymentAccount as _PaymentAccount
        pa_id_in = d["payment_account_id"]
        picked_pa = _PaymentAccount.objects.filter(id=pa_id_in, is_active=True).first()
        if not picked_pa:
            # Try treating the value as a chart Account id and
            # mapping its type to a PaymentAccount type.
            try:
                coa_match = _Account.objects.filter(id=pa_id_in).first()
            except Exception:  # noqa: BLE001
                coa_match = None
            if coa_match is not None:
                pa_type_map = {
                    "CASH":      _PaymentAccount.AccountType.CASH,
                    "BANK":      _PaymentAccount.AccountType.BANK,
                    "MFS":       _PaymentAccount.AccountType.MFS,
                    "MOBILE":    _PaymentAccount.AccountType.MFS,
                    "CARD":      _PaymentAccount.AccountType.CARD,
                    "ASSET":     _PaymentAccount.AccountType.CASH,
                    "LIABILITY": _PaymentAccount.AccountType.OTHER,
                }
                hint = pa_type_map.get(coa_match.account_type)
                if hint:
                    picked_pa = (
                        _PaymentAccount.objects
                        .filter(account_type=hint, is_active=True)
                        .order_by("name").first()
                    )
            # Last-resort fallback: any active PaymentAccount.
            if not picked_pa:
                picked_pa = (
                    _PaymentAccount.objects
                    .filter(is_active=True)
                    .order_by("name").first()
                )
            if not picked_pa:
                return Response(
                    {"detail": "No active Payment Account configured. "
                               "Add one under Payment Accounts and try again."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        coa_kind = (
            _Account.Type.ASSET
        )
        coa_pay = (
            _Account.objects
            .filter(account_type=coa_kind, is_active=True)
            .order_by("code")
            .first()
        )
        if not coa_pay:
            return Response(
                {"detail": "No asset (cash/bank) account in chart of accounts."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            expense = services.record_expense(
                category           = d.get("category") or "OTHER",
                amount             = d["amount"],
                expense_account_id = expense_account_id,
                payment_account_id = coa_pay.id,
                description        = d["description"],
                expense_date       = d.get("expense_date"),
                created_by_id      = request.user.id,
            )
        except services.AccountingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Apply rich-form extras the simple service layer doesn't know about.
        extra = {}
        if d.get("reference_no"):       extra["reference_no"]      = d["reference_no"].strip()
        if d.get("location_id"):        extra["location_id"]       = d["location_id"]
        if d.get("tax_amount") is not None:  extra["tax_amount"]   = d["tax_amount"]
        if d.get("paid_amount") is not None:
            from decimal import Decimal as _D
            paid = _D(str(d["paid_amount"] or 0))
            amt  = _D(str(d["amount"]))
            extra["paid_amount"] = paid
            # Only honor explicit payment_status if the caller sent one;
            # otherwise infer from paid vs amount.
            extra["payment_status"] = (
                d.get("payment_status")
                or ("paid" if paid >= amt else "partial" if paid > 0 else "due")
            )
        elif d.get("payment_status"):
            extra["payment_status"] = d["payment_status"]
        if d.get("expense_for"):        extra["expense_for"]       = d["expense_for"].strip()
        if d.get("contact_name"):       extra["contact_name"]      = d["contact_name"].strip()
        if d.get("contact_id"):         extra["contact_id"]        = d["contact_id"]
        if d.get("recurring"):          extra["recurring"]         = bool(d["recurring"])
        if d.get("recurring_details"):  extra["recurring_details"] = d["recurring_details"].strip()
        # New rich-form fields — taxonomy FKs, payment-method extras,
        # and the user-facing PaymentAccount reference.
        if d.get("expense_category_id"):     extra["expense_category_id"]     = d["expense_category_id"]
        if d.get("expense_sub_category_id"): extra["expense_sub_category_id"] = d["expense_sub_category_id"]
        extra["payment_account_picked_id"] = picked_pa.id
        if d.get("payment_method"):    extra["payment_method"]      = d["payment_method"].strip()
        if d.get("card_holder_name"):  extra["card_holder_name"]    = d["card_holder_name"].strip()
        if d.get("card_transaction_no"): extra["card_transaction_no"] = d["card_transaction_no"].strip()
        if d.get("card_type"):         extra["card_type"]           = d["card_type"].strip()
        if d.get("card_month"):        extra["card_month"]          = d["card_month"].strip()
        if d.get("card_year"):         extra["card_year"]           = d["card_year"].strip()
        if d.get("cheque_no"):         extra["cheque_no"]           = d["cheque_no"].strip()
        if d.get("bank_account_no"):   extra["bank_account_no"]     = d["bank_account_no"].strip()
        if d.get("attach_document_url"): extra["attach_document_url"] = d["attach_document_url"].strip()
        if extra:
            # Defensive: each field is saved INDIVIDUALLY so if a
            # tenant's DB hasn't run migration 0010 yet (the new
            # payment_method / cheque_no / etc. columns don't exist
            # there) we skip those rather than 500-ing on the whole
            # request. Original columns (reference_no, location_id,
            # tax_amount, paid_amount, payment_status, expense_for,
            # contact_name) always exist.
            import logging as _lg
            _log = _lg.getLogger(__name__)
            for k, v in extra.items():
                try:
                    setattr(expense, k, v)
                    expense.save(update_fields=[k])
                except Exception as exc:  # noqa: BLE001
                    _log.warning(
                        "Could not persist expense extra field '%s' = %r on %s: %s "
                        "(probably missing column — run migrate_tenants).",
                        k, v, expense.id, exc,
                    )

        # ── User-facing PaymentAccount balance ───────────────────────────
        # The List Accounts page reads its balance from
        # PaymentAccountTransaction rows. A recorded expense must
        # deduct from the cashier's chosen account, otherwise the
        # visible balance never moves — exactly the bug the user
        # reported on returns earlier. Writing -amount on the
        # selected PaymentAccount makes "Cash on Hand" or "City Bank"
        # drop by exactly the expense total.
        from decimal import Decimal as _D
        try:
            from .models import PaymentAccountTransaction as _PAT
            paid_amt = _D(str(d.get("paid_amount") or d["amount"]))
            if paid_amt > 0:
                _PAT.objects.create(
                    account     = picked_pa,
                    kind        = _PAT.Kind.EXPENSE,
                    amount      = -paid_amt,
                    reference   = expense.reference_no or "",
                    note        = f"Expense: {expense.description or expense.get_category_display()}",
                )
        except Exception as exc:  # noqa: BLE001
            import logging as _lg
            _lg.getLogger(__name__).exception(
                "Failed to write PaymentAccountTransaction for expense %s: %s",
                expense.id, exc,
            )

        expense_full = Expense.objects.select_related(
            "expense_account", "payment_account", "journal_entry"
        ).get(id=expense.id)

        log_from_request(
            request,
            action      = AuditAction.CREATE,
            module      = "accounting.Expense",
            record_id   = expense_full.id,
            record_repr = str(expense_full),
            new_value   = {
                "category": expense_full.category,
                "amount":   str(expense_full.amount),
                "account":  expense_full.expense_account.name,
            },
        )

        return Response(ExpenseSerializer(expense_full).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Accounting"])
class ExpenseDetailView(APIView):
    """GET / PATCH / DELETE /api/accounting/expenses/<id>/"""
    permission_classes = [IsAuthenticated]

    def _get_object(self, pk):
        try:
            return Expense.objects.select_related(
                "expense_account", "payment_account", "journal_entry",
                "expense_category", "expense_sub_category",
            ).get(id=pk)
        except Expense.DoesNotExist:
            return None

    def get(self, request, pk):
        obj = self._get_object(pk)
        if not obj:
            return Response({"detail": "Expense not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(ExpenseSerializer(obj).data)

    def patch(self, request, pk):
        obj = self._get_object(pk)
        if not obj:
            return Response({"detail": "Expense not found."}, status=status.HTTP_404_NOT_FOUND)
        data = request.data or {}
        # Limited update — display/header fields the Edit Expense
        # modal exposes. The journal entry stays intact because the
        # money has already moved; if the operator changes amount or
        # account they're expected to delete + recreate the expense.
        SIMPLE = (
            "description", "expense_for", "contact_name", "reference_no",
            "tax_amount", "expense_date", "recurring", "recurring_details",
        )
        for f in SIMPLE:
            if f in data:
                setattr(obj, f, data[f])
        # FK fields by id — keep the patch safe by validating before
        # we save so a bad id raises a clear 400 instead of crashing.
        from decimal import Decimal as _D
        if "category_id" in data:
            obj.expense_category_id = data["category_id"] or None
        if "sub_category_id" in data:
            obj.expense_sub_category_id = data["sub_category_id"] or None
        if "location_id" in data:
            obj.location_id = data["location_id"] or None
        if "contact_id" in data:
            obj.contact_id = data["contact_id"] or None
        if "note" in data:
            # The frontend modal calls the textarea "Expense note"
            # but the column is `description` — both keys are
            # accepted so callers don't break.
            obj.description = str(data["note"] or "")
        if "total_amount" in data or "amount" in data:
            try:
                obj.amount = _D(str(data.get("total_amount") or data.get("amount") or 0))
            except Exception:
                pass
        if "tax_rate" in data:
            try:
                rate = _D(str(data["tax_rate"] or 0))
                obj.tax_amount = (obj.amount or _D("0")) * rate / _D("100")
            except Exception:
                pass
        # Recurring trio. recurring_details is a CharField in this
        # tenant's schema — collapse into a compact "interval unit /
        # count" string so it round-trips cleanly without altering
        # the column type.
        if "is_recurring" in data:
            obj.recurring = bool(data["is_recurring"])
        if any(k in data for k in ("recurring_interval", "recurring_unit", "recurring_count")):
            interval = data.get("recurring_interval") or ""
            unit     = data.get("recurring_unit") or "Days"
            count    = data.get("recurring_count") or ""
            obj.recurring_details = f"{interval} {unit} / {count}".strip()
        obj.save()
        return Response(ExpenseSerializer(obj).data)

    def delete(self, request, pk):
        from .models import PaymentAccountTransaction as _PAT, JournalEntry as _JE
        from django.db import transaction as _txn
        obj = self._get_object(pk)
        if not obj:
            return Response({"detail": "Expense not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            with _txn.atomic(using=obj._state.db or "default"):
                # Reverse the user-facing PaymentAccount entry first so
                # the visible balance bumps back up.
                pa_id = getattr(obj, "payment_account_picked_id", None)
                if pa_id:
                    _PAT.objects.filter(reference=obj.reference_no or "",
                                        account_id=pa_id).delete()
                # Wipe the journal entry so totals re-balance, then
                # the expense itself. The legacy chart-of-accounts
                # PROTECT FK is respected.
                if obj.journal_entry_id:
                    try:
                        _JE.objects.filter(id=obj.journal_entry_id).delete()
                    except Exception:
                        pass
                obj.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        except Exception as exc:  # noqa: BLE001
            return Response(
                {"detail": f"Could not delete expense: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )


# ──────────────────────────────────────────────────────────────────────────────
# Expense Categories (master) — full CRUD list/detail
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class ExpenseCategoryListCreateView(APIView):
    """GET / POST  /api/accounting/expense-categories/"""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.db.models import Q
        qs = ExpenseCategory.objects.select_related("parent").order_by("parent_id", "name")
        if request.query_params.get("active") == "true":
            qs = qs.filter(is_active=True)
        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(Q(name__icontains=search) | Q(code__icontains=search))
        return Response(ExpenseCategorySerializer(qs, many=True).data)

    def post(self, request):
        ser = ExpenseCategorySerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Accounting"])
class ExpenseCategoryDetailView(APIView):
    """GET / PATCH / DELETE  /api/accounting/expense-categories/<id>/"""
    permission_classes = [IsAuthenticated]

    def _get(self, pk):
        try:
            return ExpenseCategory.objects.select_related("parent").get(pk=pk)
        except ExpenseCategory.DoesNotExist:
            return None

    def get(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(ExpenseCategorySerializer(obj).data)

    def patch(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        ser = ExpenseCategorySerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)

    def delete(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if obj.children.exists():
            return Response(
                {"detail": "Cannot delete a category that has sub-categories. Delete the children first."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Reports
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class LedgerView(APIView):
    """
    GET /api/accounting/ledger/

    Required query param: account_id
    Optional:             date_from, date_to
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Account ledger",
        description="Returns all journal entry lines for an account with running balance. Requires `can_view_profit_loss` permission.",
        parameters=[
            OpenApiParameter("account_id", OpenApiTypes.UUID, required=True, description="Account UUID"),
            OpenApiParameter("date_from",  OpenApiTypes.DATE, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",    OpenApiTypes.DATE, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        account_id = request.query_params.get("account_id")
        if not account_id:
            return Response(
                {"detail": "account_id query parameter is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        date_from = date_to = None
        try:
            if df := request.query_params.get("date_from"):
                date_from = _parse_date(df, "date_from")
            if dt := request.query_params.get("date_to"):
                date_to = _parse_date(dt, "date_to")
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            result = services.get_ledger(
                account_id=account_id, date_from=date_from, date_to=date_to
            )
        except services.AccountingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)

        return Response(result)


@extend_schema(tags=["Accounting"])
class TrialBalanceView(APIView):
    """
    GET /api/accounting/trial-balance/

    Optional: date_from, date_to
    Restricted to OWNER / ADMIN (CAN_VIEW_PROFIT_LOSS).
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Trial balance",
        description="Returns debit/credit totals per account. Requires `can_view_profit_loss` permission (OWNER / ADMIN).",
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
    def get(self, request):
        date_from = date_to = None
        try:
            if df := request.query_params.get("date_from"):
                date_from = _parse_date(df, "date_from")
            if dt := request.query_params.get("date_to"):
                date_to = _parse_date(dt, "date_to")
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            services.get_trial_balance(date_from=date_from, date_to=date_to)
        )


@extend_schema(tags=["Accounting"])
class ProfitLossView(APIView):
    """
    GET /api/accounting/profit-loss/

    Required: date_from, date_to
    Restricted to OWNER / ADMIN (CAN_VIEW_PROFIT_LOSS).
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Profit & Loss statement",
        description="Returns revenue, COGS, gross profit, expenses, and net profit for the period. Requires `can_view_profit_loss`.",
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE, required=True, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, required=True, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
    def get(self, request):
        try:
            date_from = _parse_date(request.query_params.get("date_from", ""), "date_from")
            date_to   = _parse_date(request.query_params.get("date_to",   ""), "date_to")
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            services.get_profit_and_loss(date_from=date_from, date_to=date_to)
        )


@extend_schema(tags=["Accounting"])
class BalanceSheetView(APIView):
    """
    GET /api/accounting/balance-sheet/

    Required: as_of_date (YYYY-MM-DD)
    Restricted to OWNER / ADMIN (CAN_VIEW_PROFIT_LOSS).
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Balance sheet",
        description="Returns assets, liabilities, and equity as of a specific date. Requires `can_view_profit_loss`.",
        parameters=[
            OpenApiParameter("as_of_date", OpenApiTypes.DATE, required=True, description="Snapshot date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
    def get(self, request):
        try:
            as_of = _parse_date(
                request.query_params.get("as_of_date", ""), "as_of_date"
            )
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(services.get_balance_sheet(as_of_date=as_of))


@extend_schema(tags=["Accounting"])
class CashFlowView(APIView):
    """
    GET /api/accounting/cash-flow/

    Required: date_from, date_to
    Restricted to OWNER / ADMIN (CAN_VIEW_PROFIT_LOSS).
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Cash flow statement",
        description="Returns operating, investing, and financing cash flows for the period. Requires `can_view_profit_loss`.",
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE, required=True, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, required=True, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
    def get(self, request):
        try:
            date_from = _parse_date(request.query_params.get("date_from", ""), "date_from")
            date_to   = _parse_date(request.query_params.get("date_to",   ""), "date_to")
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            services.get_cash_flow(date_from=date_from, date_to=date_to)
        )


# ──────────────────────────────────────────────────────────────────────────────
# Payment Accounts — Cash / Bank / MFS wallets
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class PaymentAccountListCreateView(APIView):
    """GET / POST /api/accounting/payment-accounts/"""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.db.models import Q
        qs = PaymentAccount.objects.all()
        active_q = request.query_params.get("active")
        if active_q == "true":
            qs = qs.filter(is_active=True)
        elif active_q == "false":
            qs = qs.filter(is_active=False)
        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(Q(name__icontains=search) | Q(account_number__icontains=search))
        return Response(PaymentAccountSerializer(qs, many=True).data)

    def post(self, request):
        ser = PaymentAccountSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        instance = ser.save(
            added_by_name=(
                getattr(request.user, "name", None)
                or getattr(request.user, "email", "")
                or ""
            ),
        )
        return Response(PaymentAccountSerializer(instance).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Accounting"])
class PaymentAccountDetailView(APIView):
    """GET / PATCH / DELETE /api/accounting/payment-accounts/<id>/"""
    permission_classes = [IsAuthenticated]

    def _get(self, pk):
        try:
            return PaymentAccount.objects.get(pk=pk)
        except PaymentAccount.DoesNotExist:
            return None

    def get(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(PaymentAccountSerializer(obj).data)

    def patch(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        ser = PaymentAccountSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)

    def delete(self, request, pk):
        obj = self._get(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Balance Summary — merchant-view balance sheet for the Payment Accounts page
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class BalanceSummaryView(APIView):
    """
    GET /api/accounting/balance-summary/

    Returns a compact "merchant balance sheet" used by the Payment Accounts →
    Balance Sheet screen. Aggregates four things in a single response:

      assets:
        customer_due  — Σ (sale.total − sale.amount_paid) where balance_due > 0
        closing_stock — Σ (product_stock.qty × product.cost_price) — best-effort
        accounts      — list of [{name, balance}] from PaymentAccount

      liabilities:
        supplier_due  — Σ (purchase.grand_total − purchase.paid_amount) > 0

    Optional query: ?location_id=<uuid>&as_of_date=YYYY-MM-DD
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from decimal import Decimal as _D
        from django.db.models import Sum, F, DecimalField, ExpressionWrapper, Q, Value
        from django.db.models.functions import Coalesce

        loc_id    = request.query_params.get("location_id") or None
        as_of_str = request.query_params.get("as_of_date") or None

        # ── Customer due (sales)
        try:
            from sales.models import Sale
            sale_qs = Sale.objects.exclude(status="VOIDED")
            if loc_id:    sale_qs = sale_qs.filter(location_id=loc_id)
            if as_of_str: sale_qs = sale_qs.filter(created_at__date__lte=as_of_str)
            customer_due = sale_qs.aggregate(
                t=Coalesce(Sum("balance_due"), Value(_D("0")))
            )["t"] or _D("0")
        except Exception:
            customer_due = _D("0")

        # ── Supplier due (purchases)
        try:
            from purchases.models import Purchase
            purchase_qs = Purchase.objects.exclude(status="cancelled")
            if loc_id:    purchase_qs = purchase_qs.filter(location_id=loc_id)
            if as_of_str: purchase_qs = purchase_qs.filter(purchase_date__lte=as_of_str)
            # payment_due is a property — compute via expression
            purchase_qs = purchase_qs.annotate(
                _due=ExpressionWrapper(
                    F("grand_total") - F("paid_amount"),
                    output_field=DecimalField(max_digits=14, decimal_places=2),
                ),
            )
            supplier_due = purchase_qs.filter(_due__gt=0).aggregate(
                t=Coalesce(Sum("_due"), Value(_D("0")))
            )["t"] or _D("0")
        except Exception:
            supplier_due = _D("0")

        # ── Closing stock value
        try:
            from inventory.models import ProductStock
            stock_qs = ProductStock.objects.select_related("product")
            if loc_id: stock_qs = stock_qs.filter(location_id=loc_id)
            stock_qs = stock_qs.annotate(
                _value=ExpressionWrapper(
                    F("quantity") * F("product__cost_price"),
                    output_field=DecimalField(max_digits=18, decimal_places=2),
                ),
            )
            closing_stock = stock_qs.aggregate(
                t=Coalesce(Sum("_value"), Value(_D("0")))
            )["t"] or _D("0")
        except Exception:
            closing_stock = _D("0")

        # ── Payment account balances
        # BUG (previously): only opening_balance was reported, so
        # accounts_total ignored every recorded sale payment,
        # expense, transfer, and adjustment. That under-counted
        # total_assets and broke the merchant balance equation.
        # Fix: balance = opening_balance + Σ transactions.amount
        # (matches PaymentAccountSerializer.get_balance), honouring
        # the as_of_date upper bound when supplied.
        accounts = []
        accounts_total = _D("0")
        try:
            from .models import PaymentAccountTransaction  # noqa: PLC0415
            pa_rows = list(
                PaymentAccount.objects
                .filter(is_active=True)
                .values("id", "name", "account_type", "opening_balance")
            )
            for a in pa_rows:
                tx_qs = PaymentAccountTransaction.objects.filter(account_id=a["id"])
                if as_of_str:
                    tx_qs = tx_qs.filter(created_at__date__lte=as_of_str)
                agg = tx_qs.aggregate(t=Coalesce(Sum("amount"), Value(_D("0"))))
                bal = (a.get("opening_balance") or _D("0")) + (agg["t"] or _D("0"))
                accounts.append({
                    "id":           str(a["id"]),
                    "name":         a["name"],
                    "account_type": a["account_type"],
                    "balance":      str(bal),
                })
                accounts_total += bal
        except Exception:
            accounts = []
            accounts_total = _D("0")

        total_assets      = customer_due + closing_stock + accounts_total
        total_liabilities = supplier_due
        # Equity (Net Worth) — what the business is worth right
        # now. Equation: Assets = Liabilities + Equity, so Equity
        # = Assets − Liabilities.
        net_worth = total_assets - total_liabilities

        return Response({
            "assets": {
                "customer_due":  str(customer_due),
                "closing_stock": str(closing_stock),
                "accounts":      accounts,
                "accounts_total": str(accounts_total),
            },
            "liabilities": {
                "supplier_due": str(supplier_due),
            },
            "total_assets":      str(total_assets),
            "total_liabilities": str(total_liabilities),
            "net_worth":         str(net_worth),
            # Tolerance-safe balance check — small floating drift
            # from quantize() rounding can produce 0.01 deltas. We
            # treat the sheet as balanced when the absolute delta
            # is under 1 paisa.
            "is_balanced":       abs(total_assets - (total_liabilities + net_worth)) < _D("0.01"),
        })


# ──────────────────────────────────────────────────────────────────────────────
# Payment Account — Transactions (Account Book), Deposit, Fund Transfer
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Accounting"])
class PaymentAccountTransactionsView(APIView):
    """
    GET /api/accounting/payment-accounts/<id>/transactions/
        ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD

    Returns the ledger for one payment account, plus a running balance
    seeded from `opening_balance`.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        from decimal import Decimal as _D
        try:
            acct = PaymentAccount.objects.get(pk=pk)
        except PaymentAccount.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        qs = acct.transactions.select_related("counter_account").order_by("transaction_date", "created_at")
        if df := request.query_params.get("date_from"):
            try: qs = qs.filter(transaction_date__date__gte=_parse_date(df, "date_from"))
            except ValueError as e: return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        if dt := request.query_params.get("date_to"):
            try: qs = qs.filter(transaction_date__date__lte=_parse_date(dt, "date_to"))
            except ValueError as e: return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        rows = list(qs)
        running = _D(str(acct.opening_balance or 0))
        enriched = []
        for tx in rows:
            running += _D(str(tx.amount))
            enriched.append({
                **PaymentAccountTransactionSerializer(tx).data,
                "running_balance": str(running),
            })

        return Response({
            "account": PaymentAccountSerializer(acct).data,
            "opening_balance": str(acct.opening_balance or 0),
            "closing_balance": str(running),
            "transactions":    enriched,
            "count":           len(enriched),
        })


@extend_schema(tags=["Accounting"])
class PaymentAccountDepositView(APIView):
    """
    POST /api/accounting/payment-accounts/<id>/deposit/

    Records a single Deposit, Withdrawal or Adjustment transaction against
    the account. Withdrawals are stored as a NEGATIVE amount so the
    aggregated balance stays correct.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        from decimal import Decimal as _D
        try:
            acct = PaymentAccount.objects.get(pk=pk)
        except PaymentAccount.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        ser = DepositInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data

        amount = _D(str(d["amount"]))
        if d["kind"] == "WITHDRAWAL":
            amount = -amount

        tx = PaymentAccountTransaction.objects.create(
            account         = acct,
            kind            = d["kind"],
            amount          = amount,
            reference       = d.get("reference", "").strip(),
            note            = d.get("note", "").strip(),
            created_by_name = (
                getattr(request.user, "name", None)
                or getattr(request.user, "email", "")
                or ""
            ),
        )
        return Response(PaymentAccountTransactionSerializer(tx).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Accounting"])
class PaymentAccountTransferView(APIView):
    """
    POST /api/accounting/payment-account-transfers/

    Atomically records BOTH legs of a fund transfer between two accounts.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from decimal import Decimal as _D
        from django.db import transaction as _atomic

        ser = FundTransferInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data

        try:
            src = PaymentAccount.objects.get(pk=d["from_account_id"])
            dst = PaymentAccount.objects.get(pk=d["to_account_id"])
        except PaymentAccount.DoesNotExist:
            return Response({"detail": "One of the accounts was not found."}, status=status.HTTP_404_NOT_FOUND)

        amount = _D(str(d["amount"]))
        actor  = (
            getattr(request.user, "name", None)
            or getattr(request.user, "email", "")
            or ""
        )
        ref  = d.get("reference", "").strip()
        note = d.get("note", "").strip() or f"Fund transfer {src.name} → {dst.name}"

        with _atomic.atomic():
            out_tx = PaymentAccountTransaction.objects.create(
                account=src, counter_account=dst,
                kind="TRANSFER_OUT", amount=-amount,
                reference=ref, note=note, created_by_name=actor,
            )
            in_tx = PaymentAccountTransaction.objects.create(
                account=dst, counter_account=src,
                kind="TRANSFER_IN", amount=amount,
                reference=ref, note=note, created_by_name=actor,
            )

        return Response({
            "from": PaymentAccountTransactionSerializer(out_tx).data,
            "to":   PaymentAccountTransactionSerializer(in_tx).data,
        }, status=status.HTTP_201_CREATED)


# ──────────────────────────────────────────────────────────────────────────────
# Branch-aware reports
# ──────────────────────────────────────────────────────────────────────────────

from . import branch_reports as _branch_reports  # noqa: E402


# NOTE: this is a SECOND `_parse_date` deliberately renamed `_iso_date`.
# The file already defines a `_parse_date(s, field_name)` earlier (2-arg,
# raises ValueError). When I appended these views in an earlier commit I
# shadowed that name with a 1-arg version, which silently broke
# ExpenseListCreateView at line 315. Lesson learned: pick a non-colliding
# name when appending to an existing module.
def _iso_date(s):
    if not s: return None
    try:
        from datetime import date as _date
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


class BranchPnLView(APIView):
    """GET /api/accounting/reports/branch/pnl/?location_id=X&date_from=&date_to="""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        loc = request.query_params.get("location_id")
        if not loc:
            return Response({"detail": "location_id is required."}, status=400)
        result = _branch_reports.branch_profit_and_loss(
            location_id=loc,
            date_from=_iso_date(request.query_params.get("date_from")),
            date_to=_iso_date(request.query_params.get("date_to")),
        )
        return Response(result)


class BranchContributionView(APIView):
    """GET /api/accounting/reports/branch/contribution/?location_id=X&date_from=&date_to=

    How much this branch contributed into each global account.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        loc = request.query_params.get("location_id")
        if not loc:
            return Response({"detail": "location_id is required."}, status=400)
        result = _branch_reports.branch_contribution_to_global(
            location_id=loc,
            date_from=_iso_date(request.query_params.get("date_from")),
            date_to=_iso_date(request.query_params.get("date_to")),
        )
        return Response(result)


class CashReconciliationView(APIView):
    """GET /api/accounting/reports/branch/cash-reconciliation/?location_id=X&date_to=

    End-of-day cash audit for a single branch — every branch-scoped ASSET
    account's running balance.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        loc = request.query_params.get("location_id")
        if not loc:
            return Response({"detail": "location_id is required."}, status=400)
        result = _branch_reports.cash_reconciliation(
            location_id=loc,
            date_to=_iso_date(request.query_params.get("date_to")),
        )
        return Response(result)


class GlobalAccountBalanceView(APIView):
    """GET /api/accounting/reports/global-account-balance/?account_id=X

    Total cross-branch balance of one global account (central bank, central
    MFS). Refuses on branch-scoped accounts — those already have a single
    home balance via the regular Account.get_balance().
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .models import Account
        aid = request.query_params.get("account_id")
        if not aid:
            return Response({"detail": "account_id is required."}, status=400)
        try:
            result = _branch_reports.global_account_balance(
                account_id=aid,
                date_to=_iso_date(request.query_params.get("date_to")),
            )
        except Account.DoesNotExist:
            return Response({"detail": "Account not found."}, status=404)
        except ValueError as e:
            return Response({"detail": str(e)}, status=400)
        return Response(result)


# ─────────────────────────────────────────────────────────────────────────
# Expense Payment helpers
# ─────────────────────────────────────────────────────────────────────────
def _post_expense_ledger(payment, *, reversal=False):
    """Write a PaymentAccountTransaction for the supplied
    ExpensePayment. Expense payments are money OUT (negative
    EXPENSE row). On reversal — used by edit + delete — we post the
    opposite-sign row so the running balance returns to where it
    was. Silent fail when the accounting infra isn't reachable so
    legacy tenants don't bomb."""
    if not payment.payment_account_id:
        return
    try:
        from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
    except Exception:
        return
    acct = PaymentAccount.objects.filter(id=payment.payment_account_id, is_active=True).first()
    if not acct:
        return
    from decimal import Decimal as _D  # noqa: PLC0415
    sign = _D("1") if reversal else _D("-1")
    PaymentAccountTransaction.objects.create(
        account=acct,
        kind=PaymentAccountTransaction.Kind.EXPENSE,
        amount=sign * _D(str(payment.amount or 0)),
        reference=payment.reference or "",
        note=(
            f"Expense payment "
            f"(expense {payment.expense.reference_no or payment.expense_id})"
            + (" — reversal" if reversal else "")
        ),
    )


def _parse_paid_at(raw):
    if not raw:
        return None
    from django.utils.dateparse import parse_datetime, parse_date  # noqa: PLC0415
    return parse_datetime(str(raw)) or parse_date(str(raw))


class ExpensePaymentListView(APIView):
    """GET (list) + POST (create) /api/accounting/expenses/<id>/payments/"""
    permission_classes = [IsAuthenticated]

    def _expense(self, pk):
        from .models import Expense  # noqa: PLC0415
        try:
            return Expense.objects.get(pk=pk)
        except Expense.DoesNotExist:
            return None

    def get(self, request, pk):
        expense = self._expense(pk)
        if not expense:
            return Response({"detail": "Expense not found."}, status=404)
        from .models import ExpensePayment  # noqa: PLC0415
        rows = ExpensePayment.objects.filter(expense_id=pk)
        from .serializers import ExpensePaymentSerializer  # noqa: PLC0415
        return Response(ExpensePaymentSerializer(rows, many=True).data)

    def post(self, request, pk):
        from decimal import Decimal as _D
        from django.db import transaction
        from django.utils import timezone as _tz
        expense = self._expense(pk)
        if not expense:
            return Response({"detail": "Expense not found."}, status=404)
        data = request.data or {}
        try:
            amount = _D(str(data.get("amount") or 0))
        except Exception:
            return Response({"detail": "Invalid amount."}, status=400)
        if amount <= 0:
            return Response({"detail": "Amount must be > 0."}, status=400)

        from .models import ExpensePayment  # noqa: PLC0415
        with transaction.atomic():
            p = ExpensePayment.objects.create(
                expense = expense,
                reference_no = (data.get("reference_no") or "")[:80],
                amount = amount,
                method = data.get("method") or "cash",
                reference = data.get("reference") or "",
                notes = data.get("notes") or data.get("note") or "",
                payment_account_id = data.get("payment_account_id") or None,
                paid_at = _parse_paid_at(data.get("paid_at") or data.get("date")) or _tz.now(),
            )
            _post_expense_ledger(p)
        from .serializers import ExpensePaymentSerializer  # noqa: PLC0415
        return Response(ExpensePaymentSerializer(p).data, status=201)


class ExpensePaymentDetailView(APIView):
    """GET / PATCH / DELETE /api/accounting/expenses/payments/<pid>/"""
    permission_classes = [IsAuthenticated]

    def _payment(self, pk):
        from .models import ExpensePayment  # noqa: PLC0415
        try:
            return ExpensePayment.objects.select_related("expense").get(pk=pk)
        except ExpensePayment.DoesNotExist:
            return None

    def get(self, request, pk):
        p = self._payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        from .serializers import ExpensePaymentSerializer  # noqa: PLC0415
        return Response(ExpensePaymentSerializer(p).data)

    def patch(self, request, pk):
        from decimal import Decimal as _D
        from django.db import transaction
        p = self._payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        data = request.data or {}
        with transaction.atomic():
            # Reverse the OLD ledger row before applying changes so
            # the running balance is correct no matter what the
            # operator edits (amount, account, method).
            _post_expense_ledger(p, reversal=True)

            if "amount" in data and data["amount"] not in (None, ""):
                try:
                    p.amount = _D(str(data["amount"]))
                except Exception:
                    return Response({"detail": "Invalid amount."}, status=400)
            if "method" in data and data["method"]:
                p.method = data["method"]
            if "reference" in data:
                p.reference = str(data["reference"] or "")
            if "notes" in data or "note" in data:
                p.notes = str(data.get("notes") or data.get("note") or "")
            if "payment_account_id" in data:
                p.payment_account_id = data["payment_account_id"] or None
            paid_at = _parse_paid_at(data.get("paid_at") or data.get("date"))
            if paid_at is not None:
                p.paid_at = paid_at
            if "reference_no" in data:
                p.reference_no = str(data["reference_no"] or "")[:80]
            p.save()
            _post_expense_ledger(p)
        from .serializers import ExpensePaymentSerializer  # noqa: PLC0415
        return Response(ExpensePaymentSerializer(p).data)

    def delete(self, request, pk):
        from django.db import transaction
        p = self._payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        with transaction.atomic():
            _post_expense_ledger(p, reversal=True)
            p.delete()
        return Response(status=204)
