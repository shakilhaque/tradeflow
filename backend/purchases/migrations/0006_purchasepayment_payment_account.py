"""Add payment_account_id to purchase_payments on every tenant DB.

Lets the View Payments modal show WHICH cash box / bank account the
supplier payment came out of. Nullable so legacy rows stay valid;
new payments recorded through the Add Payment modal populate it.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0005_normalize_supplier_phones"),
    ]

    operations = [
        migrations.AddField(
            model_name="purchasepayment",
            name="payment_account_id",
            field=models.UUIDField(
                blank=True, db_index=True, null=True,
                help_text="UUID of the accounting.PaymentAccount this payment was made from.",
            ),
        ),
    ]
