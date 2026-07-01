from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0011_customergroup_price_calc_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="salepayment",
            name="payment_account_id",
            field=models.UUIDField(
                null=True, blank=True, db_index=True,
                help_text="UUID of the accounting.PaymentAccount this payment landed in.",
            ),
        ),
    ]
