"""
Migration 0001 — Create system_settings and tax_groups tables in tenant databases.
"""

import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="SystemSetting",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("key",           models.CharField(db_index=True, max_length=100, unique=True)),
                ("value_str",     models.TextField()),
                (
                    "value_type",
                    models.CharField(
                        choices=[
                            ("STRING",  "String"),
                            ("INTEGER", "Integer"),
                            ("FLOAT",   "Float / Decimal"),
                            ("BOOLEAN", "Boolean"),
                            ("JSON",    "JSON Object"),
                        ],
                        default="STRING",
                        max_length=10,
                    ),
                ),
                ("description",   models.CharField(blank=True, max_length=300)),
                ("updated_by_id", models.UUIDField(blank=True, null=True)),
                ("updated_at",    models.DateTimeField(auto_now=True)),
                ("created_at",    models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "db_table": "system_settings",
                "ordering": ["key"],
            },
        ),
        migrations.CreateModel(
            name="TaxGroup",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("code",        models.CharField(db_index=True, max_length=20, unique=True)),
                ("name",        models.CharField(max_length=100)),
                ("rate",        models.DecimalField(decimal_places=4, max_digits=6)),
                ("is_default",  models.BooleanField(default=False)),
                ("is_active",   models.BooleanField(db_index=True, default=True)),
                ("description", models.CharField(blank=True, max_length=300)),
                ("created_at",  models.DateTimeField(auto_now_add=True)),
                ("updated_at",  models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "tax_groups",
                "ordering": ["name"],
            },
        ),
    ]
