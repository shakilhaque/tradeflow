"""
Sales Representative Report

Three views, scoped to the sales-rep who *created* each record:
    mode=added       — Sales they added (created_by_id = user_id)
    mode=commission  — Same sales but with a Commission column.
                       The commission % is provided per request as
                       `commission_percent` (default 0). Row-level commission
                       = total_amount × commission_percent / 100.
    mode=expenses    — Expenses they recorded (created_by_id = user_id)

Common filters
    user_id        — UUID of the sales rep (created_by_id). Cashiers are
                     auto-clamped to their own UUID.
    location_id    — Filter to a single location.
    date_from / date_to — Required for any meaningful figures.
    commission_percent  — used only in commission mode (default 0).
    search, page, limit

Summary block (the orange banner in the original screenshot)
    total_sale          — SUM(Sale.total_amount) for FINAL sales in range
    total_sale_return   — SUM(SellReturn.total_amount) in range
    net_sale            — total_sale − total_sale_return
    total_expense       — SUM(Expense.amount) in range
    total_commission    — total_sale × commission_percent / 100 (only when
                          commission mode is requested)

Footer totals row (matches the bottom of the table) is computed across the
FULL filtered set, not just the current page.

Permission: CAN_VIEW_REPORTS.
"""
from datetime import date as _date
from decimal import Decimal as _D

from django.db.models import (
    Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value,
)
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _parse_date(s):
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _resolve_user_names(uuids):
    if not uuids:
        return {}
    try:
        from accounts.models import User  # noqa: PLC0415
        rows = (
            User.objects.using("default")
            .filter(id__in=uuids)
            .values("id", "name", "email")
        )
        return {str(r["id"]): (r["name"] or r["email"] or "—") for r in rows}
    except Exception:
        return {}


@extend_schema(tags=["Reports"])
class SalesRepresentativeReportView(APIView):
    """Sales-representative report — Sales Added / With Commission / Expenses."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Sales representative report",
        description=(
            "Sales / sales-returns / expenses scoped to the rep who created "
            "each record. Three view modes accessible by the `mode` query "
            "param: `added` (default), `commission`, `expenses`."
        ),
        parameters=[
            OpenApiParameter("mode",        OpenApiTypes.STR,  description="added | commission | expenses (default added)"),
            OpenApiParameter("user_id",     OpenApiTypes.UUID, description="Filter by sales-rep UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
            OpenApiParameter("commission_percent", OpenApiTypes.NUMBER, description="Commission percent for the With-Commission tab (default 0)"),
            OpenApiParameter("search",      OpenApiTypes.STR,  description="Invoice / customer / reference"),
            OpenApiParameter("page",        OpenApiTypes.INT,  description="Page (default 1)"),
            OpenApiParameter("limit",       OpenApiTypes.INT,  description="Per page (default 25, max 200)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from accounts.permissions import Perm, has_permission  # noqa: PLC0415
        if not has_permission(request.user, Perm.CAN_VIEW_REPORTS):
            return Response(
                {"detail": "You do not have permission to view reports."},
                status=status.HTTP_403_FORBIDDEN,
            )

        params = request.query_params
        mode = (params.get("mode") or "added").lower()
        if mode not in ("added", "commission", "expenses"):
            mode = "added"

        date_from   = _parse_date(params.get("date_from"))
        date_to     = _parse_date(params.get("date_to"))
        location_id = params.get("location_id") or ""
        user_id     = params.get("user_id") or ""
        search      = (params.get("search") or "").strip()
        try:
            commission_percent = _D(str(params.get("commission_percent") or "0"))
        except Exception:
            commission_percent = _D("0")
        if commission_percent < 0:
            commission_percent = _D("0")
        if commission_percent > _D("100"):
            commission_percent = _D("100")

        try:
            page = max(int(params.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1
        try:
            limit = int(params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        limit = min(max(limit, 5), 200)

        # CASHIER clamp — restrict to own UUID.
        if getattr(request.user, "role", "") == "cashier":
            user_id = str(request.user.id)

        # ── Shared querysets ────────────────────────────────────────────────
        from sales.models import Sale, SellReturn  # noqa: PLC0415
        from accounting.models import Expense       # noqa: PLC0415

        from accounts.branch_context import branch_scope  # noqa: PLC0415
        # Sales — only FINAL count for revenue / returns / commission.
        sales_qs = branch_scope(
            Sale.objects.filter(status="FINAL")
            .select_related("location", "customer")
        )
        if date_from:    sales_qs = sales_qs.filter(created_at__date__gte=date_from)
        if date_to:      sales_qs = sales_qs.filter(created_at__date__lte=date_to)
        if location_id:  sales_qs = sales_qs.filter(location_id=location_id)
        if user_id:      sales_qs = sales_qs.filter(created_by_id=user_id)
        if search:
            sales_qs = sales_qs.filter(
                Q(invoice_number__icontains=search) |
                Q(customer__name__icontains=search) |
                Q(customer__phone__icontains=search)
            )

        # Sale returns — same filters where applicable.
        returns_qs = branch_scope(
            SellReturn.objects.all()
            .select_related("location", "customer", "parent_sale")
        )
        if date_from:    returns_qs = returns_qs.filter(return_date__gte=date_from)
        if date_to:      returns_qs = returns_qs.filter(return_date__lte=date_to)
        if location_id:  returns_qs = returns_qs.filter(location_id=location_id)
        if user_id:      returns_qs = returns_qs.filter(created_by_id=user_id)

        # Expenses
        expenses_qs = branch_scope(
            Expense.objects.all()
            .select_related("expense_account", "payment_account")
        )
        if date_from:    expenses_qs = expenses_qs.filter(expense_date__gte=date_from)
        if date_to:      expenses_qs = expenses_qs.filter(expense_date__lte=date_to)
        if location_id:  expenses_qs = expenses_qs.filter(location_id=location_id)
        if user_id:      expenses_qs = expenses_qs.filter(created_by_id=user_id)
        if search and mode == "expenses":
            expenses_qs = expenses_qs.filter(
                Q(reference_no__icontains=search) |
                Q(expense_for__icontains=search)  |
                Q(contact_name__icontains=search) |
                Q(description__icontains=search)
            )

        # ── Summary banner (matches the orange block in the screenshot) ─────
        total_sale = sales_qs.aggregate(v=Coalesce(Sum("total_amount"), ZERO))["v"] or _D("0")
        total_return = returns_qs.aggregate(v=Coalesce(Sum("total_amount"), ZERO))["v"] or _D("0")
        total_expense = expenses_qs.aggregate(v=Coalesce(Sum("amount"), ZERO))["v"] or _D("0")
        net_sale = total_sale - total_return
        total_commission = (total_sale * commission_percent / _D("100")).quantize(_D("0.01"))

        summary = {
            "total_sale":          str(total_sale),
            "total_sale_return":   str(total_return),
            "net_sale":            str(net_sale),
            "total_expense":       str(total_expense),
            "commission_percent":  str(commission_percent),
            "total_commission":    str(total_commission),
        }

        # ── Filter dropdown options ────────────────────────────────────────
        # Full tenant roster (owner + every sub-user) from the master
        # DB. The old row-derived list had the classic Django
        # .distinct()-with-default-ordering bug (ORDER BY column joins
        # the DISTINCT clause), so the same rep appeared once PER SALE
        # — "Ismail Hossain" dozens of times in the dropdown.
        from ._user_options import tenant_user_options  # noqa: PLC0415
        user_options = tenant_user_options(request.user)

        from inventory.models import Location  # noqa: PLC0415
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        # ── Mode dispatch ──────────────────────────────────────────────────
        if mode == "expenses":
            footer = self._footer_expenses(expenses_qs)
            rows, count, total_pages, page = self._page_expenses(expenses_qs, page, limit)
        else:
            # 'added' and 'commission' share the same Sale rows.
            sales_qs = sales_qs.order_by("-created_at")
            footer = self._footer_sales(sales_qs, commission_percent if mode == "commission" else _D("0"))
            rows, count, total_pages, page = self._page_sales(
                sales_qs, page, limit,
                commission_percent=commission_percent if mode == "commission" else _D("0"),
            )

        return Response({
            "mode":               mode,
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "summary":            summary,
            "footer":             footer,
            "rows":               rows,
            "page":               page,
            "limit":              limit,
            "total_pages":        total_pages,
            "count":              count,
            "user_options":       user_options,
            "location_options":   location_options,
            "commission_percent": str(commission_percent),
        })

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _page_sales(self, sales_qs, page, limit, *, commission_percent):
        count = sales_qs.count()
        total_pages = max((count + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = list(sales_qs[offset: offset + limit])

        rows = []
        for s in page_rows:
            total = s.total_amount or _D("0")
            paid  = s.amount_paid  or _D("0")
            due   = (total - paid)
            commission = (total * commission_percent / _D("100")).quantize(_D("0.01")) \
                          if commission_percent > 0 else _D("0")
            rows.append({
                "id":              str(s.id),
                "created_at":      s.created_at,
                "invoice_number":  s.invoice_number,
                "customer_name":   s.customer.name if s.customer else "Walk-in",
                "location_name":   s.location.name if s.location else "—",
                "payment_status":  s.payment_status,
                "total":           str(total),
                "paid":            str(paid),
                "remaining":       str(due if due > 0 else _D("0")),
                "commission":      str(commission),
            })
        return rows, count, total_pages, page

    def _footer_sales(self, sales_qs, commission_percent):
        agg = sales_qs.aggregate(
            f_total = Coalesce(Sum("total_amount"), ZERO),
            f_paid  = Coalesce(Sum("amount_paid"), ZERO),
            f_due   = Coalesce(Sum(ExpressionWrapper(
                F("total_amount") - F("amount_paid"),
                output_field=DEC,
            )), ZERO),
        )
        total = agg["f_total"] or _D("0")
        commission = (total * commission_percent / _D("100")).quantize(_D("0.01")) \
                      if commission_percent > 0 else _D("0")
        return {
            "total":      str(total),
            "paid":       str(agg["f_paid"] or _D("0")),
            "remaining":  str(agg["f_due"]  or _D("0")),
            "commission": str(commission),
        }

    def _page_expenses(self, expenses_qs, page, limit):
        expenses_qs = expenses_qs.order_by("-expense_date", "-created_at")
        count = expenses_qs.count()
        total_pages = max((count + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = list(expenses_qs[offset: offset + limit])

        rows = []
        for e in page_rows:
            rows.append({
                "id":              str(e.id),
                "expense_date":    e.expense_date,
                "reference_no":    e.reference_no or "—",
                "category":        e.get_category_display(),
                "expense_for":     e.expense_for or "",
                "contact_name":    e.contact_name or "",
                "payment_status":  e.payment_status,
                "amount":          str(e.amount or _D("0")),
                "paid":            str(e.paid_amount or _D("0")),
                "remaining":       str((e.amount or _D("0")) - (e.paid_amount or _D("0"))),
            })
        return rows, count, total_pages, page

    def _footer_expenses(self, expenses_qs):
        agg = expenses_qs.aggregate(
            f_amount = Coalesce(Sum("amount"),      ZERO),
            f_paid   = Coalesce(Sum("paid_amount"), ZERO),
            f_due    = Coalesce(Sum(ExpressionWrapper(
                F("amount") - F("paid_amount"),
                output_field=DEC,
            )), ZERO),
        )
        return {
            "amount":     str(agg["f_amount"] or _D("0")),
            "paid":       str(agg["f_paid"]   or _D("0")),
            "remaining":  str(agg["f_due"]    or _D("0")),
        }
