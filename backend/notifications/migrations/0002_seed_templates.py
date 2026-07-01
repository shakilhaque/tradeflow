"""
Migration 0002 — Seed default notification templates.

Seeds one template per (event_type, channel) combination for the most
common channels (EMAIL + IN_APP).  SMS templates are seeded but inactive
by default — enable via the system settings UI when an SMS provider is
configured.
"""

from django.db import migrations

# Each entry: (event_type, channel, name, subject_template, body_template, is_active)
_TEMPLATES = [
    # LOW_STOCK ────────────────────────────────────────────────────────────────
    (
        "LOW_STOCK", "EMAIL",
        "Low Stock Alert — Email",
        "Low Stock Alert: {product_name} [{sku}]",
        (
            "Hello,\n\n"
            "This is an automated alert to inform you that stock for the following "
            "product has dropped to or below the reorder level.\n\n"
            "  Product   : {product_name}\n"
            "  SKU       : {sku}\n"
            "  Current Qty : {current_qty}\n"
            "  Reorder Level: {reorder_level}\n\n"
            "Please arrange a restock at your earliest convenience.\n\n"
            "Regards,\nInventory System"
        ),
        True,
    ),
    (
        "LOW_STOCK", "IN_APP",
        "Low Stock Alert — In-App",
        "Low Stock: {product_name}",
        "Stock for {product_name} [{sku}] is at {current_qty} units (reorder level: {reorder_level}).",
        True,
    ),
    (
        "LOW_STOCK", "SMS",
        "Low Stock Alert — SMS",
        "",
        "LOW STOCK: {product_name} [{sku}] — only {current_qty} left. Reorder level: {reorder_level}.",
        False,    # disabled until SMS provider configured
    ),
    # NEW_SALE ─────────────────────────────────────────────────────────────────
    (
        "NEW_SALE", "EMAIL",
        "New Sale — Email",
        "Sale #{sale_number} Confirmed",
        (
            "Thank you for your purchase!\n\n"
            "  Sale #      : {sale_number}\n"
            "  Date        : {date}\n"
            "  Total       : {total_amount}\n"
            "  Payment     : {payment_status}\n\n"
            "Regards,\nThe Store Team"
        ),
        True,
    ),
    (
        "NEW_SALE", "IN_APP",
        "New Sale — In-App",
        "New sale #{sale_number}",
        "Sale #{sale_number} totalling {total_amount} was recorded on {date}.",
        True,
    ),
    (
        "NEW_SALE", "SMS",
        "New Sale — SMS",
        "",
        "Sale #{sale_number} confirmed. Total: {total_amount}. Status: {payment_status}.",
        False,
    ),
    # PAYMENT_DUE ──────────────────────────────────────────────────────────────
    (
        "PAYMENT_DUE", "EMAIL",
        "Payment Due — Email",
        "Payment Due: Sale #{sale_number}",
        (
            "Hello,\n\n"
            "A payment is outstanding for the following sale.\n\n"
            "  Sale #      : {sale_number}\n"
            "  Total       : {total_amount}\n"
            "  Paid        : {amount_paid}\n"
            "  Balance Due : {balance_due}\n\n"
            "Please settle at your earliest convenience.\n\n"
            "Regards,\nThe Store Team"
        ),
        True,
    ),
    (
        "PAYMENT_DUE", "IN_APP",
        "Payment Due — In-App",
        "Payment due for sale #{sale_number}",
        "Balance of {balance_due} is outstanding on sale #{sale_number}.",
        True,
    ),
    (
        "PAYMENT_DUE", "SMS",
        "Payment Due — SMS",
        "",
        "Payment due: {balance_due} outstanding on sale #{sale_number}. Please settle soon.",
        False,
    ),
    # BACKORDER ────────────────────────────────────────────────────────────────
    (
        "BACKORDER", "EMAIL",
        "Backorder Alert — Email",
        "Backorder Alert: {product_name} [{sku}]",
        (
            "Hello,\n\n"
            "A sale attempted to consume more stock than is available.\n\n"
            "  Product     : {product_name} [{sku}]\n"
            "  Requested   : {qty_requested}\n"
            "  Available   : {qty_available}\n"
            "  Shortage    : {shortage}\n\n"
            "Please restock immediately.\n\n"
            "Regards,\nInventory System"
        ),
        True,
    ),
    (
        "BACKORDER", "IN_APP",
        "Backorder Alert — In-App",
        "Backorder: {product_name}",
        "Backorder on {product_name} [{sku}]: {qty_requested} requested, only {qty_available} available.",
        True,
    ),
    (
        "BACKORDER", "SMS",
        "Backorder Alert — SMS",
        "",
        "BACKORDER: {product_name} [{sku}]. Need {qty_requested}, have {qty_available}. Shortage: {shortage}.",
        False,
    ),
    # SALE_VOIDED ──────────────────────────────────────────────────────────────
    (
        "SALE_VOIDED", "EMAIL",
        "Sale Voided — Email",
        "Sale #{sale_number} Has Been Voided",
        (
            "Hello,\n\n"
            "The following sale has been voided.\n\n"
            "  Sale #  : {sale_number}\n"
            "  Amount  : {total_amount}\n"
            "  Reason  : {void_reason}\n\n"
            "Regards,\nThe Store Team"
        ),
        True,
    ),
    (
        "SALE_VOIDED", "IN_APP",
        "Sale Voided — In-App",
        "Sale #{sale_number} voided",
        "Sale #{sale_number} ({total_amount}) has been voided. Reason: {void_reason}",
        True,
    ),
    (
        "SALE_VOIDED", "SMS",
        "Sale Voided — SMS",
        "",
        "Sale #{sale_number} voided. Amount: {total_amount}. Reason: {void_reason}.",
        False,
    ),
    # IMPORT_DONE ──────────────────────────────────────────────────────────────
    (
        "IMPORT_DONE", "EMAIL",
        "Import Completed — Email",
        "Import Completed: {import_type} ({committed_rows} rows)",
        (
            "Hello,\n\n"
            "Your data import has completed successfully.\n\n"
            "  Type      : {import_type}\n"
            "  File      : {file_name}\n"
            "  Rows      : {committed_rows}\n"
            "  Completed : {committed_at}\n\n"
            "Regards,\nImport System"
        ),
        True,
    ),
    (
        "IMPORT_DONE", "IN_APP",
        "Import Completed — In-App",
        "Import done: {import_type}",
        "{committed_rows} {import_type} records imported from {file_name} at {committed_at}.",
        True,
    ),
    (
        "IMPORT_DONE", "SMS",
        "Import Completed — SMS",
        "",
        "Import done: {committed_rows} {import_type} records from {file_name}.",
        False,
    ),
]


def seed_templates(apps, schema_editor):
    db = schema_editor.connection.alias
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for (event_type, channel, name, subject, body, is_active) in _TEMPLATES:
        NotificationTemplate.objects.using(db).update_or_create(
            event_type=event_type,
            channel=channel,
            defaults=dict(
                name=name,
                subject_template=subject,
                body_template=body,
                is_active=is_active,
            ),
        )


def delete_templates(apps, schema_editor):
    db = schema_editor.connection.alias
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.using(db).all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("notifications", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_templates, reverse_code=delete_templates),
    ]
