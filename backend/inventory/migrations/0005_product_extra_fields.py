from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0004_remove_product_product_name_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="cost_price",
            field=models.DecimalField(decimal_places=4, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="product",
            name="tax_rate",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=5),
        ),
        migrations.AddField(
            model_name="product",
            name="tax_type",
            field=models.CharField(
                choices=[("inclusive", "Inclusive"), ("exclusive", "Exclusive")],
                default="exclusive",
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="product",
            name="product_type",
            field=models.CharField(
                choices=[("single", "Single"), ("variable", "Variable"), ("combo", "Combo")],
                default="single",
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="product",
            name="barcode_type",
            field=models.CharField(default="C128", max_length=15),
        ),
        migrations.AddField(
            model_name="product",
            name="weight",
            field=models.DecimalField(blank=True, decimal_places=3, max_digits=10, null=True),
        ),
        migrations.AddField(
            model_name="product",
            name="not_for_selling",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="product",
            name="image_url",
            field=models.URLField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="product",
            name="meta",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
