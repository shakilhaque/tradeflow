"""Migration 0008 — PaymentLink mapping for Payment Account Report."""

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0007_payment_account_transaction"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentLink",
            fields=[
                ("id",          models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("source_ref",  models.CharField(max_length=120, unique=True)),
                ("source_type", models.CharField(blank=True, default="", max_length=20)),
                ("note",        models.CharField(blank=True, default="", max_length=200)),
                ("created_at",  models.DateTimeField(auto_now_add=True)),
                ("updated_at",  models.DateTimeField(auto_now=True)),
                ("payment_account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="payment_links",
                    to="accounting.paymentaccount",
                )),
            ],
            options={
                "db_table": "payment_links",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="paymentlink",
            index=models.Index(fields=["payment_account", "source_type"], name="pl_acct_type_idx"),
        ),
    ]
