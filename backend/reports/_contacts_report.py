"""
Customers & Suppliers Report — unified contact ledger.

Endpoint: GET /api/reports/contacts/
Query    type=all|customer|supplier  (default all)
         search                       (free-text on name / phone / email)
         page, limit

Each row represents one contact:
    Customer:
        Total Purchase           — 0  (customers don't purchase from us)
        Total Purchase Return    — 0
        Total Sale               — Σ Sale.total_amount (FINAL)
        Total Sell Return        — Σ SellReturn.total_amount
        Opening Balance Due      — 0  (IFFAA doesn't track opening balances yet)
        Due                      — Σ(Sale.total_amount − amount_paid)  for FINAL,
                                    minus refunds still owed to the customer.
    Supplier:
        Total Purchase           — Σ Purchase.grand_total (non-cancelled)
        Total Purchase Return    — Σ PurchaseReturn.total_amount
        Total Sale               — 0
        Total Sell Return        — 0
        Opening Balance Due      — 0
        Due                      — Σ(Purchase.grand_total − paid_amount).
                                    Positive means WE owe the supplier.

Permission: CAN_VIEW_REPORTS.
"""
from decimal import Decimal as _D

from django.db.models import Count, DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


DEC  = DecimalField(max_digits=18, decimal_places=2)
ZERO = Value(_D("0"), output_field=DEC)


def _D0(v):
    if v is None:
        return _D("0")
    return _D(str(v))


@extend_schema(tags=["Reports"])
class ContactsReportView(APIView):
    """Unified customer + supplier ledger summary."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Customers & Suppliers report",
        description=(
            "Returns one row per contact (Customer or Supplier) with their "
            "lifetime totals and outstanding due. Filter by `type` to show "
            "only customers or only suppliers."
        ),
        parameters=[
            OpenApiParameter("type",   OpenApiTypes.STR, description="all | customer | supplier (default all)"),
            OpenApiParameter("search", OpenApiTypes.STR, description="Free-text on name / phone / email"),
            OpenApiParameter("page",   OpenApiTypes.INT, description="Page (default 1)"),
            OpenApiParameter("limit",  OpenApiTypes.INT, description="Per page (default 25, max 200)"),
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

        p     = request.query_params
        kind  = (p.get("type") or "all").lower()
        if kind not in ("all", "customer", "supplier"):
            kind = "all"
        search = (p.get("search") or "").strip()

        try:
            page = max(int(p.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1
        try:
            limit = int(p.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        limit = min(max(limit, 5), 500)

        rows = []
        if kind in ("all", "customer"):
            rows.extend(self._customer_rows(search))
        if kind in ("all", "supplier"):
            rows.extend(self._supplier_rows(search))

        # Sort: largest activity first (purchase + sale + returns) so the
        # most relevant contacts surface at the top.
        def _activity(r):
            return (
                _D0(r["total_purchase"])         +
                _D0(r["total_sale"])             +
                _D0(r["total_purchase_return"])  +
                _D0(r["total_sell_return"])
            )
        rows.sort(key=_activity, reverse=True)

        # ── Footer totals across the full unfiltered set ───────────────────
        footer = {
            "total_purchase":        str(sum((_D0(r["total_purchase"])        for r in rows), _D("0"))),
            "total_purchase_return": str(sum((_D0(r["total_purchase_return"]) for r in rows), _D("0"))),
            "total_sale":            str(sum((_D0(r["total_sale"])            for r in rows), _D("0"))),
            "total_sell_return":     str(sum((_D0(r["total_sell_return"])     for r in rows), _D("0"))),
            "opening_balance_due":   str(sum((_D0(r["opening_balance_due"])   for r in rows), _D("0"))),
            "due":                   str(sum((_D0(r["due"])                   for r in rows), _D("0"))),
            "customer_count":        sum(1 for r in rows if r["type"] == "customer"),
            "supplier_count":        sum(1 for r in rows if r["type"] == "supplier"),
            "row_count":             len(rows),
            # Per-type due totals across the FULL set — the frontend's
            # Net receivable / Net payable KPIs used to sum only the
            # current page's rows, so the headline numbers changed as
            # the operator flipped pages.
            "customer_due": str(sum(
                (_D0(r["due"]) for r in rows if r["type"] == "customer"), _D("0")
            )),
            "supplier_due": str(sum(
                (_D0(r["due"]) for r in rows if r["type"] == "supplier"), _D("0")
            )),
        }

        # Pagination over the in-memory list.
        count       = len(rows)
        total_pages = max((count + limit - 1) // limit, 1)
        page        = min(page, total_pages)
        offset      = (page - 1) * limit
        page_rows   = rows[offset: offset + limit]

        return Response({
            "rows":         page_rows,
            "footer":       footer,
            "page":         page,
            "limit":        limit,
            "total_pages":  total_pages,
            "count":        count,
            "type_options": [
                {"value": "all",      "label": "All contacts"},
                {"value": "customer", "label": "Customers only"},
                {"value": "supplier", "label": "Suppliers only"},
            ],
        })

    # ── Per-type builders ───────────────────────────────────────────────────

    def _customer_rows(self, search: str):
        """Aggregate sales + sell-returns per customer; build ledger rows."""
        from sales.models import Customer, Sale, SellReturn  # noqa: PLC0415

        cust_qs = Customer.objects.filter(is_active=True)
        if search:
            cust_qs = cust_qs.filter(
                Q(name__icontains=search) |
                Q(phone__icontains=search) |
                Q(email__icontains=search)
            )

        # One-shot aggregates keyed by customer_id (branch-scoped).
        from accounts.branch_context import branch_scope  # noqa: PLC0415
        sale_agg = (
            branch_scope(Sale.objects.filter(status="FINAL", customer__isnull=False))
            .values("customer_id")
            .annotate(
                total      = Coalesce(Sum("total_amount"), ZERO),
                paid       = Coalesce(Sum("amount_paid"),  ZERO),
                cnt        = Count("id"),
            )
        )
        sale_map = {str(r["customer_id"]): r for r in sale_agg}

        ret_agg = (
            SellReturn.objects
            .filter(customer__isnull=False)
            .values("customer_id")
            .annotate(
                total = Coalesce(Sum("total_amount"), ZERO),
                paid  = Coalesce(Sum("amount_paid"),  ZERO),
            )
        )
        ret_map = {str(r["customer_id"]): r for r in ret_agg}

        rows = []
        for c in cust_qs:
            sid = str(c.id)
            s   = sale_map.get(sid, {})
            r   = ret_map.get(sid, {})
            sale_total   = _D0(s.get("total"))
            sale_paid    = _D0(s.get("paid"))
            ret_total    = _D0(r.get("total"))
            ret_paid     = _D0(r.get("paid"))
            sale_due     = sale_total - sale_paid          # customer owes us
            return_due   = ret_total - ret_paid            # we owe customer
            net_due      = sale_due - return_due           # +: customer owes us

            # Skip customers with zero activity (helps reduce noise).
            if sale_total == 0 and ret_total == 0 and net_due == 0:
                continue

            rows.append({
                "type":                  "customer",
                "contact_id":            sid,
                "name":                  c.name,
                "phone":                 c.phone or "",
                "email":                 c.email or "",
                "order_count":           int(s.get("cnt") or 0),
                "total_purchase":        "0",
                "total_purchase_return": "0",
                "total_sale":            str(sale_total),
                "total_sell_return":     str(ret_total),
                "opening_balance_due":   "0",
                "due":                   str(net_due),
            })
        return rows

    def _supplier_rows(self, search: str):
        """Aggregate purchases + purchase-returns per supplier; build ledger rows."""
        from purchases.models import Purchase, PurchaseReturn, Supplier  # noqa: PLC0415

        sup_qs = Supplier.objects.filter(is_active=True)
        if search:
            sup_qs = sup_qs.filter(
                Q(name__icontains=search) |
                Q(phone__icontains=search) |
                Q(email__icontains=search)
            )

        pur_agg = (
            branch_scope(Purchase.objects.exclude(status="cancelled"))
            .values("supplier_id")
            .annotate(
                total = Coalesce(Sum("grand_total"), ZERO),
                paid  = Coalesce(Sum("paid_amount"), ZERO),
            )
        )
        pur_map = {str(r["supplier_id"]): r for r in pur_agg}

        ret_agg = (
            PurchaseReturn.objects
            .exclude(status="cancelled")
            .values("supplier_id")
            .annotate(total=Coalesce(Sum("total_amount"), ZERO))
        )
        ret_map = {str(r["supplier_id"]): r for r in ret_agg}

        rows = []
        for s in sup_qs:
            sid       = str(s.id)
            p         = pur_map.get(sid, {})
            r         = ret_map.get(sid, {})
            pur_total = _D0(p.get("total"))
            pur_paid  = _D0(p.get("paid"))
            ret_total = _D0(r.get("total"))
            pur_due   = pur_total - pur_paid               # we owe supplier

            if pur_total == 0 and ret_total == 0 and pur_due == 0:
                continue

            rows.append({
                "type":                  "supplier",
                "contact_id":            sid,
                "name":                  s.name,
                "phone":                 s.phone or "",
                "email":                 s.email or "",
                "total_purchase":        str(pur_total),
                "total_purchase_return": str(ret_total),
                "total_sale":            "0",
                "total_sell_return":     "0",
                "opening_balance_due":   "0",
                "due":                   str(pur_due),
            })
        return rows
