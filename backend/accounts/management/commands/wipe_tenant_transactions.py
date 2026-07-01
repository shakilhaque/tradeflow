"""
Wipe a single tenant's SALES + PURCHASE transaction history.

DESTRUCTIVE — deletes data permanently. Dry-run by default; you must
pass --confirm to actually delete. Always runs inside one DB
transaction per tenant, so a mid-run failure rolls everything back.

What it removes (for the named tenant only):
  • Sales side  : Sale, SaleItem, SalePayment, SellReturn,
                  SellReturnItem
  • Purchase side: Purchase, PurchaseItem, PurchasePayment,
                  PurchaseReturn, PurchaseReturnItem
  • Inventory reset (unless --keep-stock): FIFOLayer + StockMovement
                  deleted, every ProductStock.quantity set to 0 — so no
                  phantom stock is left from the deleted purchases/sales.
  • Payment accounts (unless --keep-accounts): PaymentAccountTransaction
                  rows of kind SALE (sale receipts) and WITHDRAWAL
                  (supplier payments) deleted, so each account's balance
                  drops the sale/purchase cash footprint back to its
                  opening balance + remaining (deposits/expenses/
                  transfers/manual adjustments are untouched).

What it KEEPS: products, contacts, locations, expenses, payment
accounts themselves, settings, users — everything that isn't a sale or
purchase transaction.

Usage (run on the server, inside the backend venv):
    # inspect first — shows counts, deletes nothing
    python manage.py wipe_tenant_transactions --db-name saas_ongko_computer_stationary --dry-run

    # actually wipe (full clean slate)
    python manage.py wipe_tenant_transactions --db-name saas_ongko_computer_stationary --confirm

    # by tenant identifier instead of db name
    python manage.py wipe_tenant_transactions --identifier owner@example.com --confirm

    # keep inventory / account balances as-is (rows only)
    python manage.py wipe_tenant_transactions --db-name saas_… --confirm --keep-stock --keep-accounts

    # ALSO empty the product catalogue (List Products page)
    python manage.py wipe_tenant_transactions --db-name saas_… --products --dry-run
    python manage.py wipe_tenant_transactions --db-name saas_… --products --confirm
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from accounts.models import Tenant
from accounts.services import resolve_user_by_identifier
from accounts.tenant_db import (
    register_tenant_db,
    set_current_db_alias,
    clear_current_db_alias,
)


def _label(tenant) -> str:
    u = tenant.user
    who = u.email or u.phone or u.username or str(u.id)
    return f"{who} ({tenant.db_name})"


class Command(BaseCommand):
    help = "Delete a tenant's sales + purchase transaction history (dry-run unless --confirm)."

    def add_arguments(self, parser):
        parser.add_argument("--db-name", type=str, default="",
                            help="Physical tenant DB name, e.g. saas_ongko_computer_stationary.")
        parser.add_argument("--alias", type=str, default="",
                            help="Tenant db_alias.")
        parser.add_argument("--identifier", type=str, default="",
                            help="Tenant owner email / mobile / username.")
        parser.add_argument("--confirm", action="store_true",
                            help="Actually delete. Without this it's a dry-run.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Explicit dry-run (this is also the default when --confirm is absent).")
        parser.add_argument("--keep-stock", action="store_true",
                            help="Do NOT reset inventory (leave FIFO layers / ProductStock / movements).")
        parser.add_argument("--keep-accounts", action="store_true",
                            help="Do NOT remove SALE/WITHDRAWAL payment-account transactions.")
        parser.add_argument("--products", action="store_true",
                            help="ALSO delete the entire product catalogue (products, "
                                 "variations, combo items, stock transfers). Use to empty "
                                 "the List Products page.")

    # ── Resolve the single target tenant ───────────────────────────
    def _resolve_tenant(self, options):
        qs = Tenant.objects.select_related("user")
        if options["db_name"]:
            return qs.filter(db_name=options["db_name"].strip()).first()
        if options["alias"]:
            return qs.filter(db_alias=options["alias"].strip()).first()
        if options["identifier"]:
            user = resolve_user_by_identifier(options["identifier"].strip())
            if not user:
                return None
            return qs.filter(user=user).first()
        return None

    def handle(self, *args, **options):
        # Dry-run unless --confirm is given; an explicit --dry-run
        # always wins (so --dry-run --confirm stays safe).
        dry = options["dry_run"] or not options["confirm"]

        tenant = self._resolve_tenant(options)
        if not tenant:
            self.stderr.write(self.style.ERROR(
                "No tenant matched. Pass one of --db-name / --alias / --identifier."
            ))
            return

        self.stdout.write(self.style.NOTICE(
            f"Target tenant: {_label(tenant)}"
        ))
        if dry:
            self.stdout.write(self.style.WARNING("DRY RUN — nothing will be deleted. Add --confirm to delete.\n"))

        register_tenant_db(tenant.db_alias, tenant.db_name)
        set_current_db_alias(tenant.db_alias)
        try:
            self._wipe(options, dry)
        finally:
            clear_current_db_alias()

    # ── The actual work (runs with the tenant alias active) ─────────
    def _wipe(self, options, dry):
        from sales.models import (  # noqa: PLC0415
            Sale, SaleItem, SalePayment, SellReturn, SellReturnItem, BackOrder,
        )
        from purchases.models import (  # noqa: PLC0415
            Purchase, PurchaseItem, PurchasePayment,
            PurchaseReturn, PurchaseReturnItem,
        )
        wipe_products = options["products"]

        # Counts first (shown in both dry-run and real mode).
        counts = {
            "SalePayment":        SalePayment.objects.count(),
            "SellReturnItem":     SellReturnItem.objects.count(),
            "SellReturn":         SellReturn.objects.count(),
            "SaleItem":           SaleItem.objects.count(),
            "Sale":               Sale.objects.count(),
            "PurchasePayment":    PurchasePayment.objects.count(),
            "PurchaseReturnItem": PurchaseReturnItem.objects.count(),
            "PurchaseReturn":     PurchaseReturn.objects.count(),
            "PurchaseItem":       PurchaseItem.objects.count(),
            "Purchase":           Purchase.objects.count(),
            "BackOrder":          BackOrder.objects.count(),
        }

        prod_counts = {}
        if wipe_products:
            try:
                from inventory.models import (  # noqa: PLC0415
                    Product, Variation, ComboItem, StockTransfer, StockTransferItem,
                )
                prod_counts = {
                    "StockTransferItem": StockTransferItem.objects.count(),
                    "StockTransfer":     StockTransfer.objects.count(),
                    "ComboItem":         ComboItem.objects.count(),
                    "Variation":         Variation.objects.count(),
                    "Product":           Product.objects.count(),
                }
            except Exception:
                prod_counts = {}

        inv_counts = {}
        if not options["keep_stock"]:
            try:
                from inventory.models import FIFOLayer, StockMovement, ProductStock  # noqa: PLC0415
                inv_counts = {
                    "FIFOLayer":      FIFOLayer.objects.count(),
                    "StockMovement":  StockMovement.objects.count(),
                    "ProductStock→0": ProductStock.objects.exclude(quantity=0).count(),
                }
            except Exception:
                inv_counts = {}

        acct_count = 0
        if not options["keep_accounts"]:
            try:
                from accounting.models import PaymentAccountTransaction as _PAT  # noqa: PLC0415
                acct_count = _PAT.objects.filter(
                    kind__in=[_PAT.Kind.SALE, _PAT.Kind.WITHDRAWAL]
                ).count()
            except Exception:
                acct_count = 0

        self.stdout.write("Rows in scope:")
        for k, v in counts.items():
            self.stdout.write(f"  {k:<20} {v}")
        for k, v in inv_counts.items():
            self.stdout.write(f"  {k:<20} {v}")
        if not options["keep_accounts"]:
            self.stdout.write(f"  {'PA txn SALE+WDL':<20} {acct_count}")
        if wipe_products:
            self.stdout.write("  -- catalogue (--products) --")
            for k, v in prod_counts.items():
                self.stdout.write(f"  {k:<20} {v}")

        if dry:
            self.stdout.write(self.style.WARNING("\nDry run complete — no changes made."))
            return

        # Real delete inside an atomic block on the tenant alias.
        from accounts.tenant_db import get_current_db_alias  # noqa: PLC0415
        alias = get_current_db_alias()
        with transaction.atomic(using=alias):
            # Sales side. BackOrder + SaleItem + SellReturnItem all
            # PROTECT Product, so they must go before any product
            # delete below.
            BackOrder.objects.all().delete()
            SalePayment.objects.all().delete()
            SellReturnItem.objects.all().delete()
            SellReturn.objects.all().delete()
            SaleItem.objects.all().delete()
            Sale.objects.all().delete()
            # Purchase side (PurchaseItem / PurchaseReturnItem PROTECT Product too).
            PurchasePayment.objects.all().delete()
            PurchaseReturnItem.objects.all().delete()
            PurchaseReturn.objects.all().delete()
            PurchaseItem.objects.all().delete()
            Purchase.objects.all().delete()

            # Inventory reset (also a prerequisite for deleting products).
            if not options["keep_stock"] or wipe_products:
                try:
                    from inventory.models import FIFOLayer, StockMovement, ProductStock  # noqa: PLC0415
                    FIFOLayer.objects.all().delete()
                    StockMovement.objects.all().delete()
                    if wipe_products:
                        ProductStock.objects.all().delete()
                    else:
                        ProductStock.objects.exclude(quantity=0).update(quantity=0)
                except Exception as exc:  # noqa: BLE001
                    self.stderr.write(self.style.WARNING(f"  inventory reset skipped: {exc}"))

            # Catalogue wipe — clear every remaining Product-PROTECT
            # referrer (stock transfers, combo components) then the
            # products themselves.
            if wipe_products:
                try:
                    from inventory.models import (  # noqa: PLC0415
                        Product, Variation, ComboItem, StockTransfer, StockTransferItem,
                    )
                    StockTransferItem.objects.all().delete()
                    StockTransfer.objects.all().delete()
                    ComboItem.objects.all().delete()
                    Variation.objects.all().delete()
                    Product.objects.all().delete()
                except Exception as exc:  # noqa: BLE001
                    self.stderr.write(self.style.WARNING(f"  product wipe skipped: {exc}"))

            if not options["keep_accounts"]:
                try:
                    from accounting.models import PaymentAccountTransaction as _PAT  # noqa: PLC0415
                    _PAT.objects.filter(
                        kind__in=[_PAT.Kind.SALE, _PAT.Kind.WITHDRAWAL]
                    ).delete()
                except Exception as exc:  # noqa: BLE001
                    self.stderr.write(self.style.WARNING(f"  account reset skipped: {exc}"))

        msg = "sales + purchase history"
        if wipe_products:
            msg += " + product catalogue"
        self.stdout.write(self.style.SUCCESS(
            f"\nDone — {msg} wiped for this tenant."
        ))
