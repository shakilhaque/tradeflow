"""
Apply pending tenant-app migrations across every tenant database.

This is the "everyone catches up" command — run it whenever you add or
change a model that lives in a tenant-routed app (inventory, sales,
purchases, accounting, audit, imports, notifications, system_config),
or after fixing a migration bug, so existing tenants get the same
schema brand-new tenants do.

Usage
─────
    # bring every provisioned tenant up to latest
    python manage.py migrate_tenants

    # just one tenant, by email / mobile / username
    python manage.py migrate_tenants --identifier 01830566126
    python manage.py migrate_tenants --identifier ruhanhaque29@gmail.com

    # just one tenant, by DB alias (skips user lookup)
    python manage.py migrate_tenants --alias tenant_abc

    # include not-yet-provisioned tenants too (rarely useful — those
    # need provision_tenant_now first; this only migrates if the DB
    # already exists)
    python manage.py migrate_tenants --include-pending
"""
from django.core.management.base import BaseCommand

from accounts.models import Tenant
from accounts.services import resolve_user_by_identifier
from accounts.tenant_db import register_tenant_db, run_tenant_migrations


def _label(user) -> str:
    """Best human-readable label — email is optional on User now."""
    return user.email or user.phone or user.username or str(user.id)


class Command(BaseCommand):
    help = "Run tenant-app migrations for existing tenant databases."

    def add_arguments(self, parser):
        parser.add_argument(
            "--identifier",
            type=str,
            default="",
            help="Email, mobile number, or username of one tenant to migrate.",
        )
        # Legacy alias for backwards compatibility with any scripts/cron
        # that still pass --email. Treated identically to --identifier.
        parser.add_argument(
            "--email",
            type=str,
            default="",
            help="(Alias for --identifier.) Email of the tenant to migrate.",
        )
        parser.add_argument(
            "--alias",
            type=str,
            default="",
            help="Only migrate this tenant db_alias.",
        )
        parser.add_argument(
            "--include-pending",
            action="store_true",
            help="Also include tenants where is_provisioned=False.",
        )

    def handle(self, *args, **options):
        qs = Tenant.objects.select_related("user").all()
        if not options["include_pending"]:
            qs = qs.filter(is_provisioned=True)

        ident = (options["identifier"] or options["email"] or "").strip()
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

        migrated = 0
        failed = 0
        for tenant in tenants:
            label = _label(tenant.user)
            try:
                register_tenant_db(tenant.db_alias, tenant.db_name)
                run_tenant_migrations(tenant.db_alias)
                migrated += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Migrated tenant: {label} ({tenant.db_alias})"
                    )
                )
            except Exception as exc:  # noqa: BLE001
                failed += 1
                self.stderr.write(
                    self.style.ERROR(
                        f"Failed tenant: {label} ({tenant.db_alias}) -> {exc}"
                    )
                )

        self.stdout.write(
            self.style.NOTICE(
                f"Done. Migrated={migrated}, Failed={failed}, Total={len(tenants)}"
            )
        )
