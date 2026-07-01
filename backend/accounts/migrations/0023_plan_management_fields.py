"""Subscription Plans Management — extra Plan fields.

Additive: monthly/yearly headline prices, trial_days, max_products,
max_storage_mb and a module_features toggle map. The existing
price/billing_cycle/duration_days remain authoritative for billing.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0022_platformnotice_target_user_ids"),
    ]

    operations = [
        migrations.AddField(
            model_name="plan", name="monthly_price",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True,
                                      help_text="Headline monthly price (management view). Blank = use `price`."),
        ),
        migrations.AddField(
            model_name="plan", name="yearly_price",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True,
                                      help_text="Headline yearly price (management view)."),
        ),
        migrations.AddField(
            model_name="plan", name="trial_days",
            field=models.PositiveIntegerField(default=0, help_text="Free trial length in days (0 = no trial)."),
        ),
        migrations.AddField(
            model_name="plan", name="max_products",
            field=models.PositiveIntegerField(default=0, help_text="Max products allowed. 0 = unlimited."),
        ),
        migrations.AddField(
            model_name="plan", name="max_storage_mb",
            field=models.PositiveIntegerField(default=0, help_text="Storage cap in MB. 0 = unlimited."),
        ),
        migrations.AddField(
            model_name="plan", name="module_features",
            field=models.JSONField(blank=True, default=dict,
                                   help_text="Per-module access toggles: pos, inventory, accounting, "
                                             "purchase, sales, reports, multi_branch, api_access."),
        ),
    ]
