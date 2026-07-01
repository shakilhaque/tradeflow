"""
Diagnose which tenant database each user resolves to.

Use this when staff in the same tenant can't see each other's data
(e.g. "Fahim makes a sale but the owner/admin can't see it"). The usual
cause is a sub-user who has a stray Tenant row of their own, so the request
middleware routed them to a SEPARATE database. The fix in middleware now
always routes a sub-user via its parent owner — this command confirms which
users were affected and where their data physically lives.

Usage
─────
    # all users grouped by the owner they belong to
    python manage.py diagnose_user_dbs

    # only one tenant, by owner email / phone / username
    python manage.py diagnose_user_dbs --identifier 01830566126

A user is FLAGGED ⚠ when it has a parent_owner_id (it's a sub-user) AND a
Tenant row of its own — that's the misrouting condition. Read-only; changes
nothing.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from accounts.models import Tenant, User
from accounts.services import resolve_user_by_identifier


def _label(u: User) -> str:
    return u.email or u.phone or u.username or str(u.id)


class Command(BaseCommand):
    help = "Show which tenant DB each user resolves to and flag misrouted sub-users."

    def add_arguments(self, parser):
        parser.add_argument("--identifier", type=str, default="",
                            help="Limit to one owner (email / phone / username).")

    def handle(self, *args, **options):
        own_tenant = {
            t.user_id: t for t in Tenant.objects.all().only(
                "user_id", "db_alias", "db_name", "is_provisioned")
        }

        users = list(User.objects.all().order_by("parent_owner_id", "name"))

        # Group users under the owner they belong to (themselves if owner).
        owners: dict = {}
        for u in users:
            owner_id = u.parent_owner_id or u.id
            owners.setdefault(owner_id, []).append(u)

        ident = (options.get("identifier") or "").strip()
        only_owner_id = None
        if ident:
            who = resolve_user_by_identifier(ident)
            if not who:
                self.stderr.write(self.style.ERROR(f"No user matches '{ident}'."))
                return
            only_owner_id = who.parent_owner_id or who.id

        flagged = 0
        for owner_id, members in owners.items():
            if only_owner_id and owner_id != only_owner_id:
                continue
            owner_tenant = own_tenant.get(owner_id)
            owner_db = owner_tenant.db_alias if owner_tenant else "— NO TENANT ROW —"
            owner_user = next((m for m in members if m.id == owner_id), None)
            header = _label(owner_user) if owner_user else str(owner_id)
            self.stdout.write(self.style.MIGRATE_HEADING(
                f"\nOwner: {header}  →  resolves to DB: {owner_db}"))

            for m in members:
                stray = own_tenant.get(m.id) if m.parent_owner_id else None
                resolves_to = (own_tenant.get(m.parent_owner_id or m.id)
                               or owner_tenant)
                resolves_alias = resolves_to.db_alias if resolves_to else "— UNRESOLVED —"
                role = (m.role or "").lower()
                if stray:
                    flagged += 1
                    self.stdout.write(self.style.ERROR(
                        f"  ⚠ {_label(m):<28} role={role:<8} "
                        f"has its OWN Tenant row (db={stray.db_alias}) — "
                        f"data was landing there, not in {owner_db}."))
                else:
                    self.stdout.write(
                        f"    {_label(m):<28} role={role:<8} → {resolves_alias}")

        self.stdout.write("")
        if flagged:
            self.stdout.write(self.style.WARNING(
                f"{flagged} sub-user(s) had a stray Tenant row. After deploying the "
                f"middleware fix they now read/write the owner's DB. Historical rows "
                f"created earlier still live in the stray DB and need a one-off move."))
        else:
            self.stdout.write(self.style.SUCCESS(
                "No misrouted sub-users found — every staff member resolves to its "
                "owner's tenant DB."))
