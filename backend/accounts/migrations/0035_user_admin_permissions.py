"""
Add User.admin_permissions — the per-(sub-)admin list of platform-admin
sections the user may access (RBAC for the admin panel). Empty by default;
superusers ignore it (they have every section).
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0034_plan_yearly_discount_percent"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="admin_permissions",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
