"""
Migration 0003 — Add reorder_level field to Product.

This field enables low-stock alert triggers when total FIFO stock
drops at or below this threshold.
"""

from decimal import Decimal
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0002_product_soft_delete"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="reorder_level",
            field=models.DecimalField(
                max_digits=14,
                decimal_places=4,
                default=Decimal("0"),
                help_text="Minimum stock quantity before a low-stock alert fires.",
            ),
        ),
    ]
