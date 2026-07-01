from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0004_sale_advanced_fields"),
    ]

    operations = [
        migrations.AlterField(
            model_name="sale",
            name="status",
            field=models.CharField(
                choices=[
                    ("QUOTATION", "Quotation"),
                    ("PROFORMA", "Proforma"),
                    ("DRAFT", "Draft"),
                    ("FINAL", "Final"),
                    ("PENDING", "Pending (back-order)"),
                    ("VOIDED", "Voided"),
                ],
                db_index=True,
                default="DRAFT",
                max_length=20,
            ),
        ),
    ]
