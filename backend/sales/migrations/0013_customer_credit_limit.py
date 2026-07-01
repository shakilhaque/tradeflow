"""Add Customer.credit_limit.

Cash-only customers default to credit_limit=0 (the model default). The
POS UI uses this to gate the Credit Sale button — only customers with
credit_limit > 0 can buy on credit. Walk-in sales (customer=NULL) are
blocked at the API layer regardless of this field.
"""
from decimal import Decimal
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0012_salepayment_payment_account"),
    ]

    operations = [
        migrations.AddField(
            model_name="customer",
            name="credit_limit",
            field=models.DecimalField(
                max_digits=14, decimal_places=2,
                default=Decimal("0"),
                help_text=(
                    "Maximum outstanding balance allowed for credit sales. "
                    "Zero (default) means this customer is CASH-ONLY — no credit. "
                    "Walk-in sales (customer=NULL) never get credit regardless."
                ),
            ),
        ),
    ]
