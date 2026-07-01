"""Data migration — normalise every existing Customer.phone and
Customer.alternate_phone in every tenant DB to the canonical
"01XXXXXXXXX" form so printed invoices, the customers list, All Sales
and Shipments tables all render the leading "0" without any caller
needing to remember to call fmtBdPhone().

Why this is needed:
  • CSV imports (Excel re-saves) silently drop the leading 0 — what
    the tenant typed as "01633111116" comes back as "1633111116".
  • Older manual entry didn't enforce the 01 prefix.

Why a migration:
  • Each tenant lives in its own per-tenant Postgres DB (saas_<slug>).
    Django's migrate command runs every tenant's migrations during
    deploy, so this one normalisation pass touches every tenant DB
    automatically — no per-tenant script, no ops checklist.
  • New tenants run the same migrations on first provisioning, so
    they're born with canonical data too.

This is idempotent: a row that is ALREADY "01XXXXXXXXX" passes
through unchanged.
"""
from django.db import migrations


def _canon(raw):
    if not raw:
        return raw
    s = str(raw).strip()
    if not s:
        return s
    d = "".join(c for c in s if c.isdigit())
    # 10 digits starting with "1" → missing leading 0
    if len(d) == 10 and d.startswith("1"):
        return "0" + d
    # 13 digits with the 880 country code
    if len(d) == 13 and d.startswith("880"):
        return "0" + d[3:]
    # 14 digits with the rare "8800…" import quirk
    if len(d) == 14 and d.startswith("8800"):
        return "0" + d[4:]
    return s


def forwards(apps, schema_editor):
    Customer = apps.get_model("sales", "Customer")
    db = schema_editor.connection.alias

    # Defensive guard + outer try/except — some legacy tenant DBs are
    # in an out-of-sync state where django_migrations recorded the
    # table create but the actual schema isn't there. Skip cleanly so
    # one bad tenant doesn't take down the multi-tenant migrate loop;
    # the next provisioning pass will heal the schema.
    try:
        table = Customer._meta.db_table
        with schema_editor.connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() AND table_name = %s",
                [table],
            )
            if cur.fetchone() is None:
                print(f"[normalize_customer_phones] skip {db}: '{table}' missing")
                return

        # Stream rows so even a tenant with 100k contacts doesn't
        # blow memory.
        qs = Customer.objects.using(db).only("id", "phone", "alternate_phone")
        for c in qs.iterator(chunk_size=500):
            new_phone = _canon(c.phone)
            new_alt   = _canon(c.alternate_phone)
            if new_phone != c.phone or new_alt != c.alternate_phone:
                c.phone = new_phone or ""
                c.alternate_phone = new_alt or ""
                c.save(update_fields=["phone", "alternate_phone"])
    except Exception as exc:  # noqa: BLE001
        print(f"[normalize_customer_phones] skip {db}: {exc}")
        return


def backwards(apps, schema_editor):
    # Reversing this would strip valid leading zeros — refuse.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0015_discount_type_and_price_group"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
