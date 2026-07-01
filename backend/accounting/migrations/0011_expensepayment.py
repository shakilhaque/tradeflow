"""Add expense_payments table on every tenant DB.

Backs the View Payments modal on the All Expenses page — operator
can list / add / edit / delete payments per expense, with the
linked PaymentAccount ledger automatically reversed and re-posted
on every mutation.
"""
import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0010_expense_rich_fields"),
    ]

    operations = [
        migrations.CreateModel(
            name="ExpensePayment",
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
                    help_text="UUID of the accounting.PaymentAccount the money came OUT of.",
                )),
                ("paid_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("expense", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="payments",
                    to="accounting.expense",
                )),
            ],
            options={
                "db_table": "expense_payments",
                "ordering": ["-paid_at"],
            },
        ),
    ]
