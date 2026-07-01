from decimal import Decimal
import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0001_initial"),
        ("sales", "0005_sale_status_proforma"),
    ]

    operations = [
        migrations.CreateModel(
            name="SellReturn",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("invoice_number", models.CharField(max_length=30, unique=True)),
                ("payment_status", models.CharField(choices=[("DUE", "Due"), ("PARTIAL", "Partial"), ("PAID", "Paid")], db_index=True, default="DUE", max_length=10)),
                ("total_amount", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("amount_paid", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("balance_due", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("created_by_id", models.UUIDField()),
                ("meta", models.JSONField(blank=True, default=dict)),
                ("notes", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("customer", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="sell_returns", to="sales.customer")),
                ("location", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="sell_returns", to="inventory.location")),
                ("parent_sale", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="sell_returns", to="sales.sale")),
            ],
            options={
                "db_table": "sell_returns",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="sellreturn",
            index=models.Index(fields=["created_at"], name="sell_ret_date_idx"),
        ),
        migrations.AddIndex(
            model_name="sellreturn",
            index=models.Index(fields=["payment_status"], name="sell_ret_pmt_idx"),
        ),
        migrations.AddIndex(
            model_name="sellreturn",
            index=models.Index(fields=["customer", "created_at"], name="sell_ret_cust_date_idx"),
        ),
    ]
