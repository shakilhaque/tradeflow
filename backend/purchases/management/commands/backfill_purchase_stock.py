"""
One-time backfill — post historical RECEIVED purchases into inventory.

Background
──────────
Until commit 98a7d2d6, purchases.services.create_purchase wrote the
Purchase + PurchaseItem rows but NEVER posted the goods into the
inventory engine: no FIFOLayer, no ProductStock increment, no
StockMovement(IN). Every purchase recorded before that fix is
therefore invisible to the Current Stock column, FIFO costing, and
the Stock Report.

This command walks every tenant database, finds RECEIVED purchases
whose lines were never posted, and posts the missing quantity through
inventory.services.add_stock_fifo — the exact same path a new
purchase uses today.

Idempotency
───────────
add_stock_fifo stamps every layer with reference_type="purchase" and
reference_id=<purchase id>. Before posting, we sum the already-posted
quantity for that (purchase, product) pair and only post the
shortfall. Running the command twice is therefore a no-op, and
purchases created AFTER the fix (already posted at creation) are
skipped automatically.

Layers are backdated with layer_date=purchase_date so the backfilled
stock sits at the right point in the FIFO queue — sales recorded
after this backfill will consume the oldest (cheapest/earliest) cost
first, exactly as if the purchase had posted on its real date.

Usage
─────
    # dry-run everything (default lists what WOULD post, writes nothing)
    python manage.py backfill_purchase_stock --dry-run

    # actually post, every provisioned tenant
    python manage.py backfill_purchase_stock

    # one tenant only — by email / mobile / username, or by DB alias
    python manage.py backfill_purchase_stock --identifier 01830566126
    python manage.py backfill_purchase_stock --alias tenant_abc
"""
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db.models import Sum

from accounts.models import Tenant
from accounts.services import resolve_user_by_identifier
from accounts.tenant_db import (
    register_tenant_db,
    set_current_db_alias,
    clear_current_db_alias,
)


def _label(user) -> str:
    return user.email or user.phone or user.username or str(user.id)


class Command(BaseCommand):
    help = (
        "Backfill inventory (FIFO layers + ProductStock + StockMovement) "
        "for RECEIVED purchases recorded before purchases posted stock."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--identifier", type=str, default="",
            help="Email, mobile number, or username of one tenant.",
        )
        parser.add_argument(
            "--alias", type=str, default="",
            help="Only backfill this tenant db_alias.",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report what would be posted without writing anything.",
        )

    # ── Per-tenant work ─────────────────────────────────────────────
    def _backfill_tenant(self, *, dry_run: bool) -> dict:
        """Runs with the tenant DB alias active (thread-local set by
        the caller). Returns counters for the summary line."""
        from inventory.models import FIFOLayer, Location, Product
        from inventory.services import add_stock_fifo, StockServiceError
        from purchases.models import Purchase

        stats = {"purchases": 0, "lines": 0, "qty": Decimal("0"), "skipped": 0}

        received = (
            Purchase.objects
            .filter(status=Purchase.Status.RECEIVED)
            .prefetch_related("items")
            .order_by("purchase_date", "created_at")
        )

        for purchase in received.iterator():
            purchase_touched = False
            for item in purchase.items.all():
                qty = Decimal(str(item.quantity or 0))
                if qty <= 0 or not item.product_id:
                    continue

                # Idempotency guard — how much of this line already
                # posted (at creation, at a status transition, or on
                # a previous run of this command)?
                already = (
                    FIFOLayer.objects
                    .filter(
                        reference_type="purchase",
                        reference_id=purchase.id,
                        product_id=item.product_id,
                    )
                    .aggregate(t=Sum("initial_qty"))["t"]
                ) or Decimal("0")
                missing = qty - already
                if missing <= 0:
                    continue

                # Product or location vanished / deactivated since the
                # purchase — skip the line with a warning instead of
                # failing the whole tenant.
                if not Product.objects.filter(id=item.product_id).exists():
                    stats["skipped"] += 1
                    self.stderr.write(self.style.WARNING(
                        f"    skip {purchase.reference_no} / {item.product_name}: "
                        f"product no longer exists"
                    ))
                    continue
                if not Location.objects.filter(
                    id=purchase.location_id, is_active=True
                ).exists():
                    stats["skipped"] += 1
                    self.stderr.write(self.style.WARNING(
                        f"    skip {purchase.reference_no} / {item.product_name}: "
                        f"location inactive or missing"
                    ))
                    continue

                if dry_run:
                    self.stdout.write(
                        f"    would post {purchase.reference_no}: "
                        f"{item.product_name} × {missing} @ {item.unit_cost}"
                    )
                else:
                    try:
                        add_stock_fifo(
                            product_id     = item.product_id,
                            location_id    = purchase.location_id,
                            quantity       = missing,
                            unit_cost      = item.unit_cost,
                            reference_type = "purchase",
                            reference_id   = purchase.id,
                            # Backdate the layer so it sits at the right
                            # point in the FIFO queue.
                            layer_date     = purchase.purchase_date,
                        )
                    except StockServiceError as exc:
                        stats["skipped"] += 1
                        self.stderr.write(self.style.WARNING(
                            f"    skip {purchase.reference_no} / "
                            f"{item.product_name}: {exc}"
                        ))
                        continue

                stats["lines"] += 1
                stats["qty"]   += missing
                purchase_touched = True

            if purchase_touched:
                stats["purchases"] += 1

        return stats

    # ── Entry point ────────────────────────────────────────────────
    def handle(self, *args, **options):
        dry_run = options["dry_run"]

        qs = Tenant.objects.select_related("user").filter(is_provisioned=True)
        ident = (options["identifier"] or "").strip()
        if ident:
            user = resolve_user_by_identifier(ident)
            if not user:
                self.stderr.write(self.style.ERROR(f"No user matches '{ident}'."))
                return
            qs = qs.filter(user=user)
        if options["alias"]:
            qs = qs.filter(db_alias=options["alias"].strip())

        tenants = list(qs.order_by("created_at"))
        if not tenants:
            self.stdout.write(self.style.WARNING("No tenant matched the given filters."))
            return

        if dry_run:
            self.stdout.write(self.style.NOTICE("DRY RUN — nothing will be written.\n"))

        ok = failed = 0
        total_lines = 0
        total_qty = Decimal("0")

        for tenant in tenants:
            label = _label(tenant.user)
            self.stdout.write(f"Tenant: {label} ({tenant.db_alias})")
            try:
                register_tenant_db(tenant.db_alias, tenant.db_name)
                set_current_db_alias(tenant.db_alias)
                try:
                    stats = self._backfill_tenant(dry_run=dry_run)
                finally:
                    clear_current_db_alias()
                ok += 1
                total_lines += stats["lines"]
                total_qty   += stats["qty"]
                self.stdout.write(self.style.SUCCESS(
                    f"  done: purchases={stats['purchases']} "
                    f"lines={stats['lines']} qty={stats['qty']} "
                    f"skipped={stats['skipped']}"
                ))
            except Exception as exc:  # noqa: BLE001
                failed += 1
                self.stderr.write(self.style.ERROR(f"  FAILED: {exc}"))

        verb = "Would post" if dry_run else "Posted"
        self.stdout.write(self.style.NOTICE(
            f"\nDone. Tenants ok={ok} failed={failed}. "
            f"{verb} {total_lines} line(s), total qty {total_qty}."
        ))
