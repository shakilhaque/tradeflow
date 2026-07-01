"""
Migration 0002 — Seed default system settings and a "No Tax" tax group.

All settings use update_or_create so re-running migrations is safe.
"""

from django.db import migrations

# (key, value_str, value_type, description)
_DEFAULT_SETTINGS = [
    # Currency
    ("currency.symbol",   "USD",    "STRING",  "Currency symbol shown in UI and receipts"),
    ("currency.code",     "USD",    "STRING",  "ISO 4217 currency code"),
    ("currency.position", "before", "STRING",  "Symbol position: 'before' or 'after' the amount"),

    # Tax
    ("tax.default_rate",    "0",     "FLOAT",   "Default tax rate percentage (0 = no tax)"),
    ("tax.inclusive",       "false", "BOOLEAN", "Whether prices include tax by default"),
    ("tax.registration_no", "",      "STRING",  "Business tax registration / VAT number"),

    # Barcode
    ("barcode.auto_generate", "true", "BOOLEAN", "Auto-generate EAN-13 barcode for new products"),
    ("barcode.prefix",        "2",    "STRING",  "EAN-13 prefix for auto-generated barcodes"),

    # Receipt
    ("receipt.header",   "My Store",        "STRING",  "Store name / header text on printed receipts"),
    ("receipt.footer",   "Thank you!",      "STRING",  "Footer message on printed receipts"),
    ("receipt.show_tax", "true",            "BOOLEAN", "Show tax line on receipt printout"),

    # Low stock
    ("low_stock.check_enabled", "true", "BOOLEAN", "Enable periodic low-stock alert checking"),
    ("low_stock.default_qty",   "5",    "INTEGER", "Default reorder level for products without one set"),

    # Sales
    ("sales.allow_negative_stock", "false", "BOOLEAN",
     "Allow sales even when stock goes negative (backorder mode)"),

    # Date/time
    ("timezone", "UTC", "STRING", "Tenant timezone (IANA name, e.g. Africa/Nairobi)"),
]

# (code, name, rate, is_default, description)
_DEFAULT_TAX_GROUPS = [
    ("NO_TAX", "No Tax",   "0.0000",  True,  "Zero-rated / exempt"),
    ("VAT5",   "VAT 5%",   "5.0000",  False, "5% value-added tax"),
    ("VAT10",  "VAT 10%",  "10.0000", False, "10% value-added tax"),
    ("VAT15",  "VAT 15%",  "15.0000", False, "15% value-added tax"),
    ("VAT20",  "VAT 20%",  "20.0000", False, "20% value-added tax"),
]


def seed_defaults(apps, schema_editor):
    db = schema_editor.connection.alias
    SystemSetting = apps.get_model("system_config", "SystemSetting")
    TaxGroup      = apps.get_model("system_config", "TaxGroup")

    for (key, value_str, value_type, description) in _DEFAULT_SETTINGS:
        SystemSetting.objects.using(db).update_or_create(
            key=key,
            defaults=dict(value_str=value_str, value_type=value_type, description=description),
        )

    for (code, name, rate, is_default, description) in _DEFAULT_TAX_GROUPS:
        TaxGroup.objects.using(db).update_or_create(
            code=code,
            defaults=dict(name=name, rate=rate, is_default=is_default,
                          description=description, is_active=True),
        )


def delete_defaults(apps, schema_editor):
    db = schema_editor.connection.alias
    apps.get_model("system_config", "SystemSetting").objects.using(db).all().delete()
    apps.get_model("system_config", "TaxGroup").objects.using(db).all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("system_config", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_defaults, reverse_code=delete_defaults),
    ]
