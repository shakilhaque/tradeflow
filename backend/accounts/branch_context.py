"""
Multi-branch access + active-branch resolution (Phase 1 foundation).

Branches are `inventory.Location` rows in each tenant's own DB. Access is
governed by `UserBranch` rows in the master DB (soft UUID references), with
the tenant owner implicitly holding every branch + the consolidated view.

These helpers are DB-routing aware: branch listing reads the tenant DB that
TenantMiddleware has already activated for the request.
"""
from __future__ import annotations

from typing import List, Optional


def is_tenant_owner(user) -> bool:
    """The tenant owner is a top-level user (no parent_owner_id). Owners see
    every branch and the consolidated (all-branches) view."""
    return bool(user and getattr(user, "id", None) and getattr(user, "parent_owner_id", None) is None)


def _all_tenant_branches() -> List[dict]:
    """Every active branch (Location) in the currently-routed tenant DB."""
    try:
        from inventory.models import Location  # noqa: PLC0415
        return [
            {"id": str(l.id), "name": l.name, "code": l.code}
            for l in Location.objects.filter(is_active=True).order_by("name")
        ]
    except Exception:
        return []


def accessible_branches(user) -> List[dict]:
    """Branches the user may access, as [{id, name, code}].

    Owner → all tenant branches. Staff → the branches granted via UserBranch
    (plus their legacy single User.branch_id), intersected with the branches
    that still exist & are active in the tenant DB.
    """
    all_branches = _all_tenant_branches()
    if is_tenant_owner(user):
        return all_branches

    from .models import UserBranch  # noqa: PLC0415
    granted = set(
        str(b) for b in UserBranch.objects.filter(user_id=user.id).values_list("branch_id", flat=True)
    )
    # Back-compat: honour the single legacy assignment too.
    if getattr(user, "branch_id", None):
        granted.add(str(user.branch_id))
    return [b for b in all_branches if b["id"] in granted]


def can_view_consolidated(user) -> bool:
    """Only the tenant owner may view the consolidated / all-branches roll-up."""
    return is_tenant_owner(user)


def manageable_branches(user) -> List[dict]:
    """Branches the user may administer on the all-branches dashboard.

    Owner → every branch. Staff → only branches where their UserBranch row is
    flagged ``can_manage=True`` (branch managers).
    """
    all_branches = _all_tenant_branches()
    if is_tenant_owner(user):
        return all_branches
    from .models import UserBranch  # noqa: PLC0415
    managed = set(
        str(b) for b in
        UserBranch.objects.filter(user_id=user.id, can_manage=True)
                          .values_list("branch_id", flat=True)
    )
    return [b for b in all_branches if b["id"] in managed]


def can_manage_any_branch(user) -> bool:
    """True for the owner, or any staff member who manages at least one branch.
    Gates access to the all-branches dashboard."""
    if is_tenant_owner(user):
        return True
    from .models import UserBranch  # noqa: PLC0415
    return UserBranch.objects.filter(user_id=user.id, can_manage=True).exists()


def staff_branch_ids(user) -> set:
    """Branch ids granted to a (sub-)user — master-DB only, so it's cheap
    enough for the per-request middleware. Owners aren't constrained by this."""
    from .models import UserBranch  # noqa: PLC0415
    ids = {
        str(b) for b in
        UserBranch.objects.filter(user_id=user.id).values_list("branch_id", flat=True)
    }
    if getattr(user, "branch_id", None):
        ids.add(str(user.branch_id))
    return ids


def user_can_access_branch(user, branch_id) -> bool:
    """True if the user may operate within the given branch id. Owners may
    access any branch of their tenant; staff only their granted set."""
    if not branch_id:
        return False
    if is_tenant_owner(user):
        return True
    return str(branch_id) in staff_branch_ids(user)


def resolve_active_branch(user, requested_branch_id: Optional[str]):
    """Validate the X-Branch-Id header against the user's access and return the
    branch id to scope the request to (kept light — no tenant-DB query):

      • "all" / "consolidated" / empty → None (consolidated) for the owner,
        else the staff member's first assigned branch.
      • a specific id the user may access → that id.
      • an id the user may NOT access → their first assigned branch (owner:
        the requested id, since owners can access everything).
    """
    raw = (requested_branch_id or "").strip().lower()
    owner = is_tenant_owner(user)

    if raw in ("", "all", "consolidated", "*"):
        return None if owner else _staff_first_branch(user)

    if owner:
        # The owner can operate in any of their branches; trust the header.
        return str(requested_branch_id)

    granted = staff_branch_ids(user)
    if str(requested_branch_id) in granted:
        return str(requested_branch_id)
    return next(iter(sorted(granted)), None)


def _staff_first_branch(user) -> Optional[str]:
    granted = staff_branch_ids(user)
    return next(iter(sorted(granted)), None)


# ──────────────────────────────────────────────────────────────────────────────
# Active-branch query scoping (Phase 2)
# ──────────────────────────────────────────────────────────────────────────────

def active_branch_id() -> Optional[str]:
    """The branch the current request is scoped to (None = consolidated /
    all-branches, owner only)."""
    from .tenant_db import get_current_branch_id  # noqa: PLC0415
    return get_current_branch_id()


def branch_scope(qs, field: str = "location_id"):
    """Filter a queryset to the active branch. When no branch is active
    (consolidated owner view) the queryset is returned unchanged.

    `field` is the lookup that holds the branch (Location) id — usually
    `location_id`, but some models reach it through a relation
    (e.g. `sale__location_id`).
    """
    bid = active_branch_id()
    if bid:
        return qs.filter(**{field: bid})
    return qs

