"""
Migration 0005 — Seed default Permissions and RolePermissions.

Reads the authoritative role→permission matrix from accounts.permissions
and populates the DB tables.  Uses update_or_create so re-running is safe.
"""
from django.db import migrations


def _seed(apps, schema_editor):
    from accounts.permissions import Perm, _ROLE_PERMISSIONS  # noqa: PLC0415

    Permission    = apps.get_model("accounts", "Permission")
    RolePermission = apps.get_model("accounts", "RolePermission")
    db = schema_editor.connection.alias

    # ── 1. Upsert Permission rows ─────────────────────────────────────────────
    perm_objects = {}
    for code, description in Perm.DESCRIPTIONS.items():
        obj, _ = Permission.objects.using(db).update_or_create(
            code=code,
            defaults={
                "name":        code.replace("_", " ").title(),
                "description": description,
            },
        )
        perm_objects[code] = obj

    # ── 2. Upsert RolePermission rows ─────────────────────────────────────────
    for role_code, perm_codes in _ROLE_PERMISSIONS.items():
        for perm_code in perm_codes:
            perm = perm_objects.get(perm_code)
            if perm:
                RolePermission.objects.using(db).get_or_create(
                    role_code=role_code,
                    permission=perm,
                )


def _unseed(apps, schema_editor):
    RolePermission = apps.get_model("accounts", "RolePermission")
    Permission      = apps.get_model("accounts", "Permission")
    db = schema_editor.connection.alias
    RolePermission.objects.using(db).all().delete()
    Permission.objects.using(db).all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0004_rbac_models"),
    ]

    operations = [
        migrations.RunPython(_seed, reverse_code=_unseed),
    ]
