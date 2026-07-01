"""Add `extras` JSONField to Product.

Destination for tenant CSV columns the import mapper doesn't recognise
as a typed field — e.g. "Current Stock Value (By purchase price)",
"Total unit sold", supplier-specific codes, etc. Default empty dict so
every existing row picks up the new column without a data migration.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0010_combo_item"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="extras",
            field=models.JSONField(
                default=dict,
                blank=True,
                help_text="Tenant-specific columns from imports that don't map to typed fields.",
            ),
        ),
    ]
