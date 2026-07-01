"""
Seed sample expense rows for a given tenant DB so the new List Expenses page
has data to display.

Usage:
    python manage.py seed_expenses                 # all registered tenant DBs
    python manage.py seed_expenses --db tenant_xxx # one specific alias
    python manage.py seed_expenses --count 30      # rows per tenant (default 25)
"""
import random
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connections

from accounts.tenant_db import register_tenant_db
from accounts.models import Tenant


SAMPLE_NAMES = ["Ongko Printers", "BD Bago Software", "Banani Office", "Demo Vendor", "Generic Supplier"]
SAMPLE_NOTES = [
    "Office supplies",
    "Internet bill - May",
    "Software subscription",
    "Rent payment",
    "Cleaning service",
    "Courier charges",
    "Marketing campaign",
    "Staff lunch",
    "Electricity bill",
    "Vehicle fuel",
]


class Command(BaseCommand):
    help = "Insert sample Expense rows in tenant database(s)."

    def add_arguments(self, parser):
        parser.add_argument("--db",    type=str, default=None, help="Specific tenant DB alias.")
        parser.add_argument("--count", type=int, default=25,   help="Rows to insert per tenant.")

    def handle(self, *args, **options):
        target = options["db"]
        count  = options["count"]

        tenants = Tenant.objects.filter(is_provisioned=True)
        if target:
            tenants = tenants.filter(db_alias=target)

        if not tenants.exists():
            self.stderr.write("No matching provisioned tenants.")
            return

        for tenant in tenants:
            register_tenant_db(tenant.db_alias, tenant.db_name)
            self._seed_one(tenant.db_alias, count)
            self.stdout.write(self.style.SUCCESS(
                f"Seeded {count} expenses for tenant: {tenant.user.email if tenant.user else tenant.db_alias}"
            ))

    def _seed_one(self, db_alias: str, count: int):
        # Lazy import — must happen AFTER register_tenant_db so router routes to tenant DB.
        from accounting.models import Account, Expense

        # Need at least one expense account and one payment account
        expense_acct = Account.objects.using(db_alias).filter(account_type="EXPENSE").first()
        payment_acct = Account.objects.using(db_alias).filter(account_type="ASSET").first()
        if not expense_acct or not payment_acct:
            self.stderr.write(
                f"  ! Skipping {db_alias}: missing EXPENSE or ASSET accounts in chart."
            )
            return

        # Pick a location id from inventory if any
        try:
            from inventory.models import Location  # noqa: PLC0415
            loc_id = Location.objects.using(db_alias).values_list("id", flat=True).first()
        except Exception:
            loc_id = None

        categories = [c[0] for c in Expense.Category.choices]
        statuses   = ["paid", "paid", "paid", "partial", "due"]  # weighted toward paid

        # Use a dummy created_by_id (pull any user)
        from accounts.models import User
        created_by = User.objects.values_list("id", flat=True).first() or "00000000-0000-0000-0000-000000000000"

        today = date.today()
        for i in range(count):
            amt   = Decimal(random.choice([300, 400, 500, 750, 900, 1500, 2200])).quantize(Decimal("0.01"))
            tax   = (amt * Decimal("0.05")).quantize(Decimal("0.01"))
            stat  = random.choice(statuses)
            paid  = amt if stat == "paid" else (amt / 2 if stat == "partial" else Decimal("0"))
            ed    = today - timedelta(days=random.randint(0, 60))

            Expense.objects.using(db_alias).create(
                category        = random.choice(categories),
                expense_account = expense_acct,
                payment_account = payment_acct,
                amount          = amt,
                tax_amount      = tax,
                paid_amount     = paid,
                payment_status  = stat,
                location_id     = loc_id,
                expense_for     = random.choice(SAMPLE_NAMES),
                contact_name    = random.choice(SAMPLE_NAMES),
                description     = random.choice(SAMPLE_NOTES),
                expense_date    = ed,
                created_by_id   = created_by,
            )
