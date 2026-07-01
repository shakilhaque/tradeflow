import uuid

from django.conf import settings
from django.db import migrations, models

import accounts.models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0009_user_profile_picture"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="LoginOtp",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=uuid.uuid4, editable=False, serialize=False,
                    ),
                ),
                (
                    "code",
                    models.CharField(
                        max_length=6, db_index=True,
                        default=accounts.models._generate_otp_code,
                    ),
                ),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                (
                    "expires_at",
                    models.DateTimeField(
                        db_index=True,
                        default=accounts.models._otp_expiry,
                    ),
                ),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="login_otps",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "login_otps",
                "ordering": ["-created_at"],
            },
        ),
    ]
