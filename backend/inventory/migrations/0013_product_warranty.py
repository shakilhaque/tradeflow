"""
Link a Product to a named Warranty term (defined on the Warranties page) so
the List Products page can show a "Warranty" column with the real warranty.
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0012_backfill_reorder_level_from_meta"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="warranty",
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="products",
                to="inventory.warranty",
            ),
        ),
    ]
