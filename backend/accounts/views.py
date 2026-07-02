"""
API Views — authentication for the single-client build:
username availability, email+password login, logout, JWT refresh.
"""
import logging

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenRefreshView as _BaseTokenRefreshView

from .serializers import LoginSerializer

logger = logging.getLogger(__name__)


@extend_schema(tags=["Auth"])
class UsernameAvailabilityView(APIView):
    """Live username-availability probe used when creating staff users."""
    permission_classes = [AllowAny]
    throttle_classes   = [AnonRateThrottle]

    @extend_schema(
        summary="Check whether a username is available",
        description=(
            "Returns `{available: bool, reason: str, suggestions: [str]}`. "
            "When the username is unavailable OR malformed, `suggestions` lists "
            "a few usable alternatives."
        ),
    )
    def get(self, request):
        from . import services as _services

        raw = request.query_params.get("username", "")
        wanted = _services.normalize_username(raw)

        if not wanted:
            return Response({
                "available":   False,
                "reason":      "Enter a username to check.",
                "suggestions": [],
            })

        if not _services.is_valid_username_format(wanted):
            seed = request.query_params.get("seed") or raw or "user"
            return Response({
                "available":   False,
                "reason":      (
                    f"Username must be {_services.USERNAME_MIN_LEN}-"
                    f"{_services.USERNAME_MAX_LEN} characters, start with a "
                    "lowercase letter, and contain only lowercase letters, "
                    "digits, or underscores."
                ),
                "suggestions": _services.suggest_usernames(seed),
            })

        if not _services.is_username_available(wanted):
            return Response({
                "available":   False,
                "reason":      "This username has already been used.",
                "suggestions": _services.suggest_usernames(wanted),
            })

        return Response({"available": True, "reason": "", "suggestions": []})


@extend_schema(tags=["Auth"])
class LoginView(APIView):
    """Email + password → JWT access and refresh tokens."""
    permission_classes = [AllowAny]
    throttle_classes   = [ScopedRateThrottle]
    throttle_scope     = "login"

    @extend_schema(
        summary="Login",
        description=(
            "Authenticate with email and password. Returns JWT access and refresh tokens.\n\n"
            "The access token contains: `role`, `permissions`, `email`, `name`, `user_id`."
        ),
        request=LoginSerializer,
        responses={200: None},
        auth=[],
    )
    def post(self, request):
        from .security_log import record_security_event
        ident = (request.data.get("identifier") or request.data.get("email")
                 or request.data.get("mobile") or request.data.get("phone") or "")
        serializer = LoginSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            record_security_event("login_failure", request=request, success=False,
                                  actor_email=ident)
            from rest_framework.exceptions import ValidationError
            raise ValidationError(serializer.errors)
        record_security_event("login_success", request=request, actor_email=ident)
        return Response(serializer.validated_data, status=status.HTTP_200_OK)


@extend_schema(tags=["Auth"])
class LogoutView(APIView):
    """Revoke a refresh token (logout). Idempotent — an already-invalid token
    still returns 200 so the client can clear its session unconditionally."""
    permission_classes     = [AllowAny]   # the refresh token is itself the credential
    authentication_classes = []
    throttle_classes       = []

    @extend_schema(summary="Logout", description="Blacklist the supplied refresh token.", auth=[])
    def post(self, request):
        from rest_framework_simplejwt.tokens import RefreshToken
        from rest_framework_simplejwt.exceptions import TokenError
        token = (request.data or {}).get("refresh", "")
        if not token:
            return Response({"detail": "Refresh token is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            RefreshToken(token).blacklist()
        except TokenError:
            pass  # already expired / blacklisted — treat as logged out
        from .security_log import record_security_event
        record_security_event("logout", request=request)
        return Response({"detail": "Logged out."}, status=status.HTTP_200_OK)


@extend_schema(tags=["Auth"])
class TokenRefreshView(_BaseTokenRefreshView):
    """Refresh JWT access token using a valid refresh token."""

    @extend_schema(
        summary="Refresh access token",
        description="Exchange a valid refresh token for a new access token (rotated on use).",
        auth=[],
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)
