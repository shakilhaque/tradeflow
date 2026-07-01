"""Migration 0007 — PaymentAccountTransaction ledger."""

import uuid

import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0006_payment_account"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentAccountTransaction",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("kind", models.CharField(
                    choices=[
                        ("DEPOSIT",      "Deposit"),
                        ("WITHDRAWAL",   "Withdrawal"),
                        ("TRANSFER_IN",  "Transfer In"),
                        ("TRANSFER_OUT", "Transfer Out"),
                        ("SALE",         "Sale Payment"),
                        ("EXPENSE",      "Expense Payment"),
                        ("ADJUSTMENT",   "Adjustment"),
                    ],
                    db_index=True, max_length=20,
                )),
                ("amount",           models.DecimalField(decimal_places=2, max_digits=14)),
                ("reference",        models.CharField(blank=True, default="", max_length=120)),
                ("note",             models.TextField(blank=True, default="")),
                ("transaction_date", models.DateTimeField(db_index=True, default=timezone.now)),
                ("created_by_name",  models.CharField(blank=True, default="", max_length=120)),
                ("created_at",       models.DateTimeField(auto_now_add=True)),
                ("account",          models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="transactions",
                    to="accounting.paymentaccount",
                )),
                ("counter_account",  models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="counter_transactions",
                    to="accounting.paymentaccount",
                )),
            ],
            options={
                "db_table": "payment_account_transactions",
                "ordering": ["-transaction_date", "-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="paymentaccounttransaction",
            index=models.Index(fields=["account", "-transaction_date"], name="pa_txn_acct_date_idx"),
        ),
    ]
