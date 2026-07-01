"""
Notification services.

Public API
──────────
  notify_event(event_type, context, *, recipients, related_type, related_id)
      → list[Notification]
      High-level entrypoint. Looks up active templates, renders each channel,
      creates Notification rows, dispatches delivery.

  send_notification(notification_id)
      → None
      Send one Notification row (called by Celery task or inline in EAGER mode).

  notify_low_stock(product)
  notify_new_sale(sale)
  notify_payment_due(sale)
  notify_backorder(product, qty_requested, qty_available)
  notify_sale_voided(sale)
  notify_import_done(batch, created_by_id, recipient_email, recipient_name)
      Domain-specific helpers that build context and call notify_event.

Design
──────
• All DB reads/writes use the tenant alias from _current_db().
• Delivery failures are stored on the Notification row — never raised.
• Email uses Django's send_mail; SMS is a stub (replace with Twilio/Africa's Talking).
• In-app notifications are stored as SENT immediately (they live in the DB).
"""

import logging
from typing import Optional
from uuid import UUID

from django.core.mail import send_mail
from django.conf import settings as django_settings
from django.utils import timezone

from accounts.tenant_db import get_current_db_alias


def _current_db() -> str:
    """Return the active tenant DB alias, falling back to 'default'."""
    return get_current_db_alias() or "default"

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Core dispatcher
# ──────────────────────────────────────────────────────────────────────────────

def notify_event(
    event_type: str,
    context: dict,
    *,
    recipients: list[dict],          # [{id, email, phone, name}, ...]
    related_type: str = "",
    related_id=None,
) -> list:
    """
    Create and dispatch Notification rows for every active template × recipient.

    `recipients` list items may omit any key — use None/empty string for missing.

    Returns the list of created Notification objects.
    """
    from .models import NotificationTemplate, Notification
    db = _current_db()

    templates = list(
        NotificationTemplate.objects.using(db).filter(
            event_type=event_type, is_active=True
        )
    )
    if not templates:
        logger.debug("No active templates for event_type=%s", event_type)
        return []

    created: list = []
    for tmpl in templates:
        subject, body = tmpl.render(context)
        for rec in recipients:
            notif = Notification.objects.using(db).create(
                template=tmpl,
                event_type=event_type,
                channel=tmpl.channel,
                recipient_id=rec.get("id"),
                recipient_email=rec.get("email", ""),
                recipient_phone=rec.get("phone", ""),
                recipient_name=rec.get("name", ""),
                subject=subject,
                body=body,
                context=context,
                related_type=related_type,
                related_id=related_id,
            )
            # Dispatch immediately (Celery task or synchronous fallback)
            _dispatch(notif)
            created.append(notif)

    return created


def _dispatch(notification) -> None:
    """Send one notification.  In Celery mode, enqueue a task; otherwise send inline."""
    try:
        from .tasks import deliver_notification
        deliver_notification.delay(str(notification.pk))
    except Exception:
        # Celery not available or ALWAYS_EAGER — fall back to synchronous
        send_notification(str(notification.pk))


# ──────────────────────────────────────────────────────────────────────────────
# Delivery
# ──────────────────────────────────────────────────────────────────────────────

def send_notification(notification_id: str) -> None:
    """
    Deliver one Notification record.  Called by the Celery task.

    Catches all exceptions so a delivery failure never raises to the caller.
    """
    from .models import Notification
    db = _current_db()

    try:
        notif = Notification.objects.using(db).get(pk=notification_id)
    except Notification.DoesNotExist:
        logger.error("send_notification: Notification %s not found.", notification_id)
        return

    if notif.status not in (Notification.Status.PENDING,):
        logger.debug("Notification %s already %s — skipping.", notification_id, notif.status)
        return

    try:
        if notif.channel == "EMAIL":
            _send_email(notif)
        elif notif.channel == "SMS":
            _send_sms(notif)
        elif notif.channel == "IN_APP":
            _send_in_app(notif)
        else:
            raise ValueError(f"Unknown channel: {notif.channel}")
        notif.mark_sent()
    except Exception as exc:
        logger.exception("Notification delivery failed [%s]: %s", notification_id, exc)
        notif.mark_failed(str(exc))


def _send_email(notification) -> None:
    """Send email via Django's email backend."""
    if not notification.recipient_email:
        raise ValueError("No recipient email address.")
    send_mail(
        subject=notification.subject or notification.event_type,
        message=notification.body,
        from_email=django_settings.DEFAULT_FROM_EMAIL,
        recipient_list=[notification.recipient_email],
        fail_silently=False,
    )
    logger.info("Email sent to %s for event %s", notification.recipient_email, notification.event_type)


def _send_sms(notification) -> None:
    """
    SMS delivery stub.

    Replace this with your SMS provider (Twilio, Africa's Talking, etc.).
    For now we log the message and mark it sent.
    """
    if not notification.recipient_phone:
        raise ValueError("No recipient phone number.")
    # TODO: integrate SMS provider
    logger.info(
        "SMS [STUB] to %s: %s",
        notification.recipient_phone,
        notification.body[:160],
    )


def _send_in_app(notification) -> None:
    """
    In-app notifications are stored in the DB.
    We mark them SENT immediately — the frontend polls GET /api/notifications/.
    """
    pass   # Nothing to do — the DB row IS the notification


# ──────────────────────────────────────────────────────────────────────────────
# Domain helpers
# ──────────────────────────────────────────────────────────────────────────────

def notify_low_stock(product, current_qty, reorder_level, *, owner_recipients: list[dict]) -> list:
    """
    Fire LOW_STOCK notification.

    owner_recipients: list of [{id, email, phone, name}] for store owner / managers.
    """
    context = {
        "product_name": product.name,
        "sku":          product.sku,
        "current_qty":  str(current_qty),
        "reorder_level": str(reorder_level),
    }
    return notify_event(
        "LOW_STOCK",
        context,
        recipients=owner_recipients,
        related_type="inventory.Product",
        related_id=product.pk,
    )


def notify_new_sale(sale, *, recipients: list[dict]) -> list:
    """Fire NEW_SALE notification for the customer and/or owner."""
    context = {
        "sale_number":   str(sale.pk)[:8].upper(),
        "total_amount":  str(sale.total_amount),
        "payment_status": sale.payment_status.upper(),
        "date":          sale.created_at.strftime("%Y-%m-%d"),
    }
    return notify_event(
        "NEW_SALE",
        context,
        recipients=recipients,
        related_type="sales.Sale",
        related_id=sale.pk,
    )


def notify_payment_due(sale, *, recipients: list[dict]) -> list:
    """Fire PAYMENT_DUE notification for outstanding balances."""
    balance = sale.total_amount - sale.amount_paid
    context = {
        "sale_number":    str(sale.pk)[:8].upper(),
        "total_amount":   str(sale.total_amount),
        "amount_paid":    str(sale.amount_paid),
        "balance_due":    str(balance),
        "payment_status": sale.payment_status.upper(),
    }
    return notify_event(
        "PAYMENT_DUE",
        context,
        recipients=recipients,
        related_type="sales.Sale",
        related_id=sale.pk,
    )


def notify_backorder(product, qty_requested, qty_available, *, recipients: list[dict]) -> list:
    """Fire BACKORDER notification when a sale request exceeds available stock."""
    context = {
        "product_name":  product.name,
        "sku":           product.sku,
        "qty_requested": str(qty_requested),
        "qty_available": str(qty_available),
        "shortage":      str(qty_requested - qty_available),
    }
    return notify_event(
        "BACKORDER",
        context,
        recipients=recipients,
        related_type="inventory.Product",
        related_id=product.pk,
    )


def notify_sale_voided(sale, *, recipients: list[dict]) -> list:
    """Fire SALE_VOIDED notification."""
    context = {
        "sale_number":  str(sale.pk)[:8].upper(),
        "total_amount": str(sale.total_amount),
        "void_reason":  sale.void_reason if hasattr(sale, "void_reason") else "",
    }
    return notify_event(
        "SALE_VOIDED",
        context,
        recipients=recipients,
        related_type="sales.Sale",
        related_id=sale.pk,
    )


def notify_import_done(batch, *, recipients: list[dict]) -> list:
    """Fire IMPORT_DONE notification after a successful commit."""
    context = {
        "import_type":    batch.import_type,
        "committed_rows": str(batch.committed_rows or 0),
        "file_name":      batch.file_name,
        "committed_at":   batch.committed_at.strftime("%Y-%m-%d %H:%M") if batch.committed_at else "",
    }
    return notify_event(
        "IMPORT_DONE",
        context,
        recipients=recipients,
        related_type="imports.ImportBatch",
        related_id=batch.pk,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Read helpers
# ──────────────────────────────────────────────────────────────────────────────

def get_user_notifications(user_id, *, limit: int = 50, unread_only: bool = False) -> list:
    """Return in-app notifications for a user, newest first."""
    from .models import Notification
    db = _current_db()
    qs = Notification.objects.using(db).filter(
        recipient_id=user_id,
        channel="IN_APP",
    )
    if unread_only:
        qs = qs.filter(status=Notification.Status.SENT)
    return list(qs[:limit])


def mark_notification_read(notification_id, user_id) -> bool:
    """Mark an in-app notification as READ. Returns True on success."""
    from .models import Notification
    db = _current_db()
    try:
        notif = Notification.objects.using(db).get(
            pk=notification_id, recipient_id=user_id, channel="IN_APP"
        )
        notif.mark_read()
        return True
    except Notification.DoesNotExist:
        return False


def get_unread_count(user_id) -> int:
    """Fast unread in-app notification count."""
    from .models import Notification
    db = _current_db()
    return Notification.objects.using(db).filter(
        recipient_id=user_id,
        channel="IN_APP",
        status=Notification.Status.SENT,
    ).count()
