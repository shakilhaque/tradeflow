"""Seed the built-in marketing services into the CMS so admins can edit them.

Idempotent: only seeds when no `services` CmsItems exist yet.
"""
import uuid

from django.db import migrations


DEFAULT_SERVICES = [
    {
        "slug": "accounting-saas", "name": "Accounting SaaS",
        "icon": "M3 7l9-4 9 4M3 7v10l9 4 9-4V7M3 7l9 4 9-4",
        "short_description": "Our flagship product. Invoicing, expenses, journals, AR / AP, tax reports, and full P&L / Balance Sheet.",
    },
    {
        "slug": "inventory-pos", "name": "Inventory & POS",
        "icon": "M5 8h14l-1 12H6L5 8z M9 8V5a3 3 0 016 0v3",
        "short_description": "Multi-location stock tracking, transfers, batches, and a built-in POS for retail businesses.",
    },
    {
        "slug": "tax-compliance", "name": "Tax & Compliance",
        "icon": "M4 6h16M4 12h16M4 18h10",
        "short_description": "VAT, AIT, and statutory reports formatted exactly as auditors expect — exportable to Excel and PDF.",
    },
    {
        "slug": "multi-tenant-hosting", "name": "Multi-Tenant Hosting",
        "icon": "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4",
        "short_description": "Each client gets an isolated database. We handle backups, scaling, and zero-downtime upgrades.",
    },
    {
        "slug": "real-time-reporting", "name": "Real-Time Reporting",
        "icon": "M3 17l6-6 4 4 8-8",
        "short_description": "Reports update the moment a transaction posts. No nightly batches, no stale dashboards.",
    },
    {
        "slug": "role-based-security", "name": "Role-Based Security",
        "icon": "M16 11V7a4 4 0 10-8 0v4M5 11h14v10H5z",
        "short_description": "Granular permissions, audit logs, and SSO-ready authentication out of the box.",
    },
]


def seed(apps, schema_editor):
    CmsItem = apps.get_model("accounts", "CmsItem")
    if CmsItem.objects.filter(collection="services").exists():
        return
    for i, svc in enumerate(DEFAULT_SERVICES):
        CmsItem.objects.create(
            id=uuid.uuid4(),
            collection="services",
            slug=svc["slug"],
            data={
                "name": svc["name"],
                "slug": svc["slug"],
                "short_description": svc["short_description"],
                "full_description": "",
                "icon": svc["icon"],
                "banner_image": "",
                "seo_title": svc["name"],
                "seo_description": svc["short_description"],
            },
            sort_order=i,
            is_published=True,
        )


def unseed(apps, schema_editor):
    CmsItem = apps.get_model("accounts", "CmsItem")
    CmsItem.objects.filter(collection="services",
                           slug__in=[s["slug"] for s in DEFAULT_SERVICES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0029_website_cms"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
