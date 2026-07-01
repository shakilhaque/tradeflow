"""
Add Plan.yearly_discount_percent — the explicit yearly discount the Super
Admin can set per plan from Plans → Edit. When > 0 the public pricing page
advertises exactly this percentage (and prices the strike-through from it);
when 0 it falls back to deriving the discount from the monthly price.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0033_plan_max_users"),
    ]

    operations = [
        migrations.AddField(
            model_name="plan",
            name="yearly_discount_percent",
            field=models.PositiveSmallIntegerField(
                default=0,
                help_text="Discount % advertised on the public pricing page for "
                          "yearly plans (0 = derive from the monthly price). The "
                          "admin sets this; the landing page updates on save.",
            ),
        ),
    ]
