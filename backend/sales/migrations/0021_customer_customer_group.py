"""Add Customer.customer_group — optional FK linking a customer to a
CustomerGroup (pricing tier / segment). Lets the Customers list filter by
group. Nullable with SET_NULL so deleting a group never deletes customers,
and applies cleanly to every existing/new tenant DB.
"""
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0020_ensure_customer_balance_columns"),
    ]

    operations = [
        migrations.AddField(
            model_name="customer",
            name="customer_group",
            field=models.ForeignKey(
                null=True, blank=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="customers",
                to="sales.customergroup",
                help_text="Optional customer group (pricing tier / segment).",
            ),
        ),
    ]
