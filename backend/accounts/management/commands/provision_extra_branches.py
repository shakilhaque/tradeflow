"""
provision_extra_branches — open up a tenant's branch limit and seed
business locations into their tenant DB in one shot.

Useful when a free/basic-plan tenant needs extra branches without
going through the standard subscription upgrade flow (e.g. during
beta access, custom pilots, or operator support tickets).

What it does
────────────
  1. Resolves the tenant by --email (active subscription preferred).
  2. Bumps that subscription's plan max_branches so the
     LocationViewSet's "BRANCH_LIMIT" guard no longer trips — done
     either by switching to an existing higher-tier plan OR by
     cloning the current plan into a one-off "<Name> + extra
     branches" plan whose max_branches matches the new total. The
     original Plan row is never mutated (other tenants on the same
     plan are unaffected).
  3. Creates N Location rows in the tenant's own DB. Existing
     locations are kept; duplicates by name are skipped.

Usage
─────
    python manage.py provision_extra_branches \\
        --email ongkobd@gmail.com \\
        --count 3

    # Custom names (comma-separated):
    python manage.py provision_extra_branches \\
        --email ongkobd@gmail.com \\
        --names "Main Branch,North Outlet,South Outlet"

    # Just bump the limit without creating any locations:
    python manage.py provision_extra_branches \\
        --email ongkobd@gmail.com \\
        --raise-limit 5 \\
        --no-create
"""
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import Plan, Subscription, Tenant, User
from accounts.tenant_db import register_tenant_db


def _slugify(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:48] or "loc"


class Command(BaseCommand):
    help = "Open a tenant's branch limit and seed N business locations into their tenant DB."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True,
                            help="Owner email of the target tenant.")
        parser.add_argument("--count", type=int, default=0,
                            help="Number of locations to create (used when --names is empty).")
        parser.add_argument("--names", default="",
                            help='Comma-separated location names. Overrides --count when set.')
        parser.add_argument("--raise-limit", type=int, default=0,
                            help="Force the tenant's plan max_branches to at least this value. "
                                 "Defaults to current_locations + new_locations.")
        parser.add_argument("--no-create", action="store_true",
                            help="Skip creating locations — just bump the branch limit.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Show what would happen, write nothing.")

    # ── 1. Resolve tenant ────────────────────────────────────────────────
    def _resolve_tenant(self, email):
        try:
            user = User.objects.get(email__iexact=email.strip())
        except User.DoesNotExist:
            raise CommandError(f"No user with email '{email}'.")

        try:
            tenant = Tenant.objects.select_related("user").get(user=user)
        except Tenant.DoesNotExist:
            raise CommandError(f"User '{email}' has no Tenant row yet — they haven't been provisioned.")

        if not tenant.is_provisioned:
            raise CommandError(
                f"Tenant for '{email}' is not yet provisioned (db_alias={tenant.db_alias}). "
                "Wait for the provision Celery task to complete and re-run."
            )

        sub = (
            Subscription.objects
            .filter(user=user)
            .select_related("plan")
            .order_by(
                # Active subs first, then the most recently created.
                "-status", "-created_at",
            )
            .first()
        )
        if not sub:
            raise CommandError(f"User '{email}' has no Subscription row.")
        return user, tenant, sub

    # ── 2. Bump branch limit ─────────────────────────────────────────────
    def _ensure_limit(self, sub, required, dry):
        plan = sub.plan
        current = plan.max_branches or 0
        # 0 means "unlimited" by convention in Plan.max_branches.
        if current == 0 or current >= required:
            self.stdout.write(
                f"  · Plan '{plan.name}' already allows {current or 'unlimited'} branches — no change needed."
            )
            return plan

        new_name = f"{plan.name} + custom branches"
        new_code = f"{plan.code or _slugify(plan.name)}-custom-{required}b"

        # Re-use a previously created custom plan with the same shape if one
        # exists (so re-running the command doesn't multiply rows).
        existing = Plan.objects.filter(code=new_code).first()
        if existing:
            self.stdout.write(f"  · Re-using existing plan '{existing.name}' (max_branches={existing.max_branches}).")
            if not dry:
                sub.plan = existing
                sub.save(update_fields=["plan"])
            return existing

        self.stdout.write(
            f"  · Cloning plan '{plan.name}' → '{new_name}' (max_branches {current} → {required})."
        )
        if dry:
            return plan

        new_plan = Plan.objects.create(
            name             = new_name[:100],
            code             = new_code[:64],
            price            = plan.price or Decimal("0"),
            billing_cycle    = plan.billing_cycle,
            duration_days    = plan.duration_days,
            is_trial         = plan.is_trial,
            is_custom        = True,
            max_branches     = required,
            max_sub_accounts = plan.max_sub_accounts,
            per_branch_fee   = plan.per_branch_fee,
            description      = (plan.description or "") + " — custom branch entitlement.",
            features         = list(plan.features or []),
            sort_order       = (plan.sort_order or 100) + 1,
            is_active        = False,  # internal — don't show on the public pricing page
        )
        sub.plan = new_plan
        sub.save(update_fields=["plan"])
        return new_plan

    # ── 3. Seed locations ────────────────────────────────────────────────
    def _seed_locations(self, tenant, names, dry):
        # Inventory models live in the tenant DB. Register the alias on
        # this process before querying.
        register_tenant_db(tenant.db_alias, tenant.db_name)

        from inventory.models import Location  # noqa: PLC0415

        existing_names = set(
            Location.objects.using(tenant.db_alias).values_list("name", flat=True)
        )
        existing_codes = set(
            Location.objects.using(tenant.db_alias).values_list("code", flat=True)
        )

        created = 0
        for name in names:
            name = (name or "").strip()
            if not name:
                continue
            if name in existing_names:
                self.stdout.write(f"    · skip '{name}' — a location with that name already exists.")
                continue
            base_code = _slugify(name).upper()[:18]
            code = base_code or f"LOC{created + 1}"
            i = 1
            while code in existing_codes:
                i += 1
                code = f"{base_code[:14]}-{i}"
            self.stdout.write(self.style.SUCCESS(f"    · creating '{name}' (code={code})"))
            if not dry:
                Location.objects.using(tenant.db_alias).create(
                    name      = name[:120],
                    code      = code[:20],
                    is_active = True,
                )
            existing_names.add(name)
            existing_codes.add(code)
            created += 1
        return created

    # ── handle ───────────────────────────────────────────────────────────
    def handle(self, *args, **opts):
        email   = opts["email"]
        dry     = bool(opts["dry_run"])
        count   = int(opts["count"] or 0)
        raw_names = (opts["names"] or "").strip()
        names = [n.strip() for n in raw_names.split(",") if n.strip()] if raw_names else []
        if not names and count > 0:
            names = [f"Branch {i + 1}" for i in range(count)]

        if dry:
            self.stdout.write(self.style.WARNING("DRY RUN — no writes."))
        self.stdout.write(self.style.NOTICE(f"Resolving tenant for {email}…"))

        user, tenant, sub = self._resolve_tenant(email)
        self.stdout.write(
            f"  · User:    {user.email} (id={user.id})\n"
            f"  · Tenant:  db_alias={tenant.db_alias}\n"
            f"  · Plan:    {sub.plan.name} (status={sub.status}, max_branches={sub.plan.max_branches})"
        )

        # Compute target limit
        register_tenant_db(tenant.db_alias, tenant.db_name)
        from inventory.models import Location  # noqa: PLC0415
        current_loc_count = Location.objects.using(tenant.db_alias).count()
        to_create = 0 if opts["no_create"] else len(names)
        required = opts["raise_limit"] or (current_loc_count + to_create)

        self.stdout.write("")
        self.stdout.write(self.style.NOTICE("1. Branch-limit step"))
        with transaction.atomic():
            self._ensure_limit(sub, required, dry)
            if dry:
                transaction.set_rollback(True)

        if opts["no_create"]:
            self.stdout.write(self.style.SUCCESS("\n--no-create set — skipping location seeding."))
            return

        self.stdout.write("")
        self.stdout.write(self.style.NOTICE("2. Location seeding step"))
        created = self._seed_locations(tenant, names, dry)
        sub.refresh_from_db()

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"Done. Plan: {sub.plan.name} (max_branches={sub.plan.max_branches}). "
            f"Locations created: {created} (total now: {current_loc_count + created})"
            + ("  [DRY RUN]" if dry else "")
        ))
