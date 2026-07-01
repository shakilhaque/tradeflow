"""
Seed a handful of sample products into a tenant database so the Products page
can be exercised end-to-end without manual data entry.

Usage:
    python manage.py seed_sample_products --alias=tenant_xxx
    python manage.py seed_sample_products --email=owner@example.com
"""
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError

from accounts.models import Tenant
from accounts.tenant_db import register_tenant_db, set_current_db_alias

from inventory.models import Brand, Category, Location, Product, Unit
from inventory.services import add_stock_fifo


SAMPLE_UNITS = [
    ("Pieces", "Pc(s)"),
    ("Kilogram", "kg"),
    ("Box", "box"),
]

SAMPLE_BRANDS = ["Generic", "House Brand", "OEM"]
SAMPLE_CATEGORIES = ["Stationery", "Tape & Adhesives", "Files & Folders"]

SAMPLE_PRODUCTS = [
    {
        "name": "0.5\" Transparent Water Tape",
        "sku": "246529",
        "selling_price": Decimal("15.00"),
        "cost_price": Decimal("8.00"),
        "category": "Tape & Adhesives",
        "brand": "Generic",
        "unit": "Pieces",
        "tax_rate": Decimal("0"),
        "tax_type": "exclusive",
        "product_type": "single",
        "opening_qty": Decimal("16"),
    },
    {
        "name": "03L Fita Exam File",
        "sku": "246245",
        "selling_price": Decimal("185.00"),
        "cost_price": Decimal("140.00"),
        "category": "Files & Folders",
        "brand": "House Brand",
        "unit": "Pieces",
        "opening_qty": Decimal("4"),
    },
    {
        "name": "1 CM Dispenser Tape",
        "sku": "246977",
        "selling_price": Decimal("10.00"),
        "cost_price": Decimal("4.58"),
        "category": "Tape & Adhesives",
        "brand": "Generic",
        "unit": "Pieces",
        "opening_qty": Decimal("36"),
    },
    {
        "name": "1.5 CM Dispenser Tape",
        "sku": "249357",
        "selling_price": Decimal("15.00"),
        "cost_price": Decimal("6.88"),
        "category": "Tape & Adhesives",
        "brand": "Generic",
        "unit": "Pieces",
        "opening_qty": Decimal("7"),
    },
    {
        "name": "10 No Chipa Tali Khata",
        "sku": "247215",
        "selling_price": Decimal("50.00"),
        "cost_price": Decimal("30.00"),
        "category": "Stationery",
        "brand": "OEM",
        "unit": "Pieces",
        "opening_qty": Decimal("6"),
    },
]


class Command(BaseCommand):
    help = "Seed sample products into a tenant database for UI testing."

    def add_arguments(self, parser):
        parser.add_argument("--email", type=str, default="", help="Tenant owner email.")
        parser.add_argument("--alias", type=str, default="", help="Tenant DB alias.")

    def handle(self, *args, **options):
        tenant = self._resolve_tenant(options)
        register_tenant_db(tenant.db_alias, tenant.db_name)
        set_current_db_alias(tenant.db_alias)

        try:
            location = Location.objects.using(tenant.db_alias).filter(is_active=True).first()
            if not location:
                location = Location.objects.using(tenant.db_alias).create(
                    name="Main Branch", code="MAIN", is_active=True,
                )

            unit_map = {}
            for name, abbr in SAMPLE_UNITS:
                obj, _ = Unit.objects.using(tenant.db_alias).get_or_create(
                    name=name, defaults={"abbreviation": abbr},
                )
                unit_map[name] = obj

            brand_map = {}
            for name in SAMPLE_BRANDS:
                obj, _ = Brand.objects.using(tenant.db_alias).get_or_create(name=name)
                brand_map[name] = obj

            cat_map = {}
            for name in SAMPLE_CATEGORIES:
                obj, _ = Category.objects.using(tenant.db_alias).get_or_create(
                    name=name, parent=None,
                )
                cat_map[name] = obj

            created = 0
            skipped = 0
            for spec in SAMPLE_PRODUCTS:
                if Product.objects.using(tenant.db_alias).filter(sku=spec["sku"]).exists():
                    skipped += 1
                    continue
                product = Product.objects.using(tenant.db_alias).create(
                    name=spec["name"],
                    sku=spec["sku"],
                    selling_price=spec["selling_price"],
                    cost_price=spec.get("cost_price", Decimal("0")),
                    tax_rate=spec.get("tax_rate", Decimal("0")),
                    tax_type=spec.get("tax_type", "exclusive"),
                    product_type=spec.get("product_type", "single"),
                    barcode_type="C128",
                    category=cat_map.get(spec["category"]),
                    brand=brand_map.get(spec["brand"]),
                    unit=unit_map[spec["unit"]],
                )
                if spec.get("opening_qty"):
                    add_stock_fifo(
                        product_id=product.id,
                        location_id=location.id,
                        quantity=spec["opening_qty"],
                        unit_cost=spec.get("cost_price", Decimal("0")),
                        reference_type="opening_stock",
                    )
                created += 1
                self.stdout.write(self.style.SUCCESS(f"  + {product.name} (SKU {product.sku})"))

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
