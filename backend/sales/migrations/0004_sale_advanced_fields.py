from django.db import migrations, models
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0003_remove_customer_customer_name_del_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="sale_date",
            field=models.DateTimeField(
                db_index=True,
                default=django.utils.timezone.now,
                help_text="Business sale date/time selected from Add Sale screen.",
            ),
        ),
        migrations.AddField(
            model_name="sale",
            name="pay_term_days",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Credit term in days (0 means immediate payment).",
            ),
        ),
        migrations.AddField(
            model_name="sale",
            name="shipping_charges",
            field=models.DecimalField(max_digits=14, decimal_places=2, default=0),
        ),
        migrations.AddField(
            model_name="sale",
            name="extra_charges",
            field=models.DecimalField(
                max_digits=14,
                decimal_places=2,
                default=0,
                help_text="Sum of additional expense rows from Add Sale screen.",
            ),
        ),
        migrations.AddField(
            model_name="sale",
            name="meta",
            field=models.JSONField(
                default=dict,
                blank=True,
                help_text="Extended Add Sale fields (invoice scheme, shipping details, service staff, docs, etc.)",
            ),
        ),
    ]
