"""
Notifications module models — stored in each TENANT's dedicated PostgreSQL database.

Tables
──────
  notification_templates  — message templates per event type and channel
  notifications           — individual delivery records (one per channel per recipient)

Design notes
────────────
• Templates are seeded by migration 0002 with sensible defaults.
• A single business event (e.g. LOW_STOCK) may produce multiple Notification rows
  if both email and in-app channels are active for the recipient.
• Notification rows are write-mostly and read rarely — index on (status, created_at).
• The `context` JSONField stores template substitution variables at send time so
  the rendered body is always reproducible even if the template changes later.
"""

import uuid
from django.db import models
from django.utils import timezone


class NotificationTemplate(models.Model):
    """
    Parameterised message template for one event + channel combination.

    subject_template / body_template use simple {variable} substitution.
    Available variables depend on the event_type (see services.py).
    """

    class EventType(models.TextChoices):
        LOW_STOCK    = "LOW_STOCK",    "Low Stock Alert"
        NEW_SALE     = "NEW_SALE",     "New Sale"
        PAYMENT_DUE  = "PAYMENT_DUE",  "Payment Due"
        BACKORDER    = "BACKORDER",    "Backorder Alert"
        SALE_VOIDED  = "SALE_VOIDED",  "Sale Voided"
        IMPORT_DONE  = "IMPORT_DONE",  "Import Completed"

    class Channel(models.TextChoices):
        EMAIL  = "EMAIL",  "Email"
        SMS    = "SMS",    "SMS"
        IN_APP = "IN_APP", "In-App"

    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event_type       = models.CharField(max_length=20, choices=EventType.choices, db_index=True)
    channel          = models.CharField(max_length=10, choices=Channel.choices, db_index=True)
    name             = models.CharField(max_length=200)
    subject_template = models.CharField(
        max_length=500,
        blank=True,
        help_text="Used for email/SMS. Supports {variable} substitution.",
    )
    body_template    = models.TextField(
        help_text="Full message body. Supports {variable} substitution.",
    )
    is_active        = models.BooleanField(default=True, db_index=True)
    created_at       = models.DateTimeField(auto_now_add=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        db_table        = "notification_templates"
        unique_together = [["event_type", "channel"]]
        ordering        = ["event_type", "channel"]

    def __str__(self):
        return f"{self.get_event_type_display()} / {self.get_channel_display()}"

    def render(self, context: dict) -> tuple[str, str]:
        """
        Return (subject, body) with {variable} placeholders substituted.
        Missing keys are left as-is (no KeyError).
        """
        import string

        class _SafeDict(dict):
            def __missing__(self, key):
                return f"{{{key}}}"

        safe = _SafeDict(context)
        subject = self.subject_template.format_map(safe)
        body    = self.body_template.format_map(safe)
        return subject, body


class Notification(models.Model):
    """
    One delivery attempt for a single recipient via a single channel.

    Lifecycle: PENDING → SENT or FAILED
    Failed notifications can be retried by resetting status to PENDING
    and re-enqueuing the Celery task.
    """

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        SENT    = "SENT",    "Sent"
        FAILED  = "FAILED",  "Failed"
        READ    = "READ",    "Read"   # in-app only

    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template         = models.ForeignKey(
        NotificationTemplate,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="notifications",
    )
    event_type       = models.CharField(max_length=20, db_index=True)
    channel          = models.CharField(max_length=10, db_index=True)

    # Recipient info (no FK to accounts.User — cross-DB boundary)
    recipient_id     = models.UUIDField(null=True, blank=True, db_index=True)
    recipient_email  = models.EmailField(blank=True)
    recipient_phone  = models.CharField(max_length=30, blank=True)
    recipient_name   = models.CharField(max_length=200, blank=True)

    # Rendered content (stored at send time — template may change later)
    subject          = models.CharField(max_length=500, blank=True)
    body             = models.TextField()

    # Substitution variables used to render the message
    context          = models.JSONField(default=dict)

    # Delivery state
    status           = models.CharField(
        max_length=10,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    sent_at          = models.DateTimeField(null=True, blank=True)
    read_at          = models.DateTimeField(null=True, blank=True)
    error_message    = models.TextField(blank=True)

    # Source reference
    related_type     = models.CharField(max_length=100, blank=True, db_index=True)
    related_id       = models.UUIDField(null=True, blank=True, db_index=True)

    created_at       = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "notifications"
        ordering = ["-created_at"]
        indexes  = [
            models.Index(
                fields=["status", "channel"],
                name="notif_status_channel_idx",
            ),
            models.Index(
                fields=["recipient_id", "status"],
                name="notif_recipient_status_idx",
            ),
            models.Index(
                fields=["event_type", "created_at"],
                name="notif_event_date_idx",
            ),
        ]

    def __str__(self):
        return (
            f"[{self.channel}] {self.event_type} → "
            f"{self.recipient_email or self.recipient_id} [{self.status}]"
        )

    def mark_sent(self):
        self.status = self.Status.SENT
        self.sent_at = timezone.now()
        self.save(update_fields=["status", "sent_at"])

    def mark_failed(self, error: str):
        self.status = self.Status.FAILED
        self.error_message = error[:2000]
        self.save(update_fields=["status", "error_message"])

    def mark_read(self):
        if self.channel == "IN_APP" and self.status != self.Status.READ:
            self.status = self.Status.READ
            self.read_at = timezone.now()
            self.save(update_fields=["status", "read_at"])
