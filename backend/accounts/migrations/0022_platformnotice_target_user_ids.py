"""Add PlatformNotice.target_user_ids — optional per-tenant targeting.

Empty list keeps the existing broadcast-to-everyone behaviour; a non-empty
list scopes the notice to those tenant owners (and their sub-users).
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0021_subscription_audit"),
    ]

    operations = [
        migrations.AddField(
            model_name="platformnotice",
            name="target_user_ids",
            field=models.JSONField(
                blank=True, default=list,
                help_text="Tenant owner user-IDs this notice is for. EMPTY = "
                          "broadcast to every tenant; non-empty = only those "
                          "tenants (and their sub-users) see it.",
            ),
        ),
    ]
