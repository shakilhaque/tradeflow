"""
purchases · 0001_initial — REAL baseline.

History
───────
This file was originally written with ``SeparateDatabaseAndState`` and
*empty* ``database_operations`` because every tenant DB on the server at
the time already had the `suppliers` / `purchases` / etc. tables live.
The state-only form lets Django mark the migration applied without
trying to CREATE TABLE again.

That worked for old tenants but broke EVERY brand-new tenant: a fresh
`saas_<name>` DB has no tables, 0001 runs but creates nothing, and 0002
(AddField on suppliers) trips with
   ProgrammingError: relation "suppliers" does not exist.

Fix
───
Use real ``CreateModel`` operations so a fresh DB actually gets the
tables. Existing tenants that already have 0001 in their
``django_migrations`` table are unaffected — Django will not re-run an
applied migration. If you ever need to onboard a brand-new tenant onto
an existing partially-migrated DB you can ``--fake`` 0001 manually.

Deploy
    python manage.py migrate_tenants    # new tenants get tables created,
                                        # old tenants skip (already applied)
"""
import uuid
from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


PURCHASE_STATUS = [
    ("draft", "Draft"),
    ("received", "Received"),
    ("partial", "Partial"),
    ("cancelled", "Cancelled"),
]
PAYMENT_STATUS = [
    ("due", "Due"),
    ("partial", "Partial"),
    ("paid", "Paid"),
]
PAYMENT_METHOD = [
    ("cash", "Cash"),
    ("card", "Card"),
    ("bank_transfer", "Bank Transfer"),
    ("mobile", "Mobile Money"),
    ("other", "Other"),
]
RETURN_STATUS = [
    ("draft", "Draft"),
    ("completed", "Completed"),
    ("cancelled", "Cancelled"),
]


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("inventory", "0008_merge_stock_transfer"),
    ]

    operations = [
        migrations.CreateModel(
            name="Supplier",
            fields=[
                ("id",          models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name",        models.CharField(db_index=True, max_length=200)),
                ("contact",     models.CharField(blank=True, max_length=150)),
                ("email",       models.EmailField(blank=True, db_index=True, max_length=254)),
                ("phone",       models.CharField(blank=True, max_length=30)),
                ("address",     models.TextField(blank=True)),
                ("tax_number",  models.CharField(blank=True, max_length=50)),
                ("notes",       models.TextField(blank=True)),
                ("is_active",   models.BooleanField(db_index=True, default=True)),
                ("deleted_at",  models.DateTimeField(blank=True, db_index=True, null=True)),
                ("created_at",  models.DateTimeField(auto_now_add=True)),
                ("updated_at",  models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "suppliers", "ordering": ["name"]},
        ),
        migrations.CreateModel(
            name="Purchase",
            fields=[
                ("id",              models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("reference_no",    models.CharField(db_index=True, max_length=80, unique=True)),
                ("purchase_date",   models.DateField(default=timezone.localdate)),
                ("status",          models.CharField(choices=PURCHASE_STATUS, db_index=True, default="draft", max_length=20)),
                ("payment_status",  models.CharField(choices=PAYMENT_STATUS, db_index=True, default="due", max_length=20)),
                ("subtotal",        models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("discount_amount", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("tax_amount",      models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("shipping_cost",   models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("grand_total",     models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("paid_amount",     models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("notes",           models.TextField(blank=True)),
                ("added_by_id",     models.UUIDField(blank=True, db_index=True, null=True)),
                ("added_by_name",   models.CharField(blank=True, max_length=200)),
                ("created_at",      models.DateTimeField(auto_now_add=True)),
                ("updated_at",      models.DateTimeField(auto_now=True)),
                ("location",        models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="purchases", to="inventory.location")),
                ("supplier",        models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="purchases", to="purchases.supplier")),
            ],
            options={"db_table": "purchases", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="PurchaseItem",
            fields=[
                ("id",           models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("product_name", models.CharField(blank=True, max_length=200)),
                ("sku",          models.CharField(blank=True, max_length=50)),
                ("quantity",     models.DecimalField(decimal_places=4, max_digits=14)),
                ("unit_cost",    models.DecimalField(decimal_places=4, max_digits=14)),
                ("tax_rate",     models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=5)),
                ("discount",     models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("line_total",   models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("received_qty", models.DecimalField(decimal_places=4, default=Decimal("0"), max_digits=14)),
                ("product",      models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="purchase_items", to="inventory.product")),
                ("purchase",     models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="items", to="purchases.purchase")),
            ],
            options={"db_table": "purchase_items", "ordering": ["id"]},
        ),
        migrations.CreateModel(
            name="PurchasePayment",
            fields=[
                ("id",         models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("amount",     models.DecimalField(decimal_places=2, max_digits=14)),
                ("method",     models.CharField(choices=PAYMENT_METHOD, default="cash", max_length=20)),
                ("reference",  models.CharField(blank=True, max_length=120)),
                ("notes",      models.TextField(blank=True)),
                ("paid_at",    models.DateTimeField(default=timezone.now)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("purchase",   models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="payments", to="purchases.purchase")),
            ],
            options={"db_table": "purchase_payments", "ordering": ["-paid_at"]},
        ),
        migrations.CreateModel(
            name="PurchaseReturn",
            fields=[
                ("id",            models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("reference_no",  models.CharField(db_index=True, max_length=80, unique=True)),
                ("return_date",   models.DateField(default=timezone.localdate)),
                ("status",        models.CharField(choices=RETURN_STATUS, default="completed", max_length=20)),
                ("total_amount",  models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("notes",         models.TextField(blank=True)),
                ("added_by_id",   models.UUIDField(blank=True, null=True)),
                ("added_by_name", models.CharField(blank=True, max_length=200)),
                ("created_at",    models.DateTimeField(auto_now_add=True)),
                ("updated_at",    models.DateTimeField(auto_now=True)),
                ("purchase",      models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="returns", to="purchases.purchase")),
                ("supplier",      models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="returns", to="purchases.supplier")),
                ("location",      models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="purchase_returns", to="inventory.location")),
            ],
            options={"db_table": "purchase_returns", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="PurchaseReturnItem",
            fields=[
                ("id",              models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("product_name",    models.CharField(blank=True, max_length=200)),
                ("sku",             models.CharField(blank=True, max_length=50)),
                ("quantity",        models.DecimalField(decimal_places=4, max_digits=14)),
                ("unit_cost",       models.DecimalField(decimal_places=4, max_digits=14)),
                ("line_total",      models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("product",         models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="purchase_return_items", to="inventory.product")),
                ("purchase_return", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="items", to="purchases.purchasereturn")),
            ],
            options={"db_table": "purchase_return_items", "ordering": ["id"]},
        ),
    ]
