from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0013_tenantrole"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="sales_commission_percent",
            field=models.DecimalField(
                max_digits=5, decimal_places=2, null=True, blank=True,
                help_text="Percentage of each finalized sale credited to this user. 0 / blank = none.",
            ),
        ),
        migrations.AddField(
            model_name="user",
            name="max_sales_discount_percent",
            field=models.DecimalField(
                max_digits=5, decimal_places=2, null=True, blank=True,
                help_text="Highest discount % this user can apply on a sale without supervisor approval.",
            ),
        ),
        migrations.AddField(
            model_name="user",
            name="allow_selected_contacts",
            field=models.BooleanField(
                default=False,
                help_text="Restrict this user to selling only to a fixed customer list.",
            ),
        ),
        migrations.AddField(
            model_name="user",
            name="allowed_contact_ids",
            field=models.JSONField(
                default=list, blank=True,
                help_text="List of Customer UUIDs the user can sell to. Empty = no contact restriction.",
            ),
        ),
        migrations.AddField(
            model_name="tenantrole",
            name="permissions",
            field=models.JSONField(default=list, blank=True),
        ),
    ]
