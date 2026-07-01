import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0014_user_sales_fields_role_permissions"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="tenant_role",
            field=models.ForeignKey(
                null=True, blank=True,
                on_delete=django.db.models.deletion.SET_NULL,
                to="accounts.tenantrole",
                related_name="users",
                help_text="Optional custom role granting granular permissions on top of the built-in role.",
            ),
        ),
    ]
