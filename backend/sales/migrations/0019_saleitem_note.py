"""Add SaleItem.note — the per-line note (IMEI / serial / free text) entered
on POS or Add Sale and printed on the invoice under each product.

Plain additive column with a safe default, so it applies cleanly to every
existing and new tenant DB during migrate.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0018_customer_default_credit_limit"),
    ]

    operations = [
        migrations.AddField(
            model_name="saleitem",
            name="note",
            field=models.TextField(
                blank=True, default="",
                help_text="Per-line note (IMEI / serial / etc.) entered on POS "
                          "or Add Sale — printed on the invoice under this product.",
            ),
        ),
    ]
