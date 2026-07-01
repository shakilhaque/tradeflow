"""
Seed the default Chart of Accounts into every tenant database.

This migration runs via RunPython and uses the historical model so it remains
stable even if Account fields change in future migrations.

Account hierarchy
─────────────────
1000  Current Assets          (parent)
  1001  Cash                  ASSET  is_system
  1002  Bank                  ASSET  is_system
  1003  Mobile Wallet         ASSET  is_system
  1100  Accounts Receivable   ASSET  is_system
  1200  Inventory             ASSET  is_system

2000  Current Liabilities     (parent)
  2100  Accounts Payable      LIABILITY  is_system
  2200  Tax Payable           LIABILITY  is_system

3000  Equity                  (parent)
  3100  Owner's Equity        EQUITY  is_system
  3200  Retained Earnings     EQUITY  is_system

4000  Revenue                 (parent)
  4100  Sales Revenue         INCOME  is_system
  4900  Sales Discounts       INCOME  is_system  is_contra=True

5000  Cost of Goods Sold      COGS   is_system   (also acts as parent)

6000  Operating Expenses      (parent)
  6100  Rent Expense          EXPENSE
  6200  Utilities Expense     EXPENSE
  6300  Salaries Expense      EXPENSE
  6400  Marketing Expense     EXPENSE
  6500  Supplies Expense      EXPENSE
  6600  Transport Expense     EXPENSE
  6900  Miscellaneous Expense EXPENSE
"""
from django.db import migrations


def seed_accounts(apps, schema_editor):
    Account = apps.get_model("accounting", "Account")
    db = schema_editor.connection.alias

    # ── helper ────────────────────────────────────────────────────────────────
    def upsert(code, name, account_type, *,
               parent_code=None, is_contra=False, is_system=False,
               description=""):
        parent = None
        if parent_code:
            parent = Account.objects.using(db).get(code=parent_code)
        obj, _ = Account.objects.using(db).update_or_create(
            code=code,
            defaults=dict(
                name=name,
                account_type=account_type,
                parent=parent,
                is_contra=is_contra,
                is_system=is_system,
                is_active=True,
                description=description,
            ),
        )
        return obj

    # ── 1000 — Current Assets ────────────────────────────────────────────────
    upsert("1000", "Current Assets",       "ASSET", is_system=True,
           description="All current asset accounts")
    upsert("1001", "Cash",                 "ASSET", parent_code="1000", is_system=True,
           description="Physical cash on hand")
    upsert("1002", "Bank",                 "ASSET", parent_code="1000", is_system=True,
           description="Bank / card receipts")
    upsert("1003", "Mobile Wallet",        "ASSET", parent_code="1000", is_system=True,
           description="Mobile money receipts")
    upsert("1100", "Accounts Receivable",  "ASSET", parent_code="1000", is_system=True,
           description="Amounts owed by customers")
    upsert("1200", "Inventory",            "ASSET", parent_code="1000", is_system=True,
           description="Inventory asset at cost (FIFO)")

    # ── 2000 — Current Liabilities ───────────────────────────────────────────
    upsert("2000", "Current Liabilities",  "LIABILITY", is_system=True,
           description="All current liability accounts")
    upsert("2100", "Accounts Payable",     "LIABILITY", parent_code="2000", is_system=True,
           description="Amounts owed to suppliers")
    upsert("2200", "Tax Payable",          "LIABILITY", parent_code="2000", is_system=True,
           description="VAT / sales tax collected but not yet remitted")

    # ── 3000 — Equity ────────────────────────────────────────────────────────
    upsert("3000", "Equity",               "EQUITY", is_system=True,
           description="Owner equity accounts")
    upsert("3100", "Owner's Equity",       "EQUITY", parent_code="3000", is_system=True,
           description="Capital contributed by owners")
    upsert("3200", "Retained Earnings",    "EQUITY", parent_code="3000", is_system=True,
           description="Cumulative net income retained in the business")

    # ── 4000 — Revenue ───────────────────────────────────────────────────────
    upsert("4000", "Revenue",              "INCOME", is_system=True,
           description="All revenue accounts")
    upsert("4100", "Sales Revenue",        "INCOME", parent_code="4000", is_system=True,
           description="Revenue from product sales")
    upsert("4900", "Sales Discounts",      "INCOME", parent_code="4000",
           is_system=True, is_contra=True,
           description="Contra-revenue: discounts granted to customers")

    # ── 5000 — Cost of Goods Sold ─────────────────────────────────────────────
    upsert("5000", "Cost of Goods Sold",   "COGS", is_system=True,
           description="FIFO cost of products sold")

    # ── 6000 — Operating Expenses ────────────────────────────────────────────
    upsert("6000", "Operating Expenses",   "EXPENSE", is_system=False,
           description="All operating expense accounts")
    upsert("6100", "Rent Expense",         "EXPENSE", parent_code="6000",
           description="Office / store rent")
    upsert("6200", "Utilities Expense",    "EXPENSE", parent_code="6000",
           description="Electricity, water, internet")
    upsert("6300", "Salaries Expense",     "EXPENSE", parent_code="6000",
           description="Employee salaries and wages")
    upsert("6400", "Marketing Expense",    "EXPENSE", parent_code="6000",
           description="Advertising and promotions")
    upsert("6500", "Supplies Expense",     "EXPENSE", parent_code="6000",
           description="Office and operational supplies")
    upsert("6600", "Transport Expense",    "EXPENSE", parent_code="6000",
           description="Delivery and travel costs")
    upsert("6900", "Miscellaneous Expense","EXPENSE", parent_code="6000",
           description="Other operating expenses")


def unseed_accounts(apps, schema_editor):
    """Reverse: remove only the seeded accounts (leaf → parent order)."""
    Account = apps.get_model("accounting", "Account")
    db = schema_editor.connection.alias
    codes = [
        "6900", "6600", "6500", "6400", "6300", "6200", "6100", "6000",
        "5000",
        "4900", "4100", "4000",
        "3200", "3100", "3000",
        "2200", "2100", "2000",
        "1200", "1100", "1003", "1002", "1001", "1000",
    ]
    Account.objects.using(db).filter(code__in=codes).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounting", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_accounts, reverse_code=unseed_accounts),
    ]
