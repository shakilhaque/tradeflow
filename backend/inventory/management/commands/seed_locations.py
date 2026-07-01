"""
Seed a richer set of business locations into a tenant database so that
location dropdowns across the app aren't limited to the single default.

Usage:
    python manage.py seed_locations --alias=tenant_xxx
    python manage.py seed_locations --email=owner@example.com
"""
from django.core.management.base import BaseCommand, CommandError

from accounts.models import Tenant
from accounts.tenant_db import register_tenant_db, set_current_db_alias

from inventory.models import Location


SAMPLE_LOCATIONS = [
    ("Main Branch",       "MAIN",   "House 12, Road 5, Dhanmondi, Dhaka"),
    ("Mirpur Outlet",     "MIRPUR", "Plot 23, Block C, Mirpur 10, Dhaka"),
    ("Gulshan Showroom",  "GUL",    "Road 11, Gulshan 1, Dhaka"),
    ("Uttara Branch",     "UTT",    "Sector 7, Uttara, Dhaka"),
    ("Banani Outlet",     "BAN",    "Road 27, Banani, Dhaka"),
    ("Chittagong Branch", "CTG",    "Agrabad C/A, Chittagong"),
    ("Sylhet Branch",     "SYL",    "Zindabazar, Sylhet"),
    ("Khulna Warehouse",  "KHU",    "Khalishpur Industrial Area, Khulna"),
    ("Rajshahi Branch",   "RAJ",    "Sahebbazar, Rajshahi"),
    ("Online Store",      "ONLN",   "E-commerce / pickup hub"),
]


class Command(BaseCommand):
    help = "Seed multiple business locations into a tenant database."

    def add_arguments(self, parser):
        parser.add_argument("--email", type=str, default="", help="Tenant owner email.")
        parser.add_argument("--alias", type=str, default="", help="Tenant DB alias.")

    def handle(self, *args, **options):
        tenant = self._resolve_tenant(options)
        register_tenant_db(tenant.db_alias, tenant.db_name)
        set_current_db_alias(tenant.db_alias)

        try:
            created, skipped = 0, 0
            for name, code, address in SAMPLE_LOCATIONS:
                obj, was_new = Location.objects.using(tenant.db_alias).get_or_create(
                    code=code,
                    defaults={"name": name, "address": address, "is_active": True},
                )
                if was_new:
                    created += 1
                    self.stdout.write(self.style.SUCCESS(f"  + {obj.name} ({obj.code})"))
                else:
                    skipped += 1
            self.stdout.write(self.style.NOTICE(
                f"Done. Created={created}, Skipped(existing)={skipped}, Tenant={tenant.db_alias}"
            ))
        finally:
            set_current_db_alias(None)

    def _resolve_tenant(self, options) -> Tenant:
        qs = Tenant.objects.select_related("user")
        if options["alias"]:
            qs = qs.filter(db_alias=options["alias"].strip())
        elif options["email"]:
            qs = qs.filter(user__email__iexact=options["email"].strip())
        else:
            raise CommandError("Provide --email or --alias to identify the tenant.")
        tenant = qs.first()
        if not tenant:
            raise CommandError("No matching tenant found.")
        return tenant
