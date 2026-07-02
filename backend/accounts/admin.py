"""
Django admin — NSL-POS (single-client).
"""
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.utils.html import format_html

from .models import User, SecurityEvent


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display    = ("email", "name", "username", "role", "status_badge", "is_staff", "created_at")
    list_filter     = ("status", "role", "is_staff", "is_active")
    search_fields   = ("email", "name", "username", "phone", "business_name")
    ordering        = ("-created_at",)
    readonly_fields = ("id", "created_at", "last_login")

    fieldsets = (
        ("Identity",      {"fields": ("id", "email", "name", "username")}),
        ("Business Info", {"fields": ("phone", "business_name")}),
        ("Security",      {"fields": ("password",)}),
        ("Account State", {"fields": ("status", "role", "is_active", "is_locked")}),
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
        return format_html('<b style="color:{};">{}</b>', colour, obj.get_status_display())

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
