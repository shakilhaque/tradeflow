"""
Master-DB security-event logging.

`record_security_event()` writes one immutable row to `accounts.SecurityEvent`
(master DB). It is deliberately best-effort: any failure is logged and
swallowed so audit logging can never break a login / admin action.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("accounts")


def client_ip(request) -> str | None:
    """Best-effort client IP, honouring the first hop of X-Forwarded-For."""
    if request is None:
        return None
    fwd = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if fwd:
        return fwd.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR") or None


def record_security_event(
    event: str,
    *,
    request=None,
    actor=None,
    actor_email: str = "",
    target: str = "",
    success: bool = True,
    detail: dict | None = None,
) -> None:
    """Append a SecurityEvent row. Never raises into the caller."""
    try:
        from .models import SecurityEvent

        ua = ""
        ip = None
        if request is not None:
            ua = (request.META.get("HTTP_USER_AGENT", "") or "")[:500]
            ip = client_ip(request)

        SecurityEvent.objects.create(
            event       = event,
            actor_id    = getattr(actor, "id", None),
            actor_email = (actor_email or getattr(actor, "email", "") or "")[:254],
            target      = (target or "")[:254],
            success     = success,
            ip_address  = ip,
            user_agent  = ua,
            detail      = detail or {},
        )
    except Exception:  # noqa: BLE001 — audit logging must never break the request
        logger.exception("Failed to record security event '%s'", event)
