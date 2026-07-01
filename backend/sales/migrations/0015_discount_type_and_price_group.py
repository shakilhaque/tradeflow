"""Add discount_type + selling_price_group to Discount.

Idempotent SQL pattern (RunSQL `ADD COLUMN IF NOT EXISTS`) so the
migration can be re-applied across every tenant DB safely — including
tenants that had the columns added by hand earlier.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0014_customer_individual_business_fields"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name="discount",
                    name="discount_type",
                    field=models.CharField(
                        max_length=12,
                        default="FIXED",
                        choices=[("FIXED", "Fixed"), ("PERCENTAGE", "Percentage")],
                    ),
                ),
                migrations.AddField(
                    model_name="discount",
                    name="selling_price_group",
                    field=models.CharField(
                        max_length=40, default="ALL", blank=True,
                        help_text="Selling price group the discount applies to. 'ALL' = every tier.",
                    ),
                ),
            ],
            database_operations=[
                migrations.RunSQL(
                    sql=[
                        'ALTER TABLE "discounts" '
                        'ADD COLUMN IF NOT EXISTS "discount_type" varchar(12) NOT NULL DEFAULT \'FIXED\';',
                        'ALTER TABLE "discounts" '
                        'ADD COLUMN IF NOT EXISTS "selling_price_group" varchar(40) NOT NULL DEFAULT \'ALL\';',
                    ],
                    reverse_sql=[
                        'ALTER TABLE "discounts" DROP COLUMN IF EXISTS "selling_price_group";',
                        'ALTER TABLE "discounts" DROP COLUMN IF EXISTS "discount_type";',
                    ],
                ),
            ],
        ),
    ]
