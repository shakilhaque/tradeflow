"""Add refund + gateway/method fields to Payment and the REFUNDED status.

Hand-written so it applies cleanly to every existing tenant master DB without
makemigrations drift. All fields are nullable / defaulted, so existing rows
are unaffected.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0023_plan_management_fields"),
    ]

    operations = [
        migrations.AlterField(
            model_name="payment",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("success", "Success"),
                    ("failed", "Failed"),
                    ("refunded", "Refunded"),
                ],
                db_index=True,
                default="pending",
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="gateway",
            field=models.CharField(
                blank=True, default="", max_length=50,
                help_text="Payment gateway that processed the transaction (e.g. SSLCommerz, bKash).",
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="method",
            field=models.CharField(
                blank=True, default="", max_length=50,
                help_text="Payment method/channel (e.g. card, mobile banking, bank transfer).",
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="refund_amount",
            field=models.DecimalField(
                blank=True, decimal_places=2, max_digits=10, null=True,
                help_text="Amount refunded when status is REFUNDED.",
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="refunded_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
