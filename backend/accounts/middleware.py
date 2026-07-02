"""
Request middleware — NSL-POS (single-client).

BranchMiddleware resolves the ACTIVE BRANCH for each request (multi-branch data
isolation). It reads the `X-Branch-Id` header the frontend sends after the user
picks a branch, validates it against the user's branch memberships, and stashes
the result in a thread-local that branch-scoped querysets read. `None` means the
consolidated / all-branches view (owner only).
"""
import logging

from django.utils.deprecation import MiddlewareMixin

from .tenant_db import (
    clear_current_branch_id,
    set_current_branch_id,
)

logger = logging.getLogger(__name__)


def _user_id_from_request(request):
    """Extract the user_id claim from the JWT Bearer token (signature-verified)."""
    auth = request.META.get("HTTP_AUTHORIZATION", "")
    if not auth.startswith("Bearer "):
        return None
    raw_token = auth.split(" ", 1)[1].strip()
    try:
        from rest_framework_simplejwt.tokens import AccessToken
        validated = AccessToken(raw_token)
        return validated.get("user_id")
    except Exception:
        return None


class BranchMiddleware(MiddlewareMixin):
    """Resolve the active branch for the request (multi-branch isolation)."""

    def process_request(self, request):
        clear_current_branch_id()
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
