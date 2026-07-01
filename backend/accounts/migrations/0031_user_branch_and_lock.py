"""
Tenant Users module (Super Admin) — add branch tag + account lock to User.

  • branch_id / branch_name — denormalised branch a tenant user belongs to,
    so "Users per Branch" works without querying every tenant DB.
  • is_locked / locked_at   — Lock/Unlock a user's login (separate from the
    active/suspended status).
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0030_seed_cms_services"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="branch_id",
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="user",
            name="branch_name",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="user",
            name="is_locked",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="locked_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
