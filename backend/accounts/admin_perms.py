"""
Platform-admin RBAC catalogue.

Each entry is one section of the platform-admin panel (mirrors the admin
sidebar). A STAFF (sub-admin) user is granted a subset of these via the
`User.admin_permissions` JSON list; a superuser implicitly has them all.

Keep the keys in sync with the frontend Sidebar path→permission map.
"""

ADMIN_PERMISSIONS = [
    {"key": "dashboard",        "label": "Dashboard"},
    {"key": "tenants",          "label": "Tenants"},
    {"key": "tenant_users",     "label": "Tenant Users"},
    {"key": "revenue",          "label": "Revenue Analytics"},
    {"key": "payments",         "label": "Payments"},
    {"key": "payment_gateways", "label": "Payment Gateways"},
    {"key": "support",          "label": "Support Tickets"},
    {"key": "clients",          "label": "Clients & Billing"},
    {"key": "subscriptions",    "label": "Subscriptions"},
    {"key": "plans",            "label": "Plans"},
    {"key": "coupons",          "label": "Coupons"},
    {"key": "website",          "label": "Website Content"},
    {"key": "notices",          "label": "Notice Board"},
    {"key": "bulk_sms",         "label": "Bulk SMS"},
    {"key": "referrals",        "label": "Referrals"},
    {"key": "admin_users",      "label": "Admin Users"},
]

ADMIN_PERMISSION_KEYS = {p["key"] for p in ADMIN_PERMISSIONS}


def sanitize_admin_permissions(raw) -> list:
    """Keep only known keys from an arbitrary input list, de-duped + ordered
    to match the catalogue."""
    if not isinstance(raw, (list, tuple, set)):
        return []
    wanted = {str(k) for k in raw}
    return [p["key"] for p in ADMIN_PERMISSIONS if p["key"] in wanted]


def effective_admin_perms(user) -> list:
    """The section keys a user can actually access. Superuser → all;
    non-admin → none; sub-admin → their sanitised stored list."""
    if not user or not (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)):
        return []
    if getattr(user, "is_superuser", False):
        return [p["key"] for p in ADMIN_PERMISSIONS]
    return sanitize_admin_permissions(getattr(user, "admin_permissions", None) or [])


def admin_has_perm(user, key) -> bool:
    """True if the user may access the given platform-admin section."""
    if not user or not (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)):
        return False
    if getattr(user, "is_superuser", False):
        return True
    return key in (getattr(user, "admin_permissions", None) or [])
