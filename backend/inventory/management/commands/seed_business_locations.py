"""
Seed a richer set of business locations into a tenant database so the
'Business Location' dropdown on every page (Add Product, Sales, Stock
Report, etc.) has more than just 'Main Branch'.

Usage:
    python manage.py seed_business_locations --alias=tenant_xxx
    python manage.py seed_business_locations --email=owner@example.com
    python manage.py seed_business_locations --email=owner@example.com --reset
"""
from django.core.management.base import BaseCommand, CommandError

from accounts.models import Tenant
from accounts.tenant_db import register_tenant_db, set_current_db_alias

from inventory.models import Location


SAMPLE_LOCATIONS = [
    ("Main Branch",          "MAIN",  "Head office — Dhaka"),
    ("Mirpur Outlet",        "MRP",   "Mirpur 10, Dhaka"),
    ("Dhanmondi Outlet",     "DHN",   "Dhanmondi 27, Dhaka"),
    ("Gulshan Outlet",       "GLS",   "Gulshan 1, Dhaka"),
    ("Uttara Outlet",        "UTT",   "Uttara Sector 7, Dhaka"),
    ("Chittagong Branch",    "CTG",   "Agrabad C/A, Chittagong"),
    ("Sylhet Branch",        "SYL",   "Zindabazar, Sylhet"),
    ("Khulna Branch",        "KHL",   "Khan Jahan Ali Road, Khulna"),
    ("Rajshahi Branch",      "RJH",   "Saheb Bazar, Rajshahi"),
    ("Central Warehouse",    "WH-1",  "Tejgaon I/A, Dhaka"),
    ("North Warehouse",      "WH-N",  "Gazipur"),
    ("Online Store",         "WEB",   "E-commerce / web orders"),
]


class Command(BaseCommand):
    help = "Seed a default set of business locations into a tenant database."

    def add_arguments(self, parser):
        parser.add_argument("--email", type=str, default="", help="Tenant owner email.")
        parser.add_argument("--alias", type=str, default="", help="Tenant DB alias.")
        parser.add_argument("--reset", action="store_true",
                            help="Reactivate any deactivated locations with matching codes.")

    def handle(self, *args, **options):
        tenant = self._resolve_tenant(options)
        register_tenant_db(tenant.db_alias, tenant.db_name)
        set_current_db_alias(tenant.db_alias)
        try:
            created = 0
            updated = 0
            for name, code, address in SAMPLE_LOCATIONS:
                loc, was_created = Location.objects.using(tenant.db_alias).get_or_create(
                    code=code,
                    defaults={"name": name, "address": address, "is_active": True},
                )
                if was_created:
                    created += 1
                    self.stdout.write(self.style.SUCCESS(f"  + {loc.name} ({loc.code})"))
                elif options["reset"] and not loc.is_active:
                    loc.is_active = True
                    loc.save(using=tenant.db_alias, update_fields=["is_active"])
                    updated += 1
                    self.stdout.write(self.style.WARNING(f"  ↺ reactivated {loc.name} ({loc.code})"))

            self.stdout.write(self.style.NOTICE(
                f"Done. Created={created}, Reactivated={updated}, Tenant={tenant.db_alias}"
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
