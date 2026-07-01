"""
Request middleware stack for the SaaS subscription system.

Two middlewares — order in settings.MIDDLEWARE matters:

  1. TenantMiddleware    (must come first of the two)
       • Parses the JWT Bearer token.
       • Looks up the Tenant record in the master DB.
       • Calls register_tenant_db() so Django can open connections to it.
       • Sets the thread-local DB alias that TenantDatabaseRouter reads.
       • Clears the thread-local on response/exception (prevents leakage
         across requests in the same thread-pool thread).

  2. SubscriptionMiddleware  (must come after TenantMiddleware)
       • Blocks SUSPENDED users from reaching non-billing endpoints.
       • Relies on request.user already being resolved; because DRF's JWT
         authentication runs inside views (not Django middleware), this
         middleware reads the user status from the JWT-decoded user_id via
         the same helper that TenantMiddleware uses.

Both middlewares live here to keep the middleware stack declaration simple.
"""
import logging

from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

from .tenant_db import (
    clear_current_db_alias,
    clear_current_branch_id,
    get_current_db_alias,
    register_tenant_db,
    set_current_branch_id,
    set_current_db_alias,
)

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# "Tenant not ready" guard
#
# Paths that DO NOT touch the tenant database — safe to serve even while the
# user's tenant DB is still being provisioned. Everything else is blocked
# with a clean 503 so the frontend can show a friendly banner instead of
# crashing on missing tables in the master DB.
# ──────────────────────────────────────────────────────────────────────────────

_TENANT_SAFE_PREFIXES = (
    "/api/auth/",            # login, /me, OTP, refresh
    "/api/billing/",         # billing status, payment history
    "/api/me/",              # /me/referrals (master DB only)
    "/api/pay-now/",
    "/api/payment/",
    "/api/plans/",
    "/api/subscribe/",
    "/api/signup-trial/",
    "/api/set-password/",
    "/api/resend-setup-link/",
    "/api/admin/",           # platform-admin endpoints read master DB only
    "/admin/",
    "/api/schema",           # drf-spectacular schema
)


def _is_tenant_safe(path: str) -> bool:
    return any(path.startswith(p) for p in _TENANT_SAFE_PREFIXES)


_TENANT_NOT_READY_BODY = {
    "status":  "error",
    "data":    None,
    "message": (
        "Your workspace is still being prepared. This usually takes less than "
        "a minute. Please refresh the page in a moment."
    ),
    "errors":  {"code": "tenant_not_ready"},
}


# ──────────────────────────────────────────────────────────────────────────────
# Shared JWT helper
# ──────────────────────────────────────────────────────────────────────────────

def _user_id_from_request(request):
    """
    Extract the user_id claim from the JWT Bearer token without running
    DRF's full authentication pipeline.

    Returns the user_id (str/UUID) or None if there is no valid token.
    Signature verification IS performed by the simplejwt AccessToken class.
    """
    auth = request.META.get("HTTP_AUTHORIZATION", "")
    if not auth.startswith("Bearer "):
        return None

    raw_token = auth.split(" ", 1)[1].strip()
    try:
        from rest_framework_simplejwt.tokens import AccessToken
        from rest_framework_simplejwt.exceptions import TokenError

        validated = AccessToken(raw_token)
        return validated.get("user_id")
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# 1. TenantMiddleware
# ──────────────────────────────────────────────────────────────────────────────

class TenantMiddleware(MiddlewareMixin):
    """
    Sets the per-request tenant database alias.

    Flow per request:
      1. Parse the JWT Bearer token (if present).
      2. Query the master DB for the matching Tenant record.
      3. If the tenant DB is provisioned:
           a. Register it in settings.DATABASES (idempotent).
           b. Write alias to thread-local → TenantDatabaseRouter will use it.
      4. Continue to the next middleware / view.

    Flow per response (or exception):
      • Clear the thread-local to prevent alias leakage to the next request
        served by this OS thread.

    Position in MIDDLEWARE: as early as possible — before
    SubscriptionMiddleware and before any view that might query a tenant DB.
    """

    def process_request(self, request):
        clear_current_db_alias()  # always start clean

        user_id = _user_id_from_request(request)
        if not user_id:
            return None

        try:
            from .models import Tenant, User

            # Resolve the tenant OWNER for this user. A sub-user (one with a
            # parent_owner_id, created via the User Management page) ALWAYS
            # shares its owner's tenant database — it must never resolve to a
            # Tenant row of its own. Previously we looked up the user's own
            # Tenant first and only fell back to the parent; a leftover/stray
            # Tenant row on a sub-user would then route that user to a
            # SEPARATE database, so their sales/expenses were invisible to the
            # owner and other staff (and vice-versa). Resolving via the parent
            # first guarantees every staff member reads and writes the same
            # tenant DB.
            owner_id = (
                User.objects.filter(id=user_id)
                .values_list("parent_owner_id", flat=True)
                .first()
            ) or user_id
            tenant = (
                Tenant.objects
                .only("db_alias", "db_name", "is_provisioned")
                .get(user_id=owner_id)
            )

            if tenant.is_provisioned:
                register_tenant_db(tenant.db_alias, tenant.db_name)
                set_current_db_alias(tenant.db_alias)
                logger.debug(
                    "Tenant DB resolved: alias=%s  user_id=%s",
                    tenant.db_alias, user_id,
                )
            elif not _is_tenant_safe(request.path_info):
                # Tenant DB still being built — short-circuit any tenant-app
                # request with a clean 503 so the frontend can react. Without
                # this, queries would silently fall through to the master DB
                # and 500 on missing tables (the previous "request failed
                # with status code 500" UX).
                logger.info(
                    "Blocking %s for user_id=%s — tenant not yet provisioned.",
                    request.path_info, user_id,
                )
                return JsonResponse(_TENANT_NOT_READY_BODY, status=503)
            else:
                logger.debug(
                    "Tenant DB not yet provisioned for user_id=%s (path %s allowed).",
                    user_id, request.path_info,
                )

        except Tenant.DoesNotExist:
            # The user signed up but the master-DB tenant row hasn't been
            # written yet (extremely rare race). Treat the same as 'not ready'.
            if not _is_tenant_safe(request.path_info):
                return JsonResponse(_TENANT_NOT_READY_BODY, status=503)
        except Exception as exc:
            # Anything unexpected — log loudly but DON'T crash the request.
            logger.exception("TenantMiddleware failed: %s", exc)

        return None

    def process_response(self, request, response):
        clear_current_db_alias()
        return response

    def process_exception(self, request, exception):
        clear_current_db_alias()
        return None  # let Django's default exception handler take over


class BranchMiddleware(MiddlewareMixin):
    """Resolves the ACTIVE BRANCH for the request (multi-branch isolation).

    Reads the `X-Branch-Id` header the frontend sends after the user picks a
    branch, validates it against the user's branch memberships, and stashes
    the result in a thread-local that branch-scoped querysets read. `None`
    means the consolidated / all-branches view (tenant owner only).

    Must run AFTER TenantMiddleware — branch validation for staff reads the
    master DB, and the active branch is only meaningful once a tenant DB is
    active. Lightweight: no tenant-DB query in the hot path.
    """

    def process_request(self, request):
        clear_current_branch_id()
        # Single-client build: there is no tenant DB alias to gate on — branch
        # isolation runs directly against the one database for any
        # authenticated request that carries a JWT.
        user_id = _user_id_from_request(request)
        if not user_id:
            return None
        try:
            from .models import User
            from .branch_context import resolve_active_branch

            user = (
                User.objects.filter(id=user_id)
                .only("id", "parent_owner_id", "branch_id")
                .first()
            )
            if not user:
                return None
            requested = request.META.get("HTTP_X_BRANCH_ID")
            set_current_branch_id(resolve_active_branch(user, requested))
        except Exception as exc:  # noqa: BLE001
            logger.exception("BranchMiddleware failed: %s", exc)
        return None

    def process_response(self, request, response):
        clear_current_branch_id()
        return response

    def process_exception(self, request, exception):
        clear_current_branch_id()
        return None


# ──────────────────────────────────────────────────────────────────────────────
# 2. SubscriptionMiddleware
# ──────────────────────────────────────────────────────────────────────────────

# Paths a suspended user is still allowed to reach.
# Prefix-matched: any URL that STARTS WITH one of these is allowed through.
_ALLOWED_PREFIXES = (
    "/api/billing/",   # billing status, payment history
    "/api/pay-now/",   # initiate renewal payment
    "/api/payment/",   # webhook + status polling
    "/api/auth/",      # login, token refresh
    "/api/plans/",     # read-only plan catalogue
    "/admin/",         # Django admin (superusers must still be reachable)
)

_SUSPENSION_BODY = {
    "status":  "error",
    "data":    None,
    "message": (
        "Your subscription is paused because your bill is unpaid. "
        "Please pay your bill to reopen your account — your data is safe."
    ),
    "errors":  {"code": "subscription_suspended"},
}


class SubscriptionMiddleware(MiddlewareMixin):
    """
    Blocks SUSPENDED users from reaching non-billing endpoints.

    Checks:
      • Unauthenticated / anonymous → pass through (no subscription to check).
      • Superuser → always pass through.
      • User status == 'suspended' AND path not in _ALLOWED_PREFIXES → 403.

    Note: DRF's JWT authentication resolves request.user inside the view,
    not in Django middleware.  So we read the user status from the DB using
    the same user_id we extracted from the JWT — one extra DB hit per
    suspended-user request, but suspended users are rare in practice.
    """

    def process_request(self, request):
        user = getattr(request, "user", None)

        # Django session auth resolved the user (admin, browsable API, etc.)
        if user and user.is_authenticated:
            return self._check_user(user, request.path_info)

        # DRF JWT — user not yet resolved; read from token.
        user_id = _user_id_from_request(request)
        if not user_id:
            return None  # anonymous — pass through

        try:
            from .models import User
            db_user = User.objects.only("status", "is_superuser").get(id=user_id)
            return self._check_user(db_user, request.path_info)
        except Exception:
            return None

    @staticmethod
    def _check_user(user, path: str):
        if user.is_superuser:
            return None
        if getattr(user, "status", "active") != "suspended":
            return None

        for prefix in _ALLOWED_PREFIXES:
            if path.startswith(prefix):
                return None

        logger.info("Blocked suspended user %s at %s", getattr(user, "email", "?"), path)
        return JsonResponse(_SUSPENSION_BODY, status=403)
