"""Supplier gains Individual / Business split + structured address — mirror
of sales.Customer's 0014 migration. All new columns blank/nullable so
existing supplier rows backfill cleanly without a data step.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0003_supplier_soft_delete"),
    ]

    operations = [
        migrations.AddField(
            model_name="supplier",
            name="is_individual",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="supplier",
            name="contact_id",
            field=models.CharField(max_length=40, blank=True, default="", db_index=True),
        ),
        migrations.AddField(
            model_name="supplier",
            name="prefix",
            field=models.CharField(
                max_length=10, blank=True, default="",
                choices=[("Mr","Mr"),("Mrs","Mrs"),("Miss","Miss"),("Ms","Ms"),("Dr","Dr")],
            ),
        ),
        migrations.AddField(model_name="supplier", name="first_name",
            field=models.CharField(max_length=100, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="middle_name",
            field=models.CharField(max_length=100, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="last_name",
            field=models.CharField(max_length=100, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="date_of_birth",
            field=models.DateField(null=True, blank=True)),
        migrations.AddField(model_name="supplier", name="alternate_phone",
            field=models.CharField(max_length=30, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="landline",
            field=models.CharField(max_length=30, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="address_line_2",
            field=models.CharField(max_length=255, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="city",
            field=models.CharField(max_length=100, blank=True, default="", db_index=True)),
        migrations.AddField(model_name="supplier", name="state",
            field=models.CharField(max_length=100, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="country",
            field=models.CharField(max_length=100, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="zip_code",
            field=models.CharField(max_length=20, blank=True, default="")),
        migrations.AddField(model_name="supplier", name="shipping_address",
            field=models.TextField(blank=True, default="")),
    ]
