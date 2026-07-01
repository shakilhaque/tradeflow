"""
Celery tasks for the notifications module.

Tasks
─────
  deliver_notification(notification_id)
      — Send one pending Notification record.

  check_low_stock_task()
      — Periodic task: scan all tenant DBs, fire LOW_STOCK alerts for
        products whose total FIFO stock ≤ reorder_level.
        Runs every hour via Celery Beat (configured in management or Beat admin).

  send_pending_notifications()
      — Periodic task: retry any PENDING notifications older than 5 minutes
        that were missed (e.g. Celery was down).
        Runs every 15 minutes.

Important: These tasks must be imported by the Celery app's autodiscover.
The Celery app is assumed to be at config/celery.py with:
    app.autodiscover_tasks(['notifications'])
"""

import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def deliver_notification(self, notification_id: str):
    """
    Send one Notification by its primary key.

    Retries up to 3 times with a 60-second delay on transient errors
    (e.g. SMTP timeout, network hiccup).
    """
    from accounts.tenant_db import _current_db
    from notifications.services import send_notification

    try:
        send_notification(notification_id)
    except Exception as exc:
        logger.warning(
            "deliver_notification %s failed (attempt %d): %s",
            notification_id, self.request.retries + 1, exc,
        )
        raise self.retry(exc=exc)


@shared_task
def check_low_stock_task():
    """
    Scan all provisioned tenant databases for products with low stock.

    For each tenant DB:
      • Fetch all active products (with reorder_level > 0)
      • Compare total FIFO remaining_qty against reorder_level
      • Fire LOW_STOCK notification for products at or below reorder_level

    This task is tenant-aware: it iterates over all registered tenant DBs,
    sets the thread-local alias before querying, and resets it after.
    """
    from django.db import connections
    from accounts.models import Tenant
    from accounts.tenant_db import set_current_db_alias as set_current_db, get_current_db_alias
    _current_db = lambda: get_current_db_alias() or "default"  # noqa: E731

    try:
        tenants = list(Tenant.objects.filter(is_provisioned=True).values("db_alias"))
    except Exception as exc:
        logger.error("check_low_stock_task: failed to load tenant list: %s", exc)
        return

    for tenant in tenants:
        db_alias = tenant["db_alias"]
        set_current_db(db_alias)
        try:
            _check_low_stock_for_db(db_alias)
        except Exception as exc:
            logger.error(
                "check_low_stock_task: error for tenant DB '%s': %s", db_alias, exc
            )
        finally:
            set_current_db(None)


def _check_low_stock_for_db(db_alias: str):
    """Core low-stock check for a single tenant DB."""
    from django.db.models import Sum
    from inventory.models import Product, FIFOLayer
    from notifications.services import notify_low_stock

    # Find products with reorder_level set
    products_with_reorder = Product.objects.using(db_alias).filter(
        is_active=True,
        reorder_level__gt=0,
        is_deleted=False,
    ).values("pk", "name", "sku", "reorder_level")

    if not products_with_reorder:
        return

    # Aggregate remaining FIFO qty per product in one query
    fifo_totals = dict(
        FIFOLayer.objects.using(db_alias)
        .filter(product_id__in=[p["pk"] for p in products_with_reorder], remaining_qty__gt=0)
        .values("product_id")
        .annotate(total=Sum("remaining_qty"))
        .values_list("product_id", "total")
    )

    # Build owner/manager recipient list (use the owner's email from master)
    # We load owner users for this tenant from the master DB.
    recipients = _get_owner_recipients(db_alias)
    if not recipients:
        return

    for prod in products_with_reorder:
        total_qty = fifo_totals.get(prod["pk"], 0) or 0
        if total_qty <= prod["reorder_level"]:
            # Reconstruct a minimal product-like object for the service call
            class _Stub:
                pk = prod["pk"]
                name = prod["name"]
                sku = prod["sku"]

            try:
                notify_low_stock(
                    product=_Stub(),
                    current_qty=total_qty,
                    reorder_level=prod["reorder_level"],
                    owner_recipients=recipients,
                )
            except Exception as exc:
                logger.error(
                    "Low-stock notification failed for product %s: %s", prod["sku"], exc
                )


def _get_owner_recipients(db_alias: str) -> list[dict]:
    """
    Build recipient list from master-DB users who are owner/admin for this tenant.

    Returns [{id, email, name, phone}] or [] on failure.
    """
    try:
        from accounts.models import User, Tenant
        tenant = Tenant.objects.filter(db_alias=db_alias).select_related("user").first()
        if not tenant:
            return []
        owner = tenant.user
        recipients = [{"id": owner.pk, "email": owner.email, "name": owner.name, "phone": ""}]

        # Also include admin users for this tenant
        admins = User.objects.filter(
            tenant=tenant,
            role__in=["admin", "manager"],
            is_active=True,
        ).values("id", "email", "name")
        for a in admins:
            recipients.append({"id": a["id"], "email": a["email"], "name": a["name"], "phone": ""})

        return recipients
    except Exception as exc:
        logger.error("_get_owner_recipients for %s failed: %s", db_alias, exc)
        return []


@shared_task
def send_pending_notifications():
    """
    Retry PENDING notifications older than 5 minutes.

    Handles Celery-was-down scenarios by re-dispatching missed deliveries.
    """
    from datetime import timedelta
    from accounts.models import Tenant
    from accounts.tenant_db import set_current_db_alias as set_current_db

    cutoff = timezone.now() - timedelta(minutes=5)

    try:
        tenants = list(Tenant.objects.filter(is_provisioned=True).values("db_alias"))
    except Exception as exc:
        logger.error("send_pending_notifications: failed to load tenants: %s", exc)
        return

    for tenant in tenants:
        db_alias = tenant["db_alias"]
        set_current_db(db_alias)
        try:
            from notifications.models import Notification
            stale = Notification.objects.using(db_alias).filter(
                status=Notification.Status.PENDING,
                created_at__lte=cutoff,
            ).values_list("pk", flat=True)[:100]

            for notif_id in stale:
                deliver_notification.delay(str(notif_id))
                logger.info("Re-queued stale notification %s for %s", notif_id, db_alias)
        except Exception as exc:
            logger.error(
                "send_pending_notifications: error for %s: %s", db_alias, exc
            )
        finally:
            set_current_db(None)
