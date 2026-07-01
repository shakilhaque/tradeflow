"""
Rename existing tenant databases from random-hex names (saas_tenant_3db1b7198141)
to human-readable slugs derived from business_name (saas_ongko_stationery).

Usage:
    python manage.py rename_tenant_dbs --dry-run        # show what would change
    python manage.py rename_tenant_dbs                  # actually rename

Steps performed per tenant:
    1. Compute the new (db_alias, db_name) from the user's business_name.
    2. If new name == old name → skip.
    3. Disconnect all active sessions on the old database.
    4. ALTER DATABASE <old> RENAME TO <new>  (Postgres-native, instant).
    5. Update the Tenant row's db_name / db_alias columns.

Caveats:
    • You should stop gunicorn/celery during the rename window so no live
      connection survives across the cut-over.
    • The new alias is dynamically registered at next request via TenantMiddleware,
      so no settings file edit is needed.
"""
import psycopg2
from psycopg2 import sql

from django.core.management.base import BaseCommand
from django.db import connections, transaction
from django.conf import settings

from accounts.models import Tenant
from accounts.tenant_db import build_tenant_identifiers
from accounts.tenant_db import _master_conn_params  # noqa: PLC2701 — internal helper, intentional


class Command(BaseCommand):
    help = "Rename tenant databases from UUID-based names to business-name slugs."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Show planned renames without touching the databases.",
        )

    def handle(self, *args, **opts):
        dry = opts["dry_run"]

        tenants = Tenant.objects.select_related("user").order_by("created_at")
        if not tenants:
            self.stdout.write(self.style.SUCCESS("No tenants to rename."))
            return

        # Build all targets first so we can detect collisions before mutating anything.
        # Track pending names locally so duplicate business_name slugs get suffixed
        # (_2, _3, ...) in the dry-run preview the same way they would in a real run.
        renames = []
        pending_aliases = set()
        pending_names   = set()
        for t in tenants:
            new_alias, new_name = build_tenant_identifiers(t.user)
            # Apply in-batch collision suffix.
            if new_alias in pending_aliases or new_name in pending_names:
                base_alias = new_alias
                base_name  = new_name
                i = 2
                while (
                    f"{base_alias}_{i}" in pending_aliases
                    or f"{base_name}_{i}" in pending_names
                ):
                    i += 1
                new_alias = f"{base_alias}_{i}"
                new_name  = f"{base_name}_{i}"
            pending_aliases.add(new_alias)
            pending_names.add(new_name)

            if new_name == t.db_name and new_alias == t.db_alias:
                self.stdout.write(f"  ✓ {t.user.email}: already named '{t.db_name}'")
                continue
            renames.append((t, new_alias, new_name))
            biz = getattr(t.user, "business_name", "") or "(none)"
            self.stdout.write(
                f"  → {t.user.email} [business_name='{biz}']:"
                f"   '{t.db_name}' → '{new_name}'"
                f"   (alias '{t.db_alias}' → '{new_alias}')"
            )

        if not renames:
            self.stdout.write(self.style.SUCCESS("Nothing to rename."))
            return

        if dry:
            self.stdout.write(self.style.WARNING(
                f"[dry-run] {len(renames)} tenant(s) would be renamed. "
                f"Re-run without --dry-run to apply."
            ))
            return

        # Apply renames.
        p = _master_conn_params()
        conn = psycopg2.connect(
            dbname="postgres",
            user=p["USER"], password=p["PASSWORD"],
            host=p["HOST"], port=p["PORT"],
        )
        conn.autocommit = True
        renamed = 0
        failed  = 0

        try:
            for tenant, new_alias, new_name in renames:
                old_name  = tenant.db_name
                old_alias = tenant.db_alias

                # Close any pooled Django connection on the old alias.
                if old_alias in connections.databases:
                    try:
                        connections[old_alias].close()
                    except Exception:
                        pass
                if old_alias in settings.DATABASES:
                    settings.DATABASES.pop(old_alias, None)

                try:
                    with conn.cursor() as cur:
                        # 1. Terminate other backends on the source DB.
                        cur.execute(
                            "SELECT pg_terminate_backend(pid) "
                            "FROM pg_stat_activity "
                            "WHERE datname = %s AND pid <> pg_backend_pid()",
                            (old_name,),
                        )
                        # 2. Rename.
                        cur.execute(
                            sql.SQL("ALTER DATABASE {} RENAME TO {}").format(
                                sql.Identifier(old_name),
                                sql.Identifier(new_name),
                            )
                        )

                    # 3. Update Tenant row.
                    with transaction.atomic():
                        tenant.db_name  = new_name
                        tenant.db_alias = new_alias
                        tenant.save(update_fields=["db_name", "db_alias"])

                    self.stdout.write(self.style.SUCCESS(
                        f"  ✓ {tenant.user.email}: {old_name} → {new_name}"
                    ))
                    renamed += 1

                except Exception as exc:
                    self.stdout.write(self.style.ERROR(
                        f"  ✗ {tenant.user.email}: rename failed ({exc})"
                    ))
                    failed += 1
        finally:
            conn.close()

        self.stdout.write(self.style.SUCCESS(
            f"Done. Renamed {renamed} database(s); {failed} failure(s)."
        ))
        if renamed:
            self.stdout.write(self.style.WARNING(
                "Restart gunicorn now so worker processes pick up the new alias mapping:\n"
                "    sudo systemctl restart gunicorn"
            ))
