"""
Audit log table — lives in each tenant's dedicated database.
"""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="AuditLog",
            fields=[
                ("id",          models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)),
                ("user_id",     models.UUIDField(null=True, blank=True, db_index=True)),
                ("user_name",   models.CharField(max_length=200, blank=True)),
                ("action",      models.CharField(
                    max_length=10,
                    choices=[
                        ("CREATE", "Create"),
                        ("UPDATE", "Update"),
                        ("DELETE", "Delete"),
                        ("VOID",   "Void"),
                        ("LOGIN",  "Login"),
                        ("EXPORT", "Export"),
                    ],
                    db_index=True,
                )),
                ("module",      models.CharField(max_length=100, db_index=True)),
                ("record_id",   models.UUIDField(null=True, blank=True, db_index=True)),
                ("record_repr", models.CharField(max_length=300, blank=True)),
                ("old_value",   models.JSONField(null=True, blank=True)),
                ("new_value",   models.JSONField(null=True, blank=True)),
                ("ip_address",  models.GenericIPAddressField(null=True, blank=True)),
                ("user_agent",  models.CharField(max_length=500, blank=True)),
                ("extra",       models.JSONField(default=dict, blank=True)),
                ("created_at",  models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={"db_table": "audit_logs", "ordering": ["-created_at"]},
        ),
        migrations.AddIndex(
            model_name="auditlog",
            index=models.Index(fields=["module", "record_id"], name="audit_module_record_idx"),
        ),
        migrations.AddIndex(
            model_name="auditlog",
            index=models.Index(fields=["user_id", "created_at"], name="audit_user_time_idx"),
        ),
        migrations.AddIndex(
            model_name="auditlog",
            index=models.Index(fields=["action", "created_at"], name="audit_action_time_idx"),
        ),
    ]
