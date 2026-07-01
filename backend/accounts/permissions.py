"""
RBAC — Permission constants, role-permission matrix, and checking utilities.

Architecture
────────────
  Permission codes are defined as class constants on `Perm`.
  The default role→permission matrix is coded in `_ROLE_PERMISSIONS` (fast,
  no DB hit).  The DB tables (Permission, RolePermission) hold the same data
  and allow future per-tenant overrides without a code deployment.

Usage — method decorator on APIView
────────────────────────────────────
  from accounts.permissions import require_permission, Perm

  class ProfitLossView(APIView):
      @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
      def get(self, request):
          ...

Usage — programmatic check
───────────────────────────
  from accounts.permissions import has_permission, Perm

  if not has_permission(request.user, Perm.CAN_VIEW_REPORTS):
      return Response({"detail": "Forbidden."}, status=403)

Role summary
────────────
  OWNER   → all permissions
  ADMIN   → all except can_manage_settings
  MANAGER → sales ops + reports + products + expenses
  CASHIER → create / edit sales only
"""

import functools
import logging

from rest_framework import status
from rest_framework.response import Response

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Permission code constants
# ──────────────────────────────────────────────────────────────────────────────

class Perm:
    """Namespace for all permission code strings."""

    # ── Sales ─────────────────────────────────────────────────────────────────
    CAN_CREATE_SALE         = "can_create_sale"
    CAN_EDIT_SALE           = "can_edit_sale"
    CAN_VOID_SALE           = "can_void_sale"

    # ── Pricing ───────────────────────────────────────────────────────────────
    CAN_VIEW_PURCHASE_PRICE = "can_view_purchase_price"
    CAN_APPLY_DISCOUNT      = "can_apply_discount"

    # ── Reports ───────────────────────────────────────────────────────────────
    CAN_VIEW_REPORTS        = "can_view_reports"        # general reports
    CAN_VIEW_PROFIT_LOSS    = "can_view_profit_loss"    # P&L / Balance Sheet / Trial Balance

    # ── Operations ────────────────────────────────────────────────────────────
    CAN_MANAGE_PRODUCTS     = "can_manage_products"
    CAN_MANAGE_USERS        = "can_manage_users"
    CAN_MANAGE_ACCOUNTS     = "can_manage_accounts"     # chart of accounts
    CAN_RECORD_EXPENSE      = "can_record_expense"
    CAN_VIEW_AUDIT_LOG      = "can_view_audit_log"
    CAN_MANAGE_SETTINGS     = "can_manage_settings"

    # ── Convenience set of all codes ──────────────────────────────────────────
    ALL: frozenset = frozenset({
        CAN_CREATE_SALE, CAN_EDIT_SALE, CAN_VOID_SALE,
        CAN_VIEW_PURCHASE_PRICE, CAN_APPLY_DISCOUNT,
        CAN_VIEW_REPORTS, CAN_VIEW_PROFIT_LOSS,
        CAN_MANAGE_PRODUCTS, CAN_MANAGE_USERS, CAN_MANAGE_ACCOUNTS,
        CAN_RECORD_EXPENSE, CAN_VIEW_AUDIT_LOG, CAN_MANAGE_SETTINGS,
    })

    # Human-readable metadata — used by the seed migration
    DESCRIPTIONS: dict = {
        CAN_CREATE_SALE:         "Create new sales (any status)",
        CAN_EDIT_SALE:           "Edit DRAFT / QUOTATION sales",
        CAN_VOID_SALE:           "Void finalized sales",
        CAN_VIEW_PURCHASE_PRICE: "See cost price / COGS on products and reports",
        CAN_APPLY_DISCOUNT:      "Apply discounts without supervisor override",
        CAN_VIEW_REPORTS:        "Access sales, stock, expense, and tax reports",
        CAN_VIEW_PROFIT_LOSS:    "Access P&L, Balance Sheet, and Trial Balance",
        CAN_MANAGE_PRODUCTS:     "Create and edit products, stock, categories",
        CAN_MANAGE_USERS:        "Create, edit, and deactivate staff accounts",
        CAN_MANAGE_ACCOUNTS:     "Manage chart of accounts and journal entries",
        CAN_RECORD_EXPENSE:      "Record operational expenses",
        CAN_VIEW_AUDIT_LOG:      "View audit trail for all operations",
        CAN_MANAGE_SETTINGS:     "Change system-wide settings (owner only)",
    }


# ──────────────────────────────────────────────────────────────────────────────
# Default role → permission matrix
# ──────────────────────────────────────────────────────────────────────────────
# This is the in-code source of truth.  The seed migration (0005_seed_rbac.py)
# reads this same mapping to populate the DB tables.

_ROLE_PERMISSIONS: dict[str, frozenset] = {
    "owner": frozenset(Perm.ALL),

    "admin": frozenset(Perm.ALL - {Perm.CAN_MANAGE_SETTINGS}),

    "manager": frozenset({
        Perm.CAN_CREATE_SALE,
        Perm.CAN_EDIT_SALE,
        Perm.CAN_VOID_SALE,
        Perm.CAN_VIEW_PURCHASE_PRICE,
        Perm.CAN_APPLY_DISCOUNT,
        Perm.CAN_VIEW_REPORTS,
        Perm.CAN_MANAGE_PRODUCTS,
        Perm.CAN_RECORD_EXPENSE,
        Perm.CAN_VIEW_AUDIT_LOG,
    }),

    "cashier": frozenset({
        Perm.CAN_CREATE_SALE,
        Perm.CAN_EDIT_SALE,
        # Cashiers may apply discounts at the till without a supervisor
        # override — the hard supervisor-password gate blocked routine
        # POS discounts for every non-manager user.
        Perm.CAN_APPLY_DISCOUNT,
    }),
}


# ──────────────────────────────────────────────────────────────────────────────
# Public checking API
# ──────────────────────────────────────────────────────────────────────────────

def has_permission(user, permission_code: str) -> bool:
    """
    Return True if the user has the given permission.

    Resolution order (any one of these is enough to grant access):

      1. The user is a Django superuser.
      2. The user's built-in role is 'owner'.
      3. The user's built-in role appears in the legacy Perm.* matrix
         AND ``permission_code`` is in that role's matrix entry.
      4. The user has been assigned a custom TenantRole AND that role's
         permissions list contains ``permission_code`` (or a granular
         alias for it via LEGACY_ALIAS).
      5. The user's built-in role appears in BUILTIN_GRANULAR AND that
         role's granular set contains ``permission_code`` (or alias).

    Parameters
    ──────────
    user             The authenticated request.user (or any User instance).
    permission_code  Either a legacy ``Perm.*`` constant OR a granular code
                     like ``user.delete``.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if getattr(user, "is_superuser", False):
        return True

    role = getattr(user, "role", None) or ""
    if role == "owner":
        return True

    # 1. Legacy role-matrix exact match (covers old Perm.* call sites).
    if permission_code in _ROLE_PERMISSIONS.get(role, frozenset()):
        return True

    # Effective granular permission set for this user, computed lazily.
    granular = _granular_permissions_for(user)

    # 2. Direct granular match.
    if permission_code in granular:
        return True

    # 3. Legacy-to-granular alias bridge: if the caller asked for a
    #    coarse legacy code (e.g. CAN_MANAGE_USERS) and the user holds
    #    any of its granular aliases (e.g. user.edit), allow.
    from .role_permissions import LEGACY_ALIAS  # noqa: PLC0415
    aliases = LEGACY_ALIAS.get(permission_code, frozenset())
    if aliases and (granular & aliases):
        return True

    return False


def _granular_permissions_for(user) -> frozenset:
    """
    Return the granular permission set effectively held by the user.

    Owner → every code in the catalog. Custom TenantRole → that role's
    saved permissions list. Otherwise the built-in BUILTIN_GRANULAR
    set for the user's role (admin / manager / cashier).
    """
    from .role_permissions import ALL_PERMISSIONS, BUILTIN_GRANULAR  # noqa: PLC0415

    role = getattr(user, "role", None) or ""
    if role == "owner":
        return ALL_PERMISSIONS

    # A user can override the built-in role's granular set by being
    # assigned a custom TenantRole. We avoid the DB hit when the FK
    # isn't set.
    tenant_role_id = getattr(user, "tenant_role_id", None)
    if tenant_role_id:
        try:
            from .models import TenantRole  # noqa: PLC0415
            tr = TenantRole.objects.only("permissions").get(id=tenant_role_id)
            return frozenset(tr.permissions or [])
        except Exception:  # noqa: BLE001
            # Custom role row gone — fall through to the built-in set so
            # the user still has SOME baseline access.
            pass

    return BUILTIN_GRANULAR.get(role, frozenset())


def get_user_permissions(user) -> frozenset:
    """
    Return the COMBINED set of permission codes the user holds.

    Used by the login serializer to ship `permissions` to the SPA so the
    UI can hide unauthorised actions. Includes both legacy Perm.* codes
    (so existing has_permission() call sites keep working) AND the new
    granular codes (so the frontend can decide on a per-button basis).
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return frozenset()
    if getattr(user, "is_superuser", False):
        from .role_permissions import ALL_PERMISSIONS  # noqa: PLC0415
        return frozenset(Perm.ALL) | ALL_PERMISSIONS

    role = getattr(user, "role", None) or ""
    legacy   = _ROLE_PERMISSIONS.get(role, frozenset())
    granular = _granular_permissions_for(user)
    return frozenset(legacy) | frozenset(granular)


def role_permissions(role_code: str) -> frozenset:
    """Return the default permission set for a given role code string."""
    return _ROLE_PERMISSIONS.get(role_code, frozenset())


# ──────────────────────────────────────────────────────────────────────────────
# Decorators
# ──────────────────────────────────────────────────────────────────────────────

def require_permission(permission_code: str):
    """
    DRF-compatible decorator for APIView instance methods.

    Checks `has_permission(request.user, permission_code)` before executing
    the wrapped method.  Returns HTTP 403 if the check fails.

    Example
    ───────
    class BalanceSheetView(APIView):
        permission_classes = [IsAuthenticated]

        @require_permission(Perm.CAN_VIEW_PROFIT_LOSS)
        def get(self, request):
            ...
    """
    def decorator(method):
        @functools.wraps(method)
        def wrapped(self, request, *args, **kwargs):
            if not has_permission(request.user, permission_code):
                logger.warning(
                    "Permission denied: user=%s  role=%s  required=%s  path=%s",
                    getattr(request.user, "id", "?"),
                    getattr(request.user, "role", "?"),
                    permission_code,
                    request.path,
                )
                return Response(
                    {
                        "detail": "You do not have permission to perform this action.",
                        "required_permission": permission_code,
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            return method(self, request, *args, **kwargs)
        return wrapped
    return decorator


# ──────────────────────────────────────────────────────────────────────────────
# DRF Permission class (alternative to decorator — usable in permission_classes)
# ──────────────────────────────────────────────────────────────────────────────

from rest_framework.permissions import BasePermission  # noqa: E402


class HasPermission(BasePermission):
    """
    DRF permission class factory.

    Usage:
        class MyView(APIView):
            permission_classes = [IsAuthenticated, HasPermission.for_code(Perm.CAN_VIEW_REPORTS)]

    Or subclass:
        class CanViewReports(HasPermission):
            required_permission = Perm.CAN_VIEW_REPORTS
    """
    required_permission: str = ""

    def has_permission(self, request, view):
        return has_permission(request.user, self.required_permission)

    @classmethod
    def for_code(cls, code: str):
        """Return a one-off subclass that checks `code` as a permission."""
        return type(f"HasPermission_{code}", (cls,), {"required_permission": code})


def require_perm_method(perm_code: str):
    """
    Per-method permission gate suitable for ModelViewSet.create/update/destroy.

    Wraps the wrapped method so non-privileged callers see a clean 403 JSON
    body before the body parsing / business logic runs. Owners and admins
    are always allowed.

        class CustomerViewSet(ModelViewSet):
            @require_perm_method("customer.delete")
            def destroy(self, request, *a, **k): ...
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapped(self, request, *args, **kwargs):
            role = getattr(request.user, "role", None) or ""
            if role in ("owner", "admin") or has_permission(request.user, perm_code):
                return fn(self, request, *args, **kwargs)
            return Response(
                {"detail": "You do not have permission to perform this action.",
                 "required_permission": perm_code},
                status=status.HTTP_403_FORBIDDEN,
            )
        return wrapped
    return decorator

    @classmethod
    def for_code(cls, permission_code: str):
        """Return a HasPermission subclass bound to the given permission code."""
        return type(
            f"Has_{permission_code}",
            (cls,),
            {"required_permission": permission_code},
        )
