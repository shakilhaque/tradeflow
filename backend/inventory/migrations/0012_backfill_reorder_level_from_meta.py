"""Backfill Product.reorder_level from the legacy meta.alert_qty.

The Add Product form used to store the "Alert quantity" only inside
Product.meta["alert_qty"] (a JSON blob), while the low-stock report and the
dashboard "Product Stock Alert" filter on the real Product.reorder_level
column. Because the column kept its default of 0, the alert effectively
never fired — every product looked "above its alert quantity".

The form now writes reorder_level directly, but existing products across
every tenant still have their threshold trapped in meta.alert_qty. This
migration copies that value into reorder_level for any product whose
reorder_level is still 0/NULL but has a positive meta.alert_qty.

Per-tenant + defensive (each tenant lives in its own DB; migrate runs this
on every tenant during deploy, and on new tenants at provisioning).
Idempotent: products already carrying a reorder_level are left untouched.
"""
from decimal import Decimal, InvalidOperation

from django.db import migrations, models


def forwards(apps, schema_editor):
    Product = apps.get_model("inventory", "Product")
    db = schema_editor.connection.alias

    try:
        table = Product._meta.db_table
        with schema_editor.connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() AND table_name = %s",
                [table],
            )
            if cur.fetchone() is None:
                print(f"[backfill_reorder_level] skip {db}: '{table}' missing")
                return

        updated = 0
        qs = (
            Product.objects.using(db)
            .filter(models.Q(reorder_level__isnull=True) | models.Q(reorder_level__lte=0))
            .only("id", "reorder_level", "meta")
        )
        for p in qs.iterator(chunk_size=500):
            raw = (p.meta or {}).get("alert_qty")
            if raw in (None, ""):
                continue
            try:
                val = Decimal(str(raw))
            except (InvalidOperation, TypeError, ValueError):
                continue
            if val > 0:
                p.reorder_level = val
                p.save(update_fields=["reorder_level"])
                updated += 1
        print(f"[backfill_reorder_level] {db}: {updated} product(s) updated")
    except Exception as exc:  # noqa: BLE001
        print(f"[backfill_reorder_level] skip {db}: {exc}")
        return


def backwards(apps, schema_editor):
    # One-way data heal — nothing to reverse.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0011_product_extras"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
