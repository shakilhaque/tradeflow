"""
Reset Plan.price (and related plan fields) to the canonical values declared
in `accounts/migrations/0008_plan_pricing_v2.py`.

When the admin edits a plan via Django admin and accidentally bumps a price,
the only audit trail is the Payment rows already created at the wrong price.
Run this command after such an edit to put the Plan rows back to the
documented BDT prices (and optionally fix in-place the most recent Payment
amounts that were charged at the inflated price).

Usage
─────
  # See what would change (no writes):
  python manage.py sync_plan_prices --dry-run

  # Reset Plan rows only (Payments untouched):
  python manage.py sync_plan_prices

  # Also rewrite Payment.amount for SUCCESS payments where the stored amount
  # doesn't match the canonical plan price (use with care — this rewrites
  # historical financial data, only do this if you know the customer was
  # actually charged the canonical amount and the Payment row is just wrong):
  python manage.py sync_plan_prices --fix-payments

  # Limit Payment fixing to a single plan code:
  python manage.py sync_plan_prices --fix-payments --plan basic-monthly
"""
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction


# Canonical pricing — kept in sync with migration 0008_plan_pricing_v2.PLANS.
# Only the fields that actually affect billing are listed; description,
# features and sort_order are NOT touched (those are tenant-visible copy).
CANONICAL = {
    "basic-monthly":     {"name": "Basic",                  "price": Decimal("300")},
    "basic-yearly":      {"name": "Basic (Yearly)",         "price": Decimal("2880")},
    "standard-monthly":  {"name": "Standard",               "price": Decimal("500")},
    "standard-yearly":   {"name": "Standard (Yearly)",      "price": Decimal("4800")},
    "premium-monthly":   {"name": "Premium",                "price": Decimal("700")},
    "premium-yearly":    {"name": "Premium (Yearly)",       "price": Decimal("6720")},
    # Trial / custom plans intentionally not listed — those don't drive billing.
}


class Command(BaseCommand):
    help = "Reset Plan.price to the canonical BDT values (and optionally fix mis-priced Payments)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="Show what would change, write nothing.")
        parser.add_argument("--fix-payments", action="store_true",
                            help="Also rewrite Payment.amount for SUCCESS payments stored at the wrong price.")
        parser.add_argument("--plan", default=None,
                            help="Limit --fix-payments to this plan code (e.g. basic-monthly).")

    def handle(self, *args, **opts):
        from accounts.models import Plan, Payment

        dry = bool(opts["dry_run"])
        fix_pay = bool(opts["fix_payments"])
        only_plan = opts.get("plan")

        if dry:
            self.stdout.write(self.style.WARNING("DRY RUN — no writes will be made."))

        plan_updates = 0
        with transaction.atomic():
            for code, want in CANONICAL.items():
                try:
                    plan = Plan.objects.get(code=code)
                except Plan.DoesNotExist:
                    self.stdout.write(f"  · {code}: missing (skipping)")
                    continue
                changes = []
                if plan.price != want["price"]:
                    changes.append(f"price {plan.price} → {want['price']}")
                # Don't touch the display name unless it's been mangled.
                if plan.name != want["name"]:
                    changes.append(f"name '{plan.name}' → '{want['name']}'")
                if not changes:
                    self.stdout.write(f"  · {code}: already canonical")
                    continue
                self.stdout.write(self.style.NOTICE(f"  · {code}: {', '.join(changes)}"))
                if not dry:
                    plan.price = want["price"]
                    plan.name  = want["name"]
                    plan.save(update_fields=["price", "name"])
                plan_updates += 1

            payment_updates = 0
            if fix_pay:
                self.stdout.write("")
                self.stdout.write(self.style.WARNING("Rewriting Payment.amount where it differs from the canonical plan price…"))
                qs = Payment.objects.filter(status="success").select_related("subscription__plan")
                if only_plan:
                    qs = qs.filter(subscription__plan__code=only_plan)
                for p in qs:
                    plan = p.subscription.plan if p.subscription else None
                    code = plan.code if plan else None
                    if not code or code not in CANONICAL:
                        continue
                    want = CANONICAL[code]["price"]
                    if p.amount == want:
                        continue
                    self.stdout.write(
                        f"    · txn {p.transaction_id or p.id}: {p.amount} → {want} ({code})"
                    )
                    if not dry:
                        p.amount = want
                        p.save(update_fields=["amount"])
                    payment_updates += 1
            if dry:
                # Roll back the transaction even though we didn't write.
                transaction.set_rollback(True)

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"Plans updated: {plan_updates}"
            + (f"  · Payments rewritten: {payment_updates}" if fix_pay else "")
            + ("  (DRY RUN)" if dry else "")
        ))
