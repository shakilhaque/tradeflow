"""
Django admin — SaaS Subscription System
"""
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.utils import timezone
from django.utils.html import format_html

from .models import User, Plan, Subscription, Payment, PasswordSetupToken, SecurityEvent


# ──────────────────────────────────────────────────────────────────────────────
# User
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display    = ("email", "name", "username", "status_badge", "subscribed", "is_first_login", "created_at")
    list_filter     = ("status", "is_staff", "is_active", "is_first_login")
    search_fields   = ("email", "name", "username", "phone", "business_name")
    ordering        = ("-created_at",)
    readonly_fields = ("id", "username", "created_at", "last_login")

    fieldsets = (
        ("Identity",      {"fields": ("id", "email", "name", "username")}),
        ("Business Info", {"fields": ("phone", "business_name")}),
        ("Security",      {"fields": ("password",)}),
        ("Account State", {"fields": ("status", "is_active", "is_first_login")}),
        ("Permissions",   {"fields": ("is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Timestamps",    {"fields": ("created_at", "last_login")}),
    )
    add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields":  ("email", "name", "password1", "password2"),
        }),
    )

    @admin.display(description="Status")
    def status_badge(self, obj):
        colour = "green" if obj.status == User.Status.ACTIVE else "red"
        return format_html(
            '<b style="color:{};">{}</b>', colour, obj.get_status_display()
        )

    @admin.display(description="Subscribed", boolean=True)
    def subscribed(self, obj):
        return obj.has_active_subscription

    actions = ["suspend_selected", "activate_selected"]

    @admin.action(description="Suspend selected users")
    def suspend_selected(self, request, queryset):
        for u in queryset:
            u.suspend()
        self.message_user(request, f"Suspended {queryset.count()} user(s).")

    @admin.action(description="Activate selected users")
    def activate_selected(self, request, queryset):
        for u in queryset:
            u.activate()
        self.message_user(request, f"Activated {queryset.count()} user(s).")


# ──────────────────────────────────────────────────────────────────────────────
# Plan
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display    = (
        "name", "code", "price", "billing_cycle", "duration_days",
        "max_branches", "max_sub_accounts", "is_trial", "is_custom",
        "active_subscribers", "is_active", "sort_order",
    )
    list_filter     = ("is_active", "billing_cycle", "is_trial", "is_custom")
    search_fields   = ("name", "code")
    readonly_fields = ("id", "created_at")
    fieldsets = (
        ("Identity",     {"fields": ("id", "code", "name", "description", "sort_order")}),
        ("Pricing",      {"fields": ("price", "billing_cycle", "duration_days", "per_branch_fee")}),
        ("Limits",       {"fields": ("max_branches", "max_sub_accounts")}),
        ("Plan Type",    {"fields": ("is_trial", "is_custom", "is_active")}),
        ("Marketing",    {"fields": ("features",)}),
        ("Timestamps",   {"fields": ("created_at",)}),
    )

    @admin.display(description="Active Subscribers")
    def active_subscribers(self, obj):
        return obj.subscriptions.filter(status=Subscription.Status.ACTIVE).count()


# ──────────────────────────────────────────────────────────────────────────────
# Subscription
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display    = ("user", "plan", "status_badge", "start_date", "next_billing_date", "days_left", "created_at")
    list_filter     = ("status", "plan")
    search_fields   = ("user__email", "user__name", "plan__name")
    raw_id_fields   = ("user",)
    readonly_fields = ("id", "created_at")

    @admin.display(description="Status")
    def status_badge(self, obj):
        colours = {"active": "green", "suspended": "orange", "expired": "red", "cancelled": "gray"}
        c = colours.get(obj.status, "black")
        return format_html('<b style="color:{};">{}</b>', c, obj.get_status_display())

    @admin.display(description="Days Left")
    def days_left(self, obj):
        delta = (obj.next_billing_date - timezone.localdate()).days
        if delta < 0:
            return format_html('<span style="color:red;">Expired {} day(s) ago</span>', abs(delta))
        if delta <= 3:
            return format_html('<span style="color:orange;">{} day(s)</span>', delta)
        return f"{delta} days"

    actions = ["cancel_selected", "suspend_selected"]

    @admin.action(description="Cancel selected subscriptions")
    def cancel_selected(self, request, queryset):
        queryset.update(status=Subscription.Status.CANCELLED)
        self.message_user(request, f"Cancelled {queryset.count()} subscription(s).")

    @admin.action(description="Suspend selected subscriptions")
    def suspend_selected(self, request, queryset):
        queryset.update(status=Subscription.Status.SUSPENDED)
        self.message_user(request, f"Suspended {queryset.count()} subscription(s).")


# ──────────────────────────────────────────────────────────────────────────────
# Payment
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display    = ("short_id", "user", "amount", "status_badge", "transaction_id", "paid_at", "created_at")
    list_filter     = ("status",)
    search_fields   = ("user__email", "transaction_id")
    raw_id_fields   = ("user", "subscription")
    readonly_fields = ("id", "created_at", "paid_at", "metadata")

    @admin.display(description="ID")
    def short_id(self, obj):
        return str(obj.id)[:8] + "…"

    @admin.display(description="Status")
    def status_badge(self, obj):
        colours = {"pending": "orange", "success": "green", "failed": "red"}
        c = colours.get(obj.status, "black")
        return format_html('<b style="color:{};">{}</b>', c, obj.get_status_display())


# ──────────────────────────────────────────────────────────────────────────────
# Password Setup Token
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(PasswordSetupToken)
class PasswordSetupTokenAdmin(admin.ModelAdmin):
    list_display    = ("user", "token_preview", "expires_at", "is_valid_badge", "created_at")
    search_fields   = ("user__email",)
    raw_id_fields   = ("user",)
    readonly_fields = ("id", "token", "expires_at", "created_at")

    @admin.display(description="Token")
    def token_preview(self, obj):
        return obj.token[:14] + "…"

    @admin.display(description="Valid", boolean=True)
    def is_valid_badge(self, obj):
        return obj.is_valid

    actions = ["reissue_tokens"]

    @admin.action(description="Re-issue tokens for selected users")
    def reissue_tokens(self, request, queryset):
        for t in queryset:
            PasswordSetupToken.issue(t.user)
        self.message_user(request, f"Re-issued {queryset.count()} token(s).")


# ──────────────────────────────────────────────────────────────────────────────
# Security Event (read-only audit trail)
# ──────────────────────────────────────────────────────────────────────────────

@admin.register(SecurityEvent)
class SecurityEventAdmin(admin.ModelAdmin):
    list_display    = ("created_at", "event", "success", "actor_email", "target", "ip_address")
    list_filter     = ("event", "success", "created_at")
    search_fields   = ("actor_email", "target", "ip_address")
    readonly_fields = ("id", "event", "actor_id", "actor_email", "target", "success",
                       "ip_address", "user_agent", "detail", "created_at")
    ordering        = ("-created_at",)

    def has_add_permission(self, request):       return False
    def has_change_permission(self, request, obj=None): return False
    def has_delete_permission(self, request, obj=None): return False
