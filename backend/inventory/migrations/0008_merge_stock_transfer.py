"""
Originally a merge migration between 0007_stock_transfer and
0007_alter_product_barcode_type_alter_product_cost_price_and_more.

The second parent was created on the old server but never committed to
git, so on any fresh checkout the dependency points at a nonexistent
node. The merge had no operations anyway, so it is now a plain chain
node on top of 0007_stock_transfer.

If you ever need to onboard a DB that already has this migration
recorded with both parents, that's still fine — Django only checks the
graph for new applications, not for already-applied migrations.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0007_stock_transfer"),
    ]

    operations = []
