import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0012_user_parent_owner"),
    ]

    operations = [
        migrations.CreateModel(
            name="TenantRole",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=80, help_text="Display name (e.g. 'Sub Company', 'Stock Auditor').")),
                ("description", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="tenant_roles",
                    to="accounts.user",
                    help_text="Tenant owner this custom role belongs to.",
                )),
            ],
            options={
                "db_table": "tenant_roles",
                "ordering": ["name"],
                "unique_together": {("owner", "name")},
            },
        ),
    ]
