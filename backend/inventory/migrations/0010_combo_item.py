import uuid
from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0009_variation"),
    ]

    operations = [
        migrations.CreateModel(
            name="ComboItem",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False,
                        primary_key=True, serialize=False,
                    ),
                ),
                (
                    "quantity",
                    models.DecimalField(decimal_places=4, default=Decimal("1"), max_digits=14),
                ),
                ("sort_order", models.PositiveIntegerField(db_index=True, default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "combo",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="combo_items",
                        to="inventory.product",
                    ),
                ),
                (
                    "component",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="used_in_combos",
                        to="inventory.product",
                    ),
                ),
            ],
            options={
                "db_table": "product_combo_items",
                "ordering": ["sort_order", "created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="comboitem",
            index=models.Index(
                fields=["combo", "sort_order"], name="combo_parent_order_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="comboitem",
            constraint=models.UniqueConstraint(
                fields=["combo", "component"], name="uniq_combo_component",
            ),
        ),
    ]
