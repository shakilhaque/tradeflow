from decimal import Decimal
import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0001_initial"),
        ("sales", "0007_discount"),
    ]

    operations = [
        migrations.AddField(
            model_name="sellreturn",
            name="return_date",
            field=models.DateField(db_index=True, default=django.utils.timezone.now),
        ),
        migrations.AddField(
            model_name="sellreturn",
            name="refund_method",
            field=models.CharField(blank=True, default="", max_length=20),
        ),
        migrations.AddField(
            model_name="sellreturn",
            name="restocking_fee",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="sellreturn",
            name="refunded_amount",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.CreateModel(
            name="SellReturnItem",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("quantity", models.DecimalField(decimal_places=4, max_digits=14)),
                ("unit_price", models.DecimalField(decimal_places=2, max_digits=14)),
                ("line_total", models.DecimalField(decimal_places=2, max_digits=14)),
                ("reason", models.CharField(blank=True, default="", max_length=30)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("product", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="return_items", to="inventory.product")),
                ("sell_return", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="items", to="sales.sellreturn")),
            ],
            options={
                "db_table": "sell_return_items",
            },
        ),
    ]
