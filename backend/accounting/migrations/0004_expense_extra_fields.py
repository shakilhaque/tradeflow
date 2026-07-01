"""Migration 0004 — extra columns for the Expense list page."""

from decimal import Decimal

from django.db import migrations, models


def _backfill_refs(apps, schema_editor):
    """Generate EP{year}/{serial} refs for any existing rows that lack one.

    NOTE: Queries must use schema_editor.connection.alias so they hit the
    tenant DB being migrated — the TenantDatabaseRouter is not active inside
    RunPython operations.
    """
    db = schema_editor.connection.alias
    Expense = apps.get_model("accounting", "Expense")
    rows = (
        Expense.objects.using(db)
        .filter(reference_no__isnull=True)
        .order_by("expense_date", "created_at")
    )
    counters = {}
    for row in rows:
        yr = row.expense_date.year if row.expense_date else 0
        counters[yr] = counters.get(yr, 0) + 1
        row.reference_no = f"EP{yr}/{counters[yr]:04d}"
        row.save(using=db, update_fields=["reference_no"])


def _backfill_payment_status(apps, schema_editor):
    """If amount > 0 assume Paid (tenants on the old schema treated everything as paid)."""
    db = schema_editor.connection.alias
    Expense = apps.get_model("accounting", "Expense")
    Expense.objects.using(db).filter(paid_amount=Decimal("0")).update(paid_amount=models.F("amount"))
    Expense.objects.using(db).filter(paid_amount__gte=models.F("amount")).update(payment_status="paid")


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0003_alter_account_code_alter_account_id_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="expense",
            name="reference_no",
            field=models.CharField(blank=True, max_length=40, unique=True, null=True),
        ),
        migrations.AddField(
            model_name="expense",
            name="tax_amount",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="expense",
            name="paid_amount",
            field=models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14),
        ),
        migrations.AddField(
            model_name="expense",
            name="payment_status",
            field=models.CharField(
                choices=[("paid", "Paid"), ("partial", "Partial"), ("due", "Due")],
                db_index=True, default="due", max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="expense",
            name="location_id",
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="expense",
            name="expense_for",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="expense",
            name="contact_name",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="expense",
            name="recurring",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="expense",
            name="recurring_details",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.RunPython(_backfill_refs,           reverse_code=migrations.RunPython.noop),
        migrations.RunPython(_backfill_payment_status, reverse_code=migrations.RunPython.noop),
    ]
