"""Add CONTACT to ImportBatch.import_type choices."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("imports", "0003_importbatch_supplier_choice"),
    ]

    operations = [
        migrations.AlterField(
            model_name="importbatch",
            name="import_type",
            field=models.CharField(
                max_length=20,
                choices=[
                    ("PRODUCT",  "Products"),
                    ("EXPENSE",  "Expenses"),
                    ("ORDER",    "Orders"),
                    ("SUPPLIER", "Suppliers"),
                    ("CONTACT",  "Contacts"),
                ],
            ),
        ),
    ]
