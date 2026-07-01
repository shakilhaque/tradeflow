"""Customer gains Individual / Business split + structured address.

The Add/Edit Contact form now branches: Individual collects
prefix/first/middle/last/dob, Business collects business_name; both
collect the same contact + address + tax + credit fields.

`name` (the existing canonical display string) is composed on save from
the individual or business inputs so every downstream consumer
(invoices, Sale.customer.name, reports) keeps working unchanged.

All new columns are blank/nullable with sensible defaults so existing
rows backfill cleanly without a data migration.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0013_customer_credit_limit"),
    ]

    operations = [
        migrations.AddField(
            model_name="customer",
            name="contact_type",
            field=models.CharField(
                max_length=10,
                choices=[
                    ("customer", "Customer"),
                    ("supplier", "Supplier"),
                    ("both",     "Both (Supplier & Customer)"),
                ],
                default="customer",
                db_index=True,
            ),
        ),
        migrations.AddField(
            model_name="customer",
            name="is_individual",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="customer",
            name="contact_id",
            field=models.CharField(max_length=40, blank=True, default="", db_index=True),
        ),
        migrations.AddField(
            model_name="customer",
            name="prefix",
            field=models.CharField(
                max_length=10, blank=True, default="",
                choices=[
                    ("Mr", "Mr"), ("Mrs", "Mrs"), ("Miss", "Miss"),
                    ("Ms", "Ms"), ("Dr", "Dr"),
                ],
            ),
        ),
        migrations.AddField(
            model_name="customer",
            name="first_name",
            field=models.CharField(max_length=100, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="middle_name",
            field=models.CharField(max_length=100, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="last_name",
            field=models.CharField(max_length=100, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="date_of_birth",
            field=models.DateField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name="customer",
            name="alternate_phone",
            field=models.CharField(max_length=30, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="landline",
            field=models.CharField(max_length=30, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="address_line_2",
            field=models.CharField(max_length=255, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="city",
            field=models.CharField(max_length=100, blank=True, default="", db_index=True),
        ),
        migrations.AddField(
            model_name="customer",
            name="state",
            field=models.CharField(max_length=100, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="country",
            field=models.CharField(max_length=100, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="zip_code",
            field=models.CharField(max_length=20, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="customer",
            name="shipping_address",
            field=models.TextField(blank=True, default=""),
        ),
    ]
