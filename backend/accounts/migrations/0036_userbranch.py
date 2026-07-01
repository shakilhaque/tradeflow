"""
UserBranch — branch membership for multi-branch data isolation (Phase 1).
Stores which branches (tenant Locations, by soft UUID) a sub-user may access.
Tenant owners implicitly have every branch + the consolidated view.
"""
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0035_user_admin_permissions"),
    ]

    operations = [
        migrations.CreateModel(
            name="UserBranch",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("branch_id", models.UUIDField(db_index=True)),
                ("branch_name", models.CharField(blank=True, default="", max_length=200)),
                ("can_manage", models.BooleanField(default=False, help_text="Branch-level manager — broader permissions within this branch.")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="branch_memberships", to="accounts.user")),
            ],
            options={
                "db_table": "user_branches",
            },
        ),
        migrations.AlterUniqueTogether(
            name="userbranch",
            unique_together={("user", "branch_id")},
        ),
    ]
