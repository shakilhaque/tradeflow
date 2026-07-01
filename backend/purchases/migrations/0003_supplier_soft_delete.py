"""Add SoftDeleteMixin columns (is_deleted, deleted_at) to Supplier.

The Supplier model inherits from accounts.soft_delete.SoftDeleteMixin
but the matching columns were never generated on the tenant tables —
every list endpoint then 500s with:

    column suppliers.is_deleted does not exist

Idempotent at the DB level
──────────────────────────
Some tenant DBs already have these columns from an earlier ad-hoc
ALTER (or a prior failed migration attempt). Plain AddField would
crash there with "column already exists". We split the migration:

  - state_operations:    Django records the columns in its model
                         state (so the ORM knows about them).
  - database_operations: RunSQL with ADD COLUMN IF NOT EXISTS —
                         safe whether the column is there or not.

That lets `migrate_tenants` succeed on EVERY tenant DB regardless
of its prior state, including freshly-provisioned tenants where the
columns genuinely don't exist yet.
"""
from django.db import migrations, models


ADD_COLUMNS_SQL = """
    ALTER TABLE suppliers
        ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone NULL;
    CREATE INDEX IF NOT EXISTS suppliers_is_deleted_idx ON suppliers (is_deleted);
"""

REVERSE_SQL = """
    DROP INDEX IF EXISTS suppliers_is_deleted_idx;
    ALTER TABLE suppliers
        DROP COLUMN IF EXISTS is_deleted,
        DROP COLUMN IF EXISTS deleted_at;
"""


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0002_supplier_extra_fields"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name="supplier",
                    name="is_deleted",
                    field=models.BooleanField(default=False, db_index=True, editable=False),
                ),
                migrations.AddField(
                    model_name="supplier",
                    name="deleted_at",
                    field=models.DateTimeField(null=True, blank=True, editable=False),
                ),
            ],
            database_operations=[
                migrations.RunSQL(sql=ADD_COLUMNS_SQL, reverse_sql=REVERSE_SQL),
            ],
        ),
    ]
