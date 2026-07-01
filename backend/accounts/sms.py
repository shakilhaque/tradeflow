"""
SMS abstraction with auto-fallback.

Pick a backend at runtime:

    • SSLWirelessBackend — if `SSL_WIRELESS_API_TOKEN` and `SSL_WIRELESS_SID`
      env vars are set. Sends SMS via the SSL Wireless HTTP API
      (https://smsplus.sslwireless.com/api/v3/send-sms).
    • ConsoleBackend — otherwise. Logs the SMS body at INFO level (and to
      a dedicated file when settings.SMS_LOG_FILE is configured).
      *This is what makes testing without a real SIM possible.*

When DEBUG=True AND the ConsoleBackend is in use, the helper
`get_last_console_otp(user)` exposes the most-recent generated OTP back
to API views so the dev frontend can pre-fill it.

Public API (used by services.py / otp_views.py):
    send_sms(phone, message) -> bool   # True if the gateway accepted
    backend_name()           -> str    # 'ssl_wireless' | 'console'
"""
from __future__ import annotations

import json
import logging
from typing import Iterable, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from django.conf import settings

logger = logging.getLogger("accounts.sms")


# ──────────────────────────────────────────────────────────────────────────────
# Backends
# ──────────────────────────────────────────────────────────────────────────────


class _BaseBackend:
    name = "base"

    def send(self, phone: str, message: str) -> bool:  # pragma: no cover
        raise NotImplementedError


class ConsoleBackend(_BaseBackend):
    """Logs the SMS instead of sending it — used in dev / when no provider creds.

    Output goes to two places:
      • `accounts.sms` logger at INFO (so it appears in gunicorn logs)
      • If `settings.SMS_LOG_FILE` is set, it's also appended there as a
        human-readable line. Useful when testing without a SIM:
            tail -f /var/log/iffaa-sms.log
    """

    name = "console"

    def send(self, phone: str, message: str) -> bool:
        line = f"[SMS → {phone}] {message}"
        logger.info(line)
        log_file = getattr(settings, "SMS_LOG_FILE", None)
        if log_file:
            try:
                with open(log_file, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError as exc:
                logger.warning("Failed to append to SMS_LOG_FILE=%s: %s", log_file, exc)
        return True


class SSLWirelessBackend(_BaseBackend):
    """Send SMS via SSL Wireless SMS-Plus API (Bangladesh).

    Required Django settings (typically loaded from env via python-decouple):
        SSL_WIRELESS_API_TOKEN  — issued by SSL Wireless dashboard.
        SSL_WIRELESS_SID        — sender ID / mask (e.g. "IFFAA").
        SSL_WIRELESS_URL        — optional override; defaults to the v3 endpoint.

    The API expects JSON like:
        {
            "api_token": "...",
            "sid":       "...",
            "msisdn":    "8801XXXXXXXXX",
            "sms":       "your message",
            "csms_id":   "<unique-per-message>"
        }
    """

    name = "ssl_wireless"
    DEFAULT_URL = "https://smsplus.sslwireless.com/api/v3/send-sms"

    def send(self, phone: str, message: str) -> bool:
        ok, _info = self.send_verbose(phone, message)
        return ok

    def send_verbose(self, phone: str, message: str):
        """Like send(), but returns (ok, info) where `info` carries the
        resolved msisdn, the SID/url used, and the FULL parsed SSL Wireless
        response (or the error). Used by the Test-SMS screen + the
        `send_test_sms` management command to surface exactly WHY a number
        fails (masking pending, invalid SID, bad number, low balance, …)."""
        cfg       = get_sms_config()
        api_token = cfg.get("api_token") or ""
        sid       = cfg.get("sid") or ""
        url       = cfg.get("url") or self.DEFAULT_URL
        if not api_token or not sid:
            logger.error("SSL Wireless not configured — falling back to console.")
            return ConsoleBackend().send(phone, message), {"detail": "Gateway not configured (console)."}

        # Normalise phone to MSISDN: SSL Wireless expects digits-only, country
        # code prefix included (e.g. 8801XXXXXXXXX). Accept '+88…' or '01…'.
        msisdn = _normalize_msisdn(phone)
        if not msisdn:
            logger.error("Invalid phone number %r — SMS not sent.", phone)
            return False, {"detail": f"Invalid phone number {phone!r}."}

        from django.utils import timezone as _tz
        import secrets as _secrets
        csms_id = f"iffaa-{int(_tz.now().timestamp())}-{_secrets.token_hex(3)}"

        payload = {
            "api_token": api_token,
            "sid":       sid,
            "msisdn":    msisdn,
            "sms":       message,
            "csms_id":   csms_id,
        }
        body = json.dumps(payload).encode("utf-8")
        req  = Request(url, data=body, headers={"Content-Type": "application/json"})

        info = {"msisdn": msisdn, "sid": sid, "url": url, "csms_id": csms_id}
        try:
            with urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"raw": raw}
            info["response"] = data
            # SSL Wireless responds with {"status": "SUCCESS"|"FAILED", ...}
            ok = str(data.get("status", "")).upper() == "SUCCESS"
            if not ok:
                logger.error("SSL Wireless reported failure for %s: %s", msisdn, data)
            else:
                logger.info("SMS sent to %s via SSL Wireless (csms_id=%s).", msisdn, csms_id)
            return ok, info
        except HTTPError as exc:
            err = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else str(exc)
            logger.error("SSL Wireless HTTP %s for %s: %s", getattr(exc, "code", "?"), msisdn, err)
            info["response"] = {"http_status": getattr(exc, "code", None), "body": err}
            return False, info
        except URLError as exc:
            logger.exception("SSL Wireless request failed for %s: %s", msisdn, exc)
            info["response"] = {"error": str(exc)}
            return False, info

    def get_balance(self):
        """Query the SSL Wireless account SMS balance.

        Returns (balance, raw) where `balance` is a number/str or None on
        failure and `raw` is the parsed response (or an error string) for the
        admin UI. The balance endpoint is derived from the send URL
        (…/send-sms → …/balance); adjust if SSL gives a different path.
        """
        cfg   = get_sms_config()
        token = cfg.get("api_token") or ""
        if not token:
            return None, "SMS gateway not configured."
        base = cfg.get("url") or self.DEFAULT_URL
        balance_url = base.replace("send-sms", "balance")
        body = json.dumps({"api_token": token}).encode("utf-8")
        req  = Request(balance_url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                return None, raw
            # SSL Wireless balance responses vary; probe the common shapes.
            bal = data.get("balance")
            if bal is None and isinstance(data.get("data"), dict):
                d = data["data"]
                bal = d.get("balance") or d.get("sms_balance") or d.get("available")
            return bal, data
        except (HTTPError, URLError) as exc:
            logger.warning("SSL Wireless balance request failed: %s", exc)
            return None, str(exc)


# ──────────────────────────────────────────────────────────────────────────────
# Phone normalisation
# ──────────────────────────────────────────────────────────────────────────────

def _normalize_msisdn(phone: str) -> Optional[str]:
    """
    Return a Bangladesh MSISDN as `880XXXXXXXXXX` (no '+', no spaces) or None.

    Accepts inputs like:
        '01711111111'      → '8801711111111'
        '+8801711111111'   → '8801711111111'
        '8801711111111'    → '8801711111111'
        '01 711 111 111'   → '8801711111111'
    """
    if not phone:
        return None
    digits = "".join(c for c in str(phone) if c.isdigit())
    if not digits:
        return None
    if digits.startswith("88") and len(digits) == 13:
        return digits
    if digits.startswith("0") and len(digits) == 11:
        return "88" + digits
    if digits.startswith("1") and len(digits) == 10:
        return "880" + digits
    # Last resort: 10–14 digit blob — caller validated the input.
    if 10 <= len(digits) <= 14:
        return digits
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

_LAST_OTP_BY_USER: dict = {}  # in-memory cache, dev-only convenience

_TRUTHY = {"1", "true", "yes", "on"}


def get_sms_config() -> dict:
    """Resolve the active SMS gateway config.

    Resolution order per field: PlatformConfig `sms.*` row (admin-panel
    managed, master DB) → Django settings / .env → built-in default. This
    lets a platform admin change the API token / SID from the SMS Gateway
    screen WITHOUT a server restart (no module-level backend cache).

    Returns {enabled, api_token, sid, url}.
    """
    rows = {}
    try:
        from .models import PlatformConfig
        rows = {
            c.key: c.value
            for c in PlatformConfig.objects.filter(
                key__in=["sms.api_token", "sms.sid", "sms.url", "sms.enabled"]
            )
        }
    except Exception:  # noqa: BLE001 — table missing during early migrate, etc.
        rows = {}

    api_token = (rows.get("sms.api_token") or "").strip() or (getattr(settings, "SSL_WIRELESS_API_TOKEN", "") or "")
    sid       = (rows.get("sms.sid") or "").strip() or (getattr(settings, "SSL_WIRELESS_SID", "") or "")
    url       = (rows.get("sms.url") or "").strip() or (getattr(settings, "SSL_WIRELESS_URL", "") or SSLWirelessBackend.DEFAULT_URL)

    enabled_raw = rows.get("sms.enabled")
    # Default ON when nothing explicit is stored — credentials gate the rest.
    enabled = True if enabled_raw is None or enabled_raw == "" else (str(enabled_raw).strip().lower() in _TRUTHY)

    return {"enabled": enabled, "api_token": api_token, "sid": sid, "url": url}


def _select_backend() -> _BaseBackend:
    # No permanent cache — read the live config each time so an admin credential
    # change takes effect immediately. The lookup is one cheap master-DB query.
    cfg = get_sms_config()
    if cfg.get("enabled") and cfg.get("api_token") and cfg.get("sid"):
        return SSLWirelessBackend()
    return ConsoleBackend()


def send_sms(phone: str, message: str) -> bool:
    """Send an SMS via the currently-selected backend. Returns True on success."""
    return _select_backend().send(phone, message)


def backend_name() -> str:
    return _select_backend().name


def remember_dev_otp(user_id, code: str) -> None:
    """Cache the most-recent OTP per user — only meaningful with ConsoleBackend
    in DEBUG mode. Used by API views to surface the code back to the dev
    frontend so testing without a SIM is friction-less.
    """
    _LAST_OTP_BY_USER[str(user_id)] = code


def get_last_dev_otp(user_id) -> Optional[str]:
    """Return the cached OTP for `user_id`, or None.

    Only returns a value when we're in DEBUG mode AND the ConsoleBackend is
    active — never leaks codes in production.
    """
    if not settings.DEBUG:
        return None
    if backend_name() != "console":
        return None
    return _LAST_OTP_BY_USER.get(str(user_id))
