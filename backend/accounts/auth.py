"""
Custom JWT authentication helpers.

`allow_suspended_user_rule` is wired into SIMPLE_JWT.USER_AUTHENTICATION_RULE
so that suspended tenants (User.is_active = False) can still authenticate via
JWT and reach the Pay Bill / billing endpoints.

The actual authorisation (which routes a suspended user is allowed to reach)
is enforced by SubscriptionMiddleware — not by the JWT layer.
"""


def allow_suspended_user_rule(user) -> bool:
    """
    Return True for any user that exists and isn't deleted/cancelled.

    Default SimpleJWT rule is `lambda u: u and u.is_active`, which blocks
    suspended users at the auth layer — they can't even hit /api/pay-now/.
    We override it so suspension is enforced by application logic instead
    (SubscriptionMiddleware redirects them to billing endpoints only).
    """
    if user is None:
        return False
    # A Super Admin can LOCK a user — a locked account can neither log in nor
    # use an existing token.
    if getattr(user, "is_locked", False):
        return False
    # Hard-deleted or platform-cancelled accounts should still be blocked.
    status = getattr(user, "status", "active")
    return status != "cancelled"


# ──────────────────────────────────────────────────────────────────────────────
# Force-logout-aware JWT authentication
# ──────────────────────────────────────────────────────────────────────────────

from rest_framework_simplejwt.authentication import JWTAuthentication  # noqa: E402


class ForceLogoutAwareJWTAuthentication(JWTAuthentication):
    """
    Like SimpleJWT's JWTAuthentication, but also rejects any token issued
    before the user's `force_logout_at` instant. That lets a Super Admin end
    all of a user's sessions ("Force Logout") without locking the account —
    the user simply has to log in again to mint a fresh token.
    """

    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        cutoff = getattr(user, "force_logout_at", None)
        if cutoff is not None:
            iat = validated_token.get("iat")
            if iat is not None and int(iat) < int(cutoff.timestamp()):
                from rest_framework_simplejwt.exceptions import AuthenticationFailed
                raise AuthenticationFailed(
                    "Your session was ended by an administrator. Please log in again.",
                    code="session_revoked",
                )
        return user
