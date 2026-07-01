"""
Defensive backfill — guarantee the Customer balance columns exist on EVERY
tenant database.

`advance_balance` (and its sibling `opening_balance`) were introduced in
0009_customer_extra_fields. In practice a handful of older tenant databases
ended up with 0009 recorded as *applied* in django_migrations while the
physical columns were never created (e.g. a faked/edited migration history,
or a provisioning run that half-completed). On those tenants the new
customer-advance / Pay feature fails with
`column customers.advance_balance does not exist`, even though it works fine
on freshly provisioned tenants.

A plain AddField here would crash on the (vast majority of) tenants that
already have the columns. Instead we run idempotent `ADD COLUMN IF NOT
EXISTS` SQL with NO state_operations — Django's model state already knows
about these fields from 0009, so we only need to reconcile the database.

On a tenant that already has the columns this is a pure no-op; on one that
is missing them it adds them with the correct type/default. Either way,
`migrate_tenants` brings the whole fleet to a consistent schema.
"""
from django.db import migrations


SQL = """
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS advance_balance numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS opening_balance numeric(14, 2) NOT NULL DEFAULT 0;
"""


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0019_saleitem_note"),
    ]

    operations = [
        # reverse_sql = noop: these columns are part of the real schema since
        # 0009, so we never want to drop them on a rollback of THIS migration.
        migrations.RunSQL(sql=SQL, reverse_sql=migrations.RunSQL.noop),
    ]
