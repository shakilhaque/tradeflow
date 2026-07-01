"""
Super Admin Tenant Users — Phase D: force-logout support.

`force_logout_at` records the instant a Super Admin ended a user's sessions.
Any access/refresh token issued before this time is rejected on the next
request, so all active sessions die while the account stays usable (the user
can log in again immediately).
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0031_user_branch_and_lock"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="force_logout_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
