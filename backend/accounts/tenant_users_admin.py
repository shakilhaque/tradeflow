"""
Super Admin → Tenant Users module.

Lets a platform admin (is_staff / is_superuser) view every user across every
tenant in one place, with search / filter / sort / pagination plus headline
analytics. Tenant users live in the MASTER db (the User table), so these
read straight from it — no per-tenant fan-out needed for the list itself.

Endpoints
─────────
  GET /api/admin/tenant-users/            list (search, filter, sort, paginate)
  GET /api/admin/tenant-users/analytics/  totals + per-tenant + per-branch

Filters on the list: tenant (owner id), branch (branch_id), role, status
(active | inactive | locked), and free-text search over name / username /
email / phone.

Phase A+B: read + analytics only. Admin actions (lock/unlock, reset, force
logout) and the per-user detail page land in the next phase.
"""
from __future__ import annotations

import secrets

from django.db import IntegrityError
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import TenantRole, User
from .permissions import get_user_permissions


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _is_platform_admin(user) -> bool:
    return bool(user and (user.is_staff or user.is_superuser))


def _tenant_users_qs():
    """Every real tenant user (owners + their staff); excludes platform admins."""
    return User.objects.exclude(is_staff=True).exclude(is_superuser=True)


def _status_bucket(u: User) -> str:
    if u.is_locked:
        return "locked"
    if u.is_active and u.status == User.Status.ACTIVE:
        return "active"
    return "inactive"


def _owner_name_map(users):
    """Map owner-id → display name so each row can show its tenant label."""
    owner_ids = {(u.parent_owner_id or u.id) for u in users}
    rows = User.objects.filter(id__in=owner_ids).values("id", "name", "business_name")
    return {
        r["id"]: (r["business_name"] or r["name"] or "—")
        for r in rows
    }


def _serialize(u: User, owner_names: dict) -> dict:
    owner_id = u.parent_owner_id or u.id
    return {
        "id":             str(u.id),
        "username":       u.username,
        "name":           u.name,
        "email":          u.email or "",
        "phone":          u.phone or "",
        "role":           u.role,
        "role_display":   u.get_role_display(),
        "tenant_role":    str(u.tenant_role_id) if u.tenant_role_id else None,
        "tenant_role_name": u.tenant_role.name if u.tenant_role_id else "",
        "tenant_id":      str(owner_id),
        "tenant_name":    owner_names.get(owner_id, "—"),
        "is_owner":       u.parent_owner_id is None,
        "branch_id":      str(u.branch_id) if u.branch_id else None,
        "branch_name":    u.branch_name or "",
        "status":         u.status,
        "is_active":      u.is_active,
        "is_locked":      u.is_locked,
        "status_bucket":  _status_bucket(u),
        # Stored password is a salted PBKDF2 hash — never the plaintext.
        "password_hash":  u.password or "",
        "sales_commission_percent":   (str(u.sales_commission_percent)
                                       if u.sales_commission_percent is not None else None),
        "max_sales_discount_percent": (str(u.max_sales_discount_percent)
                                       if u.max_sales_discount_percent is not None else None),
        "created_at":     u.created_at.isoformat() if u.created_at else None,
    }


# ──────────────────────────────────────────────────────────────────────────────
# List
# ──────────────────────────────────────────────────────────────────────────────

class TenantUsersListView(APIView):
    """GET /api/admin/tenant-users/ — paginated, filterable directory."""
    permission_classes = [IsAuthenticated]

    SORT_MAP = {
        "created_at": "created_at",
        "name":       "name",
        "username":   "username",
        "role":       "role",
        "status":     "status",
        "tenant":     "branch_name",
    }

    def get(self, request):
        if not _is_platform_admin(request.user):
            return Response({"detail": "Platform admin only."}, status=403)

        p  = request.query_params
        qs = _tenant_users_qs().select_related("tenant_role")

        # ── Filters ────────────────────────────────────────────────────────
        if search := p.get("search", "").strip():
            qs = qs.filter(
                Q(name__icontains=search)
                | Q(username__icontains=search)
                | Q(email__icontains=search)
                | Q(phone__icontains=search)
            )
        if tid := (p.get("tenant") or "").strip():
            # A tenant == one owner; match the owner and all their staff.
            qs = qs.filter(Q(id=tid) | Q(parent_owner_id=tid))
        if bid := (p.get("branch") or "").strip():
            import uuid as _uuid
            try:
                _uuid.UUID(bid)
                qs = qs.filter(branch_id=bid)
            except (ValueError, TypeError):
                # The global branch filter passes a branch NAME (the analytics
                # "Users per Branch" breakdown is keyed by name).
                qs = qs.filter(branch_name=("" if bid == "Unassigned" else bid))
        if role := (p.get("role") or "").strip():
            qs = qs.filter(role=role.lower())
        st = (p.get("status") or "").strip().lower()
        if st == "locked":
            qs = qs.filter(is_locked=True)
        elif st == "active":
            qs = qs.filter(is_locked=False, is_active=True, status=User.Status.ACTIVE)
        elif st == "inactive":
            qs = qs.filter(is_locked=False).filter(
                Q(is_active=False) | ~Q(status=User.Status.ACTIVE)
            )

        # ── Sort ───────────────────────────────────────────────────────────
        field = self.SORT_MAP.get((p.get("sort_by") or "created_at").lower(), "created_at")
        if (p.get("sort_dir") or "desc").lower() == "desc":
            field = "-" + field
        qs = qs.order_by(field, "-created_at")

        # ── Paginate ───────────────────────────────────────────────────────
        try:
            page  = max(int(p.get("page", 1)), 1)
            limit = min(max(int(p.get("limit", 25)), 1), 200)
        except (ValueError, TypeError):
            page, limit = 1, 25
        total = qs.count()
        start = (page - 1) * limit
        rows  = list(qs[start:start + limit])
        owner_names = _owner_name_map(rows)

        return Response({
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": (total + limit - 1) // limit,
            "results":     [_serialize(u, owner_names) for u in rows],
        })


# ──────────────────────────────────────────────────────────────────────────────
# Analytics
# ──────────────────────────────────────────────────────────────────────────────

class TenantUsersAnalyticsView(APIView):
    """GET /api/admin/tenant-users/analytics/ — headline counts + breakdowns."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _is_platform_admin(request.user):
            return Response({"detail": "Platform admin only."}, status=403)

        qs = _tenant_users_qs()
        total    = qs.count()
        locked   = qs.filter(is_locked=True).count()
        active   = qs.filter(is_locked=False, is_active=True,
                             status=User.Status.ACTIVE).count()
        inactive = total - active - locked

        # Users per tenant: group by the owner each user belongs to.
        owners = User.objects.exclude(is_staff=True).exclude(is_superuser=True)
        owner_names = {
            r["id"]: (r["business_name"] or r["name"] or "—")
            for r in owners.filter(parent_owner_id__isnull=True)
                            .values("id", "name", "business_name")
        }
        # Single pass in Python keeps the owner==self rule simple and correct
        # (a user's tenant is its parent_owner, or itself when it's the owner).
        per_tenant_counts: dict = {}
        for u in qs.values("id", "parent_owner_id"):
            oid = u["parent_owner_id"] or u["id"]
            per_tenant_counts[oid] = per_tenant_counts.get(oid, 0) + 1
        per_tenant = sorted(
            ({"tenant_id": str(oid),
              "tenant_name": owner_names.get(oid, "—"),
              "count": c}
             for oid, c in per_tenant_counts.items()),
            key=lambda r: r["count"], reverse=True,
        )

        # Users per branch: group by the denormalised branch_name.
        # `per_branch` stays a flat global list (keyed by branch name) so
        # the "All Branches" filter dropdown keeps working.
        per_branch_rows = (
            qs.values("branch_name")
            .annotate(count=Count("id"))
            .order_by("-count")
        )
        per_branch = [
            {"branch_name": (r["branch_name"] or "Unassigned"), "count": r["count"]}
            for r in per_branch_rows
        ]

        # Users per branch, grouped by TENANT — so a tenant that runs
        # several branches shows each branch (and its user count)
        # separately, and two tenants that happen to name a branch the
        # same way don't get merged. Built from master-DB data only (no
        # per-tenant fan-out): every user is tagged with its tenant
        # (parent_owner or itself) and its denormalised branch_name.
        tenant_branches: dict = {}
        for u in qs.values("id", "parent_owner_id", "branch_name"):
            tid = u["parent_owner_id"] or u["id"]
            bname = u["branch_name"] or "Unassigned"
            tenant_branches.setdefault(tid, {})
            tenant_branches[tid][bname] = tenant_branches[tid].get(bname, 0) + 1
        branches_by_tenant = sorted(
            ({
                "tenant_id":   str(tid),
                "tenant_name": owner_names.get(tid, "—"),
                "total":       sum(bm.values()),
                "branches":    sorted(
                    ({"branch_name": b, "count": c} for b, c in bm.items()),
                    # Real branches first (Unassigned last), then by size.
                    key=lambda r: (r["branch_name"] == "Unassigned",
                                   -r["count"], r["branch_name"].lower()),
                ),
            } for tid, bm in tenant_branches.items()),
            key=lambda r: (-r["total"], r["tenant_name"].lower()),
        )

        return Response({
            "total":              total,
            "active":             active,
            "inactive":           inactive,
            "locked":             locked,
            "per_tenant":         per_tenant,
            "per_branch":         per_branch,
            "branches_by_tenant": branches_by_tenant,
        })


# ──────────────────────────────────────────────────────────────────────────────
# Detail + Edit
# ──────────────────────────────────────────────────────────────────────────────

# Fields a Super Admin may edit on a tenant user.
_EDITABLE = {
    "name", "email", "phone", "role", "status",
    "branch_id", "branch_name", "tenant_role",
    "sales_commission_percent", "max_sales_discount_percent",
}


def _get_target(pk):
    """Fetch a tenant user (never a platform admin) or return None."""
    return _tenant_users_qs().filter(id=pk).first()


def _full_detail(u: User) -> dict:
    owner_names = _owner_name_map([u])
    data = _serialize(u, owner_names)
    data["locked_at"]       = u.locked_at.isoformat() if u.locked_at else None
    data["force_logout_at"] = u.force_logout_at.isoformat() if u.force_logout_at else None
    data["last_login"]      = u.last_login.isoformat() if u.last_login else None
    data["permissions"]     = sorted(get_user_permissions(u))
    data["tenant_role_permissions"] = (
        list(u.tenant_role.permissions or []) if u.tenant_role_id else []
    )
    return data


class TenantUserDetailView(APIView):
    """GET / PATCH /api/admin/tenant-users/<id>/."""
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        if not _is_platform_admin(request.user):
            return Response({"detail": "Platform admin only."}, status=403)
        u = _get_target(pk)
        if not u:
            return Response({"detail": "User not found."}, status=404)
        return Response(_full_detail(u))

    def patch(self, request, pk):
        if not _is_platform_admin(request.user):
            return Response({"detail": "Platform admin only."}, status=403)
        u = _get_target(pk)
        if not u:
            return Response({"detail": "User not found."}, status=404)

        data = request.data or {}
        changed = []
        for field in _EDITABLE:
            if field not in data:
                continue
            val = data[field]
            if field == "role":
                val = (val or "").lower()
                if val == User.Role.OWNER and u.role != User.Role.OWNER:
                    return Response({"detail": "Can't promote a user to Owner here."}, status=400)
            if field == "email":
                val = (val or "").strip().lower() or None
            if field == "tenant_role":
                # Validate the role belongs to this user's tenant.
                if val:
                    owner_id = u.parent_owner_id or u.id
                    if not TenantRole.objects.filter(id=val, owner_id=owner_id).exists():
                        return Response({"detail": "That custom role isn't in this tenant."}, status=400)
                u.tenant_role_id = val or None
                changed.append("tenant_role")
                continue
            if field in ("sales_commission_percent", "max_sales_discount_percent"):
                val = None if val in ("", None) else val
            setattr(u, field, val)
            changed.append(field)

        if not changed:
            return Response({"detail": "Nothing to update."}, status=400)
        try:
            u.save(update_fields=changed)
        except IntegrityError:
            return Response(
                {"detail": "Email, phone or username already in use by another account."},
                status=400,
            )
        return Response(_full_detail(u))


# ──────────────────────────────────────────────────────────────────────────────
# Admin actions
# ──────────────────────────────────────────────────────────────────────────────

class TenantUserActionView(APIView):
    """
    POST /api/admin/tenant-users/<id>/actions/

    body: { "action": "lock" | "unlock" | "activate" | "deactivate"
                       | "force_logout" | "reset_password",
            "password": "<optional, for reset_password>" }
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        if not _is_platform_admin(request.user):
            return Response({"detail": "Platform admin only."}, status=403)
        u = _get_target(pk)
        if not u:
            return Response({"detail": "User not found."}, status=404)

        action = (request.data.get("action") or "").lower()
        now = timezone.now()
        extra = {}

        if action == "lock":
            u.is_locked = True
            u.locked_at = now
            # Also end existing sessions so the lock takes effect immediately.
            u.force_logout_at = now
            u.save(update_fields=["is_locked", "locked_at", "force_logout_at"])

        elif action == "unlock":
            u.is_locked = False
            u.locked_at = None
            u.save(update_fields=["is_locked", "locked_at"])

        elif action == "activate":
            u.status = User.Status.ACTIVE
            u.is_active = True
            u.save(update_fields=["status", "is_active"])

        elif action == "deactivate":
            u.status = User.Status.SUSPENDED
            u.is_active = False
            u.force_logout_at = now
            u.save(update_fields=["status", "is_active", "force_logout_at"])

        elif action == "force_logout":
            u.force_logout_at = now
            u.save(update_fields=["force_logout_at"])

        elif action == "reset_password":
            pwd = (request.data.get("password") or "").strip()
            generated = False
            if not pwd:
                pwd = secrets.token_urlsafe(9)
                generated = True
            if len(pwd) < 6:
                return Response({"detail": "Password must be at least 6 characters."}, status=400)
            u.set_password(pwd)
            u.is_first_login = False
            u.force_logout_at = now   # kick old sessions after a reset
            u.save(update_fields=["password", "is_first_login", "force_logout_at"])
            # Only echo a password we generated — never one the admin typed.
            if generated:
                extra["password"] = pwd

        else:
            return Response({"detail": f"Unknown action '{action}'."}, status=400)

        return Response({"ok": True, "action": action, **extra, "user": _full_detail(u)})
