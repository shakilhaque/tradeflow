"""
Reports API views.

Access control (role-based)
───────────────────────────
  OWNER / ADMIN   → all reports
  MANAGER         → sales, stock, expense, tax, product reports
  CASHIER         → own sales only (filtered by finalized_by_id = request.user.id)

Endpoints
─────────
  GET /api/reports/sales/      Sales summary with breakdown
  GET /api/reports/stock/      Current stock levels + valuation
  GET /api/reports/expenses/   Expense breakdown by category
  GET /api/reports/tax/        Tax collected / payable
  GET /api/reports/products/   Product performance

All require authentication.  Financial reports (profit/loss is in accounting
app) additionally require CAN_VIEW_PROFIT_LOSS.  General reports require
CAN_VIEW_REPORTS.
"""
import logging
from datetime import date

from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Perm, has_permission, require_permission
from . import services

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ──────────────────────────────────────────────────────────────────────────────

def _parse_date(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"'{name}' must be YYYY-MM-DD.")


def _require_dates(params, *names) -> tuple:
    """Parse and return required date params; raise ValueError if missing."""
    results = []
    for name in names:
        val = params.get(name, "").strip()
        if not val:
            raise ValueError(f"'{name}' is required.")
        results.append(_parse_date(val, name))
    return tuple(results)


# ──────────────────────────────────────────────────────────────────────────────
# 1. Sales Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Reports"])
class SalesReportView(APIView):
    """
    GET /api/reports/sales/

    Required params: date_from, date_to (YYYY-MM-DD)
    Optional params: location_id, user_id, product_id, group_by (day|month|product|user)

    CASHIER restriction: user_id is forced to request.user.id
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Sales report",
        description=(
            "Returns sales summary with breakdown by the chosen `group_by` dimension.\n\n"
            "Includes total revenue, quantity sold, and discount figures. "
            "Cashiers can only see their own sales (`user_id` is forced to the caller's ID). "
            "Requires `can_view_reports`."
        ),
        parameters=[
            OpenApiParameter("date_from",   OpenApiTypes.DATE, required=True,  description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, required=True,  description="End date (YYYY-MM-DD)"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, required=False, description="Filter by location UUID"),
            OpenApiParameter("user_id",     OpenApiTypes.UUID, required=False, description="Filter by staff UUID (cashiers always see only their own)"),
            OpenApiParameter("product_id",  OpenApiTypes.UUID, required=False, description="Filter by product UUID"),
            OpenApiParameter("group_by",    OpenApiTypes.STR,  required=False, description="Grouping: day | week | month | product | user (default: day)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        # Full report access (any staff, all sellers) needs CAN_VIEW_REPORTS.
        # A user WITHOUT it may still read THEIR OWN sales only — this powers
        # the dashboard "Top Sellers" card for sub-users, where each staff
        # member sees just their own row. They are hard-locked to their own
        # user_id and can never read another person's data.
        can_view = has_permission(request.user, Perm.CAN_VIEW_REPORTS)
        requested_uid = request.query_params.get("user_id")
        if not can_view and requested_uid and str(requested_uid) != str(request.user.id):
            return Response(
                {"detail": "You can only view your own sales."},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            date_from, date_to = _require_dates(
                request.query_params, "date_from", "date_to"
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        params     = request.query_params
        group_by   = params.get("group_by", "day")
        if group_by not in ("day", "week", "month", "product", "user", "service_staff"):
            group_by = "day"

        # Lock the result to the caller's own sales when they either lack the
        # reports permission OR are a cashier (cashiers always see only their
        # own, even if granted the permission).
        user_id = requested_uid
        if not can_view or request.user.role == "cashier":
            user_id = str(request.user.id)

        try:
            result = services.get_sales_report(
                date_from   = date_from,
                date_to     = date_to,
                location_id = params.get("location_id"),
                user_id     = user_id,
                product_id  = params.get("product_id"),
                group_by    = group_by,
            )
        except Exception as exc:
            logger.exception("Sales report error")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(result)


# ──────────────────────────────────────────────────────────────────────────────
# 2. Stock Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Reports"])
class StockReportView(APIView):
    """
    GET /api/reports/stock/

    Optional params: location_id, category_id, low_stock_only (true/false)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Stock report",
        description=(
            "Returns current stock levels and valuation for all products. "
            "Filter by location or category, or pass `low_stock_only=true` to show only items "
            "at or below their reorder level. Requires `can_view_reports`."
        ),
        parameters=[
            OpenApiParameter("location_id",    OpenApiTypes.UUID, required=False, description="Filter by location UUID"),
            OpenApiParameter("category_id",    OpenApiTypes.UUID, required=False, description="Filter by category UUID"),
            OpenApiParameter("low_stock_only", OpenApiTypes.BOOL, required=False, description='Pass "true" to show only low-stock items'),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_REPORTS)
    def get(self, request):
        params = request.query_params

        try:
            result = services.get_stock_report(
                location_id    = params.get("location_id"),
                category_id    = params.get("category_id"),
                subcategory_id = params.get("subcategory_id"),
                brand_id       = params.get("brand_id"),
                unit_id        = params.get("unit_id"),
                product_id     = params.get("product_id"),
                low_stock_only = params.get("low_stock_only", "false").lower() == "true",
            )
        except Exception as exc:
            logger.exception("Stock report error")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(result)


# ──────────────────────────────────────────────────────────────────────────────
# 3. Expense Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Reports"])
class ExpenseReportView(APIView):
    """
    GET /api/reports/expenses/

    Required: date_from, date_to
    Optional: category, user_id
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Expense report",
        description=(
            "Returns expense totals broken down by category for the given date range. "
            "Optionally filter by expense category name or the staff member who recorded the expense. "
            "Requires `can_view_reports`."
        ),
        parameters=[
            OpenApiParameter("date_from",   OpenApiTypes.DATE, required=True,  description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, required=True,  description="End date (YYYY-MM-DD)"),
            OpenApiParameter("category",    OpenApiTypes.STR,  required=False, description="Expense category code filter"),
            OpenApiParameter("user_id",     OpenApiTypes.UUID, required=False, description="Filter by staff UUID"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, required=False, description="Filter by location UUID"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_REPORTS)
    def get(self, request):
        try:
            date_from, date_to = _require_dates(
                request.query_params, "date_from", "date_to"
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        params = request.query_params
        try:
            result = services.get_expense_report(
                date_from   = date_from,
                date_to     = date_to,
                category    = params.get("category"),
                user_id     = params.get("user_id"),
                location_id = params.get("location_id"),
            )
        except Exception as exc:
            logger.exception("Expense report error")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(result)


# ──────────────────────────────────────────────────────────────────────────────
# 4. Tax Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Reports"])
class TaxReportView(APIView):
    """
    GET /api/reports/tax/

    Required: date_from, date_to
    Restricted: CAN_VIEW_PROFIT_LOSS (financial data)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Tax report",
        description=(
            "Returns tax collected and payable totals for the period, broken down by tax group. "
            "This is financial data — requires `can_view_profit_loss` (OWNER / ADMIN / MANAGER)."
        ),
        parameters=[
            OpenApiParameter("date_from", OpenApiTypes.DATE, required=True, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, required=True, description="End date (YYYY-MM-DD)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
    def get(self, request):
        try:
            date_from, date_to = _require_dates(
                request.query_params, "date_from", "date_to"
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            result = services.get_tax_report(
                date_from   = date_from,
                date_to     = date_to,
                location_id = request.query_params.get("location_id"),
            )
        except Exception as exc:
            logger.exception("Tax report error")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(result)


# ──────────────────────────────────────────────────────────────────────────────
# 5. Product Performance Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Reports"])
class ProductReportView(APIView):
    """
    GET /api/reports/products/

    Required: date_from, date_to
    Optional: location_id, category_id, limit (default 20)
    Requires: CAN_VIEW_PURCHASE_PRICE (shows COGS)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Product performance report",
        description=(
            "Returns top products ranked by revenue for the given date range. "
            "Users with `can_view_purchase_price` also see COGS, gross profit, and margin %. "
            "Cashiers and other restricted roles see revenue and quantity only. "
            "Requires `can_view_reports`."
        ),
        parameters=[
            OpenApiParameter("date_from",   OpenApiTypes.DATE, required=True,  description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",     OpenApiTypes.DATE, required=True,  description="End date (YYYY-MM-DD)"),
            OpenApiParameter("location_id", OpenApiTypes.UUID, required=False, description="Filter by location UUID"),
            OpenApiParameter("category_id", OpenApiTypes.UUID, required=False, description="Filter by category UUID"),
            OpenApiParameter("limit",       OpenApiTypes.INT,  required=False, description="Max products to return (default 20, max 100)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_VIEW_REPORTS)
    def get(self, request):
        try:
            date_from, date_to = _require_dates(
                request.query_params, "date_from", "date_to"
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        params = request.query_params
        # Hide COGS / margin for cashiers
        show_cost = has_permission(request.user, Perm.CAN_VIEW_PURCHASE_PRICE)

        try:
            limit = min(int(params.get("limit", 20)), 100)
        except (ValueError, TypeError):
            limit = 20

        try:
            result = services.get_product_report(
                date_from   = date_from,
                date_to     = date_to,
                location_id = params.get("location_id"),
                category_id = params.get("category_id"),
                limit       = limit,
            )
        except Exception as exc:
            logger.exception("Product report error")
            return Response(
                {"detail": f"Report generation failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        # Strip cost/margin fields from non-privileged users
        if not show_cost:
            for product in result.get("products", []):
                product.pop("cogs", None)
                product.pop("gross_profit", None)
                product.pop("margin_pct", None)

        return Response(result)
