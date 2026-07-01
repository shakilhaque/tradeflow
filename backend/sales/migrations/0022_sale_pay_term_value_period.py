"""Add Sale.pay_term_value + Sale.pay_term_period — preserve the raw credit
term (value + days/months unit) entered on Add Sale / Add Quotation, alongside
the existing flattened pay_term_days. Plain additive nullable columns, so they
apply cleanly to every existing/new tenant DB.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0021_customer_customer_group"),
    ]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="pay_term_value",
            field=models.PositiveSmallIntegerField(
                null=True, blank=True,
                help_text="Credit term value as typed (paired with pay_term_period).",
            ),
        ),
        migrations.AddField(
            model_name="sale",
            name="pay_term_period",
            field=models.CharField(
                max_length=10, blank=True, default="",
                choices=[("", "—"), ("days", "Days"), ("months", "Months")],
                help_text="Unit for pay_term_value: days or months.",
            ),
        ),
    ]
