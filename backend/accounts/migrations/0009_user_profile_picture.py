from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0008_plan_pricing_v2"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="profile_picture",
            field=models.URLField(
                blank=True,
                default="",
                max_length=500,
                help_text=(
                    "Absolute URL of the user's avatar (uploaded via "
                    "/api/auth/me/avatar/). Empty string means the UI should "
                    "fall back to initials."
                ),
            ),
        ),
    ]
