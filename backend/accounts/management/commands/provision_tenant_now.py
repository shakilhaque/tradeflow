"""
Synchronously provision a tenant's database — create the physical PostgreSQL
DB, run migrations, seed baseline master data, and flip is_provisioned=True.

Idempotent: safe to run on already-provisioned tenants (CREATE DATABASE is
a no-op when the DB exists; migrations and master-data seeds are
no-ops when already applied).

Usage:
    # repair a single broken tenant — by email
    python manage.py provision_tenant_now ayanhaque358@gmail.com

    # …or by mobile number (BD format: 017…, +88017…, 88017…, with/without spaces)
    python manage.py provision_tenant_now 01830566126

    # …or by username
    python manage.py provision_tenant_now iffaa_sandbox_store_3f9a

    # repair every tenant where is_provisioned=False
    python manage.py provision_tenant_now --all-pending

When to use this:
    A tenant signs up but Celery / Redis isn't running, so the async
    provisioning task never fires. The Tenant row exists in master DB but
    is_provisioned=False, and the user sees 503s on every workspace page.
    Run this command on the server to repair them.
"""
from django.core.management.base import BaseCommand

from accounts.models import Tenant
from accounts.services import resolve_user_by_identifier
from accounts.tenant_db import provision_tenant


def _label(user) -> str:
    """Best human-readable label for a user — email is now optional."""
    return user.email or user.phone or user.username or str(user.id)


class Command(BaseCommand):
    help = "Synchronously create and migrate a tenant's PostgreSQL database."

    def add_arguments(self, parser):
        parser.add_argument(
            "identifier",
            nargs="?",
            default="",
            help="Email, mobile number, or username of the tenant to provision.",
        )
        parser.add_argument(
            "--all-pending",
            action="store_true",
            help="Provision every tenant where is_provisioned=False.",
        )

    def handle(self, *args, **opts):
        if opts["all_pending"]:
            self._handle_all_pending()
            return

        ident = (opts.get("identifier") or "").strip()
        if not ident:
            self.stderr.write(self.style.ERROR(
                "Pass an email / mobile / username, or use --all-pending."
            ))
            return

        user = resolve_user_by_identifier(ident)
        if not user:
            self.stderr.write(self.style.ERROR(f"No user matches '{ident}'."))
            return

        tenant = Tenant.objects.filter(user=user).first()
        if not tenant:
            self.stderr.write(self.style.ERROR(
                f"No Tenant row exists for {_label(user)}. "
                "The signup flow may have failed before creating it."
            ))
            return

        self._provision_one(user, tenant)

    def _handle_all_pending(self):
        pending = (
            Tenant.objects
            .select_related("user")
            .filter(is_provisioned=False)
            .order_by("created_at")
        )
        if not pending.exists():
            self.stdout.write(self.style.SUCCESS("Nothing to do — all tenants are provisioned."))
            return

        total = pending.count()
        self.stdout.write(self.style.WARNING(
            f"Provisioning {total} pending tenant(s)…"
        ))
        ok = fail = 0
        for tenant in pending:
            try:
                self._provision_one(tenant.user, tenant)
                ok += 1
            except Exception as exc:
                fail += 1
                self.stderr.write(self.style.ERROR(
                    f"  ✗ {_label(tenant.user)}: {exc}"
                ))
        self.stdout.write(self.style.SUCCESS(
            f"Done. Provisioned {ok} tenant(s); {fail} failure(s)."
        ))

    def _provision_one(self, user, tenant):
        self.stdout.write(
            f"  → {_label(user)}  (alias={tenant.db_alias} db={tenant.db_name})"
        )
        before = tenant.is_provisioned
        provision_tenant(str(user.id))
        tenant.refresh_from_db(fields=["is_provisioned", "provisioned_at"])
        if tenant.is_provisioned and not before:
            self.stdout.write(self.style.SUCCESS(
                f"     ✓ provisioned (db={tenant.db_name})"
            ))
        elif tenant.is_provisioned and before:
            self.stdout.write(self.style.SUCCESS(
                f"     ✓ already provisioned — migrations re-checked, master data re-seeded"
            ))
        else:
            self.stdout.write(self.style.ERROR(
                "     ✗ provisioning ran but is_provisioned is still False — check logs."
            ))
