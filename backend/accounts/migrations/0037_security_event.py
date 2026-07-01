"""
SecurityEvent — immutable master-DB log of platform-level security events
(logins, logouts, password set/reset, tenant deletes, credential changes,
platform-admin actions). Complements the tenant-scoped audit.AuditLog.
"""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0036_userbranch"),
    ]

    operations = [
        migrations.CreateModel(
            name="SecurityEvent",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("event", models.CharField(
                    max_length=24, db_index=True,
                    choices=[
                        ("login_success", "Login success"),
                        ("login_failure", "Login failure"),
                        ("logout", "Logout"),
                        ("password_set", "Password set/reset"),
                        ("tenant_delete", "Tenant deleted"),
                        ("sms_config", "SMS credentials changed"),
                        ("admin_action", "Platform-admin action"),
                    ],
                )),
                ("actor_id", models.UUIDField(blank=True, null=True, db_index=True)),
                ("actor_email", models.CharField(blank=True, default="", max_length=254)),
                ("target", models.CharField(blank=True, default="", max_length=254)),
                ("success", models.BooleanField(default=True)),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.CharField(blank=True, default="", max_length=500)),
                ("detail", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={
                "db_table": "security_events",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="securityevent",
            index=models.Index(fields=["event", "created_at"], name="secevt_event_time_idx"),
        ),
        migrations.AddIndex(
            model_name="securityevent",
            index=models.Index(fields=["actor_id", "created_at"], name="secevt_actor_time_idx"),
        ),
    ]
