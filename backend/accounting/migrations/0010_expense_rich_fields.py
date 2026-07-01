"""Add expense_category FK + method-specific fields + payment-account
reference + attached-document URL to the Expense model.

Idempotent SQL via SeparateDatabaseAndState (RunSQL ADD COLUMN IF
NOT EXISTS) so it re-applies safely across tenant DBs that may
already have hand-patched these columns.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0009_branch_locality"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name="expense",
                    name="contact_id",
                    field=models.UUIDField(null=True, blank=True, db_index=True),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="expense_category",
                    field=models.ForeignKey(
                        null=True, blank=True,
                        on_delete=models.deletion.PROTECT,
                        related_name="expenses",
                        to="accounting.expensecategory",
                    ),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="expense_sub_category",
                    field=models.ForeignKey(
                        null=True, blank=True,
                        on_delete=models.deletion.PROTECT,
                        related_name="sub_expenses",
                        to="accounting.expensecategory",
                    ),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="payment_account_picked_id",
                    field=models.UUIDField(null=True, blank=True, db_index=True),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="payment_method",
                    field=models.CharField(max_length=20, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="card_holder_name",
                    field=models.CharField(max_length=120, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="card_transaction_no",
                    field=models.CharField(max_length=120, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="card_type",
                    field=models.CharField(max_length=20, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="card_month",
                    field=models.CharField(max_length=2, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="card_year",
                    field=models.CharField(max_length=4, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="cheque_no",
                    field=models.CharField(max_length=60, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="bank_account_no",
                    field=models.CharField(max_length=60, blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="expense",
                    name="attach_document_url",
                    field=models.URLField(max_length=500, blank=True, default=""),
                ),
            ],
            database_operations=[
                migrations.RunSQL(
                    sql=[
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "contact_id" uuid;',
                        'CREATE INDEX IF NOT EXISTS "expenses_contact_id_idx" ON "expenses" ("contact_id");',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "expense_category_id" uuid REFERENCES "expense_categories"("id") DEFERRABLE INITIALLY DEFERRED;',
                        'CREATE INDEX IF NOT EXISTS "expenses_expense_category_id_idx" ON "expenses" ("expense_category_id");',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "expense_sub_category_id" uuid REFERENCES "expense_categories"("id") DEFERRABLE INITIALLY DEFERRED;',
                        'CREATE INDEX IF NOT EXISTS "expenses_expense_sub_category_id_idx" ON "expenses" ("expense_sub_category_id");',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "payment_account_picked_id" uuid;',
                        'CREATE INDEX IF NOT EXISTS "expenses_payment_account_picked_idx" ON "expenses" ("payment_account_picked_id");',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "payment_method"     varchar(20)  NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "card_holder_name"    varchar(120) NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "card_transaction_no" varchar(120) NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "card_type"           varchar(20)  NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "card_month"          varchar(2)   NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "card_year"           varchar(4)   NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "cheque_no"           varchar(60)  NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "bank_account_no"     varchar(60)  NOT NULL DEFAULT \'\';',
                        'ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "attach_document_url" varchar(500) NOT NULL DEFAULT \'\';',
                    ],
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
        ),
    ]
