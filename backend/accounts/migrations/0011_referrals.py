import uuid
from decimal import Decimal

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0010_login_otp"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Referral",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=uuid.uuid4, editable=False, serialize=False,
                    ),
                ),
                ("referrer_phone_snapshot", models.CharField(blank=True, max_length=30)),
                ("awarded_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "plan_at_signup",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+", to="accounts.plan",
                    ),
                ),
                (
                    "referred",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="referral_source",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "referrer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="referrals_made",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "triggering_payment",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name="referral_awards", to="accounts.payment",
                    ),
                ),
            ],
            options={
                "db_table": "referrals",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="DiscountCredit",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=uuid.uuid4, editable=False, serialize=False,
                    ),
                ),
                (
                    "percent",
                    models.DecimalField(decimal_places=2, default=Decimal("20.00"), max_digits=5),
                ),
                ("earned_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("applied_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("notes", models.TextField(blank=True)),
                (
                    "applied_payment",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name="discount_credits_consumed", to="accounts.payment",
                    ),
                ),
                (
                    "referral",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name="discount_credits", to="accounts.referral",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="discount_credits", to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "discount_credits",
                "ordering": ["earned_at"],
            },
        ),
    ]
