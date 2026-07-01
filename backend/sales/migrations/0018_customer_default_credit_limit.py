"""Give every customer a usable default credit limit.

Before this, Customer.credit_limit defaulted to 0, which the sale path
treats as CASH-ONLY (credit_limit <= 0 → no credit sale). That meant a
freshly-created customer couldn't buy on credit until someone manually
typed a limit, and the POS showed "No credit limit set. Credit Sale
disabled."

This migration:
  1. Changes the column default to 5000 (matches the model), so any new
     row created at the DB level is born credit-ready.
  2. Backfills every EXISTING customer whose credit_limit is 0 (or NULL)
     to 5000, so all current customers in every tenant become
     credit-eligible. Customers who already have a custom limit (> 0) are
     left untouched.

Why a migration: each tenant lives in its own per-tenant Postgres DB
(saas_<slug>). Django's migrate runs every tenant's migrations during
deploy, so this backfill touches every existing tenant automatically, and
new tenants get the 5000 default the moment they provision. Idempotent:
re-running it changes nothing once limits are non-zero.
"""
from decimal import Decimal

from django.db import migrations, models


DEFAULT_CREDIT_LIMIT = Decimal("5000")


def forwards(apps, schema_editor):
    Customer = apps.get_model("sales", "Customer")
    db = schema_editor.connection.alias

    # Defensive guard — skip cleanly if a legacy tenant DB is mid-heal so
    # one bad tenant doesn't break the multi-tenant migrate loop.
    try:
        table = Customer._meta.db_table
        with schema_editor.connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() AND table_name = %s",
                [table],
            )
            if cur.fetchone() is None:
                print(f"[default_credit_limit] skip {db}: '{table}' missing")
                return

        updated = (
            Customer.objects.using(db)
            .filter(models.Q(credit_limit__lte=0) | models.Q(credit_limit__isnull=True))
            .update(credit_limit=DEFAULT_CREDIT_LIMIT)
        )
        print(f"[default_credit_limit] {db}: {updated} customer(s) set to 5000")
    except Exception as exc:  # noqa: BLE001
        print(f"[default_credit_limit] skip {db}: {exc}")
        return


def backwards(apps, schema_editor):
    # Reversing would wrongly strip credit limits we can't distinguish from
    # operator-set 5000s — refuse.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0017_register_closure"),
    ]

    operations = [
        migrations.AlterField(
            model_name="customer",
            name="credit_limit",
            field=models.DecimalField(
                max_digits=14, decimal_places=2, default=DEFAULT_CREDIT_LIMIT,
                help_text=(
                    "Maximum outstanding balance allowed for credit sales. "
                    "Defaults to 5000 so a new customer can buy on credit "
                    "immediately; set it to 0 to make a customer strictly "
                    "CASH-ONLY. Walk-in sales (customer=NULL) never get "
                    "credit regardless."
                ),
            ),
        ),
        migrations.RunPython(forwards, backwards),
    ]
