import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0011_referrals"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="parent_owner",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="sub_users",
                to="accounts.user",
                help_text="Tenant owner this sub-user reports to. NULL for owners.",
                db_index=True,
            ),
        ),
    ]
