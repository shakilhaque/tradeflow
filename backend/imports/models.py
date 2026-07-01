"""
Import module models — stored in each TENANT's dedicated PostgreSQL database.

Flow
────
  1. Client POSTs a CSV/Excel file  → validate_import() is called
  2. File is parsed + validated (NO DB write to business tables)
  3. An ImportBatch row is created with status=VALIDATED or HAS_ERRORS
  4. Client GETs the batch to inspect errors
  5. If no errors, client POSTs to commit/ → commit_import() runs inside
     one atomic transaction (product creation, FIFO layers, expense JEs, …)
  6. Batch status becomes COMMITTED; expires_at is past → batch row can be
     pruned by a scheduled cleanup task.

ImportBatch.validated_data stores the cleaned rows as JSON so the commit
step never re-parses the original file.
"""

import uuid
from django.db import models
from django.utils import timezone


def _default_expires_at():
    """Batch rows expire 24 hours after creation."""
    from datetime import timedelta
    return timezone.now() + timedelta(hours=24)


class ImportBatch(models.Model):
    """One file-upload/validate/commit cycle."""

    class ImportType(models.TextChoices):
        PRODUCT  = "PRODUCT",  "Products"
        EXPENSE  = "EXPENSE",  "Expenses"
        ORDER    = "ORDER",    "Orders"
        SUPPLIER = "SUPPLIER", "Suppliers"
        CONTACT  = "CONTACT",  "Contacts"

    class Status(models.TextChoices):
        PENDING    = "PENDING",    "Pending Validation"
        VALIDATED  = "VALIDATED",  "Validated (ready to commit)"
        HAS_ERRORS = "HAS_ERRORS", "Has Validation Errors"
        COMMITTED  = "COMMITTED",  "Committed"
        EXPIRED    = "EXPIRED",    "Expired"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    import_type    = models.CharField(
        max_length=10,
        choices=ImportType.choices,
        db_index=True,
    )
    status         = models.CharField(
        max_length=12,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    file_name      = models.CharField(max_length=255)

    # ── Row counters ──────────────────────────────────────────────────────────
    total_rows     = models.PositiveIntegerField(default=0)
    valid_rows     = models.PositiveIntegerField(default=0)
    error_count    = models.PositiveIntegerField(default=0)

    # ── Validation result (written once by validate_import) ───────────────────
    # errors: list of {row: int, field: str, message: str}
    errors         = models.JSONField(default=list)
    # validated_data: list of clean row dicts, ready to commit
    validated_data = models.JSONField(default=list)

    # ── Commit result (written once by commit_import) ─────────────────────────
    committed_rows = models.PositiveIntegerField(null=True, blank=True)
    committed_at   = models.DateTimeField(null=True, blank=True)

    # ── Ownership ─────────────────────────────────────────────────────────────
    created_by_id  = models.UUIDField(
        db_index=True,
        help_text="UUID of the User who uploaded this file.",
    )
    created_at     = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at     = models.DateTimeField(
        default=_default_expires_at,
        db_index=True,
        help_text="Batch row is safe to prune after this datetime.",
    )

    class Meta:
        db_table = "import_batches"
        ordering = ["-created_at"]
        indexes  = [
            models.Index(
                fields=["import_type", "status"],
                name="import_type_status_idx",
            ),
            models.Index(
                fields=["created_by_id", "created_at"],
                name="import_user_date_idx",
            ),
        ]

    def __str__(self):
        return (
            f"ImportBatch [{self.import_type}] {self.status} "
            f"rows={self.total_rows} err={self.error_count}"
        )

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    @property
    def can_commit(self) -> bool:
        return self.status == self.Status.VALIDATED and not self.is_expired
