"""
Audit Log service layer.

Public API
──────────
  log_action(...)          Write one audit log entry to the current tenant DB.
  log_from_request(...)    Convenience wrapper that extracts context from a DRF request.
  get_audit_logs(...)      Query audit logs with filters.

Usage
─────
  from audit.services import log_action, AuditAction

  # In a service function or view:
  log_action(
      user_id    = request.user.id,
      user_name  = request.user.name,
      action     = AuditAction.UPDATE,
      module     = "inventory.Product",
      record_id  = product.id,
      old_value  = {"price": 100},
      new_value  = {"price": 85},
      ip_address = get_client_ip(request),
  )

RULES
─────
  • AuditLog rows are WRITE-ONLY from this module — never updated or deleted.
  • Failures are logged but NEVER propagate — audit logging must not break
    the main operation.  Wrap in try/except if calling from critical paths.
  • The DB alias is resolved at call time via _current_db().
"""

import logging
import uuid
from datetime import date as date_type
from typing import Any, Optional

from .models import AuditLog

logger = logging.getLogger(__name__)


# ── Re-export Action choices for convenience ──────────────────────────────────
AuditAction = AuditLog.Action


# ──────────────────────────────────────────────────────────────────────────────
# DB alias helper
# ──────────────────────────────────────────────────────────────────────────────

def _current_db() -> str:
    try:
        from accounts.tenant_db import get_current_db_alias  # noqa: PLC0415
        return get_current_db_alias() or "default"
    except ImportError:
        return "default"


# ──────────────────────────────────────────────────────────────────────────────
# Client IP helper
# ──────────────────────────────────────────────────────────────────────────────

def get_client_ip(request) -> Optional[str]:
    """
    Extract the real client IP from a Django/DRF request.
    Handles X-Forwarded-For (proxy / load balancer).
    """
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR") or None


# ──────────────────────────────────────────────────────────────────────────────
# 1. Core writer
# ──────────────────────────────────────────────────────────────────────────────

def log_action(
    *,
    action: str,
    module: str,
    user_id=None,
    user_name: str = "",
    record_id=None,
    record_repr: str = "",
    old_value: Optional[dict] = None,
    new_value: Optional[dict] = None,
    ip_address: Optional[str] = None,
    user_agent: str = "",
    extra: Optional[dict] = None,
) -> Optional[AuditLog]:
    """
    Write one audit log entry to the current tenant DB.

    Parameters
    ──────────
    action       One of AuditLog.Action choices.
    module       'app.ModelName' string, e.g. 'inventory.Product'.
    user_id      UUID of the acting user (nullable for system actions).
    user_name    Snapshot of user's display name.
    record_id    UUID PK of the affected record.
    record_repr  str(record) at action time.
    old_value    Dict of changed fields BEFORE the action (None for CREATE).
    new_value    Dict of changed fields AFTER the action (None for DELETE).
    ip_address   Client IP string.
    user_agent   Browser / API client identifier.
    extra        Any additional context dict.

    Returns the created AuditLog or None if writing failed.
    """
    db = _current_db()
    try:
        entry = AuditLog.objects.using(db).create(
            user_id     = user_id,
            user_name   = user_name or "",
            action      = action,
            module      = module,
            record_id   = record_id,
            record_repr = record_repr or "",
            old_value   = old_value,
            new_value   = new_value,
            ip_address  = ip_address,
            user_agent  = user_agent or "",
            extra       = extra or {},
        )
        logger.debug(
            "AuditLog[%s]: %s %s id=%s by=%s",
            entry.id, action, module, record_id, user_id,
        )
        return entry
    except Exception as exc:
        # Audit logging must NEVER break the main business operation.
        logger.error("AuditLog write failed: %s | %s %s id=%s", exc, action, module, record_id)
        return None


# ──────────────────────────────────────────────────────────────────────────────
# 2. Request-aware convenience wrapper
# ──────────────────────────────────────────────────────────────────────────────

def log_from_request(
    request,
    *,
    action: str,
    module: str,
    record_id=None,
    record_repr: str = "",
    old_value: Optional[dict] = None,
    new_value: Optional[dict] = None,
    extra: Optional[dict] = None,
) -> Optional[AuditLog]:
    """
    Convenience wrapper that extracts user context from a DRF request.

    Example:
        log_from_request(
            request,
            action      = AuditAction.UPDATE,
            module      = "inventory.Product",
            record_id   = product.id,
            old_value   = {"price": str(old_price)},
            new_value   = {"price": str(new_price)},
        )
    """
    user    = getattr(request, "user", None)
    user_id = str(user.id)   if user and user.is_authenticated else None
    name    = user.name      if user and user.is_authenticated else ""

    return log_action(
        action      = action,
        module      = module,
        user_id     = user_id,
        user_name   = name,
        record_id   = record_id,
        record_repr = record_repr,
        old_value   = old_value,
        new_value   = new_value,
        ip_address  = get_client_ip(request),
        user_agent  = request.META.get("HTTP_USER_AGENT", "")[:500],
        extra       = extra,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 3. Query helper
# ──────────────────────────────────────────────────────────────────────────────

def get_audit_logs(
    *,
    action: Optional[str]     = None,
    module: Optional[str]     = None,
    user_id                   = None,
    record_id                 = None,
    date_from: Optional[date_type] = None,
    date_to:   Optional[date_type] = None,
    limit: int                = 100,
    offset: int               = 0,
) -> list:
    """
    Return audit logs from the current tenant DB, filtered and paginated.

    Parameters
    ──────────
    action      Filter by AuditLog.Action choice.
    module      Filter by module string (exact match).
    user_id     Filter by user UUID.
    record_id   Filter by affected record UUID.
    date_from   Inclusive start date.
    date_to     Inclusive end date.
    limit       Maximum rows to return (capped at 500).
    offset      Skip this many rows (for pagination).
    """
    db  = _current_db()
    qs  = AuditLog.objects.using(db).order_by("-created_at")

    if action:
        qs = qs.filter(action=action.upper())
    if module:
        qs = qs.filter(module__icontains=module)
    if user_id:
        qs = qs.filter(user_id=user_id)
    if record_id:
        qs = qs.filter(record_id=record_id)
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)

    limit = min(int(limit), 500)
    return list(qs[offset : offset + limit])
