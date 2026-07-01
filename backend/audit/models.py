"""
Audit Log — tenant database.

Every CREATE, UPDATE, and DELETE that passes through the audit service is
recorded here.  The table is tenant-scoped so each business has its own
private audit trail.

Design decisions
────────────────
  • user_id is a bare UUIDField (not FK) — the User lives in the master DB.
  • old_value / new_value are JSONField — supports any serializable payload.
  • AuditLog rows are IMMUTABLE — no update/delete is provided by the service.
  • ip_address + user_agent capture the request context where available.
  • module stores 'app.ModelName' (e.g. 'inventory.Product').
"""
import uuid

from django.db import models


class AuditLog(models.Model):
    """Immutable record of a single auditable action."""

    class Action(models.TextChoices):
        CREATE = "CREATE", "Create"
        UPDATE = "UPDATE", "Update"
        DELETE = "DELETE", "Delete"
        VOID   = "VOID",   "Void"
        LOGIN  = "LOGIN",  "Login"
        EXPORT = "EXPORT", "Export"

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Who
    user_id     = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="UUID of the User (from master DB) who performed the action.",
    )
    user_name   = models.CharField(
        max_length=200, blank=True,
        help_text="Snapshot of the user's name at the time of the action.",
    )

    # What
    action      = models.CharField(max_length=10, choices=Action.choices, db_index=True)
    module      = models.CharField(
        max_length=100, db_index=True,
        help_text="App and model name, e.g. 'inventory.Product'.",
    )
    record_id   = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="Primary key of the affected record.",
    )
    record_repr = models.CharField(
        max_length=300, blank=True,
        help_text="Human-readable representation of the record at action time.",
    )

    # Before / after
    old_value   = models.JSONField(
        null=True, blank=True,
        help_text="Serialized state BEFORE the action (null for CREATE).",
    )
    new_value   = models.JSONField(
        null=True, blank=True,
        help_text="Serialized state AFTER the action (null for DELETE).",
    )

    # Context
    ip_address  = models.GenericIPAddressField(null=True, blank=True)
    user_agent  = models.CharField(max_length=500, blank=True)
    extra       = models.JSONField(
        default=dict, blank=True,
        help_text="Any additional context (e.g. endpoint, query params).",
    )

    created_at  = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "audit_logs"
        ordering = ["-created_at"]
        indexes  = [
            models.Index(fields=["module", "record_id"], name="audit_module_record_idx"),
            models.Index(fields=["user_id", "created_at"],  name="audit_user_time_idx"),
            models.Index(fields=["action",  "created_at"],  name="audit_action_time_idx"),
        ]

    def __str__(self):
        return (
            f"{self.created_at:%Y-%m-%d %H:%M}  "
            f"{self.user_name or self.user_id}  "
            f"{self.action}  {self.module}  {self.record_id}"
        )
