"""Payment Gateway config + Payment audit log (master DB).

Two new additive tables — no changes to existing rows.
"""
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0024_payment_refund_gateway"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentGatewayConfig",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("code", models.CharField(choices=[("sslcommerz", "SSLCommerz"), ("stripe", "Stripe"), ("paypal", "PayPal")], db_index=True, max_length=30, unique=True)),
                ("name", models.CharField(blank=True, default="", max_length=80)),
                ("is_enabled", models.BooleanField(default=False)),
                ("is_test_mode", models.BooleanField(default=True)),
                ("credentials", models.JSONField(blank=True, default=dict)),
                ("status", models.CharField(choices=[("not_configured", "Not configured"), ("connected", "Connected"), ("error", "Error")], default="not_configured", max_length=20)),
                ("last_tested_at", models.DateTimeField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "payment_gateway_config", "ordering": ["code"]},
        ),
        migrations.CreateModel(
            name="PaymentAuditLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(choices=[("verify", "Payment verified"), ("retry", "Verification retried"), ("mark_paid", "Marked as paid"), ("mark_failed", "Marked as failed"), ("refund", "Refund issued"), ("gateway_config", "Gateway configuration changed")], db_index=True, max_length=30)),
                ("from_status", models.CharField(blank=True, default="", max_length=20)),
                ("to_status", models.CharField(blank=True, default="", max_length=20)),
                ("gateway_code", models.CharField(blank=True, default="", max_length=30)),
                ("note", models.TextField(blank=True, default="")),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("performed_by", models.UUIDField(blank=True, null=True)),
                ("performed_by_email", models.CharField(blank=True, default="", max_length=254)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("payment", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="audit_logs", to="accounts.payment")),
            ],
            options={"db_table": "payment_audit_log", "ordering": ["-created_at"]},
        ),
    ]
