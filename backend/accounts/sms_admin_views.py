"""
Platform-admin SMS Gateway settings (SSL Wireless).

  GET   /api/admin/sms-gateway/          → current config (token masked) + status
  PUT   /api/admin/sms-gateway/          → save api_token / sid / url / enabled
  POST  /api/admin/sms-gateway/test/     → send a real test SMS
  POST  /api/admin/sms-gateway/balance/  → query + cache the SSL Wireless balance

Credentials live in the master-DB `PlatformConfig` key/value store (same store
the Support-Info screen uses), so a change here takes effect for every tenant
without a server restart — `accounts.sms.get_sms_config()` reads these keys.
"""
from rest_framework import status as http
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import sms as sms_mod


SMS_KEYS = ["sms.enabled", "sms.api_token", "sms.sid", "sms.url",
            "sms.balance", "sms.balance_synced_at",
            "sms.last_test_status", "sms.last_test_at"]


def _is_admin(u) -> bool:
    return bool(u and (u.is_staff or u.is_superuser))


def _rows() -> dict:
    from .models import PlatformConfig
    return {c.key: c.value for c in PlatformConfig.objects.filter(key__in=SMS_KEYS)}


def _set(key, value):
    from .models import PlatformConfig
    PlatformConfig.objects.update_or_create(key=key, defaults={"value": str(value if value is not None else "")})


def _mask(token: str) -> str:
    token = token or ""
    if len(token) <= 4:
        return "••••" if token else ""
    return "••••••" + token[-4:]


def _payload() -> dict:
    rows = _rows()
    cfg = sms_mod.get_sms_config()          # resolved (PlatformConfig → env)
    has_token = bool(cfg.get("api_token"))
    configured = bool(cfg.get("api_token") and cfg.get("sid"))
    return {
        "provider":           "SSL Wireless",
        "enabled":            cfg.get("enabled", True),
        "has_token":          has_token,
        "api_token_masked":   _mask(cfg.get("api_token")),
        "sid":                cfg.get("sid", ""),
        "url":                cfg.get("url", ""),
        "configured":         configured,
        "live_backend":       sms_mod.backend_name(),     # 'ssl_wireless' | 'console'
        "status":             ("connected" if (configured and cfg.get("enabled") and sms_mod.backend_name() == "ssl_wireless")
                               else "not_configured"),
        "balance":            rows.get("sms.balance", ""),
        "balance_synced_at":  rows.get("sms.balance_synced_at", ""),
        "last_test_status":   rows.get("sms.last_test_status", ""),
        "last_test_at":       rows.get("sms.last_test_at", ""),
    }


class AdminSmsGatewayView(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None

    def get(self, request):
        if (r := self._guard(request)) is not None:
            return r
        return Response(_payload())

    def put(self, request):
        if (r := self._guard(request)) is not None:
            return r
        data = request.data or {}
        # Only overwrite the token when a genuine new value is sent (the GET
        # returns a masked placeholder, so a blank / masked value = "keep").
        if "api_token" in data:
            tok = str(data.get("api_token") or "").strip()
            if tok and "•" not in tok:
                _set("sms.api_token", tok)
        if "sid" in data:
            _set("sms.sid", str(data.get("sid") or "").strip())
        if "url" in data:
            _set("sms.url", str(data.get("url") or "").strip())
        if "enabled" in data:
            _set("sms.enabled", "1" if data.get("enabled") else "0")
        from .security_log import record_security_event
        record_security_event(
            "sms_config", request=request, actor=request.user,
            actor_email=getattr(request.user, "email", ""),
            target="sms.gateway",
            detail={"fields": [k for k in ("api_token", "sid", "url", "enabled") if k in data]},
        )
        return Response(_payload())


class AdminSmsGatewayTestView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        from django.utils import timezone
        data = request.data or {}
        phone = str(data.get("phone") or "").strip()
        if not phone:
            return Response({"detail": "Phone number is required."}, status=http.HTTP_400_BAD_REQUEST)
        message = str(data.get("message") or "").strip() or \
            "IFFAA test SMS — your SSL Wireless gateway is configured correctly."

        if sms_mod.backend_name() == "ssl_wireless":
            ok, info = sms_mod.SSLWirelessBackend().send_verbose(phone, message)
        else:
            ok, info = sms_mod.send_sms(phone, message), {"detail": "Console backend — no real SMS sent."}

        _set("sms.last_test_status", "success" if ok else "failed")
        _set("sms.last_test_at", timezone.now().isoformat())
        return Response({
            "sent": bool(ok),
            "backend": sms_mod.backend_name(),
            "msisdn": info.get("msisdn"),
            "response": info.get("response"),     # raw SSL reply for diagnosis
            "detail": ("Test SMS accepted by the gateway. If the phone still gets nothing, "
                       "it's an operator/masking delivery issue on SSL's side." if ok
                       else "Gateway rejected the SMS — see the response for the exact reason "
                            "(token / SID / masking / balance)."),
        })


class AdminSmsGatewayBalanceView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        from django.utils import timezone
        balance, raw = sms_mod.SSLWirelessBackend().get_balance()
        if balance is not None:
            _set("sms.balance", str(balance))
            _set("sms.balance_synced_at", timezone.now().isoformat())
        return Response({
            "balance": balance,
            "synced_at": _rows().get("sms.balance_synced_at", ""),
            "raw": raw if isinstance(raw, (str, int, float)) else None,
            "ok": balance is not None,
        })
