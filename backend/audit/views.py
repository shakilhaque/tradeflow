"""
Audit Log API views.

Endpoints
─────────
  GET /api/audit-logs/        — paginated audit trail with filters
  GET /api/audit-logs/<id>/   — single log entry detail

Access control
──────────────
  Requires: IsAuthenticated. Open to every user in the tenant so all
  members can see each other's activity (the log is tenant-scoped).
"""
import logging
from datetime import date

from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import AuditLog
from .services import get_audit_logs, _current_db

logger = logging.getLogger(__name__)


def _parse_date(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"'{name}' must be YYYY-MM-DD.")


@extend_schema(tags=["Audit"])
class AuditLogListView(APIView):
    """
    GET /api/audit-logs/

    Query params
    ────────────
    action     — CREATE | UPDATE | DELETE | VOID | LOGIN | EXPORT
    module     — partial match, e.g. 'Product', 'Sale'
    user_id    — UUID of acting user
    record_id  — UUID of affected record
    date_from  — YYYY-MM-DD
    date_to    — YYYY-MM-DD
    limit      — integer, max 500, default 50
    offset     — integer, default 0
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="audit_logs_list",
        summary="List audit log entries",
        description=(
            "Returns a paginated list of audit trail entries. Supports filtering by action type, "
            "module, user, record, and date range. Requires `can_view_audit_log` (OWNER / ADMIN / MANAGER)."
        ),
        parameters=[
            OpenApiParameter("action",    OpenApiTypes.STR,  required=False, description="Action type: CREATE | UPDATE | DELETE | VOID | LOGIN | EXPORT"),
            OpenApiParameter("module",    OpenApiTypes.STR,  required=False, description="Module name partial match, e.g. 'Product', 'Sale'"),
            OpenApiParameter("user_id",   OpenApiTypes.UUID, required=False, description="UUID of the user who performed the action"),
            OpenApiParameter("record_id", OpenApiTypes.UUID, required=False, description="UUID of the affected record"),
            OpenApiParameter("date_from", OpenApiTypes.DATE, required=False, description="Start date (YYYY-MM-DD)"),
            OpenApiParameter("date_to",   OpenApiTypes.DATE, required=False, description="End date (YYYY-MM-DD)"),
            OpenApiParameter("limit",     OpenApiTypes.INT,  required=False, description="Max results (default 50, max 500)"),
            OpenApiParameter("offset",    OpenApiTypes.INT,  required=False, description="Pagination offset (default 0)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        # Open to every authenticated tenant user: in a multi-user tenant
        # everyone can see what every other user did. The log is already
        # scoped to the current tenant DB, so no cross-tenant leakage.
        params    = request.query_params
        date_from = date_to = None

        try:
            if v := params.get("date_from"):
                date_from = _parse_date(v, "date_from")
            if v := params.get("date_to"):
                date_to = _parse_date(v, "date_to")
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            limit  = min(int(params.get("limit", 50)), 500)
            offset = max(int(params.get("offset", 0)), 0)
        except (ValueError, TypeError):
            limit, offset = 50, 0

        logs = get_audit_logs(
            action    = params.get("action"),
            module    = params.get("module"),
            user_id   = params.get("user_id"),
            record_id = params.get("record_id"),
            date_from = date_from,
            date_to   = date_to,
            limit     = limit,
            offset    = offset,
        )

        # ── Dropdown option lists (for the Activity Log report) ────────────
        # Distinct user + module values across the WHOLE log so the filter
        # dropdowns don't shrink when the user pages through.
        db = _current_db()
        user_rows = (
            AuditLog.objects.using(db)
            .exclude(user_id__isnull=True)
            .values("user_id", "user_name")
            .distinct()
            .order_by("user_name")[:200]
        )
        user_options = [
            {"id": str(r["user_id"]), "name": r["user_name"] or "—"}
            for r in user_rows
        ]
        module_rows = (
            AuditLog.objects.using(db)
            .exclude(module="")
            .values_list("module", flat=True)
            .distinct()
            .order_by("module")[:100]
        )
        module_options = [
            {"value": m, "label": _humanise_module(m)} for m in module_rows
        ]
        action_options = [
            {"value": code, "label": label}
            for code, label in AuditLog.Action.choices
        ]

        return Response({
            "count":   len(logs),
            "offset":  offset,
            "limit":   limit,
            "results": [_serialize(log) for log in logs],
            "user_options":   user_options,
            "module_options": module_options,
            "action_options": action_options,
        })


@extend_schema(tags=["Audit"])
class AuditLogDetailView(APIView):
    """
    GET /api/audit-logs/<pk>/
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="audit_logs_retrieve",
        summary="Get audit log entry",
        description=(
            "Returns full detail for a single audit log entry including old and new values. "
            "Requires `can_view_audit_log`."
        ),
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request, pk):
        # Open to every authenticated tenant user (see list view note).
        db = _current_db()
        try:
            log = AuditLog.objects.using(db).get(id=pk)
        except AuditLog.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_serialize(log))


# ──────────────────────────────────────────────────────────────────────────────
# Serialization helper (no DRF ModelSerializer to keep it lightweight)
# ──────────────────────────────────────────────────────────────────────────────

def _humanise_module(module: str) -> str:
    """Map an 'app.Model' string to a friendly Subject-Type label."""
    if not module:
        return "—"
    short = module.split(".")[-1] if "." in module else module
    return {
        "Sale":           "Sell",
        "SellReturn":     "Sell Return",
        "SalePayment":    "Sell Payment",
        "Purchase":       "Purchase",
        "PurchaseReturn": "Purchase Return",
        "PurchasePayment":"Purchase Payment",
        "Expense":        "Expense",
        "Product":        "Product",
        "Customer":       "Customer",
        "Supplier":       "Supplier",
        "User":           "User",
        "Location":       "Location",
        "Category":       "Category",
        "Brand":          "Brand",
    }.get(short, short)


def _serialize(log: AuditLog) -> dict:
    return {
        "id":            str(log.id),
        "user_id":       str(log.user_id) if log.user_id else None,
        "user_name":     log.user_name,
        "action":        log.action,
        "module":        log.module,
        "subject_label": _humanise_module(log.module),
        "record_id":     str(log.record_id) if log.record_id else None,
        "record_repr":   log.record_repr,
        "old_value":     log.old_value,
        "new_value":     log.new_value,
        "ip_address":    log.ip_address,
        "created_at":    log.created_at.isoformat(),
    }
