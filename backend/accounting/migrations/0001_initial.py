import uuid
from decimal import Decimal

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        # ── Account (Chart of Accounts) ───────────────────────────────────────
        migrations.CreateModel(
            name="Account",
            fields=[
                ("id",           models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("code",         models.CharField(max_length=20, unique=True)),
                ("name",         models.CharField(max_length=200)),
                ("account_type", models.CharField(
                    max_length=20,
                    choices=[
                        ("ASSET",     "Asset"),
                        ("LIABILITY", "Liability"),
                        ("EQUITY",    "Equity"),
                        ("INCOME",    "Income"),
                        ("COGS",      "Cost of Goods Sold"),
                        ("EXPENSE",   "Expense"),
                    ],
                    db_index=True,
                )),
                ("parent",       models.ForeignKey(
                    "self", on_delete=django.db.models.deletion.SET_NULL,
                    null=True, blank=True, related_name="children",
                )),
                ("is_contra",    models.BooleanField(default=False)),
                ("is_system",    models.BooleanField(default=False)),
                ("is_active",    models.BooleanField(default=True, db_index=True)),
                ("description",  models.TextField(blank=True)),
                ("created_at",   models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "chart_of_accounts", "ordering": ["code"]},
        ),
        migrations.AddIndex(
            model_name="account",
            index=models.Index(fields=["account_type", "is_active"], name="acct_type_active_idx"),
        ),

        # ── JournalEntry ──────────────────────────────────────────────────────
        migrations.CreateModel(
            name="JournalEntry",
            fields=[
                ("id",             models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("entry_number",   models.CharField(max_length=30, unique=True)),
                ("reference_type", models.CharField(
                    max_length=20,
                    choices=[
                        ("SALE",       "Sale"),
                        ("PURCHASE",   "Purchase"),
                        ("EXPENSE",    "Expense"),
                        ("PAYMENT",    "Payment"),
                        ("ADJUSTMENT", "Adjustment"),
                        ("OPENING",    "Opening Entry"),
                    ],
                    db_index=True,
                )),
                ("reference_id",   models.UUIDField(null=True, blank=True, db_index=True)),
                ("date",           models.DateField(default=django.utils.timezone.localdate, db_index=True)),
                ("description",    models.TextField()),
                ("is_posted",      models.BooleanField(default=True)),
                ("created_by_id",  models.UUIDField(null=True, blank=True)),
                ("created_at",     models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "journal_entries", "ordering": ["-date", "-created_at"]},
        ),
        migrations.AddIndex(
            model_name="journalentry",
            index=models.Index(fields=["reference_type", "reference_id"], name="je_ref_idx"),
        ),
        migrations.AddIndex(
            model_name="journalentry",
            index=models.Index(fields=["date"], name="je_date_idx"),
        ),

        # ── JournalEntryLine ──────────────────────────────────────────────────
        migrations.CreateModel(
            name="JournalEntryLine",
            fields=[
                ("id",            models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("journal_entry", models.ForeignKey(
                    "accounting.JournalEntry", on_delete=django.db.models.deletion.CASCADE,
                    related_name="lines",
                )),
                ("account",       models.ForeignKey(
                    "accounting.Account", on_delete=django.db.models.deletion.PROTECT,
                    related_name="journal_lines",
                )),
                ("description",   models.CharField(max_length=300, blank=True)),
                ("debit",         models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
                ("credit",        models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))),
            ],
            options={"db_table": "journal_entry_lines"},
        ),
        migrations.AddConstraint(
            model_name="journalentryline",
            constraint=models.CheckConstraint(
                check=~models.Q(debit__gt=0, credit__gt=0),
                name="jel_no_simultaneous_debit_and_credit",
            ),
        ),
        migrations.AddConstraint(
            model_name="journalentryline",
            constraint=models.CheckConstraint(
                check=models.Q(debit__gte=0) & models.Q(credit__gte=0),
                name="jel_non_negative_amounts",
            ),
        ),

        # ── Expense ───────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Expense",
            fields=[
                ("id",              models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("category",        models.CharField(
                    max_length=30,
                    choices=[
                        ("RENT",      "Rent"),
                        ("UTILITIES", "Utilities"),
                        ("SALARIES",  "Salaries"),
                        ("MARKETING", "Marketing"),
                        ("SUPPLIES",  "Supplies"),
                        ("TRANSPORT", "Transport"),
                        ("OTHER",     "Other"),
                    ],
                    db_index=True,
                )),
                ("expense_account", models.ForeignKey(
                    "accounting.Account", on_delete=django.db.models.deletion.PROTECT,
                    related_name="expenses_as_expense",
                )),
                ("payment_account", models.ForeignKey(
                    "accounting.Account", on_delete=django.db.models.deletion.PROTECT,
                    related_name="expenses_as_payment",
                )),
                ("amount",          models.DecimalField(max_digits=14, decimal_places=2)),
                ("description",     models.TextField(blank=True)),
                ("expense_date",    models.DateField(default=django.utils.timezone.localdate, db_index=True)),
                ("journal_entry",   models.OneToOneField(
                    "accounting.JournalEntry", on_delete=django.db.models.deletion.PROTECT,
                    null=True, blank=True, related_name="expense",
                )),
                ("created_by_id",   models.UUIDField()),
                ("created_at",      models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "expenses", "ordering": ["-expense_date", "-created_at"]},
        ),
    ]
