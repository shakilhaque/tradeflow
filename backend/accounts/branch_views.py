"""
Branch API — multi-branch isolation (Phase 1).

  GET  /api/branches/my/          branches the signed-in user can access
  GET  /api/branches/assignments/?user_id=  a staff user's branch ids (owner)
  POST /api/branches/assign/      owner sets a staff user's branches
"""
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .branch_context import (
    accessible_branches, can_view_consolidated, is_tenant_owner,
    can_manage_any_branch,
)
from .tenant_db import get_current_branch_id


class MyBranchesView(APIView):
    """Branches the current user may access + whether they get the
    consolidated (all-branches) view. Drives the post-login branch selector
    and the header switcher."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({
            "branches":              accessible_branches(request.user),
            "can_view_consolidated": can_view_consolidated(request.user),
            "can_manage_any_branch": can_manage_any_branch(request.user),
            "active_branch_id":      get_current_branch_id(),
        })


class BranchAssignmentsView(APIView):
    """GET the branch ids granted to a given staff user (owner only)."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not is_tenant_owner(request.user):
            return Response({"detail": "Only the tenant owner can manage branch access."},
                            status=status.HTTP_403_FORBIDDEN)
        uid = request.query_params.get("user_id")
        if not uid:
            return Response({"branch_ids": [], "manage_branch_ids": []})
        from .models import UserBranch
        rows = list(UserBranch.objects.filter(user_id=uid).values("branch_id", "can_manage"))
        return Response({
            "branch_ids":        [str(r["branch_id"]) for r in rows],
            "manage_branch_ids": [str(r["branch_id"]) for r in rows if r["can_manage"]],
        })


class AssignBranchesView(APIView):
    """Owner sets which branches a staff user may access. Body:
    { "user_id": "...", "branch_ids": ["...", "..."] }. Replaces the user's
    UserBranch rows with the given set (validated against existing branches)."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not is_tenant_owner(request.user):
            return Response({"detail": "Only the tenant owner can manage branch access."},
                            status=status.HTTP_403_FORBIDDEN)

        from .models import User, UserBranch

        data = request.data or {}
        uid = (data.get("user_id") or "").strip()
        branch_ids = data.get("branch_ids") or []
        # Branches this user may MANAGE (subset of branch_ids). A branch manager
        # can reach the all-branches dashboard for their branches.
        manage_ids = {str(b) for b in (data.get("manage_branch_ids") or [])}
        if not uid:
            return Response({"detail": "user_id is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(branch_ids, (list, tuple)):
            return Response({"detail": "branch_ids must be a list."}, status=status.HTTP_400_BAD_REQUEST)

        # The target must be a staff member of THIS tenant (parent_owner == the
        # owner making the request), so an owner can't touch other tenants.
        target = User.objects.filter(id=uid).only("id", "parent_owner_id").first()
        if not target or str(target.parent_owner_id) != str(request.user.id):
            return Response({"detail": "User not found in your tenant."},
                            status=status.HTTP_404_NOT_FOUND)

        # Validate ids + capture names against the tenant's real branches.
        from inventory.models import Location  # noqa: PLC0415
        valid = {
            str(l.id): l.name
            for l in Location.objects.filter(id__in=[str(b) for b in branch_ids])
        }

        UserBranch.objects.filter(user_id=uid).delete()
        created = []
        managed = []
        for bid in branch_ids:
            sid = str(bid)
            if sid not in valid:
                continue
            can_manage = sid in manage_ids
            UserBranch.objects.create(
                user_id=uid, branch_id=sid, branch_name=valid[sid], can_manage=can_manage,
            )
            created.append(sid)
            if can_manage:
                managed.append(sid)
        return Response(
            {"user_id": uid, "branch_ids": created, "manage_branch_ids": managed},
            status=status.HTTP_200_OK,
        )
