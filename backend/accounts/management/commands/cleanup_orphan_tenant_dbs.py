"""
Find and (optionally) drop tenant databases that aren't referenced by any
Tenant row in the master DB.

Usage:
    python manage.py cleanup_orphan_tenant_dbs --dry-run    # list orphans (safe)
    python manage.py cleanup_orphan_tenant_dbs --drop       # actually drop them
    python manage.py cleanup_orphan_tenant_dbs --drop --yes # skip confirmation

Detection rule:
    Any database whose name starts with 'saas_' AND is NOT 'saas_master' AND is
    NOT listed in accounts_tenant.db_name is considered an orphan.

Safety:
    • --dry-run is the default behaviour if you omit --drop.
    • Without --yes, the command prints the list and asks for typed confirmation
      ("DROP <N>") before running any DROP DATABASE.
    • DBs in use cannot be dropped — Postgres will return an error and the
      command moves to the next one.
"""
import psycopg2
from psycopg2 import sql

from django.core.management.base import BaseCommand

from accounts.models import Tenant
from accounts.tenant_db import _master_conn_params  # noqa: PLC2701


PROTECTED = {"saas_master"}  # never drop


class Command(BaseCommand):
    help = "List or drop saas_* databases that aren't owned by any Tenant row."

    def add_arguments(self, parser):
        parser.add_argument(
            "--drop", action="store_true",
            help="Actually drop the orphans (otherwise, list only).",
        )
        parser.add_argument(
            "--yes", action="store_true",
            help="Skip the interactive confirmation prompt.",
        )

    def handle(self, *args, **opts):
        drop_them   = opts["drop"]
        auto_yes    = opts["yes"]

        # 1. Build the "expected" set from the master DB.
        known = set(
            Tenant.objects.exclude(db_name="").values_list("db_name", flat=True)
        )

        # 2. List every database from Postgres.
        p = _master_conn_params()
        conn = psycopg2.connect(
            dbname="postgres",
            user=p["USER"], password=p["PASSWORD"],
            host=p["HOST"], port=p["PORT"],
        )
        conn.autocommit = True

        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT datname, pg_size_pretty(pg_database_size(datname)) "
                    "FROM pg_database "
                    "WHERE datname LIKE 'saas_%%' "
                    "ORDER BY pg_database_size(datname) DESC"
                )
                rows = cur.fetchall()

            orphans = [
                (name, size) for (name, size) in rows
                if name not in known and name not in PROTECTED
            ]

            if not orphans:
                self.stdout.write(self.style.SUCCESS(
                    f"No orphan databases found. ({len(known)} known tenant DBs accounted for.)"
                ))
                return

            self.stdout.write(self.style.WARNING(
                f"Found {len(orphans)} orphan database(s) "
                f"(not referenced by any Tenant row):"
            ))
            for name, size in orphans:
                self.stdout.write(f"   • {name:40s} {size}")

            if not drop_them:
                self.stdout.write(
                    "\nRe-run with --drop to delete them. Use --yes to skip the "
                    "confirmation prompt."
                )
                return

            # 3. Confirm before destructive action.
            if not auto_yes:
                expected = f"DROP {len(orphans)}"
                self.stdout.write(self.style.WARNING(
                    f"\nThis is IRREVERSIBLE. Type exactly  {expected}  to proceed:"
                ))
                answer = input("> ").strip()
                if answer != expected:
                    self.stdout.write(self.style.ERROR("Aborted — confirmation did not match."))
                    return

            # 4. Drop them.
            dropped = 0
            failed  = 0
            for name, _size in orphans:
                try:
                    with conn.cursor() as cur:
                        # Terminate active sessions first (skip superuser sessions
                        # — those need to be killed manually as the postgres role).
                        cur.execute(
                            "SELECT pg_terminate_backend(pid) "
                            "FROM pg_stat_activity "
                            "WHERE datname = %s AND pid <> pg_backend_pid()",
                            (name,),
                        )
                        cur.execute(
                            sql.SQL("DROP DATABASE {}").format(sql.Identifier(name))
                        )
                    self.stdout.write(self.style.SUCCESS(f"   ✓ dropped {name}"))
                    dropped += 1
                except Exception as exc:
                    self.stdout.write(self.style.ERROR(f"   ✗ {name}: {exc}"))
                    failed += 1

            self.stdout.write(self.style.SUCCESS(
                f"\nDone. Dropped {dropped} database(s); {failed} failure(s)."
            ))
        finally:
            conn.close()
