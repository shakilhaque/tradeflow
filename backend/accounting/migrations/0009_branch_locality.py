"""Branch-aware Chart of Accounts + transaction-level locality tagging.

Adds:
  • Account.is_global (default True — preserves existing behaviour)
  • Account.location FK (NULL when is_global=True)
  • CHECK constraint: is_global=True ⟺ location IS NULL
  • JournalEntryLine.location FK (nullable; required by the service layer
    going forward, legacy rows stay NULL until manually backfilled)
  • Indexes for the per-branch report queries
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0008_payment_link"),
        ("inventory",  "0011_product_extras"),
    ]

    operations = [
        # ── Account ────────────────────────────────────────────────────────────
        migrations.AddField(
            model_name="account",
            name="is_global",
            field=models.BooleanField(
                default=True,
                db_index=True,
                help_text=(
                    "True  = shared across every branch (digital funds, central "
                    "bank/MFS accounts). One row, one balance.\n"
                    "False = pinned to a specific branch. Cashiers at other "
                    "branches cannot touch it. `location` must be set."
                ),
            ),
        ),
        migrations.AddField(
            model_name="account",
            name="location",
            field=models.ForeignKey(
                null=True, blank=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="accounts",
                to="inventory.location",
                help_text="Branch this account belongs to. NULL when is_global=True.",
            ),
        ),
        migrations.AddIndex(
            model_name="account",
            index=models.Index(fields=["is_global", "location"], name="acct_locality_idx"),
        ),
        migrations.AddConstraint(
            model_name="account",
            constraint=models.CheckConstraint(
                check=(
                    models.Q(is_global=True,  location__isnull=True)
                    | models.Q(is_global=False, location__isnull=False)
                ),
                name="account_locality_consistent",
            ),
        ),

        # ── JournalEntryLine ───────────────────────────────────────────────────
        migrations.AddField(
            model_name="journalentryline",
            name="location",
            field=models.ForeignKey(
                null=True, blank=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="journal_lines",
                to="inventory.location",
                db_index=True,
                help_text=(
                    "Branch this debit/credit is attributed to — source of truth "
                    "for per-branch P&L. Set to the branch making the transaction, "
                    "NOT the home branch of the account."
                ),
            ),
        ),
        migrations.AddIndex(
            model_name="journalentryline",
            index=models.Index(fields=["location", "account"], name="jel_loc_account_idx"),
        ),
    ]
