"""
Backfill Sale.meta["source"] so legacy sales show up on the Sales List POS page.

Usage:
    python manage.py backfill_pos_source                       # all tenants, only rows missing a source
    python manage.py backfill_pos_source --db tenant_e592df…    # one tenant
    python manage.py backfill_pos_source --force                # overwrite even existing source values
    python manage.py backfill_pos_source --source DIRECT        # tag with a different value
"""
from django.core.management.base import BaseCommand
from django.db import connections

from accounts.tenant_db import register_tenant_db
from accounts.models import Tenant


class Command(BaseCommand):
    help = "Set meta['source'] on existing Sale rows so they appear in source-filtered lists (POS, Direct, …)."

    def add_arguments(self, parser):
        parser.add_argument("--db",     type=str, default=None, help="Specific tenant DB alias")
        parser.add_argument("--source", type=str, default="POS", help='Value to write — default "POS"')
        parser.add_argument("--force",  action="store_true",     help="Overwrite even if source is already set")

    def handle(self, *args, **options):
        target = options["db"]
        source = options["source"]
        force  = options["force"]

        tenants = Tenant.objects.filter(is_provisioned=True)
        if target:
            tenants = tenants.filter(db_alias=target)

        if not tenants.exists():
            self.stderr.write("No matching provisioned tenants.")
            return

        for tenant in tenants:
            register_tenant_db(tenant.db_alias, tenant.db_name)
            updated, skipped = self._backfill_one(tenant.db_alias, source, force)
            email = tenant.user.email if tenant.user else tenant.db_alias
            self.stdout.write(self.style.SUCCESS(
                f"  ✓ {email}: tagged={updated}  skipped={skipped}  (source='{source}')"
            ))

    def _backfill_one(self, db_alias: str, source: str, force: bool):
        from sales.models import Sale

        qs = Sale.objects.using(db_alias).all()
        updated = 0
        skipped = 0
        for sale in qs.iterator(chunk_size=500):
            meta = sale.meta or {}
            existing = (meta.get("source") or "").strip()
            if existing and not force:
                skipped += 1
                continue
            meta["source"] = source
            sale.meta = meta
            sale.save(using=db_alias, update_fields=["meta"])
            updated += 1
        return updated, skipped
