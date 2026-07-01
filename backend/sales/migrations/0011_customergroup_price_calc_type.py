from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0010_customergroup"),
    ]

    operations = [
        migrations.AddField(
            model_name="customergroup",
            name="price_calculation_type",
            field=models.CharField(
                max_length=12,
                choices=[("percentage", "Percentage"), ("fixed", "Fixed")],
                default="percentage",
                help_text="How calc_percentage is interpreted: percent multiplier or flat per-line amount.",
            ),
        ),
        migrations.AlterField(
            model_name="customergroup",
            name="calc_percentage",
            field=models.DecimalField(
                max_digits=12,
                decimal_places=4,
                default=Decimal("0"),
                help_text=(
                    "Price adjustment value. Negative = discount, positive = mark-up. "
                    "Read as a % when price_calculation_type=percentage, as a flat currency amount when fixed."
                ),
            ),
        ),
    ]
