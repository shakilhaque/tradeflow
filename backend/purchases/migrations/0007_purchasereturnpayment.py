"""Add purchase_return_payments table on every tenant DB.

Lets the View Payments modal on the Purchase Returns page list
the refund payments per return, with edit/delete actions wired to
the PaymentAccount ledger (positive DEPOSIT on create, reversal
on edit/delete).
"""
import uuid
from decimal import Decimal

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0006_purchasepayment_payment_account"),
    ]

    operations = [
        migrations.CreateModel(
            name="PurchaseReturnPayment",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("reference_no", models.CharField(blank=True, default="", max_length=80)),
                ("amount", models.DecimalField(decimal_places=2, max_digits=14)),
                ("method", models.CharField(
                    choices=[
                        ("cash", "Cash"),
                        ("card", "Card"),
                        ("cheque", "Cheque"),
                        ("bank_transfer", "Bank Transfer"),
                        ("mobile", "Mobile Money"),
                        ("other", "Other"),
                    ],
                    default="cash",
                    max_length=20,
                )),
                ("reference", models.CharField(blank=True, default="", max_length=120)),
                ("notes", models.TextField(blank=True, default="")),
                ("payment_account_id", models.UUIDField(
                    blank=True, db_index=True, null=True,
                    help_text="UUID of accounting.PaymentAccount that received the refund.",
                )),
                ("paid_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("purchase_return", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="payments",
                    to="purchases.purchasereturn",
                )),
            ],
            options={
                "db_table": "purchase_return_payments",
                "ordering": ["-paid_at"],
            },
        ),
    ]
