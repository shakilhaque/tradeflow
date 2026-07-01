"""Migration 0007 — Stock Transfer header + items."""

import uuid
from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone

import inventory.models as inv_models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0006_unit_decimal_category_meta_warranty"),
    ]

    operations = [
        migrations.CreateModel(
            name="StockTransfer",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("reference_no", models.CharField(default=inv_models._generate_transfer_ref, max_length=40, unique=True)),
                ("transfer_date", models.DateField(default=timezone.now)),
                ("status", models.CharField(
                    choices=[
                        ("pending", "Pending"),
                        ("in_transit", "In Transit"),
                        ("completed", "Completed"),
                        ("cancelled", "Cancelled"),
                    ],
                    db_index=True,
                    default="completed",
                    max_length=15,
                )),
                ("shipping_charges", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("total_amount", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("notes", models.TextField(blank=True, default="")),
                ("added_by_name", models.CharField(blank=True, default="", max_length=120)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("from_location", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="outgoing_transfers",
                    to="inventory.location",
                )),
                ("to_location", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="incoming_transfers",
                    to="inventory.location",
                )),
            ],
            options={
                "db_table": "stock_transfers",
                "ordering": ["-transfer_date", "-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="stocktransfer",
            index=models.Index(fields=["status"], name="stock_trans_status_idx"),
        ),
        migrations.AddIndex(
            model_name="stocktransfer",
            index=models.Index(fields=["from_location", "to_location"], name="stock_trans_from_to_idx"),
        ),
        migrations.CreateModel(
            name="StockTransferItem",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("quantity", models.DecimalField(decimal_places=2, max_digits=12)),
                ("unit_cost", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("line_total", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("product", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    to="inventory.product",
                )),
                ("stock_transfer", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="items",
                    to="inventory.stocktransfer",
                )),
            ],
            options={
                "db_table": "stock_transfer_items",
                "ordering": ["id"],
            },
        ),
    ]
