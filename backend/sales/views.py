"""
Sales & POS API views.

All views require JWT authentication (IsAuthenticated).
The authenticated user's UUID is read from request.user.id and
passed into every service call for audit and permission checks.

Endpoints
─────────
Customers (CRUD via DRF router):
  GET/POST   /api/sales/customers/
  GET/PUT/PATCH/DELETE  /api/sales/customers/<id>/

Sales lifecycle:
  GET        /api/sales/                      list with filters
  POST       /api/sales/                      create (QUOTATION or DRAFT)
  GET        /api/sales/<id>/                 full detail
  PATCH      /api/sales/<id>/                 update editable sale
  POST       /api/sales/<id>/finalize/        finalize → FIFO deduction
  POST       /api/sales/<id>/payments/        record payment instalment
  POST       /api/sales/<id>/backorder/       create back-order
  POST       /api/sales/<id>/void/            void a FINAL sale (admin only)
"""
import csv
import io
import logging
from datetime import datetime, time
from decimal import Decimal, InvalidOperation

from django.http import HttpResponse
from rest_framework.parsers import MultiPartParser, FormParser

from drf_spectacular.utils import extend_schema, extend_schema_view, OpenApiParameter, OpenApiTypes
from django.db.models import Q, Case, When, Value, CharField, Sum, F, DecimalField
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Perm, has_permission, require_permission, require_perm_method
from accounts.branch_context import branch_scope, active_branch_id
from audit.services import AuditAction, log_from_request

from . import services
from .models import BackOrder, Customer, CustomerGroup, Discount, Sale, SalePayment, SellReturn
from .serializers import (
    AdvancedCreateSaleSerializer,
    AddPaymentSerializer,
    BackOrderSerializer,
    CreateBackOrderSerializer,
    CreateSaleSerializer,
    CustomerGroupSerializer,
    CustomerSerializer,
    FinalizeSerializer,
    SaleDetailSerializer,
    SaleListSerializer,
    DiscountSerializer,
    SellReturnListSerializer,
    SellReturnDetailSerializer,
    CreateSellReturnSerializer,
    UpdateSaleSerializer,
)

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers — friendly error translation
# ──────────────────────────────────────────────────────────────────────────────

def _friendly_sell_return_error(exc) -> str:
    """Map a raw Python exception thrown by create_sell_return into a
    sentence a non-technical tenant can act on. The full traceback is
    still logged via logger.exception elsewhere; this is the message
    we surface to the operator.
    """
    raw = str(exc) if exc else ""
    low = raw.lower()
    if "does not exist" in low and ("account" in low or "chart" in low):
        return (
            "Your chart of accounts is missing a required account "
            "(Cash, Bank, Accounts Receivable, Inventory, Revenue or COGS). "
            "Ask your administrator to add the missing account, then try again."
        )
    if "account" in low and ("not found" in low or "missing" in low):
        return (
            "A required accounting ledger is missing for this tenant. "
            "Open Accounting → Chart of Accounts and make sure Cash, Bank, "
            "Accounts Receivable, Inventory, Sales Revenue and COGS all exist."
        )
    if "stock" in low or "fifo" in low or "quantity" in low:
        return (
            "Couldn't restock the returned product. "
            "Check the product's location and quantity, then try again."
        )
    if "location" in low and "not found" in low:
        return "The branch / business location for this sale could not be found."
    if "product" in low and "not found" in low:
        return "One of the products in this return no longer exists in inventory."
    if "permission" in low:
        return (
            "Your account doesn't have permission to create a sale return. "
            "Ask your administrator to grant the 'sales.create' permission."
        )
    if "balance" in low or "exceed" in low:
        return raw   # already friendly from the service layer
    # Anything else — keep it short and non-jargony.
    return (
        "Couldn't save the sale return because of a server-side problem. "
        "If this keeps happening please contact support with the time of the attempt."
    )


# ──────────────────────────────────────────────────────────────────────────────
# Customer Groups — simple CRUD
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema_view(
    list=extend_schema(tags=["Customers"], summary="List customer groups",
        parameters=[
            OpenApiParameter("active_only", OpenApiTypes.BOOL, description='Pass "true" for active only'),
            OpenApiParameter("search", OpenApiTypes.STR, description="Search by group name or price-group label"),
        ]),
    retrieve=extend_schema(tags=["Customers"], summary="Get customer group detail"),
    create=extend_schema(tags=["Customers"], summary="Create customer group"),
    update=extend_schema(tags=["Customers"], summary="Update customer group"),
    partial_update=extend_schema(tags=["Customers"], summary="Partial update customer group"),
    destroy=extend_schema(tags=["Customers"], summary="Delete customer group"),
)
class CustomerGroupViewSet(viewsets.ModelViewSet):
    queryset           = CustomerGroup.objects.all()
    serializer_class   = CustomerGroupSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        if params.get("active_only") == "true":
            qs = qs.filter(is_active=True)
        search = (params.get("search") or "").strip()
        if search:
            qs = qs.filter(Q(name__icontains=search) | Q(price_group__icontains=search))
        return qs


# ──────────────────────────────────────────────────────────────────────────────
# Customers — simple CRUD via ModelViewSet
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema_view(
    list=extend_schema(tags=["Customers"], summary="List customers",
        parameters=[
            OpenApiParameter("active_only", OpenApiTypes.BOOL, description='Pass "true" for active only'),
            OpenApiParameter("search", OpenApiTypes.STR, description="Search by name, phone, or email"),
        ]),
    retrieve=extend_schema(tags=["Customers"], summary="Get customer detail"),
    create=extend_schema(tags=["Customers"], summary="Create customer"),
    update=extend_schema(tags=["Customers"], summary="Update customer"),
    partial_update=extend_schema(tags=["Customers"], summary="Partial update customer"),
    destroy=extend_schema(tags=["Customers"], summary="Delete customer"),
)
class CustomerViewSet(viewsets.ModelViewSet):
    queryset           = Customer.objects.all()
    serializer_class   = CustomerSerializer
    permission_classes = [IsAuthenticated]

    # Granular permission gates — owners / admins always pass; everyone
    # else needs the matching customer.* code (built-in role or custom
    # TenantRole). See accounts/role_permissions.py.
    @require_perm_method("customer.add")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @require_perm_method("customer.edit")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @require_perm_method("customer.edit")
    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

    @require_perm_method("customer.delete")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)

    # ── Advance balance ↔ cash sync ────────────────────────────────────────────
    # The contact form lets the operator set/adjust a customer's advance
    # balance directly. Advance is real money held against future invoices,
    # so any change must move the SAME amount in/out of a payment account —
    # otherwise the List Accounts balance silently drifts (e.g. removing an
    # advance left Cash on Hand untouched). The form sends `advance_account_id`
    # to say which account the cash goes to / comes from. Raising the advance
    # deposits into that account; lowering it withdraws.
    def _sync_advance_cash(self, customer, old_advance, account_id):
        from decimal import Decimal as _D
        delta = (customer.advance_balance or _D("0")) - (old_advance or _D("0"))
        if delta == 0 or not account_id:
            return
        try:
            from accounting.models import PaymentAccount, PaymentAccountTransaction
            acct = PaymentAccount.objects.filter(id=account_id, is_active=True).first()
            if not acct:
                return
            kind = (PaymentAccountTransaction.Kind.DEPOSIT if delta > 0
                    else PaymentAccountTransaction.Kind.WITHDRAWAL)
            PaymentAccountTransaction.objects.create(
                account   = acct,
                kind      = kind,
                amount    = delta,                      # signed: + deposit / − withdrawal
                reference = "",
                note      = (f"Advance added for {customer.name}" if delta > 0
                            else f"Advance removed from {customer.name}"),
            )
        except Exception:  # noqa: BLE001
            logger.exception("Failed to sync advance cash for customer %s", customer.id)

    def perform_create(self, serializer):
        from decimal import Decimal as _D
        customer = serializer.save()
        account_id = (self.request.data or {}).get("advance_account_id") or None
        self._sync_advance_cash(customer, _D("0"), account_id)

    def perform_update(self, serializer):
        old_advance = serializer.instance.advance_balance
        customer = serializer.save()
        account_id = (self.request.data or {}).get("advance_account_id") or None
        self._sync_advance_cash(customer, old_advance, account_id)

    def get_queryset(self):
        from decimal import Decimal as _D
        from django.db.models import (
            DecimalField as _DF, ExpressionWrapper as _EW,
            F as _F, Q as _Q, Sum as _Sum, Value as _V,
        )
        from django.db.models.functions import Coalesce as _Coalesce

        DEC  = _DF(max_digits=14, decimal_places=2)
        ZERO = _V(_D("0"), output_field=DEC)

        qs = super().get_queryset().select_related("customer_group")

        # Filters ─────────────────────────────────────────────────────────────
        params = self.request.query_params
        if params.get("active_only") == "true":
            qs = qs.filter(is_active=True)
        st = (params.get("status") or "").lower()
        if st == "active":
            qs = qs.filter(is_active=True)
        elif st == "inactive":
            qs = qs.filter(is_active=False)

        search = params.get("search", "").strip()
        if search:
            qs = qs.filter(
                _Q(name__icontains=search) |
                _Q(phone__icontains=search) |
                _Q(email__icontains=search) |
                _Q(tax_number__icontains=search)
            )

        # Customer group filter.
        group_id = (params.get("customer_group") or "").strip()
        if group_id:
            qs = qs.filter(customer_group_id=group_id)

        # 'No sale since' filter — exclude customers with any FINAL sale after
        # the given date. Useful for re-engagement workflows.
        no_sale_since = (params.get("no_sale_since") or "").strip()
        if no_sale_since:
            from datetime import date as _date
            try:
                cutoff = _date.fromisoformat(no_sale_since)
                qs = qs.exclude(sales__status="FINAL", sales__created_at__date__gte=cutoff)
            except (ValueError, TypeError):
                pass

        # Annotations — total sale due, total paid and sell-return due.
        # FINAL sales only count toward "sale due" (DRAFT/QUOTATION etc. don't
        # represent obligations yet).
        qs = qs.annotate(
            total_sale_due = _Coalesce(
                _Sum(
                    _EW(_F("sales__total_amount") - _F("sales__amount_paid"), output_field=DEC),
                    filter=_Q(sales__status="FINAL"),
                ),
                ZERO,
            ),
            total_sale_paid = _Coalesce(
                _Sum(_F("sales__amount_paid"), filter=_Q(sales__status="FINAL"),
                     output_field=DEC),
                ZERO,
            ),
            total_sell_return_due = _Coalesce(
                _Sum(
                    _EW(
                        _F("sell_returns__total_amount") - _F("sell_returns__amount_paid"),
                        output_field=DEC,
                    ),
                ),
                ZERO,
            ),
        )

        # Payment-status filter (depends on the annotations above):
        #   paid    → nothing outstanding (due <= 0)
        #   due     → owes money and has paid nothing
        #   partial → owes money but has paid something
        pay_status = (params.get("payment_status") or "").strip().lower()
        if pay_status == "paid":
            qs = qs.filter(total_sale_due__lte=0)
        elif pay_status == "due":
            qs = qs.filter(total_sale_due__gt=0, total_sale_paid__lte=0)
        elif pay_status == "partial":
            qs = qs.filter(total_sale_due__gt=0, total_sale_paid__gt=0)

        return qs

    @extend_schema(
        summary="Credit summary for one customer",
        description=(
            "Returns the customer's credit_limit + current due + advance + "
            "available credit. Used by the POS Credit Sale button to gate "
            "the action and show the running balance the moment the cashier "
            "picks a customer from the dropdown."
        ),
        responses={200: None},
    )
    @action(detail=True, methods=["get"], url_path="credit-summary")
    def credit_summary(self, request, pk=None):
        """GET /api/sales/customers/<id>/credit-summary/"""
        from decimal import Decimal as _D
        from django.db.models import (
            DecimalField as _DF, ExpressionWrapper as _EW,
            F as _F, Q as _Q, Sum as _Sum, Value as _V,
        )
        from django.db.models.functions import Coalesce as _Coalesce
        DEC  = _DF(max_digits=14, decimal_places=2)
        ZERO = _V(_D("0"), output_field=DEC)

        customer = self.get_object()

        # Sum (total_amount − amount_paid) across FINAL non-VOIDED sales for
        # this customer. Voided sales are excluded — they're refunded sales
        # that shouldn't count toward the due. Returns separate.
        agg = (
            branch_scope(Sale.objects.filter(customer=customer, status=Sale.Status.FINAL))
            .aggregate(
                current_due=_Coalesce(
                    _Sum(_EW(_F("total_amount") - _F("amount_paid"), output_field=DEC)),
                    ZERO,
                ),
            )
        )
        current_due = agg["current_due"] or _D("0")

        opening = customer.opening_balance or _D("0")
        advance = customer.advance_balance or _D("0")
        limit   = customer.credit_limit   or _D("0")

        # net_due here = what the customer owes from SYSTEM-CREATED sales,
        # minus any advance they've paid ahead. opening_balance is an
        # accounting anchor for the customer's pre-system history; we
        # display it but DO NOT count it against the credit limit — if we
        # did, every freshly-onboarded tenant who entered legacy due in
        # opening_balance would find their customer permanently locked out
        # of credit. The cashier sees opening_balance separately so they
        # can still factor it into a payment-collection decision.
        net_due = current_due - advance
        available = max(limit - max(net_due, _D("0")), _D("0"))

        return Response({
            "id":              str(customer.id),
            "name":            customer.name,
            "credit_limit":    str(limit),
            "opening_balance": str(opening),
            "advance_balance": str(advance),
            "current_due":     str(current_due),
            "net_due":         str(net_due),
            "available_credit": str(available),
            # Convenience flags for the frontend
            "is_credit_eligible": limit > 0,
            "would_exceed_limit": (limit > 0 and net_due >= limit),
        })

    @extend_schema(
        summary="Record a payment from a customer",
        description=(
            "Collect a payment from a customer. It settles outstanding dues "
            "oldest-first; any overflow is added to the customer's advance "
            "balance. The chosen Payment Account is credited the full amount."
        ),
        responses={200: None},
    )
    @action(detail=True, methods=["post"], url_path="pay")
    def pay(self, request, pk=None):
        """POST /api/sales/customers/<id>/pay/"""
        from . import services
        customer = self.get_object()
        data = request.data or {}
        try:
            result = services.record_customer_payment(
                customer_id        = customer.id,
                amount             = data.get("amount"),
                method             = (data.get("method") or "CASH").upper(),
                payment_account_id = data.get("payment_account_id") or None,
                note               = data.get("note", ""),
                received_by_id     = getattr(request.user, "id", None),
            )
        except (services.SalesServiceError, ValueError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(result, status=status.HTTP_200_OK)


# ──────────────────────────────────────────────────────────────────────────────
# Sales
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Sales"])
class SaleListCreateView(APIView):
    """
    GET  /api/sales/   — list sales with optional filters.
    POST /api/sales/   — create a QUOTATION or DRAFT sale.

    Query params (GET):
      status         — QUOTATION | DRAFT | FINAL | PENDING | VOIDED
      payment_status — DUE | PARTIAL | PAID
      customer_id    — filter by customer UUID
      location_id    — filter by location UUID
      limit          — max results (default 50, max 500)
    """
    permission_classes = [IsAuthenticated]

    forced_status = None
    forced_source = None
    forced_requires_shipping = False

    @extend_schema(
        summary="List sales",
        description=(
            "Returns paginated sales with advanced filters, search, sorting, and summary totals.\n\n"
            "Payment status logic:\n"
            "- PAID: total_paid >= total_amount\n"
            "- PARTIAL: total_paid > 0 and total_paid < total_amount\n"
            "- DUE: total_paid == 0"
        ),
        parameters=[
            OpenApiParameter("page", OpenApiTypes.INT, description="Page number (default 1)"),
            OpenApiParameter("limit", OpenApiTypes.INT, description="Entries per page: 10/25/50/100 (default 25)"),
            OpenApiParameter("search", OpenApiTypes.STR, description="Search by invoice number, customer name, or phone"),
            OpenApiParameter("status", OpenApiTypes.STR, description="QUOTATION|DRAFT|FINAL|PENDING|VOIDED"),
            OpenApiParameter("payment_status", OpenApiTypes.STR, description="DUE|PARTIAL|PAID (computed from totals)"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("customer_id", OpenApiTypes.UUID, description="Filter by customer UUID"),
            OpenApiParameter("date_from", OpenApiTypes.DATE, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to", OpenApiTypes.DATE, description="End date (YYYY-MM-DD)"),
            OpenApiParameter("user_id", OpenApiTypes.UUID, description="Filter by salesperson (created_by_id)"),
            OpenApiParameter("service_staff", OpenApiTypes.UUID, description="Filter by service staff (finalized_by_id)"),
            OpenApiParameter("shipping_status", OpenApiTypes.STR, description="Reserved for shipping workflow"),
            OpenApiParameter("source", OpenApiTypes.STR, description="Reserved for source workflow (POS/Direct/Online)"),
            OpenApiParameter("subscription", OpenApiTypes.BOOL, description="Reserved for subscription workflow"),
            OpenApiParameter("sort_by", OpenApiTypes.STR, description="Sort field: date, invoice_no, customer_name, total_amount, total_paid, sell_due"),
            OpenApiParameter("sort_dir", OpenApiTypes.STR, description="asc|desc (default desc)"),
        ],
        responses={200: None},
    )
    def get(self, request):
        forced_status = self.forced_status
        forced_source = self.forced_source
        qs = (
            Sale.objects
            .select_related("customer", "location")
            .prefetch_related("items")
            .annotate(
                computed_payment_status=Case(
                    When(amount_paid__gte=F("total_amount"), then=Value("PAID")),
                    When(amount_paid__gt=0, then=Value("PARTIAL")),
                    default=Value("DUE"),
                    output_field=CharField(),
                )
            )
        )

        # Multi-branch isolation — scope to the active branch (no-op for the
        # owner's consolidated view).
        qs = branch_scope(qs)

        # Basic filters
        if forced_status:
            qs = qs.filter(status=str(forced_status).upper())
        elif s := request.query_params.get("status"):
            qs = qs.filter(status=s.upper())
        else:
            # Default lists (All Sales, POS Sales) must NOT show
            # quotations / proformas / drafts — those have their own
            # dedicated pages. A quotation should appear ONLY on the
            # List Quotation page until it's finalised. Show the
            # post-quotation lifecycle states only.
            qs = qs.exclude(
                status__in=[Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT]
            )
        if cid := request.query_params.get("customer_id"):
            qs = qs.filter(customer_id=cid)
        if lid := request.query_params.get("location_id"):
            qs = qs.filter(location_id=lid)
        if uid := request.query_params.get("user_id"):
            # The Added By column renders the chain
            # created_by_name || finalized_by_name (POS-finalised
            # rows often have no created_by_id). The filter must
            # match the SAME chain, otherwise a name visible in
            # the column returns zero rows when filtered on.
            qs = qs.filter(
                Q(created_by_id=uid)
                | (Q(created_by_id__isnull=True) & Q(finalized_by_id=uid))
            )
        if sid := request.query_params.get("service_staff"):
            # Service Staff is the salesperson picked on the Add
            # Sale / POS screen and persisted into
            # Sale.meta.service_staff. Three storage eras exist in
            # live tenant data:
            #   1. user UUID (current builds),
            #   2. free-text NAME string (older Add Sale builds —
            #      the column shows e.g. lowercase "shabib"
            #      verbatim because it isn't a resolvable UUID),
            #   3. key absent entirely (oldest rows — finaliser
            #      acted as service staff).
            # Match all three so the filter agrees with what the
            # column displays.
            cond = Q(meta__service_staff=str(sid))
            staff_name = None
            try:
                from accounts.models import User
                staff_name = (
                    User.objects.using("default")
                    .filter(id=sid)
                    .values_list("name", flat=True)
                    .first()
                )
            except Exception:
                staff_name = None
            if staff_name:
                cond |= Q(meta__service_staff__iexact=staff_name)
            cond |= (
                Q(finalized_by_id=sid)
                & (Q(meta__service_staff__isnull=True) | Q(meta__service_staff=""))
            )
            qs = qs.filter(cond)
        if forced_source:
            # Source is persisted in Sale.meta (JSON), not as a concrete Sale model field.
            qs = qs.filter(meta__source__iexact=str(forced_source))
        elif src := request.query_params.get("source"):
            qs = qs.filter(meta__source__iexact=str(src))
        if self.forced_requires_shipping:
            qs = qs.exclude(meta__shipping_status__isnull=True).exclude(meta__shipping_status__exact="")

        # Date range
        df = request.query_params.get("date_from")
        dt = request.query_params.get("date_to")
        if df:
            try:
                start = timezone.make_aware(datetime.combine(datetime.fromisoformat(df).date(), time.min))
                qs = qs.filter(created_at__gte=start)
            except ValueError:
                return Response({"detail": "Invalid date_from. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        if dt:
            try:
                end = timezone.make_aware(datetime.combine(datetime.fromisoformat(dt).date(), time.max))
                qs = qs.filter(created_at__lte=end)
            except ValueError:
                return Response({"detail": "Invalid date_to. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)

        # Global search
        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(
                Q(invoice_number__icontains=search) |
                Q(customer__name__icontains=search) |
                Q(customer__phone__icontains=search)
            )

        # Computed payment status filter
        if ps := request.query_params.get("payment_status"):
            ps = ps.upper()
            if ps in {"PAID", "PARTIAL", "DUE"}:
                qs = qs.filter(computed_payment_status=ps)

        # Sorting
        sort_by = (request.query_params.get("sort_by") or "date").lower()
        sort_dir = (request.query_params.get("sort_dir") or "desc").lower()
        allowed_sort = {
            "date": "created_at",
            "invoice_no": "invoice_number",
            "customer_name": "customer__name",
            "location": "location__name",
            "total_amount": "total_amount",
            "total_paid": "amount_paid",
            "sell_due": "balance_due",
        }
        sort_field = allowed_sort.get(sort_by, "created_at")
        if sort_dir == "asc":
            qs = qs.order_by(sort_field, "id")
        else:
            qs = qs.order_by(f"-{sort_field}", "-id")

        # Summary totals on full filtered queryset
        zero_dec = Value(0, output_field=DecimalField(max_digits=14, decimal_places=2))
        summary = qs.aggregate(
            total_sales_amount=Coalesce(Sum("total_amount"), zero_dec),
            total_paid=Coalesce(Sum("amount_paid"), zero_dec),
            total_due=Coalesce(Sum("balance_due"), zero_dec),
        )
        # Total items (units sold) across the WHOLE filtered range — NOT just
        # the current page. Computed in a SEPARATE aggregate: joining
        # items into the money aggregate above would duplicate each Sale row
        # per line item and inflate total_amount / paid / due. This sums the
        # same SaleItem.quantity the dashboard's "Items Sold Today" sums, so
        # the All Sales footer total and the dashboard KPI agree for the
        # same filter window.
        items_total = qs.aggregate(t=Sum("items__quantity"))["t"]
        summary["total_items"] = items_total or Decimal("0")

        # Pagination
        try:
            limit = int(request.query_params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        if limit not in {10, 25, 50, 100}:
            limit = 25

        try:
            page = int(request.query_params.get("page", 1))
        except (ValueError, TypeError):
            page = 1
        page = max(page, 1)

        total_count = qs.count()
        total_pages = max((total_count + limit - 1) // limit, 1)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * limit

        page_rows = list(qs[offset: offset + limit])
        payment_map = {
            str(sale_id): method
            for sale_id, method in (
                SalePayment.objects
                .filter(sale_id__in=[row.id for row in page_rows])
                .order_by("created_at")
                .values_list("sale_id", "method")
            )
        }
        for row in page_rows:
            row.payment_status = getattr(row, "computed_payment_status", row.payment_status)
            row.payment_method = payment_map.get(str(row.id))

        return Response({
            "results": SaleListSerializer(page_rows, many=True).data,
            "count": total_count,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "summary": {
                "total_sales_amount": str(summary["total_sales_amount"]),
                "total_paid": str(summary["total_paid"]),
                "total_due": str(summary["total_due"]),
                "total_items": str(summary["total_items"]),
            },
        })

    @extend_schema(
        summary="Create sale",
        description="Create a new QUOTATION or DRAFT sale with line items. Stock is NOT deducted until finalization.",
        request=CreateSaleSerializer,
        responses={201: SaleDetailSerializer},
    )
    def post(self, request):
        serializer = CreateSaleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        # Multi-branch: a user working in a branch can only create sales in
        # that branch — force the location to the active branch.
        if _bid := active_branch_id():
            d["location_id"] = _bid

        try:
            sale = services.create_sale(
                location_id         = d["location_id"],
                items               = [dict(i) for i in d["items"]],
                created_by_id       = request.user.id,
                status              = d["status"],
                customer_id         = d.get("customer_id"),
                discount            = d["discount"],
                tax_rate            = d["tax_rate"],
                notes               = d["notes"],
                meta                = d.get("meta") or {},
                supervisor_password = d.get("supervisor_password"),
            )
        except services.DiscountPermissionError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            SaleDetailSerializer(sale).data,
            status=status.HTTP_201_CREATED,
        )


@extend_schema(tags=["Sales"])
class DailyItemsSoldView(APIView):
    """
    GET /api/sales/daily-items/?days=14[&location_id=...]

    Per-day "items sold" (plus revenue + order count) using the EXACT same
    base filter as the All Sales list — every sale EXCEPT quotations /
    proformas / drafts, bucketed by created_at date. This is the single
    source of truth for the dashboard's "Items Sold Today" KPI AND the
    per-day breakdown, so both always agree with the All Sales footer total
    for the same day (no more finalized_at-vs-created_at drift).
    """

    def get(self, request):
        # Visible to anyone who can see sales or reports (mirrors the
        # dashboard's other KPI gating).
        if not (
            has_permission(request.user, Perm.CAN_VIEW_REPORTS)
            or has_permission(request.user, Perm.CAN_CREATE_SALE)
        ):
            return Response({"detail": "Not allowed."}, status=status.HTTP_403_FORBIDDEN)

        from datetime import timedelta  # noqa: PLC0415
        from django.db.models import Count  # noqa: PLC0415
        from django.db.models.functions import TruncDate  # noqa: PLC0415

        try:
            days = int(request.query_params.get("days", 14))
        except (ValueError, TypeError):
            days = 14
        days = min(max(days, 1), 90)

        today = timezone.localdate()
        start = today - timedelta(days=days - 1)

        base = branch_scope(
            Sale.objects
            .exclude(status__in=[
                Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT,
            ])
            .filter(created_at__date__gte=start, created_at__date__lte=today)
        )
        if lid := request.query_params.get("location_id"):
            base = base.filter(location_id=lid)

        # Items per day — joins items and sums quantity. Done alone so the
        # join can't multiply the money totals below.
        items_by_day = {
            r["d"]: (r["q"] or Decimal("0"))
            for r in base.annotate(d=TruncDate("created_at"))
                         .values("d")
                         .annotate(q=Sum("items__quantity"))
        }
        # Revenue + order count per day — SEPARATE pass (no items join).
        money_by_day = {
            r["d"]: r
            for r in base.annotate(d=TruncDate("created_at"))
                         .values("d")
                         .annotate(revenue=Sum("total_amount"), orders=Count("id"))
        }

        breakdown = []
        for i in range(days):
            d = start + timedelta(days=i)
            m = money_by_day.get(d)
            breakdown.append({
                "date":    d.isoformat(),
                "items":   str(items_by_day.get(d, Decimal("0"))),
                "revenue": str((m["revenue"] if m else None) or Decimal("0")),
                "orders":  (m["orders"] if m else 0),
            })

        return Response({"days": days, "breakdown": breakdown})


@extend_schema(tags=["Sales"])
class DraftSaleListView(SaleListCreateView):
    """
    GET /api/sales/drafts/
    Dedicated draft list endpoint.
    """
    forced_status = Sale.Status.DRAFT


@extend_schema(tags=["Sales"])
class PosSaleListView(SaleListCreateView):
    """
    GET /api/sales/pos-sales/
    Dedicated POS sales list endpoint.
    """
    forced_source = "POS"


@extend_schema(tags=["Sales"])
class QuotationSaleListView(SaleListCreateView):
    """
    GET /api/sales/quotations/
    Dedicated quotation list endpoint.
    """
    forced_status = Sale.Status.QUOTATION


@extend_schema(tags=["Sales"])
class SellReturnListView(SaleListCreateView):
    """
    GET /api/sales/sell-returns/
    Dedicated sell return list endpoint.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List sell returns",
        description="Returns paginated sell returns with filters and search.",
        parameters=[
            OpenApiParameter("page", OpenApiTypes.INT, description="Page number (default 1)"),
            OpenApiParameter("limit", OpenApiTypes.INT, description="Entries per page: 10/25/50/100 (default 25)"),
            OpenApiParameter("search", OpenApiTypes.STR, description="Search by return invoice, parent invoice, customer name, or phone"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("customer_id", OpenApiTypes.UUID, description="Filter by customer UUID"),
            OpenApiParameter("user_id", OpenApiTypes.UUID, description="Filter by creator UUID"),
            OpenApiParameter("date_from", OpenApiTypes.DATE, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to", OpenApiTypes.DATE, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: None},
    )
    def get(self, request):
        qs = SellReturn.objects.select_related("customer", "location", "parent_sale")

        if cid := request.query_params.get("customer_id"):
            qs = qs.filter(customer_id=cid)
        if lid := request.query_params.get("location_id"):
            qs = qs.filter(location_id=lid)
        if uid := request.query_params.get("user_id"):
            qs = qs.filter(created_by_id=uid)

        df = request.query_params.get("date_from")
        dt = request.query_params.get("date_to")
        if df:
            try:
                start = timezone.make_aware(datetime.combine(datetime.fromisoformat(df).date(), time.min))
                qs = qs.filter(created_at__gte=start)
            except ValueError:
                return Response({"detail": "Invalid date_from. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        if dt:
            try:
                end = timezone.make_aware(datetime.combine(datetime.fromisoformat(dt).date(), time.max))
                qs = qs.filter(created_at__lte=end)
            except ValueError:
                return Response({"detail": "Invalid date_to. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)

        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(
                Q(invoice_number__icontains=search) |
                Q(parent_sale__invoice_number__icontains=search) |
                Q(customer__name__icontains=search) |
                Q(customer__phone__icontains=search)
            )

        qs = qs.order_by("-created_at", "-id")

        try:
            limit = int(request.query_params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        if limit not in {10, 25, 50, 100}:
            limit = 25

        try:
            page = int(request.query_params.get("page", 1))
        except (ValueError, TypeError):
            page = 1
        page = max(page, 1)

        total_count = qs.count()
        total_pages = max((total_count + limit - 1) // limit, 1)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * limit
        page_rows = list(qs[offset: offset + limit])

        return Response({
            "results": SellReturnListSerializer(page_rows, many=True).data,
            "count": total_count,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
        })


@extend_schema(tags=["Sales"])
class ShipmentListView(SaleListCreateView):
    """
    GET /api/sales/shipments/
    Dedicated shipments list endpoint.
    """
    forced_requires_shipping = True


@extend_schema(tags=["Sales"])
class DiscountListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List discounts",
        parameters=[
            OpenApiParameter("page", OpenApiTypes.INT),
            OpenApiParameter("limit", OpenApiTypes.INT),
            OpenApiParameter("search", OpenApiTypes.STR),
            OpenApiParameter("location_id", OpenApiTypes.UUID),
            OpenApiParameter("active", OpenApiTypes.BOOL),
        ],
    )
    def get(self, request):
        qs = Discount.objects.select_related("location").prefetch_related("products")
        if q := request.query_params.get("search", "").strip():
            qs = qs.filter(
                Q(name__icontains=q) |
                Q(brand__icontains=q) |
                Q(category__icontains=q)
            )
        if lid := request.query_params.get("location_id"):
            qs = qs.filter(location_id=lid)
        if active := request.query_params.get("active"):
            if active.lower() in {"true", "1"}:
                qs = qs.filter(is_active=True)
            elif active.lower() in {"false", "0"}:
                qs = qs.filter(is_active=False)

        try:
            limit = int(request.query_params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        if limit not in {10, 25, 50, 100}:
            limit = 25
        try:
            page = int(request.query_params.get("page", 1))
        except (ValueError, TypeError):
            page = 1
        page = max(page, 1)
        total_count = qs.count()
        total_pages = max((total_count + limit - 1) // limit, 1)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * limit
        rows = list(qs[offset: offset + limit])
        return Response({
            "results": DiscountSerializer(rows, many=True).data,
            "count": total_count,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
        })

    @extend_schema(summary="Create discount", request=DiscountSerializer, responses={201: DiscountSerializer})
    def post(self, request):
        serializer = DiscountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        discount = serializer.save(created_by_id=getattr(request.user, "id", None))
        return Response(DiscountSerializer(discount).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Sales"])
class DiscountBulkDeactivateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(summary="Deactivate selected discounts")
    def post(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            return Response({"detail": "ids list is required."}, status=status.HTTP_400_BAD_REQUEST)
        updated = Discount.objects.filter(id__in=ids).update(is_active=False, updated_at=timezone.now())
        return Response({"updated": updated}, status=status.HTTP_200_OK)


@extend_schema(tags=["Sales"])
class SaleCreateAdvancedView(APIView):
    """
    POST /api/sales/sales/create/
    Full-featured sale creation endpoint for Add Sale screen.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Create advanced sale",
        description=(
            "Creates a sale with full Add Sale payload including shipping, extra charges, "
            "partial/full payment, and optional immediate finalization."
        ),
        request=AdvancedCreateSaleSerializer,
        responses={201: SaleDetailSerializer},
    )
    @require_permission(Perm.CAN_CREATE_SALE)
    def post(self, request):
        serializer = AdvancedCreateSaleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        # Multi-branch: force the sale into the active branch.
        if _bid := active_branch_id():
            d["location_id"] = _bid
        try:
            sale = services.create_sale_advanced(
                location_id=d["location_id"],
                items=[dict(i) for i in d["items"]],
                created_by_id=request.user.id,
                customer_id=d.get("customer_id"),
                pay_term_days=d.get("pay_term_days", 0),
                pay_term_value=d.get("pay_term_value"),
                pay_term_period=d.get("pay_term_period", ""),
                sale_date=d.get("sale_date"),
                status=d.get("status"),
                invoice_no=d.get("invoice_no"),
                invoice_scheme=d.get("invoice_scheme", ""),
                service_staff=d.get("service_staff", ""),
                table_ref=d.get("table_ref", ""),
                source=d.get("source", "POS"),
                attach_document_name=d.get("attach_document_name", ""),
                sell_note=d.get("sell_note", ""),
                staff_note=d.get("staff_note", ""),
                discount_type=d.get("discount_type", "FIXED"),
                discount_value=d.get("discount_value", 0),
                order_tax=d.get("order_tax", 0),
                shipping_details=d.get("shipping_details", ""),
                shipping_address=d.get("shipping_address", ""),
                shipping_charges=d.get("shipping_charges", 0),
                shipping_status=d.get("shipping_status", ""),
                delivered_to=d.get("delivered_to", ""),
                shipping_documents=d.get("shipping_documents", []),
                additional_expenses=d.get("additional_expenses", []),
                payment=d.get("payment"),
                notes=d.get("notes", ""),
                supervisor_password=d.get("supervisor_password"),
            )
        except (services.SalesServiceError, services.DiscountPermissionError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except services.BackOrderRequiredError as exc:
            # Pre-wrapped envelope — see SaleFinalizeView for why
            # (the renderer strips custom keys from bare error bodies).
            return Response(
                {
                    "status":  "error",
                    "data": {
                        "back_order_required": True,
                        "out_of_stock":        True,
                        "backorder_created":   bool(getattr(exc, "backorder_created", False)),
                        "sale_id":             getattr(exc, "sale_id", None),
                        "shortfalls":          exc.shortfalls,
                    },
                    "message": str(exc),
                    "errors":  None,
                },
                status=status.HTTP_409_CONFLICT,
            )
        return Response(SaleDetailSerializer(sale).data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["Sales"])
class SaleDetailView(APIView):
    """
    GET   /api/sales/<id>/   — full detail.
    PATCH /api/sales/<id>/   — update editable (QUOTATION/DRAFT) sale.
    """
    permission_classes = [IsAuthenticated]

    def _get_sale(self, pk):
        try:
            return services.get_sale_detail(sale_id=pk)
        except services.SalesServiceError as exc:
            return None, str(exc)

    @extend_schema(summary="Get sale detail", responses={200: SaleDetailSerializer})
    def get(self, request, pk):
        try:
            sale = services.get_sale_detail(sale_id=pk)
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        return Response(SaleDetailSerializer(sale).data)

    @extend_schema(
        summary="Update sale",
        description="Update a QUOTATION or DRAFT sale. FINAL/VOIDED sales cannot be edited.",
        request=UpdateSaleSerializer,
        responses={200: SaleDetailSerializer},
    )
    def patch(self, request, pk):
        serializer = UpdateSaleSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data

        try:
            sale = services.update_sale(
                sale_id             = pk,
                updated_by_id       = request.user.id,
                items               = [dict(i) for i in d["items"]] if "items" in d else None,
                customer_id         = d.get("customer_id"),
                discount            = d.get("discount"),
                tax_rate            = d.get("tax_rate"),
                notes               = d.get("notes"),
                supervisor_password = d.get("supervisor_password"),
            )
        except services.DiscountPermissionError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(SaleDetailSerializer(sale).data)

    @extend_schema(
        summary="Delete sale",
        description=(
            "Delete a sale. Editable statuses (QUOTATION / PROFORMA / DRAFT) "
            "are hard-deleted. FINAL sales can be deleted within a 24-hour "
            "grace window after finalization — internally this routes through "
            "void_sale() which reverses FIFO stock, reverses linked "
            "PaymentAccount balances and posts the accounting reversal. "
            "Past the 24-hour window, a Sell Return must be used instead."
        ),
        responses={204: None},
    )
    @require_permission(Perm.CAN_EDIT_SALE)
    def delete(self, request, pk):
        from datetime import timedelta
        from django.utils import timezone as _tz

        try:
            sale = Sale.objects.get(pk=pk)
        except Sale.DoesNotExist:
            return Response({"detail": "Sale not found."}, status=status.HTTP_404_NOT_FOUND)

        # Editable statuses can still be hard-deleted — no stock or
        # payment impact since they were never finalized.
        if sale.status in {Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT}:
            sale.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        # FINAL / VOIDED sales — time-based rule:
        #   • The OWNER (and ADMIN) may delete at any time.
        #   • Every other user (manager / cashier) may delete only within
        #     24 hours of finalisation. After that they must ask the owner
        #     or create a Sell Return — this protects long-tail receipts
        #     from being reversed by junior staff.
        # delete_sale() reverses the side-effects (FIFO stock,
        # payment-account balance, accounting entries) AND removes the row,
        # so the sale truly disappears from All Sales.
        if sale.status in {Sale.Status.FINAL, Sale.Status.VOIDED}:
            user_role = getattr(request.user, "role", "") or ""
            is_privileged = user_role in ("owner", "admin")
            if not is_privileged:
                finalized_at = sale.finalized_at or sale.created_at
                age = _tz.now() - finalized_at
                if age > timedelta(hours=24):
                    hours = int(age.total_seconds() // 3600)
                    return Response(
                        {"detail": (
                            f"This sale was finalised {hours}h ago. Sales finalised "
                            "more than 24 hours ago can only be deleted by the "
                            "account owner. Please ask the owner, or create a "
                            "Sell Return instead."
                        )},
                        status=status.HTTP_403_FORBIDDEN,
                    )
            try:
                services.delete_sale(sale_id=sale.id, deleted_by_id=request.user.id)
            except services.SalesServiceError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            return Response(status=status.HTTP_204_NO_CONTENT)

        return Response(
            {"detail": f"This sale (status: {sale.status}) cannot be deleted."},
            status=status.HTTP_400_BAD_REQUEST,
        )


@extend_schema(tags=["Sales"])
class SaleShippingView(APIView):
    """PATCH /api/sales/sales/<id>/shipping/

    Update ONLY the shipping fields of a sale — works on ANY status,
    including FINAL, because shipping changes (status: Ordered →
    Shipped → Delivered, address corrections, delivered-to) are
    operational and don't touch stock, money or the journal.

    The regular update_sale() service refuses FINAL sales, so the
    Shipments page's "Edit Shipping" modal posts here instead.

    Body (all optional — only present keys are touched):
      shipping_details, shipping_address, shipping_status,
      delivered_to, shipping_charges, shipping_note,
      shipping_documents (list of filenames)
    """
    permission_classes = [IsAuthenticated]

    def patch(self, request, pk):
        import logging as _lg
        _log = _lg.getLogger(__name__)
        try:
            # has_permission is the runtime check (require_permission is
            # a decorator factory; calling it inline would crash).
            from accounts.permissions import has_permission as _has_permission
            if not _has_permission(request.user, Perm.CAN_CREATE_SALE):
                return Response(
                    {"detail": "You don't have permission to edit shipping. "
                               "Ask an admin to grant the 'sales.create' permission."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            try:
                sale = Sale.objects.get(pk=pk)
            except Sale.DoesNotExist:
                return Response({"detail": "Shipment / sale not found."},
                                status=status.HTTP_404_NOT_FOUND)

            data = request.data if isinstance(request.data, dict) else {}
            meta = dict(sale.meta or {})

            # ALL shipping text fields live in the Sale.meta JSON blob —
            # the Sale model has NO shipping_address / shipping_details /
            # shipping_status / delivered_to columns (only the Customer
            # model has shipping_address). So everything except
            # shipping_charges is merged into meta.
            meta_keys = (
                "shipping_details", "shipping_address", "shipping_status",
                "delivered_to", "shipping_note", "shipping_documents",
            )
            prev_status = meta.get("shipping_status", "")
            for k in meta_keys:
                if k in data:
                    meta[k] = data[k]

            # Activity log — one entry per shipping save, shown in the
            # "Activities" table of the Edit Shipping modal (and the
            # Shipments page). Records who changed what and when.
            from django.utils import timezone as _tz
            new_status_now = meta.get("shipping_status", "")
            actor = (getattr(request.user, "name", None)
                     or getattr(request.user, "email", "") or "—")
            if new_status_now and new_status_now != prev_status:
                action_label = f"Status changed: {prev_status or '—'} → {new_status_now}"
            else:
                action_label = "Shipping updated"
            activities = list(meta.get("shipping_activities") or [])
            activities.append({
                "date":   _tz.now().isoformat(),
                "action": action_label,
                "by":     actor,
                "note":   (meta.get("shipping_note") or ""),
            })
            meta["shipping_activities"] = activities[-50:]  # keep the last 50

            update_fields = ["meta", "updated_at"]
            sale.meta = meta

            # shipping_charges IS a real column on Sale.
            if "shipping_charges" in data:
                try:
                    from decimal import Decimal as _D
                    sale.shipping_charges = _D(str(data["shipping_charges"] or 0))
                    update_fields.append("shipping_charges")
                except Exception:  # noqa: BLE001
                    pass

            sale.save(update_fields=update_fields)

            # Audit — record the status transition (Ordered → Shipped).
            new_status = meta.get("shipping_status", "")
            try:
                log_from_request(
                    request,
                    action      = AuditAction.UPDATE,
                    module      = "sales.Sale",
                    record_id   = sale.id,
                    record_repr = f"Shipping {sale.invoice_number or sale.id}",
                    old_value   = {"shipping_status": prev_status},
                    new_value   = {"shipping_status": new_status},
                )
            except Exception:  # noqa: BLE001
                pass

            return Response(SaleDetailSerializer(sale).data, status=status.HTTP_200_OK)
        except Exception as exc:  # noqa: BLE001
            _log.exception("Edit shipping failed for sale %s: %s", pk, exc)
            return Response(
                {"detail": f"Couldn't update shipping: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )


@extend_schema(tags=["Sales"])
class SaleHeaderView(APIView):
    """PATCH /api/sales/sales/<id>/header/

    Edit the JOURNAL-SAFE header fields of a sale on ANY status,
    including FINAL. These fields don't touch stock, money or the
    accounting journal, so they're always editable:
        customer_id, sale_date, notes, sell_note, staff_note

    Money / stock fields (items, discount, tax) are deliberately NOT
    handled here — changing those on a FINAL sale would desync the
    journal and FIFO layers. Use a Sell Return or Void for that. The
    front-end only exposes those fields when the sale is still
    editable (DRAFT / QUOTATION / PROFORMA), where it routes through
    the normal update_sale() service instead.
    """
    permission_classes = [IsAuthenticated]

    def patch(self, request, pk):
        import logging as _lg
        _log = _lg.getLogger(__name__)
        try:
            from accounts.permissions import has_permission as _has_permission
            if not _has_permission(request.user, Perm.CAN_EDIT_SALE):
                return Response(
                    {"detail": "You don't have permission to edit sales. "
                               "Ask an admin to grant the 'sales.edit' permission."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            try:
                sale = Sale.objects.get(pk=pk)
            except Sale.DoesNotExist:
                return Response({"detail": "Sale not found."},
                                status=status.HTTP_404_NOT_FOUND)

            data = request.data if isinstance(request.data, dict) else {}
            update_fields = ["updated_at"]

            if "customer_id" in data:
                sale.customer_id = data["customer_id"] or None
                update_fields.append("customer_id")
            if "notes" in data:
                sale.notes = data["notes"] or ""
                update_fields.append("notes")
            if "sale_date" in data and data["sale_date"]:
                from django.utils.dateparse import parse_datetime
                dt = parse_datetime(str(data["sale_date"]))
                if dt:
                    sale.sale_date = dt
                    update_fields.append("sale_date")

            # meta-stored notes
            meta = dict(sale.meta or {})
            touched_meta = False
            for k in ("sell_note", "staff_note"):
                if k in data:
                    meta[k] = data[k]
                    touched_meta = True
            if touched_meta:
                sale.meta = meta
                update_fields.append("meta")

            sale.save(update_fields=update_fields)

            try:
                log_from_request(
                    request,
                    action      = AuditAction.UPDATE,
                    module      = "sales.Sale",
                    record_id   = sale.id,
                    record_repr = f"Sale header {sale.invoice_number or sale.id}",
                    new_value   = {k: str(data.get(k)) for k in data},
                )
            except Exception:  # noqa: BLE001
                pass

            return Response(SaleDetailSerializer(sale).data, status=status.HTTP_200_OK)
        except Exception as exc:  # noqa: BLE001
            _log.exception("Edit sale header failed for sale %s: %s", pk, exc)
            return Response(
                {"detail": f"Couldn't update sale: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )


@extend_schema(tags=["Sales"])
class FinalizeSaleView(APIView):
    """
    POST /api/sales/<id>/finalize/

    Transition a DRAFT or QUOTATION sale to FINAL.
    Runs full stock check + FIFO deduction atomically.

    On success:  200 with sale detail.
    On shortfall: 409 with "back_order_required": true and shortfall list.
    Required permission: CAN_CREATE_SALE
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Finalize sale",
        description=(
            "Transition a DRAFT or QUOTATION sale to FINAL. "
            "Runs stock availability check and FIFO deduction atomically. "
            "Returns 409 with shortfall details if stock is insufficient — call `/backorder/` in that case. "
            "Requires `can_create_sale` permission."
        ),
        responses={200: SaleDetailSerializer, 409: None},
    )
    @require_permission(Perm.CAN_CREATE_SALE)
    def post(self, request, pk):
        try:
            sale = services.finalize_sale(
                sale_id          = pk,
                finalized_by_id  = request.user.id,
                expected_payment = request.data.get("expected_payment") if isinstance(request.data, dict) else None,
            )
        except services.BackOrderRequiredError as exc:
            # Pre-wrapped envelope — the StandardJSONRenderer's error
            # safety-net strips custom keys (back_order_required /
            # shortfalls) from bare bodies, which prevented the
            # frontend's out-of-stock pop-up from ever firing.
            return Response(
                {
                    "status":  "error",
                    "data": {
                        "back_order_required": True,
                        "out_of_stock":        True,
                        "shortfalls":          exc.shortfalls,
                    },
                    "message": str(exc),
                    "errors":  None,
                },
                status=status.HTTP_409_CONFLICT,
            )
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Audit log
        log_from_request(
            request,
            action      = AuditAction.CREATE,
            module      = "sales.Sale",
            record_id   = sale.id,
            record_repr = f"Invoice {sale.invoice_number}",
            new_value   = {"status": sale.status, "total": str(sale.total_amount)},
        )

        return Response(SaleDetailSerializer(sale).data, status=status.HTTP_200_OK)


@extend_schema(tags=["Sales"])
class SalePaymentView(APIView):
    """
    POST /api/sales/<id>/payments/

    Record a payment instalment.  The sale must already be FINAL.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Record payment instalment",
        description="Record a payment against a FINAL sale. Updates `amount_paid`, `balance_due`, and `payment_status`.",
        request=AddPaymentSerializer,
        responses={201: None},
    )
    def post(self, request, pk):
        serializer = AddPaymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data

        try:
            payment = services.add_payment(
                sale_id            = pk,
                amount             = d["amount"],
                method             = d["method"],
                reference          = d["reference"],
                notes              = d["notes"],
                received_by_id     = request.user.id,
                payment_account_id = d.get("payment_account_id"),
            )
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        from .models import Sale
        sale = Sale.objects.get(id=pk)
        return Response(
            {
                "message":        "Payment recorded.",
                "payment_id":     str(payment.id),
                "amount":         payment.amount,
                "method":         payment.method,
                "amount_paid":    sale.amount_paid,
                "balance_due":    sale.balance_due,
                "payment_status": sale.payment_status,
            },
            status=status.HTTP_201_CREATED,
        )


@extend_schema(tags=["Sales"])
class BackOrderView(APIView):
    """
    POST /api/sales/<id>/backorder/

    Create back-order records for items with insufficient stock.
    Transitions sale → PENDING.

    Typically called after receiving a 409 from /finalize/.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Create back-order",
        description="Create back-order records for items with insufficient stock and transition the sale to PENDING.",
        responses={201: BackOrderSerializer(many=True)},
    )
    def post(self, request, pk):
        try:
            backorders = services.create_backorder(sale_id=pk)
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "message":    "Back-order created. Sale is now PENDING.",
                "sale_id":    str(pk),
                "backorders": BackOrderSerializer(backorders, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )


@extend_schema(tags=["Sales"])
class VoidSaleView(APIView):
    """
    POST /api/sales/<id>/void/

    Void a FINAL sale and reverse stock.
    Required permission: CAN_VOID_SALE (OWNER / ADMIN / MANAGER)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Void sale",
        description=(
            "Void a FINAL sale and reverse all FIFO stock deductions. "
            "Creates a reversal journal entry. Requires `can_void_sale` permission (OWNER / ADMIN / MANAGER)."
        ),
        responses={200: None},
    )
    @require_permission(Perm.CAN_VOID_SALE)
    def post(self, request, pk):
        # Capture pre-void state for audit
        try:
            sale_before = Sale.objects.get(id=pk)
            old_val = {"status": sale_before.status, "total": str(sale_before.total_amount)}
        except Sale.DoesNotExist:
            old_val = {}

        try:
            sale = services.void_sale(sale_id=pk, voided_by_id=request.user.id)
        except services.SalesServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Audit log
        log_from_request(
            request,
            action      = AuditAction.VOID,
            module      = "sales.Sale",
            record_id   = sale.id,
            record_repr = f"Invoice {sale.invoice_number}",
            old_value   = old_val,
            new_value   = {"status": sale.status},
        )

        return Response(
            {"message": "Sale voided and stock reversed.", "sale_id": str(sale.id)},
            status=status.HTTP_200_OK,
        )


# ──────────────────────────────────────────────────────────────────────────────
# Sell Return — create + detail
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Sales"])
class SellReturnCreateView(APIView):
    """POST /api/sales/sell-returns/create/  — create a credit note."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Create sell return",
        request=CreateSellReturnSerializer,
        responses={201: SellReturnDetailSerializer},
    )
    def post(self, request):
        import logging
        log = logging.getLogger(__name__)
        try:
            # has_permission() is the runtime check; require_permission
            # is the @decorator factory and isn't callable here.
            from accounts.permissions import has_permission as _has_permission
            if not _has_permission(request.user, Perm.CAN_CREATE_SALE):
                return Response(
                    {"detail": "You don't have permission to create a sale return. Ask an Admin to grant 'sales.create'."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            serializer = CreateSellReturnSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data

            try:
                ret = services.create_sell_return(
                    parent_sale_id=data["parent_sale_id"],
                    location_id=data["location_id"],
                    items=data["items"],
                    return_date=data.get("return_date"),
                    refund_method=data.get("refund_method", ""),
                    refunded_amount=data.get("refunded_amount") or 0,
                    payment_account_id=data.get("payment_account_id") or None,
                    restocking_fee=data.get("restocking_fee") or 0,
                    notes=data.get("notes", ""),
                    created_by_id=request.user.pk,
                )
            except Sale.DoesNotExist:
                return Response({"detail": "Parent sale not found."}, status=status.HTTP_404_NOT_FOUND)
            except services.SalesServiceError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

            # Post-service work — audit log + re-fetch with prefetched
            # relations. Anything that fails here is a server bug, not
            # bad input, but we still want a clean 400 instead of a
            # raw 500 so the UI surfaces something actionable.
            try:
                log_from_request(request, AuditAction.CREATE, "sell_return", str(ret.pk))
                ret.refresh_from_db()
                ret = (
                    SellReturn.objects
                    .select_related("customer", "location", "parent_sale")
                    .prefetch_related("items__product")
                    .get(pk=ret.pk)
                )
                return Response(SellReturnDetailSerializer(ret).data, status=status.HTTP_201_CREATED)
            except Exception as exc:  # noqa: BLE001
                log.exception("Sell return saved but post-processing failed: %s", exc)
                return Response(
                    {"detail": f"Sell return saved, but failed to serialise: {exc}",
                     "id": str(ret.pk)},
                    status=status.HTTP_201_CREATED,
                )
        except Exception as exc:  # noqa: BLE001
            # Outermost safety net — DRF ValidationError already routes
            # to 400 on its own. Everything else gets translated to a
            # plain-English message so a non-technical operator can
            # act on it. The full Python traceback still goes to logs.
            from rest_framework.exceptions import ValidationError as _DRFValidationError
            if isinstance(exc, _DRFValidationError):
                raise
            log.exception("Unhandled error creating sell return: %s", exc)
            friendly = _friendly_sell_return_error(exc)
            return Response({"detail": friendly}, status=status.HTTP_400_BAD_REQUEST)


@extend_schema(tags=["Sales"])
class SellReturnDetailView(APIView):
    """GET    /api/sales/sell-returns/<id>/   — credit note detail
       DELETE /api/sales/sell-returns/<id>/   — delete a credit note
       POST   /api/sales/sell-returns/<id>/refund/ — handled by
                                                    SellReturnRefundView
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(summary="Get sell return detail", responses={200: SellReturnDetailSerializer})
    def get(self, request, pk):
        try:
            ret = (
                SellReturn.objects
                .select_related("customer", "location", "parent_sale")
                .prefetch_related("items__product")
                .get(pk=pk)
            )
        except SellReturn.DoesNotExist:
            return Response({"detail": "Sell return not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(SellReturnDetailSerializer(ret).data)

    @extend_schema(summary="Patch a credit note header (discount + qty)", responses={200: SellReturnDetailSerializer})
    def patch(self, request, pk):
        """Lightweight edit: update each line's quantity and the
        header's discount_type/discount_value, then recompute totals.
        Mirrors the Edit Shipping pattern — try/except wrapped so a
        bad field never bombs the whole request."""
        import logging as _lg
        from decimal import Decimal as _D
        _log = _lg.getLogger(__name__)
        try:
            try:
                ret = (
                    SellReturn.objects
                    .select_related("customer", "location", "parent_sale")
                    .prefetch_related("items__product")
                    .get(pk=pk)
                )
            except SellReturn.DoesNotExist:
                return Response({"detail": "Credit note not found."},
                                status=status.HTTP_404_NOT_FOUND)

            data = request.data if isinstance(request.data, dict) else {}

            # 1) Update per-line return_qty when the client sends an
            #    `items` array of {id, quantity}.
            patched_lines = {str(i.get("id")): i for i in (data.get("items") or []) if i.get("id")}
            subtotal = _D("0")
            for line in ret.items.all():
                p = patched_lines.get(str(line.id))
                if p and "quantity" in p:
                    q = max(_D("0"), _D(str(p["quantity"] or 0)))
                    line.quantity = q
                    line.line_total = (_D(str(line.unit_price or 0)) * q).quantize(_D("0.01"))
                    line.save(update_fields=["quantity", "line_total", "updated_at"] if hasattr(line, "updated_at") else ["quantity", "line_total"])
                subtotal += _D(str(line.line_total or 0))

            # 2) Discount (FIXED or PERCENTAGE) → store in meta and
            #    apply against subtotal.
            meta = dict(ret.meta or {})
            if "discount_type" in data:
                meta["discount_type"] = str(data.get("discount_type") or "FIXED").upper()
            if "discount_value" in data:
                try:
                    meta["discount_value"] = str(_D(str(data.get("discount_value") or 0)))
                except Exception:  # noqa: BLE001
                    meta["discount_value"] = "0"
            d_type  = str(meta.get("discount_type") or "FIXED").upper()
            d_value = _D(str(meta.get("discount_value") or 0))
            if d_type == "PERCENTAGE":
                discount = (subtotal * d_value / _D("100")).quantize(_D("0.01"))
            else:
                discount = d_value.quantize(_D("0.01"))
            discount = min(discount, subtotal)

            new_total = (subtotal - discount).quantize(_D("0.01"))
            old_total = _D(str(ret.total_amount or 0))
            old_paid  = _D(str(ret.amount_paid or 0))

            ret.total_amount = new_total
            ret.meta = meta
            # Keep amount_paid intact; recompute balance_due + status.
            ret.balance_due = max(_D("0"), (new_total - old_paid).quantize(_D("0.01")))
            if ret.balance_due <= _D("0.005"):
                ret.payment_status = Sale.PaymentStatus.PAID
            elif old_paid > _D("0"):
                ret.payment_status = Sale.PaymentStatus.PARTIAL
            else:
                ret.payment_status = Sale.PaymentStatus.DUE

            ret.save(update_fields=[
                "total_amount", "balance_due", "payment_status", "meta", "updated_at",
            ])

            try:
                log_from_request(
                    request,
                    action      = AuditAction.UPDATE,
                    module      = "sales.SellReturn",
                    record_id   = ret.id,
                    record_repr = f"Credit note {ret.invoice_number}",
                    old_value   = {"total_amount": str(old_total)},
                    new_value   = {"total_amount": str(new_total)},
                )
            except Exception:  # noqa: BLE001
                pass

            return Response(SellReturnDetailSerializer(ret).data, status=status.HTTP_200_OK)
        except Exception as exc:  # noqa: BLE001
            _log.exception("Patch credit note failed for %s: %s", pk, exc)
            return Response({"detail": f"Couldn't update this credit note: {exc}"},
                            status=status.HTTP_400_BAD_REQUEST)

    @extend_schema(summary="Delete a credit note", responses={204: None})
    def delete(self, request, pk):
        """Hard-delete a credit note. The stock that was restocked at
        create-time stays on hand (operator's responsibility — they
        explicitly chose to delete the document). The original sale's
        balance is unaffected by deletion."""
        import logging as _lg
        _log = _lg.getLogger(__name__)
        try:
            ret = SellReturn.objects.get(pk=pk)
        except SellReturn.DoesNotExist:
            return Response({"detail": "Sell return not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            inv = ret.invoice_number
            ret.delete()
            try:
                log_from_request(
                    request,
                    action      = AuditAction.DELETE,
                    module      = "sales.SellReturn",
                    record_id   = pk,
                    record_repr = f"Credit note {inv}",
                )
            except Exception:  # noqa: BLE001
                pass
            return Response(status=status.HTTP_204_NO_CONTENT)
        except Exception as exc:  # noqa: BLE001
            _log.exception("Delete credit note failed for %s: %s", pk, exc)
            return Response({"detail": f"Couldn't delete this credit note: {exc}"},
                            status=status.HTTP_400_BAD_REQUEST)


@extend_schema(tags=["Sales"])
class SellReturnRefundView(APIView):
    """POST /api/sales/sell-returns/<id>/refund/

    Record an additional refund payment against an existing credit
    note. Mirrors the SalePaymentView pattern: bumps amount_paid +
    decreases balance_due, posts a PaymentAccountTransaction so the
    cashier's List Accounts ledger reflects the cash leaving.

    Body: { amount, method?, reference?, payment_account_id?, notes? }
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        import logging as _lg
        _log = _lg.getLogger(__name__)
        try:
            from decimal import Decimal as _D
            try:
                ret = SellReturn.objects.get(pk=pk)
            except SellReturn.DoesNotExist:
                return Response({"detail": "Credit note not found."},
                                status=status.HTTP_404_NOT_FOUND)

            data = request.data if isinstance(request.data, dict) else {}
            amount = _D(str(data.get("amount", 0) or 0))
            if amount <= 0:
                return Response({"detail": "Refund amount must be greater than zero."},
                                status=status.HTTP_400_BAD_REQUEST)

            due_before = _D(str(ret.balance_due or 0))
            if amount > due_before + _D("0.001"):
                return Response(
                    {"detail": f"Amount exceeds outstanding refund due ({due_before})."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            ret.amount_paid  = (_D(str(ret.amount_paid or 0)) + amount).quantize(_D("0.01"))
            ret.balance_due  = max(_D("0"), (due_before - amount).quantize(_D("0.01")))
            ret.refunded_amount = (_D(str(ret.refunded_amount or 0)) + amount).quantize(_D("0.01"))
            # Recompute payment status from money math (PAID / PARTIAL / DUE).
            if ret.balance_due <= _D("0.005"):
                ret.payment_status = Sale.PaymentStatus.PAID
            elif ret.amount_paid > _D("0"):
                ret.payment_status = Sale.PaymentStatus.PARTIAL
            else:
                ret.payment_status = Sale.PaymentStatus.DUE
            ret.save(update_fields=[
                "amount_paid", "balance_due", "refunded_amount",
                "payment_status", "updated_at",
            ])

            # Record a PaymentAccountTransaction on the picked account so
            # the cashier's List Accounts ledger shows the cash leaving.
            pa_id = data.get("payment_account_id")
            if pa_id:
                try:
                    from accounting.models import PaymentAccount, PaymentAccountTransaction
                    pa = PaymentAccount.objects.filter(pk=pa_id).first()
                    if pa:
                        PaymentAccountTransaction.objects.create(
                            account     = pa,
                            kind        = PaymentAccountTransaction.Kind.ADJUSTMENT,
                            amount      = -amount,
                            description = f"Refund for credit note {ret.invoice_number}",
                            reference   = str(ret.id),
                            created_by_id = request.user.id,
                        )
                except Exception:  # noqa: BLE001
                    _log.exception("PaymentAccountTransaction failed for refund %s", ret.id)

            return Response(SellReturnDetailSerializer(ret).data, status=status.HTTP_200_OK)
        except Exception as exc:  # noqa: BLE001
            _log.exception("Refund credit note failed for %s: %s", pk, exc)
            return Response({"detail": f"Couldn't record refund: {exc}"},
                            status=status.HTTP_400_BAD_REQUEST)


# ──────────────────────────────────────────────────────────────────────────────
# Import Contacts — CSV upload that creates Customers and/or Suppliers
# ──────────────────────────────────────────────────────────────────────────────

CONTACT_IMPORT_COLUMNS = [
    # (header,                  required, description)
    ("contact_type",            True,  "1 = Customer, 2 = Supplier, 3 = Both"),
    ("prefix",                  False, "Mr / Ms / Mrs (optional)"),
    ("first_name",              True,  "First name"),
    ("middle_name",             False, "Middle name (optional)"),
    ("last_name",               False, "Last name (optional)"),
    ("business_name",           False, "Required when contact_type is Supplier or Both"),
    ("tax_number",              False, "VAT / GST / TIN (optional)"),
    ("opening_balance",         False, "Numeric, defaults to 0"),
    ("pay_term_value",          False, "Integer (e.g. 30)"),
    ("pay_term_period",         False, "days or months"),
    ("email",                   False, "Email address"),
    ("mobile",                  False, "Primary phone / mobile"),
    ("alternate_contact",       False, "Secondary phone (optional)"),
    ("address_line_1",          False, "Street address line 1"),
    ("address_line_2",          False, "Street address line 2"),
    ("city",                    False, "City"),
    ("state",                   False, "State / province"),
    ("country",                 False, "Country"),
    ("zip_code",                False, "Postal code"),
    ("customer_group",          False, "Customer group name (must already exist; ignored for suppliers)"),
    ("custom_field_1",          False, "Free-form custom field 1"),
    ("custom_field_2",          False, "Free-form custom field 2"),
    ("custom_field_3",          False, "Free-form custom field 3"),
    ("custom_field_4",          False, "Free-form custom field 4"),
]


def _ci_compose_name(row):
    parts = [row.get("prefix"), row.get("first_name"), row.get("middle_name"), row.get("last_name")]
    return " ".join([p.strip() for p in parts if p and p.strip()])


def _ci_compose_address(row):
    parts = [
        row.get("address_line_1"),
        row.get("address_line_2"),
        row.get("city"),
        row.get("state"),
        row.get("zip_code"),
        row.get("country"),
    ]
    return ", ".join([p.strip() for p in parts if p and p.strip()])


def _ci_parse_decimal(raw, default=Decimal("0")):
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return Decimal(str(raw).strip())
    except InvalidOperation:
        return default


def _ci_parse_int(raw):
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return None


def _ci_contact_type(raw):
    """Map 1/2/3 (or text) to 'customer' / 'supplier' / 'both'."""
    s = (str(raw or "").strip() or "").lower()
    if s in ("1", "customer"):  return "customer"
    if s in ("2", "supplier"):  return "supplier"
    if s in ("3", "both"):      return "both"
    return ""


@extend_schema(tags=["Customers"])
class ContactImportTemplateView(APIView):
    """GET /api/sales/contacts/import-template/  → CSV template download."""
    permission_classes = [IsAuthenticated]

    @extend_schema(summary="Download contacts CSV template")
    def get(self, request):
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow([col for col, _req, _desc in CONTACT_IMPORT_COLUMNS])
        # One example customer + one example supplier row so users see the format.
        writer.writerow([
            "1", "Mr", "Anika", "", "Rahman", "", "", "0", "30", "days",
            "anika@example.com", "01711111111", "", "House 12, Road 4", "",
            "Dhaka", "Dhaka", "Bangladesh", "1207", "", "", "", "", "",
        ])
        writer.writerow([
            "2", "", "Rahim", "", "Traders", "Rahim Traders Ltd", "TIN-9876", "0",
            "30", "days", "billing@rahimtraders.com", "01999999999", "",
            "Plot 5, Block C", "Mirpur", "Dhaka", "Dhaka", "Bangladesh", "1216",
            "", "", "", "", "",
        ])
        resp = HttpResponse(out.getvalue(), content_type="text/csv; charset=utf-8")
        resp["Content-Disposition"] = 'attachment; filename="contacts-template.csv"'
        return resp


@extend_schema(tags=["Customers"])
class ContactImportView(APIView):
    """
    POST /api/sales/contacts/import/

    Multipart upload of a CSV file matching CONTACT_IMPORT_COLUMNS. Returns
    a report of how many customers / suppliers were created or skipped and
    a per-row error list so the user can fix and re-upload only the bad
    rows. Existing contacts matched by (name + phone) are skipped so the
    same file can be safely re-run.
    """
    permission_classes = [IsAuthenticated]
    parser_classes     = [MultiPartParser, FormParser]

    @extend_schema(summary="Import customers / suppliers from CSV")
    def post(self, request):
        from purchases.models import Supplier  # noqa: PLC0415

        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "No file uploaded. Send the CSV as multipart field 'file'."},
                            status=status.HTTP_400_BAD_REQUEST)

        # Decode → DictReader (lenient UTF-8 / latin-1 fallback)
        try:
            text = upload.read().decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = upload.read().decode("latin-1")
            except Exception as exc:  # noqa: BLE001
                return Response({"detail": f"Could not decode file: {exc}"},
                                status=status.HTTP_400_BAD_REQUEST)

        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            return Response({"detail": "The uploaded file is empty or has no header row."},
                            status=status.HTTP_400_BAD_REQUEST)

        # Normalise field names: lowercase + underscored
        def _norm(s): return (s or "").strip().lower().replace(" ", "_")
        norm_fields = {f: _norm(f) for f in reader.fieldnames}
        expected = {col for col, _, _ in CONTACT_IMPORT_COLUMNS}
        missing  = expected - {v for v in norm_fields.values()} - {
            "prefix", "middle_name", "last_name", "tax_number",
            "opening_balance", "pay_term_value", "pay_term_period",
            "email", "mobile", "alternate_contact", "address_line_1",
            "address_line_2", "city", "state", "country", "zip_code",
            "customer_group", "custom_field_1", "custom_field_2",
            "custom_field_3", "custom_field_4", "business_name",
        }
        # Only contact_type + first_name are hard-required.
        for req in ("contact_type", "first_name"):
            if req not in norm_fields.values():
                return Response(
                    {"detail": f"Missing required column '{req}'. Download the template for the expected layout."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        created = {"customer": 0, "supplier": 0}
        skipped = {"customer": 0, "supplier": 0}
        errors  = []

        # Group cache so customer_group name → id lookup is one query per name
        group_cache = {g.name.lower(): g for g in CustomerGroup.objects.all()}

        for i, raw_row in enumerate(reader, start=2):  # start=2 because row 1 is header
            row = {norm_fields.get(k, _norm(k)): (v or "").strip() for k, v in raw_row.items()}

            # Skip totally-empty rows
            if not any(row.values()):
                continue

            ct = _ci_contact_type(row.get("contact_type"))
            if not ct:
                errors.append({"row": i, "message": "contact_type must be 1 (Customer), 2 (Supplier) or 3 (Both)."})
                continue
            if not row.get("first_name"):
                errors.append({"row": i, "message": "first_name is required."})
                continue

            name          = _ci_compose_name(row) or row.get("first_name")
            business_name = row.get("business_name") or ""
            if ct in ("supplier", "both") and not business_name:
                # Fall back to composed name so we don't reject the row outright.
                business_name = name

            phone   = row.get("mobile") or row.get("alternate_contact") or ""
            email   = row.get("email") or ""
            tax_no  = row.get("tax_number") or ""
            address = _ci_compose_address(row)
            notes   = row.get("alternate_contact") and f"Alt phone: {row.get('alternate_contact')}" or ""

            pay_term_value  = _ci_parse_int(row.get("pay_term_value"))
            pay_term_period = (row.get("pay_term_period") or "").lower()
            if pay_term_period not in ("", "days", "months"):
                pay_term_period = ""
            opening_balance = _ci_parse_decimal(row.get("opening_balance"), Decimal("0"))

            cf = {
                "custom_field_1": row.get("custom_field_1") or "",
                "custom_field_2": row.get("custom_field_2") or "",
                "custom_field_3": row.get("custom_field_3") or "",
                "custom_field_4": row.get("custom_field_4") or "",
            }

            try:
                # ── Customer ───────────────────────────────────────────
                if ct in ("customer", "both"):
                    qs = Customer.objects.filter(name=name)
                    if phone:
                        qs = qs.filter(phone=phone)
                    if qs.exists():
                        skipped["customer"] += 1
                    else:
                        Customer.objects.create(
                            name=name, business_name=business_name,
                            email=email, phone=phone, address=address,
                            tax_number=tax_no, notes=notes,
                            pay_term_value=pay_term_value,
                            pay_term_period=pay_term_period,
                            opening_balance=opening_balance,
                            **cf,
                        )
                        created["customer"] += 1

                # ── Supplier ───────────────────────────────────────────
                if ct in ("supplier", "both"):
                    qs = Supplier.objects.filter(name=name)
                    if phone:
                        qs = qs.filter(phone=phone)
                    if qs.exists():
                        skipped["supplier"] += 1
                    else:
                        Supplier.objects.create(
                            name=name, business_name=business_name,
                            email=email, phone=phone, address=address,
                            tax_number=tax_no, notes=notes,
                            pay_term_value=pay_term_value,
                            pay_term_period=pay_term_period,
                            opening_balance=opening_balance,
                            **cf,
                        )
                        created["supplier"] += 1
            except Exception as exc:  # noqa: BLE001
                errors.append({"row": i, "message": str(exc)})
                continue

        return Response({
            "created": created,
            "skipped": skipped,
            "errors":  errors,
            "summary": {
                "rows_with_errors":  len(errors),
                "total_created":     created["customer"] + created["supplier"],
                "total_skipped":     skipped["customer"] + skipped["supplier"],
            },
        }, status=status.HTTP_200_OK)
