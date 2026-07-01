from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0002_add_tenant_model"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="role",
            field=models.CharField(
                choices=[
                    ("owner",   "Owner"),
                    ("admin",   "Admin"),
                    ("manager", "Manager"),
                    ("cashier", "Cashier"),
                ],
                default="owner",
                db_index=True,
                help_text="Controls discount permission and supervisor override in POS.",
                max_length=20,
            ),
        ),
    ]
