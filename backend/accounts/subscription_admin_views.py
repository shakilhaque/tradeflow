"""
Subscription Management — Super-Admin API views.

All endpoints are platform-admin only (is_staff / is_superuser). They operate
on the master-DB Subscription + Plan + Payment rows and the new audit tables.

Endpoints (mounted under /api/accounts/admin/):
    GET  subscriptions/                 list + filters + search + sort + paging + KPIs
    GET  subscriptions/plans/           plans available for change/upgrade
    GET  subscriptions/<id>/            full detail + history + payments + timeline
    POST subscriptions/<id>/actions/    { action, ... } → mutating admin action
"""
import logging

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from django.utils import timezone

from .models import Plan, Subscription
from . import subscription_admin as svc

logger = logging.getLogger(__name__)


def _is_admin(user) -> bool:
    return bool(user and (user.is_staff or user.is_superuser))


class _AdminBase(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None


# ──────────────────────────────────────────────────────────────────────────────
# List + KPIs
# ──────────────────────────────────────────────────────────────────────────────

_SORT_FIELDS = {
    "tenant_name":    "user__name",
    "company_name":   "user__name",
    "plan":           "plan__name",
    "start_date":     "start_date",
    "expiry_date":    "next_billing_date",
    "days_remaining": "next_billing_date",
    "monthly_fee":    "plan__price",
    "status":         "status",
}


class AdminSubscriptionsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp

        qs = Subscription.objects.select_related("user", "plan", "user__tenant")

        # Search — tenant name / email / company / plan.
        if search := request.query_params.get("search", "").strip():
            from django.db.models import Q
            qs = qs.filter(
                Q(user__name__icontains=search)
                | Q(user__email__icontains=search)
                | Q(plan__name__icontains=search)
            )

        # Filter by the requested view (mirrors the UI filter chips).
        today = timezone.localdate()
        flt = (request.query_params.get("filter") or "all").lower()
        from datetime import timedelta
        if flt == "active":
            qs = qs.filter(status=Subscription.Status.ACTIVE, plan__is_trial=False,
                           next_billing_date__gt=today + timedelta(days=svc.EXPIRING_SOON_DAYS))
        elif flt == "expiring_soon":
            qs = qs.filter(status=Subscription.Status.ACTIVE,
                           next_billing_date__gte=today,
                           next_billing_date__lte=today + timedelta(days=svc.EXPIRING_SOON_DAYS))
        elif flt == "suspended":
            qs = qs.filter(status=Subscription.Status.SUSPENDED)
        elif flt == "trial":
            qs = qs.filter(status=Subscription.Status.ACTIVE, plan__is_trial=True)
        elif flt == "expired":
            qs = qs.filter(next_billing_date__lt=today).exclude(status=Subscription.Status.SUSPENDED)
        elif flt == "cancelled":
            qs = qs.filter(status=Subscription.Status.CANCELLED)
        elif flt == "monthly":
            qs = qs.filter(plan__billing_cycle=Plan.BillingCycle.MONTHLY)
        elif flt == "yearly":
            qs = qs.filter(plan__billing_cycle=Plan.BillingCycle.YEARLY)

        # Sort.
        sort_by  = (request.query_params.get("sort_by") or "expiry_date").lower()
        sort_dir = (request.query_params.get("sort_dir") or "asc").lower()
        field = _SORT_FIELDS.get(sort_by, "next_billing_date")
        qs = qs.order_by(f"-{field}" if sort_dir == "desc" else field, "-created_at")

        # Pagination.
        try:
            limit = min(max(int(request.query_params.get("limit", 25)), 1), 200)
        except (TypeError, ValueError):
            limit = 25
        try:
            page = max(int(request.query_params.get("page", 1)), 1)
        except (TypeError, ValueError):
            page = 1
        total = qs.count()
        total_pages = max((total + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        rows = [svc.serialize_row(s) for s in qs[offset:offset + limit]]

        return Response({
            "results":     rows,
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "kpis":        svc.kpis(),
        })


class AdminSubscriptionPlansView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        plans = Plan.objects.filter(is_active=True).order_by("sort_order", "price")
        return Response({"results": [svc.serialize_plan(p) for p in plans]})


class AdminSubscriptionDetailView(_AdminBase):
    def get(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            sub = (Subscription.objects
                   .select_related("user", "plan", "user__tenant")
                   .get(id=pk))
        except Subscription.DoesNotExist:
            return Response({"detail": "Subscription not found."}, status=http.HTTP_404_NOT_FOUND)
        return Response(svc.serialize_detail(sub))


class AdminSubscriptionActionView(_AdminBase):
    """POST { action: <name>, ... } — one endpoint dispatching every admin action."""

    def post(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            sub = Subscription.objects.select_related("user", "plan").get(id=pk)
        except Subscription.DoesNotExist:
            return Response({"detail": "Subscription not found."}, status=http.HTTP_404_NOT_FOUND)

        data   = request.data or {}
        action = (data.get("action") or "").strip().lower()
        reason = (data.get("reason") or "").strip()
        actor  = request.user

        try:
            if action in ("change_plan", "upgrade", "downgrade"):
                svc.change_plan(sub, new_plan_id=data.get("plan_id"), actor=actor, reason=reason)
            elif action == "extend":
                svc.extend_subscription(sub, days=data.get("days"), actor=actor, reason=reason, bonus=False)
            elif action in ("bonus_days", "add_bonus_days"):
                svc.extend_subscription(sub, days=data.get("days"), actor=actor, reason=reason, bonus=True)
            elif action in ("change_billing_date", "change_date"):
                from datetime import date
                raw = (data.get("billing_date") or data.get("date") or "").strip()
                try:
                    new_date = date.fromisoformat(raw)
                except ValueError:
                    return Response({"detail": "billing_date must be YYYY-MM-DD."}, status=http.HTTP_400_BAD_REQUEST)
                svc.change_billing_date(sub, new_date=new_date, actor=actor, reason=reason)
            elif action == "suspend":
                svc.suspend_subscription(sub, actor=actor, reason=reason)
            elif action == "reactivate":
                svc.reactivate_subscription(sub, actor=actor, reason=reason)
            elif action in ("send_reminder", "reminder"):
                svc.send_reminder(sub, actor=actor, reason=reason)
                return Response({"detail": "Reminder sent."})
            else:
                return Response({"detail": f"Unknown action '{action}'."}, status=http.HTTP_400_BAD_REQUEST)
        except svc.SubscriptionAdminError as exc:
            return Response({"detail": str(exc)}, status=http.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Subscription admin action failed: %s", exc)
            return Response({"detail": "Action failed. Please try again."}, status=http.HTTP_500_INTERNAL_SERVER_ERROR)

        sub.refresh_from_db()
        return Response(svc.serialize_detail(
            Subscription.objects.select_related("user", "plan", "user__tenant").get(id=sub.id)
        ))
