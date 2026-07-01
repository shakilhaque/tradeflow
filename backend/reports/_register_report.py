"""
Register Report

The Iffaa POS doesn't (yet) have a formal cash-register / till open-close
entity, so this report SYNTHESISES a session as:

    one cashier × one day × one location

For each such "session" it:
    • takes the first SalePayment timestamp as Open Time
    • takes the last  SalePayment timestamp as Close Time
    • sums payments by method (Cash, Card, Bank Transfer, Mobile, Other)
    • marks status = OPEN  if the session is today AND no payment older
                            than 30 minutes (i.e. the cashier is still active)
                  = CLOSED otherwise

Endpoint
    GET /api/reports/register/?user_id=&location_id=&status=&date_from=&date_to=
                              &page=&limit=

Status filter values: all (default) | open | closed
Permission: CAN_VIEW_REPORTS. Cashiers are clamped to their own UUID.
"""
from datetime import date as _date, timedelta
from decimal import Decimal as _D

from django.db.models import Count, DecimalField, Max, Min, Q, Sum, Value
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)

METHODS = ["CASH", "CARD", "BANK_TRANSFER", "MOBILE", "OTHER"]
OPEN_WINDOW_MINUTES = 30   # how recent the last payment must be for OPEN


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
        return {
            str(r["id"]): {
                "name":  r["name"]  or r["email"] or "—",
                "email": r["email"] or "",
            }
            for r in rows
        }
    except Exception:
        return {}


@extend_schema(tags=["Reports"])
class RegisterReportView(APIView):
    """Synthesised cash-register sessions, one per cashier per day per location."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Register report",
        description=(
            "One row per synthesised register session = cashier × day × "
            "location. Columns split SalePayment totals by method."
        ),
        parameters=[
            OpenApiParameter("user_id",     OpenApiTypes.UUID, description="Filter by cashier UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, description="Filter by location UUID"),
            OpenApiParameter("status",      OpenApiTypes.STR,  description="all | open | closed (default all)"),
            OpenApiParameter("date_from",   OpenApiTypes.DATE, description="Start date YYYY-MM-DD"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, description="End date YYYY-MM-DD"),
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
                status=drf_status.HTTP_403_FORBIDDEN,
            )

        params = request.query_params
        date_from   = _parse_date(params.get("date_from"))
        date_to     = _parse_date(params.get("date_to"))
        user_id     = params.get("user_id") or ""
        location_id = params.get("location_id") or ""
        status_filter = (params.get("status") or "all").lower()
        if status_filter not in ("all", "open", "closed"):
            status_filter = "all"

        try:
            page = max(int(params.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1
        try:
            limit = int(params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        limit = min(max(limit, 5), 200)

        # CASHIER clamp.
        if getattr(request.user, "role", "") == "cashier":
            user_id = str(request.user.id)

        from sales.models import SalePayment  # noqa: PLC0415
        from accounts.branch_context import branch_scope  # noqa: PLC0415

        payments_qs = branch_scope(
            SalePayment.objects.select_related("sale__location"),
            field="sale__location_id",
        )
        if date_from:    payments_qs = payments_qs.filter(created_at__date__gte=date_from)
        if date_to:      payments_qs = payments_qs.filter(created_at__date__lte=date_to)
        if user_id:      payments_qs = payments_qs.filter(received_by_id=user_id)
        if location_id:  payments_qs = payments_qs.filter(sale__location_id=location_id)

        # Aggregate by (cashier, day, location).
        groups = (
            payments_qs
            .annotate(day=TruncDate("created_at"))
            .values("received_by_id", "day", "sale__location_id")
            .annotate(
                open_time  = Min("created_at"),
                close_time = Max("created_at"),
                payment_count = Count("id"),
                cash          = Coalesce(
                    Sum("amount", filter=Q(method="CASH")), ZERO,
                ),
                card          = Coalesce(
                    Sum("amount", filter=Q(method="CARD")), ZERO,
                ),
                bank_transfer = Coalesce(
                    Sum("amount", filter=Q(method="BANK_TRANSFER")), ZERO,
                ),
                mobile        = Coalesce(
                    Sum("amount", filter=Q(method="MOBILE")), ZERO,
                ),
                other         = Coalesce(
                    Sum("amount", filter=Q(method="OTHER")), ZERO,
                ),
                total         = Coalesce(Sum("amount"), ZERO),
            )
            .order_by("-day", "-close_time")
        )

        # Resolve names + status, then apply status filter post-aggregation.
        groups = list(groups)

        # Bulk-resolve user names + location names.
        user_lookup = _resolve_user_names(
            [str(g["received_by_id"]) for g in groups if g["received_by_id"]]
        )

        from inventory.models import Location  # noqa: PLC0415
        loc_ids = {g["sale__location_id"] for g in groups if g["sale__location_id"]}
        loc_lookup = {
            str(l.id): l.name
            for l in Location.objects.filter(id__in=loc_ids)
        }

        now = timezone.now()
        open_cutoff = now - timedelta(minutes=OPEN_WINDOW_MINUTES)
        today = timezone.localdate()

        rows = []
        for g in groups:
            close_dt = g["close_time"]
            is_open = (
                g["day"] == today
                and close_dt is not None
                and close_dt >= open_cutoff
            )
            uid = str(g["received_by_id"]) if g["received_by_id"] else ""
            info = user_lookup.get(uid, {"name": "—", "email": ""})
            rows.append({
                "user_id":       uid,
                "user_name":     info["name"],
                "user_email":    info["email"],
                "day":           g["day"].isoformat() if g["day"] else None,
                "location_id":   str(g["sale__location_id"]) if g["sale__location_id"] else "",
                "location_name": loc_lookup.get(str(g["sale__location_id"]), "—"),
                "open_time":     g["open_time"],
                "close_time":    close_dt,
                "status":        "OPEN" if is_open else "CLOSED",
                "payment_count": g["payment_count"],
                "cash":          str(g["cash"]          or _D("0")),
                "card":          str(g["card"]          or _D("0")),
                "bank_transfer": str(g["bank_transfer"] or _D("0")),
                "mobile":        str(g["mobile"]        or _D("0")),
                "other":         str(g["other"]         or _D("0")),
                "total":         str(g["total"]         or _D("0")),
            })

        if status_filter != "all":
            rows = [r for r in rows if r["status"].lower() == status_filter]

        # ── Footer totals (computed over ALL filtered rows) ─────────────────
        def s(field):
            return sum((_D(r[field]) for r in rows), _D("0"))

        footer = {
            "session_count": len(rows),
            "cash":          str(s("cash")),
            "card":          str(s("card")),
            "bank_transfer": str(s("bank_transfer")),
            "mobile":        str(s("mobile")),
            "other":         str(s("other")),
            "total":         str(s("total")),
            "open_count":    sum(1 for r in rows if r["status"] == "OPEN"),
            "closed_count":  sum(1 for r in rows if r["status"] == "CLOSED"),
        }

        # ── Pagination ──────────────────────────────────────────────────────
        count = len(rows)
        total_pages = max((count + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = rows[offset: offset + limit]

        # ── Dropdown options ────────────────────────────────────────────────
        # Full tenant roster (owner + every sub-user) from the master
        # DB — NOT just users who happen to have sessions in the
        # period. Cashiers who haven't recorded a payment yet still
        # appear so the operator can filter by them.
        from ._user_options import tenant_user_options  # noqa: PLC0415
        user_options = tenant_user_options(request.user)
        location_options = [
            {"id": str(l.id), "name": l.name}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]

        return Response({
            "period": {
                "from": date_from.isoformat() if date_from else None,
                "to":   date_to.isoformat()   if date_to   else None,
            },
            "rows":             page_rows,
            "footer":           footer,
            "page":             page,
            "limit":            limit,
            "total_pages":      total_pages,
            "count":            count,
            "user_options":     user_options,
            "location_options": location_options,
        })


# ────────────────────────────────────────────────────────────────────────────
# Register Details — modal-style endpoint the POS calls when the cashier
# clicks the "Register Details" button on the top bar. Returns the
# synthesised current session for (request.user × location × today) in
# the exact JSON shape the modal renders. Everything is computed from
# the per-tenant DB; no hardcoded buckets.
# ────────────────────────────────────────────────────────────────────────────
@extend_schema(tags=["Reports"])
class RegisterDetailsView(APIView):
    """
    GET /api/reports/register/details/?location_id=<uuid>&date=YYYY-MM-DD

    Defaults: location_id = (any), date = today (local). Always scoped
    to request.user — the cashier sees their OWN till; managers can
    pass user_id=<uuid> to view another cashier's session.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            return self._get(request)
        except Exception as e:  # pragma: no cover — defensive
            # Log to the server but never bomb on legacy tenants with
            # slightly different schemas; return an empty session shape
            # so the modal still renders zeros instead of an error toast.
            import logging
            logging.getLogger(__name__).exception("RegisterDetails failed: %s", e)
            from inventory.models import Location  # noqa: PLC0415
            params      = request.query_params
            the_date    = _parse_date(params.get("date")) or timezone.localdate()
            location_id = params.get("location_id") or ""
            target_user_id = str(request.user.id)
            loc_name = "—"
            if location_id:
                loc = Location.objects.filter(id=location_id).only("name").first()
                if loc:
                    loc_name = loc.name
            users = _resolve_user_names([target_user_id])
            ui = users.get(target_user_id, {"name": "—", "email": ""})
            zero = "0.00"
            return Response({
                "date":       the_date.isoformat(),
                "open_time":  None,
                "close_time": None,
                "user":       {"id": target_user_id, "name": ui["name"], "email": ui["email"]},
                "location":   {"id": location_id, "name": loc_name},
                "payment_methods": [
                    {"key": "CASH_IN_HAND",  "label": "Cash in hand",   "sell": zero, "expense": "—"},
                    {"key": "CASH",          "label": "Cash Payment",   "sell": zero, "expense": zero},
                    {"key": "CARD",          "label": "Card Payment",   "sell": zero, "expense": zero},
                    {"key": "BANK_TRANSFER", "label": "Bank Transfer",  "sell": zero, "expense": zero},
                    {"key": "MOBILE",        "label": "Mobile Payment", "sell": zero, "expense": zero},
                    {"key": "OTHER",         "label": "Other Payments", "sell": zero, "expense": zero},
                ],
                "totals": {
                    "total_sales": zero, "total_refund": zero, "total_payment": zero,
                    "credit_sales": zero, "total_expenses": zero, "sale_count": 0,
                },
                "products_sold": [],
                "products_grand_total": {"qty": "0", "amount": zero},
                "warning": "Could not load register details — showing zeros.",
            })

    def _get(self, request):
        params      = request.query_params
        # When the caller passes an explicit ?date= they want that
        # historical calendar day. The POS "Register Details" modal
        # passes NO date — it wants the CURRENT OPEN register, i.e.
        # everything since the last Close Register regardless of the
        # calendar date. The old code always pinned to a single day
        # (today, in UTC), so a register opened on an earlier date and
        # not yet closed showed all zeros today. `explicit_date`
        # distinguishes the two modes.
        the_date      = _parse_date(params.get("date"))
        explicit_date = the_date is not None
        if the_date is None:
            the_date = timezone.localdate()
        location_id = params.get("location_id") or ""
        # Managers may view a specific cashier's session; cashiers are
        # clamped to themselves by accounts.permissions elsewhere, but
        # we also enforce here defensively.
        target_user_id = params.get("user_id") or str(request.user.id)
        if getattr(request.user, "role", "") == "cashier":
            target_user_id = str(request.user.id)

        from sales.models import SalePayment, Sale, SellReturn, SellReturnItem, SaleItem, RegisterClosure  # noqa: PLC0415

        # ── "Current Register" lower bound = last closure for this
        # cashier × location. If none exists today, the window opens
        # at the start of the day. So once the cashier hits Close
        # Register, the modal numbers reset to zero on the next open.
        closure_qs = RegisterClosure.objects.filter(user_id=target_user_id)
        if location_id:
            closure_qs = closure_qs.filter(location_id=location_id)
        last_close = closure_qs.order_by("-closed_at").values_list("closed_at", flat=True).first()

        # ── Payments split by method (sells side) ──────────────────────────
        from accounts.branch_context import branch_scope  # noqa: PLC0415
        pay_qs = branch_scope(
            SalePayment.objects.filter(received_by_id=target_user_id),
            field="sale__location_id",
        )
        if explicit_date:
            pay_qs = pay_qs.filter(created_at__date=the_date)
        if last_close is not None:
            pay_qs = pay_qs.filter(created_at__gt=last_close)
        if location_id:
            pay_qs = pay_qs.filter(sale__location_id=location_id)

        agg = pay_qs.aggregate(
            open_time  = Min("created_at"),
            close_time = Max("created_at"),
            cash       = Coalesce(Sum("amount", filter=Q(method="CASH")), ZERO),
            card       = Coalesce(Sum("amount", filter=Q(method="CARD")), ZERO),
            bank       = Coalesce(Sum("amount", filter=Q(method="BANK_TRANSFER")), ZERO),
            mobile     = Coalesce(Sum("amount", filter=Q(method="MOBILE")), ZERO),
            other      = Coalesce(Sum("amount", filter=Q(method="OTHER")), ZERO),
            total      = Coalesce(Sum("amount"), ZERO),
        )

        # ── Sales totals (sells made TODAY by this cashier in this loc) ────
        sale_qs = branch_scope(Sale.objects.filter(
            created_by_id=target_user_id,
            status="FINAL",
        ))
        if explicit_date:
            sale_qs = sale_qs.filter(created_at__date=the_date)
        if last_close is not None:
            sale_qs = sale_qs.filter(created_at__gt=last_close)
        if location_id:
            sale_qs = sale_qs.filter(location_id=location_id)
        sale_agg = sale_qs.aggregate(
            total_sales = Coalesce(Sum("total_amount"), ZERO),
            sale_count  = Count("id"),
        )
        # Credit sales = sales with non-zero balance_due (cust owes us).
        credit_sales = sale_qs.filter(balance_due__gt=0).aggregate(
            v=Coalesce(Sum("balance_due"), ZERO),
        )["v"]

        # ── Returns / Refunds for this cashier × day × loc ─────────────────
        ret_qs = branch_scope(SellReturn.objects.filter(
            created_by_id=target_user_id,
        ))
        if explicit_date:
            ret_qs = ret_qs.filter(return_date=the_date)
        if last_close is not None:
            ret_qs = ret_qs.filter(created_at__gt=last_close)
        if location_id:
            ret_qs = ret_qs.filter(location_id=location_id)
        total_refund = ret_qs.aggregate(
            v=Coalesce(Sum("refunded_amount"), ZERO),
        )["v"]

        # ── Expenses for this cashier × day × loc ──────────────────────────
        total_expenses = _D("0")
        try:
            from accounting.models import Expense  # noqa: PLC0415
            exp_qs = branch_scope(Expense.objects.filter(
                created_by_id=target_user_id,
            ))
            if explicit_date:
                exp_qs = exp_qs.filter(expense_date=the_date)
            if last_close is not None:
                exp_qs = exp_qs.filter(created_at__gt=last_close)
            if location_id:
                exp_qs = exp_qs.filter(location_id=location_id)
            total_expenses = exp_qs.aggregate(
                v=Coalesce(Sum("amount"), ZERO),
            )["v"] or _D("0")
        except Exception:
            # Expense table missing or unmigrated on this tenant — leave 0.
            total_expenses = _D("0")

        # ── Products sold by brand (the bottom table in the screenshot) ────
        items_qs = SaleItem.objects.filter(sale__in=sale_qs).select_related("product__brand")
        by_brand = {}
        for it in items_qs.values(
            "product__brand__name",
            "quantity",
            "total_price",
        ):
            name = it["product__brand__name"] or "—"
            row  = by_brand.setdefault(name, {"qty": _D("0"), "amount": _D("0")})
            row["qty"]    += _D(str(it["quantity"]    or 0))
            row["amount"] += _D(str(it["total_price"] or 0))
        products_sold = sorted(
            [{"brand": k, "qty": str(v["qty"]), "amount": str(v["amount"])}
             for k, v in by_brand.items()],
            key=lambda r: r["brand"],
        )
        grand_qty   = sum((_D(r["qty"])    for r in products_sold), _D("0"))
        grand_total = sum((_D(r["amount"]) for r in products_sold), _D("0"))

        # ── Cash in hand = cash received − cash refunds − cash expenses ────
        # (refunds and expenses paid by other methods don't reduce the till)
        cash_refunds = ret_qs.filter(refund_method="CASH").aggregate(
            v=Coalesce(Sum("refunded_amount"), ZERO),
        )["v"] or _D("0")
        cash_expenses = _D("0")
        try:
            from accounting.models import Expense, PaymentAccount  # noqa: PLC0415
            cash_acc_ids = list(
                PaymentAccount.objects.filter(account_type="CASH").values_list("id", flat=True)
            )
            if cash_acc_ids:
                cash_expenses = exp_qs.filter(payment_account_id__in=cash_acc_ids).aggregate(
                    v=Coalesce(Sum("amount"), ZERO),
                )["v"] or _D("0")
        except Exception:
            cash_expenses = _D("0")
        cash_in_hand = (agg["cash"] or _D("0")) - cash_refunds - cash_expenses

        # ── Resolve user + location names for the footer ───────────────────
        users = _resolve_user_names([target_user_id])
        user_info = users.get(target_user_id, {"name": "—", "email": ""})
        from inventory.models import Location  # noqa: PLC0415
        loc_name = "—"
        if location_id:
            loc = Location.objects.filter(id=location_id).only("name").first()
            if loc:
                loc_name = loc.name

        return Response({
            "date":      the_date.isoformat(),
            "open_time": agg["open_time"],
            "close_time": agg["close_time"],
            "user": {
                "id":    target_user_id,
                "name":  user_info["name"],
                "email": user_info["email"],
            },
            "location": {"id": location_id, "name": loc_name},
            # Each row = one row in the Payment Method table the
            # modal renders. `sell` is money in via that method,
            # `expense` is money out via that method.
            "payment_methods": [
                # Cash in hand sits at the top of the table as a
                # convenience line — the cashier reconciles the
                # drawer against this number.
                {"key": "CASH_IN_HAND",  "label": "Cash in hand",   "sell": str(cash_in_hand), "expense": "—"},
                {"key": "CASH",          "label": "Cash Payment",   "sell": str(agg["cash"]),   "expense": str(cash_expenses)},
                {"key": "CARD",          "label": "Card Payment",   "sell": str(agg["card"]),   "expense": "0.00"},
                {"key": "BANK_TRANSFER", "label": "Bank Transfer",  "sell": str(agg["bank"]),   "expense": "0.00"},
                {"key": "MOBILE",        "label": "Mobile Payment", "sell": str(agg["mobile"]), "expense": "0.00"},
                {"key": "OTHER",         "label": "Other Payments", "sell": str(agg["other"]),  "expense": "0.00"},
            ],
            "totals": {
                "total_sales":    str(sale_agg["total_sales"] or _D("0")),
                "total_refund":   str(total_refund   or _D("0")),
                "total_payment":  str(agg["total"]   or _D("0")),
                "credit_sales":   str(credit_sales   or _D("0")),
                "total_expenses": str(total_expenses or _D("0")),
                "sale_count":     sale_agg["sale_count"] or 0,
            },
            "products_sold": products_sold,
            "products_grand_total": {
                "qty":   str(grand_qty),
                "amount": str(grand_total),
            },
        })


# ────────────────────────────────────────────────────────────────────────────
# RegisterCloseView — POST endpoint the "Close Register" modal hits.
# Snapshots the expected totals server-side (so a cashier can't fake them),
# stores the counted totals + closing note typed in the modal, and writes
# a RegisterClosure row. The next Register Details call bounds the
# "current register" window at the row's closed_at — so the next session
# starts fresh.
# ────────────────────────────────────────────────────────────────────────────
@extend_schema(tags=["Reports"])
class RegisterCloseView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from sales.models import SalePayment, RegisterClosure  # noqa: PLC0415

        target_user_id = str(request.user.id)
        location_id    = request.data.get("location_id") or None
        if location_id == "":
            location_id = None

        # Compute the expected totals server-side for this user × location
        # × since-last-closure window — same logic as the Details view, so
        # the numbers always reconcile.
        closure_qs = RegisterClosure.objects.filter(user_id=target_user_id)
        if location_id:
            closure_qs = closure_qs.filter(location_id=location_id)
        last_close = closure_qs.order_by("-closed_at").values_list("closed_at", flat=True).first()

        from accounts.branch_context import branch_scope  # noqa: PLC0415
        pay_qs = branch_scope(
            SalePayment.objects.filter(received_by_id=target_user_id),
            field="sale__location_id",
        )
        if last_close is not None:
            pay_qs = pay_qs.filter(created_at__gt=last_close)
        if location_id:
            pay_qs = pay_qs.filter(sale__location_id=location_id)

        agg = pay_qs.aggregate(
            cash   = Coalesce(Sum("amount", filter=Q(method="CASH")),          ZERO),
            card   = Coalesce(Sum("amount", filter=Q(method="CARD")),          ZERO),
            bank   = Coalesce(Sum("amount", filter=Q(method="BANK_TRANSFER")), ZERO),
            total  = Coalesce(Sum("amount"), ZERO),
        )

        def _d(v):
            try:
                return _D(str(v or "0"))
            except Exception:
                return _D("0")

        closure = RegisterClosure.objects.create(
            user_id          = target_user_id,
            location_id      = location_id,
            expected_cash    = agg["cash"]  or _D("0"),
            expected_card    = agg["card"]  or _D("0"),
            expected_cheque  = agg["bank"]  or _D("0"),
            expected_total   = agg["total"] or _D("0"),
            counted_cash     = _d(request.data.get("counted_cash")),
            counted_card     = _d(request.data.get("counted_card")),
            counted_cheque   = _d(request.data.get("counted_cheque")),
            closing_note     = str(request.data.get("closing_note") or "")[:5000],
        )

        return Response({
            "ok":          True,
            "id":          str(closure.id),
            "closed_at":   closure.closed_at,
            "expected": {
                "cash":   str(closure.expected_cash),
                "card":   str(closure.expected_card),
                "cheque": str(closure.expected_cheque),
                "total":  str(closure.expected_total),
            },
            "counted": {
                "cash":   str(closure.counted_cash),
                "card":   str(closure.counted_card),
                "cheque": str(closure.counted_cheque),
            },
        })

