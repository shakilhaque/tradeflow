"""Subscription audit trail — SubscriptionHistory + SubscriptionStatusLog.

Master-DB tables powering the Super-Admin Subscription Management module
(timeline, plan-change / extension / suspension history). Additive only —
no changes to existing tables.
"""
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0020_platform_config"),
    ]

    operations = [
        migrations.CreateModel(
            name="SubscriptionHistory",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(db_index=True, max_length=32, choices=[
                    ("created", "Created"), ("plan_changed", "Plan changed"),
                    ("upgraded", "Upgraded"), ("downgraded", "Downgraded"),
                    ("extended", "Extended"), ("bonus_days", "Bonus days added"),
                    ("billing_date_changed", "Billing date changed"),
                    ("suspended", "Suspended"), ("reactivated", "Reactivated"),
                    ("renewed", "Renewed"), ("cancelled", "Cancelled"),
                    ("payment", "Payment"),
                ])),
                ("previous_billing_date", models.DateField(blank=True, null=True)),
                ("new_billing_date", models.DateField(blank=True, null=True)),
                ("days_delta", models.IntegerField(blank=True, null=True, help_text="Days added (extensions / bonus) or removed.")),
                ("amount", models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True, help_text="Money involved, when relevant (payments / renewals).")),
                ("note", models.TextField(blank=True, default="")),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("performed_by", models.UUIDField(blank=True, null=True)),
                ("performed_by_email", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("from_plan", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="+", to="accounts.plan")),
                ("to_plan", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="+", to="accounts.plan")),
                ("subscription", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="history", to="accounts.subscription")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="subscription_history", to="accounts.user", help_text="Denormalised subscriber for fast lookup / filtering.")),
            ],
            options={
                "db_table": "subscription_history",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="SubscriptionStatusLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("from_status", models.CharField(blank=True, default="", max_length=20)),
                ("to_status", models.CharField(db_index=True, max_length=20)),
                ("reason", models.TextField(blank=True, default="")),
                ("performed_by", models.UUIDField(blank=True, null=True)),
                ("performed_by_email", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("subscription", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="status_logs", to="accounts.subscription")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="subscription_status_logs", to="accounts.user")),
            ],
            options={
                "db_table": "subscription_status_logs",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="subscriptionhistory",
            index=models.Index(fields=["subscription", "-created_at"], name="subhist_sub_created_idx"),
        ),
        migrations.AddIndex(
            model_name="subscriptionhistory",
            index=models.Index(fields=["user", "-created_at"], name="subhist_user_created_idx"),
        ),
        migrations.AddIndex(
            model_name="subscriptionhistory",
            index=models.Index(fields=["action"], name="subhist_action_idx"),
        ),
        migrations.AddIndex(
            model_name="subscriptionstatuslog",
            index=models.Index(fields=["subscription", "-created_at"], name="substatus_sub_created_idx"),
        ),
        migrations.AddIndex(
            model_name="subscriptionstatuslog",
            index=models.Index(fields=["to_status"], name="substatus_to_status_idx"),
        ),
    ]
