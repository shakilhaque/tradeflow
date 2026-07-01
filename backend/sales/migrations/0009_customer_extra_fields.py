from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0008_sellreturn_items"),
    ]

    operations = [
        migrations.AddField(
            model_name="customer",
            name="business_name",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="customer",
            name="pay_term_value",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="customer",
            name="pay_term_period",
            field=models.CharField(
                blank=True, default="", max_length=10,
                choices=[("", "—"), ("days", "Days"), ("months", "Months")],
            ),
        ),
        migrations.AddField(
            model_name="customer",
            name="opening_balance",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="customer",
            name="advance_balance",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="customer",
            name="custom_field_1",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="customer",
            name="custom_field_2",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="customer",
            name="custom_field_3",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="customer",
            name="custom_field_4",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
    ]
