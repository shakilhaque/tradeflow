"""Add shipping_details + edit_history columns to purchases.

shipping_details — surfaces on the View Purchase modal so the
typed-on-Add-Purchase value isn't lost on display.

edit_history — list of edit log entries appended on every PATCH;
powers the new "History" action menu item on All Purchases.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0007_purchasereturnpayment"),
    ]

    operations = [
        migrations.AddField(
            model_name="purchase",
            name="shipping_details",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="purchase",
            name="edit_history",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
