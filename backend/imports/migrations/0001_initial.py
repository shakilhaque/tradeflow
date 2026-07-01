"""
Migration 0001 — Create import_batches table in tenant databases.

This table lives in each tenant's dedicated PostgreSQL database.
The TenantDatabaseRouter ensures it is never created in the master DB.
"""

import imports.models
import django.utils.timezone
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="ImportBatch",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "import_type",
                    models.CharField(
                        choices=[
                            ("PRODUCT", "Products"),
                            ("EXPENSE", "Expenses"),
                            ("ORDER", "Orders"),
                        ],
                        db_index=True,
                        max_length=10,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("PENDING",    "Pending Validation"),
                            ("VALIDATED",  "Validated (ready to commit)"),
                            ("HAS_ERRORS", "Has Validation Errors"),
                            ("COMMITTED",  "Committed"),
                            ("EXPIRED",    "Expired"),
                        ],
                        db_index=True,
                        default="PENDING",
                        max_length=12,
                    ),
                ),
                ("file_name",      models.CharField(max_length=255)),
                ("total_rows",     models.PositiveIntegerField(default=0)),
                ("valid_rows",     models.PositiveIntegerField(default=0)),
                ("error_count",    models.PositiveIntegerField(default=0)),
                ("errors",         models.JSONField(default=list)),
                ("validated_data", models.JSONField(default=list)),
                ("committed_rows", models.PositiveIntegerField(blank=True, null=True)),
                ("committed_at",   models.DateTimeField(blank=True, null=True)),
                ("created_by_id",  models.UUIDField(db_index=True)),
                (
                    "created_at",
                    models.DateTimeField(auto_now_add=True, db_index=True),
                ),
                (
                    "expires_at",
                    models.DateTimeField(
                        db_index=True,
                        default=imports.models._default_expires_at,
                    ),
                ),
            ],
            options={
                "db_table": "import_batches",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="importbatch",
            index=models.Index(
                fields=["import_type", "status"],
                name="import_type_status_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="importbatch",
            index=models.Index(
                fields=["created_by_id", "created_at"],
                name="import_user_date_idx",
            ),
        ),
    ]
