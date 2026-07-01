import uuid
from decimal import Decimal

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("inventory", "0001_initial"),
    ]

    operations = [
        # ── Customer ──────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Customer",
            fields=[
                ("id",         models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("name",       models.CharField(max_length=200, db_index=True)),
                ("email",      models.EmailField(blank=True, db_index=True)),
                ("phone",      models.CharField(max_length=30, blank=True)),
                ("address",    models.TextField(blank=True)),
                ("tax_number", models.CharField(max_length=50, blank=True)),
                ("notes",      models.TextField(blank=True)),
                ("is_active",  models.BooleanField(default=True, db_index=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "customers", "ordering": ["name"]},
        ),

        # ── Sale ──────────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Sale",
            fields=[
                ("id",              models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("customer",        models.ForeignKey(
                    "sales.Customer", on_delete=django.db.models.deletion.SET_NULL,
                    null=True, blank=True, related_name="sales",
                )),
                ("location",        models.ForeignKey(
                    "inventory.Location", on_delete=django.db.models.deletion.PROTECT,
                    related_name="sales",
                )),
                ("status",          models.CharField(
                    max_length=20,
                    choices=[
                        ("QUOTATION", "Quotation"),
                        ("DRAFT",     "Draft"),
                        ("FINAL",     "Final"),
                        ("PENDING",   "Pending (back-order)"),
                        ("VOIDED",    "Voided"),
                    ],
                    default="DRAFT",
                    db_index=True,
                )),
                ("payment_status",  models.CharField(
                    max_length=10,
                    choices=[("DUE", "Due"), ("PARTIAL", "Partial"), ("PAID", "Paid")],
                    default="DUE",
                    db_index=True,
                )),
                ("subtotal",        models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("discount",        models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("tax_rate",        models.DecimalField(max_digits=5,  decimal_places=2, default=Decimal("0"))),
                ("tax_amount",      models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("total_amount",    models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("amount_paid",     models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("balance_due",     models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("invoice_number",  models.CharField(max_length=30, unique=True, null=True, blank=True)),
                ("created_by_id",   models.UUIDField()),
                ("finalized_by_id", models.UUIDField(null=True, blank=True)),
                ("finalized_at",    models.DateTimeField(null=True, blank=True)),
                ("notes",           models.TextField(blank=True)),
                ("created_at",      models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at",      models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "sales",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="sale",
            index=models.Index(fields=["status", "created_at"],   name="sales_status_date_idx"),
        ),
        migrations.AddIndex(
            model_name="sale",
            index=models.Index(fields=["payment_status"],          name="sales_pmt_status_idx"),
        ),
        migrations.AddIndex(
            model_name="sale",
            index=models.Index(fields=["customer", "created_at"], name="sales_customer_date_idx"),
        ),

        # ── SaleItem ──────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="SaleItem",
            fields=[
                ("id",            models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("sale",          models.ForeignKey(
                    "sales.Sale", on_delete=django.db.models.deletion.CASCADE, related_name="items",
                )),
                ("product",       models.ForeignKey(
                    "inventory.Product", on_delete=django.db.models.deletion.PROTECT,
                    related_name="sale_items",
                )),
                ("quantity",      models.DecimalField(max_digits=14, decimal_places=4)),
                ("unit_price",    models.DecimalField(max_digits=14, decimal_places=2)),
                ("item_discount", models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("total_price",   models.DecimalField(max_digits=14, decimal_places=2)),
                ("cogs",          models.DecimalField(max_digits=14, decimal_places=4, null=True, blank=True)),
            ],
            options={"db_table": "sale_items"},
        ),

        # ── SalePayment ───────────────────────────────────────────────────────
        migrations.CreateModel(
            name="SalePayment",
            fields=[
                ("id",             models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("sale",           models.ForeignKey(
                    "sales.Sale", on_delete=django.db.models.deletion.CASCADE,
                    related_name="sale_payments",
                )),
                ("amount",         models.DecimalField(max_digits=14, decimal_places=2)),
                ("method",         models.CharField(
                    max_length=20,
                    choices=[
                        ("CASH", "Cash"), ("CARD", "Card"),
                        ("BANK_TRANSFER", "Bank Transfer"),
                        ("MOBILE", "Mobile Payment"), ("OTHER", "Other"),
                    ],
                )),
                ("reference",      models.CharField(max_length=100, blank=True)),
                ("notes",          models.TextField(blank=True)),
                ("received_by_id", models.UUIDField()),
                ("created_at",     models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "sale_payments", "ordering": ["created_at"]},
        ),

        # ── BackOrder ─────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="BackOrder",
            fields=[
                ("id",            models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("sale",          models.ForeignKey(
                    "sales.Sale", on_delete=django.db.models.deletion.CASCADE,
                    related_name="backorders",
                )),
                ("product",       models.ForeignKey(
                    "inventory.Product", on_delete=django.db.models.deletion.PROTECT,
                    related_name="backorders",
                )),
                ("location",      models.ForeignKey(
                    "inventory.Location", on_delete=django.db.models.deletion.PROTECT,
                    related_name="backorders",
                )),
                ("requested_qty", models.DecimalField(max_digits=14, decimal_places=4)),
                ("available_qty", models.DecimalField(max_digits=14, decimal_places=4)),
                ("shortfall_qty", models.DecimalField(max_digits=14, decimal_places=4)),
                ("status",        models.CharField(
                    max_length=20,
                    choices=[
                        ("OPEN", "Open"),
                        ("FULFILLED", "Fulfilled"),
                        ("CANCELLED", "Cancelled"),
                    ],
                    default="OPEN",
                    db_index=True,
                )),
                ("notes",         models.TextField(blank=True)),
                ("created_at",    models.DateTimeField(auto_now_add=True)),
                ("fulfilled_at",  models.DateTimeField(null=True, blank=True)),
            ],
            options={"db_table": "back_orders", "ordering": ["created_at"]},
        ),
        migrations.AddIndex(
            model_name="backorder",
            index=models.Index(fields=["status", "product"], name="bo_status_product_idx"),
        ),
    ]
