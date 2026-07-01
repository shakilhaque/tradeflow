"""Platform-wide Notice Board for tenant dashboards."""
import uuid
import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0017_user_postal_address"),
    ]

    operations = [
        migrations.CreateModel(
            name="PlatformNotice",
            fields=[
                ("id",         models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
                ("title",      models.CharField(max_length=200)),
                ("body",       models.TextField(help_text="Markdown / plain text. Shown verbatim in the tenant dashboard.")),
                ("kind",       models.CharField(
                    max_length=15,
                    choices=[
                        ("info",        "Info"),
                        ("warning",     "Warning"),
                        ("critical",    "Critical"),
                        ("maintenance", "Maintenance"),
                    ],
                    default="info",
                    db_index=True,
                )),
                ("is_active",  models.BooleanField(default=True, db_index=True)),
                ("published_at", models.DateTimeField(default=timezone.now, db_index=True)),
                ("expires_at", models.DateTimeField(null=True, blank=True, db_index=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(
                    null=True, blank=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="platform_notices",
                    to="accounts.user",
                )),
            ],
            options={
                "db_table": "platform_notices",
                "ordering": ["-published_at"],
            },
        ),
    ]
