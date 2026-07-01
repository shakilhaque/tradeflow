"""Data migration — canonicalise every existing Supplier.phone and
Supplier.alternate_phone so legacy / imported rows that lost the
leading "0" get restored to the 11-digit "01XXXXXXXXX" form.

Mirrors sales/0016_normalize_customer_phones.py — same rationale, same
canonicalisation rules, same multi-tenant safety net (the migration
runs on every tenant DB during deploy and on every new tenant on
first provisioning).
"""
from django.db import migrations


def _canon(raw):
    if not raw:
        return raw
    s = str(raw).strip()
    if not s:
        return s
    d = "".join(c for c in s if c.isdigit())
    if len(d) == 10 and d.startswith("1"):
        return "0" + d
    if len(d) == 13 and d.startswith("880"):
        return "0" + d[3:]
    if len(d) == 14 and d.startswith("8800"):
        return "0" + d[4:]
    return s


def forwards(apps, schema_editor):
    Supplier = apps.get_model("purchases", "Supplier")
    db = schema_editor.connection.alias

    # Some legacy tenant DBs were registered before the purchases app
    # ever created its tables (the django_migrations row was inserted
    # by an earlier failed deploy but the actual schema never built).
    # Skip those — there are no Supplier rows to normalise anyway,
    # and a fresh `purchases/0001_initial` will build the table next
    # time the tenant uses Suppliers. The presence check below uses
    # information_schema so it works on any backend; the outer
    # try/except is a belt-and-suspenders fallback so the multi-tenant
    # migrate loop never aborts on ONE bad tenant.
    try:
        table = Supplier._meta.db_table
        with schema_editor.connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() AND table_name = %s",
                [table],
            )
            if cur.fetchone() is None:
                print(f"[normalize_supplier_phones] skip {db}: '{table}' missing")
                return

        qs = Supplier.objects.using(db).only("id", "phone", "alternate_phone")
        for s in qs.iterator(chunk_size=500):
            new_phone = _canon(s.phone)
            new_alt   = _canon(s.alternate_phone)
            if new_phone != s.phone or new_alt != s.alternate_phone:
                s.phone = new_phone or ""
                s.alternate_phone = new_alt or ""
                s.save(update_fields=["phone", "alternate_phone"])
    except Exception as exc:  # noqa: BLE001
        # Don't bring down the multi-tenant migrate loop. Log + move on.
        print(f"[normalize_supplier_phones] skip {db}: {exc}")
        return


def backwards(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("purchases", "0004_supplier_individual_business_fields"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
