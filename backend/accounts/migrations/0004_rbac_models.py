"""
Migration 0004 — RBAC: Permission and RolePermission tables.

Both tables live in the master (default) database and are created here.
Seeding happens in migration 0005_seed_rbac.py.
"""
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0003_user_role"),
    ]

    operations = [
        # ── Permission ─────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Permission",
            fields=[
                ("id",          models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("code",        models.CharField(max_length=100, unique=True,
                                help_text="Machine-readable code matching a Perm.* constant.")),
                ("name",        models.CharField(max_length=200)),
                ("description", models.TextField(blank=True)),
                ("created_at",  models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "rbac_permissions", "ordering": ["code"]},
        ),

        # ── RolePermission ─────────────────────────────────────────────────────
        migrations.CreateModel(
            name="RolePermission",
            fields=[
                ("id",         models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("role_code",  models.CharField(
                    max_length=20,
                    choices=[
                        ("owner",   "Owner"),
                        ("admin",   "Admin"),
                        ("manager", "Manager"),
                        ("cashier", "Cashier"),
                    ],
                    db_index=True,
                )),
                ("permission", models.ForeignKey(
                    "accounts.Permission",
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="role_permissions",
                )),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "db_table": "rbac_role_permissions",
                "ordering": ["role_code", "permission__code"],
            },
        ),
        migrations.AlterUniqueTogether(
            name="rolepermission",
            unique_together={("role_code", "permission")},
        ),
    ]
