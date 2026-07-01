"""Coupon & promotion management — coupons, redemptions, campaigns, audit (master DB)."""
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0026_support_tickets"),
    ]

    operations = [
        migrations.CreateModel(
            name="Coupon",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("code", models.CharField(db_index=True, max_length=40, unique=True)),
                ("name", models.CharField(max_length=120)),
                ("description", models.TextField(blank=True, default="")),
                ("discount_type", models.CharField(choices=[("percentage", "Percentage Discount"), ("fixed", "Fixed Amount Discount"), ("free_trial", "Free Trial Extension"), ("first_time", "First-Time Customer Discount"), ("renewal", "Renewal Discount"), ("promotional", "Promotional Discount")], default="percentage", max_length=20)),
                ("discount_value", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("free_trial_days", models.PositiveIntegerField(default=0, help_text="Days added for FREE_TRIAL coupons.")),
                ("max_usage_limit", models.PositiveIntegerField(blank=True, null=True, help_text="Total redemptions allowed; blank = unlimited.")),
                ("per_tenant_limit", models.PositiveIntegerField(blank=True, null=True, help_text="Redemptions per tenant; blank = unlimited.")),
                ("min_purchase_amount", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("start_date", models.DateField(blank=True, null=True)),
                ("end_date", models.DateField(blank=True, null=True)),
                ("is_active", models.BooleanField(default=True)),
                ("created_by", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("applicable_plans", models.ManyToManyField(blank=True, help_text="Empty = all plans.", related_name="coupons", to="accounts.plan")),
            ],
            options={"db_table": "coupons", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="PromotionCampaign",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=120)),
                ("description", models.TextField(blank=True, default="")),
                ("target", models.CharField(choices=[("all", "All Tenants"), ("trial", "Trial Tenants"), ("active", "Active Tenants"), ("expiring", "Expiring Tenants"), ("suspended", "Suspended Tenants"), ("plans", "Specific Plans")], default="all", max_length=20)),
                ("start_date", models.DateField(blank=True, null=True)),
                ("end_date", models.DateField(blank=True, null=True)),
                ("is_active", models.BooleanField(default=True)),
                ("created_by", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("coupons", models.ManyToManyField(blank=True, related_name="campaigns", to="accounts.coupon")),
                ("target_plans", models.ManyToManyField(blank=True, related_name="campaigns", to="accounts.plan")),
            ],
            options={"db_table": "promotion_campaigns", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="CouponRedemption",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("amount_discounted", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("gross_amount", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("is_new_subscription", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("coupon", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="redemptions", to="accounts.coupon")),
                ("payment", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="coupon_redemptions", to="accounts.payment")),
                ("subscription", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="coupon_redemptions", to="accounts.subscription")),
                ("user", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="coupon_redemptions", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "coupon_redemptions", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="CouponAuditLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(db_index=True, max_length=24)),
                ("note", models.CharField(blank=True, default="", max_length=300)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("actor", models.UUIDField(blank=True, null=True)),
                ("actor_email", models.CharField(blank=True, default="", max_length=254)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("campaign", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="audit_logs", to="accounts.promotioncampaign")),
                ("coupon", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="audit_logs", to="accounts.coupon")),
            ],
            options={"db_table": "coupon_audit_log", "ordering": ["-created_at"]},
        ),
    ]
