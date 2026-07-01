"""
Tenant Management — Super-Admin API views.

Platform-admin only (is_staff / is_superuser). Tenant-centric endpoints:

    GET  admin/tenants/                      list + search + filter + sort + paging + KPIs
    GET  admin/tenants/<user_id>/            full tenant detail bundle
    POST admin/tenants/<user_id>/actions/    { action, ... } → mutating admin action

Actions: change_plan | extend | bonus_days | suspend | reactivate | edit |
         reset_password | impersonate
"""
import logging

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from .models import Plan, User
from . import tenant_admin as svc

logger = logging.getLogger(__name__)


def _is_admin(user) -> bool:
    return bool(user and (user.is_staff or user.is_superuser))


class _AdminBase(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None


_SORT_KEYS = {
    "company_name":      lambda r: (r.get("company_name") or "").lower(),
    "owner_name":        lambda r: (r.get("owner_name") or "").lower(),
    "email":             lambda r: (r.get("email") or "").lower(),
    "plan_name":         lambda r: (r.get("plan_name") or "").lower(),
    "subscription_status": lambda r: (r.get("subscription_status") or ""),
    "account_status":    lambda r: (r.get("account_status") or ""),
    "registration_date": lambda r: (r.get("registration_date") or ""),
    "expiry_date":       lambda r: (r.get("expiry_date") or ""),
}


class AdminTenantsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp

        p = request.query_params
        search = (p.get("search") or "").strip().lower()
        flt    = (p.get("filter") or "all").lower()
        plan_q = (p.get("plan") or "").strip().lower()

        # Build rows in memory (status is derived in Python). Admin scale.
        rows = []
        for user in svc.tenant_owners_qs():
            row = svc.serialize_row(user)   # no branch query yet
            if search and not (
                search in (row["company_name"] or "").lower()
                or search in (row["owner_name"] or "").lower()
                or search in (row["email"] or "").lower()
                or search in (row["mobile"] or "").lower()
                or search in (row["plan_name"] or "").lower()
            ):
                continue
            if flt in ("active", "suspended", "trial", "expired", "cancelled") \
                    and row["subscription_status"] != flt:
                continue
            if plan_q and plan_q not in (row["plan_name"] or "").lower():
                continue
            rows.append(row)

        # Sort.
        sort_by  = (p.get("sort_by") or "registration_date").lower()
        sort_dir = (p.get("sort_dir") or "desc").lower()
        keyfn = _SORT_KEYS.get(sort_by, _SORT_KEYS["registration_date"])
        rows.sort(key=keyfn, reverse=(sort_dir == "desc"))

        # Paginate.
        try:
            limit = min(max(int(p.get("limit", 25)), 1), 200)
        except (TypeError, ValueError):
            limit = 25
        try:
            page = max(int(p.get("page", 1)), 1)
        except (TypeError, ValueError):
            page = 1
        total = len(rows)
        total_pages = max((total + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        page_rows = rows[offset:offset + limit]

        # Branch count only for the page slice (bounded tenant-DB fan-out).
        id_to_user = {str(u.id): u for u in svc.tenant_owners_qs()}
        for r in page_rows:
            u = id_to_user.get(r["id"])
            if u is not None:
                r["branch_count"] = svc._branch_count(u)

        return Response({
            "results":     page_rows,
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "kpis":        svc.kpis(),
        })


class AdminTenantPlansView(_AdminBase):
    """Plans available for change/upgrade — also powers the filter chips."""
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        plans = Plan.objects.filter(is_active=True).order_by("sort_order", "price")
        return Response({"results": [
            {"id": str(pl.id), "name": pl.name, "billing_cycle": pl.billing_cycle,
             "price": str(pl.price), "is_trial": pl.is_trial}
            for pl in plans
        ]})


def _get_tenant(user_id):
    return User.objects.select_related("tenant").prefetch_related("subscriptions__plan").get(id=user_id)


class AdminTenantDetailView(_AdminBase):
    def get(self, request, user_id):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            user = _get_tenant(user_id)
        except User.DoesNotExist:
            return Response({"detail": "Tenant not found."}, status=http.HTTP_404_NOT_FOUND)
        return Response(svc.serialize_detail(user))


class AdminTenantActionView(_AdminBase):
    def post(self, request, user_id):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            user = _get_tenant(user_id)
        except User.DoesNotExist:
            return Response({"detail": "Tenant not found."}, status=http.HTTP_404_NOT_FOUND)

        data   = request.data or {}
        action = (data.get("action") or "").strip().lower()
        reason = (data.get("reason") or "").strip()
        actor  = request.user

        try:
            if action in ("change_plan", "upgrade", "downgrade"):
                svc.change_plan(user, plan_id=data.get("plan_id"), actor=actor, reason=reason)
            elif action == "extend":
                svc.extend_subscription(user, days=data.get("days"), actor=actor, reason=reason, bonus=False)
            elif action in ("bonus_days", "add_bonus_days"):
                svc.extend_subscription(user, days=data.get("days"), actor=actor, reason=reason, bonus=True)
            elif action == "suspend":
                svc.suspend_tenant(user, actor=actor, reason=reason)
            elif action == "reactivate":
                svc.reactivate_tenant(user, actor=actor, reason=reason)
            elif action in ("edit", "update"):
                svc.update_tenant(user, data=data, actor=actor)
            elif action in ("reset_password", "reset"):
                svc.reset_password(user, actor=actor)
                _ph = "".join(c for c in (user.phone or "") if c.isdigit())
                _mask = f"{_ph[:2]}{'•' * max(0, len(_ph) - 5)}{_ph[-3:]}" if len(_ph) >= 4 else "your mobile"
                return Response({"detail": f"Password reset link sent by SMS to {_mask}."})
            elif action in ("impersonate", "login_as"):
                tokens = svc.impersonate(user)
                return Response({"detail": "Impersonation token issued.", "impersonation": tokens})
            else:
                return Response({"detail": f"Unknown action '{action}'."}, status=http.HTTP_400_BAD_REQUEST)
        except svc.TenantAdminError as exc:
            return Response({"detail": str(exc)}, status=http.HTTP_400_BAD_REQUEST)
        except svc.sub_svc.SubscriptionAdminError as exc:
            return Response({"detail": str(exc)}, status=http.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Tenant admin action failed: %s", exc)
            return Response({"detail": "Action failed. Please try again."}, status=http.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(svc.serialize_detail(_get_tenant(user_id)))
