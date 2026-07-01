import uuid
from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0009_customer_extra_fields"),
    ]

    operations = [
        migrations.CreateModel(
            name="CustomerGroup",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(db_index=True, max_length=120, unique=True)),
                ("calc_percentage", models.DecimalField(
                    decimal_places=2, default=Decimal("0"), max_digits=6,
                    help_text="Price adjustment %. Negative = discount, positive = mark-up.",
                )),
                ("price_group", models.CharField(
                    blank=True, default="", max_length=120,
                    help_text="Optional selling-price group label (e.g. Retail, Wholesale).",
                )),
                ("description", models.TextField(blank=True, default="")),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "customer_groups",
                "ordering": ["name"],
            },
        ),
    ]
