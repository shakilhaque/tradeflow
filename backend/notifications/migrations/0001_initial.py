"""
Migration 0001 — Create notification tables in tenant databases.
"""

import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="NotificationTemplate",
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
                    "event_type",
                    models.CharField(
                        choices=[
                            ("LOW_STOCK",   "Low Stock Alert"),
                            ("NEW_SALE",    "New Sale"),
                            ("PAYMENT_DUE", "Payment Due"),
                            ("BACKORDER",   "Backorder Alert"),
                            ("SALE_VOIDED", "Sale Voided"),
                            ("IMPORT_DONE", "Import Completed"),
                        ],
                        db_index=True,
                        max_length=20,
                    ),
                ),
                (
                    "channel",
                    models.CharField(
                        choices=[
                            ("EMAIL",  "Email"),
                            ("SMS",    "SMS"),
                            ("IN_APP", "In-App"),
                        ],
                        db_index=True,
                        max_length=10,
                    ),
                ),
                ("name",             models.CharField(max_length=200)),
                ("subject_template", models.CharField(blank=True, max_length=500)),
                ("body_template",    models.TextField()),
                ("is_active",        models.BooleanField(db_index=True, default=True)),
                ("created_at",       models.DateTimeField(auto_now_add=True)),
                ("updated_at",       models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "notification_templates",
                "ordering": ["event_type", "channel"],
            },
        ),
        migrations.AlterUniqueTogether(
            name="notificationtemplate",
            unique_together={("event_type", "channel")},
        ),
        migrations.CreateModel(
            name="Notification",
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
                    "template",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="notifications",
                        to="notifications.notificationtemplate",
                    ),
                ),
                ("event_type",      models.CharField(db_index=True, max_length=20)),
                ("channel",         models.CharField(db_index=True, max_length=10)),
                ("recipient_id",    models.UUIDField(blank=True, db_index=True, null=True)),
                ("recipient_email", models.EmailField(blank=True)),
                ("recipient_phone", models.CharField(blank=True, max_length=30)),
                ("recipient_name",  models.CharField(blank=True, max_length=200)),
                ("subject",         models.CharField(blank=True, max_length=500)),
                ("body",            models.TextField()),
                ("context",         models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("PENDING", "Pending"),
                            ("SENT",    "Sent"),
                            ("FAILED",  "Failed"),
                            ("READ",    "Read"),
                        ],
                        db_index=True,
                        default="PENDING",
                        max_length=10,
                    ),
                ),
                ("sent_at",       models.DateTimeField(blank=True, null=True)),
                ("read_at",       models.DateTimeField(blank=True, null=True)),
                ("error_message", models.TextField(blank=True)),
                ("related_type",  models.CharField(blank=True, db_index=True, max_length=100)),
                ("related_id",    models.UUIDField(blank=True, db_index=True, null=True)),
                ("created_at",    models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={
                "db_table": "notifications",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["status", "channel"],
                name="notif_status_channel_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["recipient_id", "status"],
                name="notif_recipient_status_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["event_type", "created_at"],
                name="notif_event_date_idx",
            ),
        ),
    ]
