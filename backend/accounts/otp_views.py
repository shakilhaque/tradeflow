"""
SMS-OTP first-login endpoints.

Flow:
    1. After payment / trial signup, services.send_login_otp(user) creates
       a LoginOtp row and dispatches an SMS containing the user's username
       and a 6-digit code.
    2. POST /api/auth/login-otp/  {username, otp}
       → on success, issues a single-use PasswordSetupToken and returns it,
         plus the user's display name and phone hint. The frontend then
         redirects to /set-password?token=<...> to force a password reset.
    3. POST /api/auth/resend-otp/  {username}
       → re-issues an OTP for the given user, with anti-enumeration response
         (always 200 even for unknown usernames).

These endpoints replace the old email-link `/api/set-password/` entry point
for the first login. The /api/set-password/ endpoint itself stays — it's
just driven by an OTP-issued token instead of a token mailed out directly.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from . import services, sms as sms_service
from .models import LoginOtp, PasswordSetupToken, User

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Serializers
# ──────────────────────────────────────────────────────────────────────────────


class OtpLoginSerializer(serializers.Serializer):
    # `identifier` (username / email / mobile) is the general form used by the
    # forgot-password flow; `username` is kept for the first-login OTP screen.
    username   = serializers.CharField(max_length=80, required=False, allow_blank=True)
    identifier = serializers.CharField(max_length=120, required=False, allow_blank=True)
    otp        = serializers.CharField(min_length=4, max_length=8)


class OtpResendSerializer(serializers.Serializer):
    # Any of these is accepted; identifier (username/email/mobile) is the most
    # general and is what the forgot-password screen sends.
    username   = serializers.CharField(max_length=80, required=False, allow_blank=True)
    email      = serializers.EmailField(required=False, allow_blank=True)
    identifier = serializers.CharField(max_length=120, required=False, allow_blank=True)


class ForgotPasswordSerializer(serializers.Serializer):
    identifier = serializers.CharField(max_length=120)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────


def _mask_phone(p: str) -> str:
    """Mask all but the last 3 digits, e.g. '8801XXXXXXXXX' → '88…111'."""
    if not p:
        return ""
    digits = "".join(c for c in p if c.isdigit())
    if len(digits) < 4:
        return "***"
    return f"{digits[:2]}{'•' * (len(digits) - 5)}{digits[-3:]}"


def _maybe_dev_payload(user) -> dict:
    """In DEBUG mode with the console SMS backend, surface the OTP so the
    dev frontend can pre-fill it. Returns an empty dict in production."""
    code = sms_service.get_last_dev_otp(user.id)
    return {"_dev_otp": code} if code else {}


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/auth/login-otp/
# ──────────────────────────────────────────────────────────────────────────────


class OtpLoginView(APIView):
    """Verify {username, otp}. On success issue a PasswordSetupToken so the
    user can complete the forced first-time password setup."""

    permission_classes = [AllowAny]
    throttle_classes   = [ScopedRateThrottle]
    throttle_scope     = "otp"

    def post(self, request):
        ser = OtpLoginSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ident = (ser.validated_data.get("identifier") or "").strip() \
            or (ser.validated_data.get("username") or "").strip()
        code  = ser.validated_data["otp"].strip()

        # Generic message — never reveal whether the account exists.
        generic_fail = {"detail": "Invalid account or verification code."}

        user = services.find_user_by_identifier(ident)
        if not user:
            return Response(generic_fail, status=status.HTTP_400_BAD_REQUEST)

        otp = (
            LoginOtp.objects
            .filter(user=user, consumed_at__isnull=True)
            .order_by("-created_at")
            .first()
        )
        if not otp:
            return Response(
                {"detail": "No active code. Tap 'Resend code' to get a new one."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not otp.verify(code):
            # Distinguish 'expired/too many attempts' from 'wrong digits' so
            # the UI can show a specific message without leaking validity.
            if otp.is_expired:
                return Response(
                    {"detail": "This code has expired. Request a new one."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if otp.attempts >= LoginOtp.MAX_ATTEMPTS:
                return Response(
                    {"detail": "Too many incorrect attempts. Request a new code."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response(generic_fail, status=status.HTTP_400_BAD_REQUEST)

        # OTP verified — issue a one-time setup token (15 min) and hand it back.
        token = PasswordSetupToken.issue(user=user)

        # First successful OTP verify is also the trigger for tenant DB
        # provisioning. We deliberately don't provision at signup time
        # because that would mark abandoned sign-ups (user submits the
        # form, never types the OTP) as fully provisioned in the admin
        # panel — they shouldn't be. Provisioning here guarantees the
        # platform only spends a tenant DB on accounts that proved they
        # own the phone number.
        try:
            from .models import Tenant
            tenant = getattr(user, "tenant", None)
            if tenant and not tenant.is_provisioned:
                from .services import _schedule_tenant_provisioning
                _schedule_tenant_provisioning(str(user.id))
        except Exception as exc:
            # Provisioning failure must not block the OTP-verify response —
            # the user can still set their password, and the operator can
            # repair the tenant later via `audit_tenants --repair`.
            import logging as _logging
            _logging.getLogger(__name__).exception(
                "Deferred tenant provisioning failed for user %s: %s", user.id, exc,
            )

        return Response(
            {
                "detail":        "Code verified. Set your password to continue.",
                "setup_token":   token.token,
                "expires_at":    token.expires_at.isoformat(),
                "user": {
                    "username":   user.username,
                    "name":       user.name,
                    "phone_mask": _mask_phone(user.phone),
                },
            },
            status=status.HTTP_200_OK,
        )


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/auth/resend-otp/
# ──────────────────────────────────────────────────────────────────────────────


class OtpResendView(APIView):
    """Re-issue an OTP for the given username or email. Anti-enumeration: the
    response is the same regardless of whether the user exists."""

    permission_classes = [AllowAny]
    throttle_classes   = [ScopedRateThrottle]
    throttle_scope     = "otp_resend"

    def post(self, request):
        ser = OtpResendSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        username   = (ser.validated_data.get("username") or "").strip()
        email      = (ser.validated_data.get("email")    or "").strip()
        identifier = (ser.validated_data.get("identifier") or "").strip()

        services.resend_login_otp(username=username, email=email, identifier=identifier)

        # Best-effort: in DEBUG/console mode, also return the latest code so
        # the dev frontend can autofill it.
        body = {"detail": "If the account exists, a new code has been sent."}
        if settings.DEBUG and sms_service.backend_name() == "console":
            user = services.find_user_by_identifier(identifier or username or email)
            if user:
                body.update(_maybe_dev_payload(user))
        return Response(body, status=status.HTTP_200_OK)


class ForgotPasswordView(APIView):
    """POST /api/auth/forgot-password/ {identifier} — self-service reset.

    Resolves the account by username / email / mobile, sends a reset OTP by
    SMS, and (anti-enumeration) always returns 200. The frontend then drives
    the SAME OTP-verify → set-password flow used for first login, so the
    tenant can set a new password without any admin involvement.
    """

    permission_classes = [AllowAny]
    throttle_classes   = [ScopedRateThrottle]
    throttle_scope     = "otp_resend"

    def post(self, request):
        ser = ForgotPasswordSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        identifier = ser.validated_data["identifier"].strip()
        user = services.find_user_by_identifier(identifier)
        body = {"detail": "If the account exists, a reset code has been sent by SMS."}
        if user:
            services.send_login_otp(user)
            body["phone_mask"] = _mask_phone(user.phone)
            if settings.DEBUG and sms_service.backend_name() == "console":
                body.update(_maybe_dev_payload(user))
        return Response(body, status=status.HTTP_200_OK)
