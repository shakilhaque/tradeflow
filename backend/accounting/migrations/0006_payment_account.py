"""Migration 0006 — PaymentAccount (Cash / Bank / MFS wallets)."""

import uuid
from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0005_expense_category"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentAccount",
            fields=[
                ("id",              models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name",            models.CharField(max_length=120)),
                ("account_number",  models.CharField(blank=True, default="", max_length=120)),
                ("account_type",    models.CharField(
                    choices=[
                        ("CASH",  "Cash Balance"),
                        ("BANK",  "Bank Balance"),
                        ("MFS",   "Mobile Banking"),
                        ("CARD",  "Card / Gateway"),
                        ("OTHER", "Other"),
                    ],
                    db_index=True, default="CASH", max_length=12,
                )),
                ("sub_type",        models.CharField(blank=True, default="", max_length=120)),
                ("opening_balance", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("note",            models.TextField(blank=True, default="")),
                ("details",         models.JSONField(blank=True, default=list)),
                ("added_by_name",   models.CharField(blank=True, default="", max_length=120)),
                ("is_active",       models.BooleanField(default=True)),
                ("created_at",      models.DateTimeField(auto_now_add=True)),
                ("updated_at",      models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "payment_accounts",
                "ordering": ["-is_active", "name"],
            },
        ),
    ]
