"""
NSL-POS — Core account models (single database).

Models:
    User            — custom auth user (email-based login)
    TenantRole      — custom role catalog with granular permissions
    Permission      — RBAC permission code
    RolePermission  — role → permission mapping
    UserBranch      — branch membership (multi-branch data isolation)
    SecurityEvent   — append-only security/audit log
"""
import uuid
import secrets

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _generate_username(name: str) -> str:
    """Build a username from display name + short random hex suffix.
    e.g. "Jane Doe" → "jane_doe_3f9a"."""
    base = "".join(c for c in name.lower().replace(" ", "_") if c.isalnum() or c == "_")
    suffix = secrets.token_hex(2)
    return f"{base}_{suffix}" if base else f"user_{suffix}"


# ──────────────────────────────────────────────────────────────────────────────
# 1. User
# ──────────────────────────────────────────────────────────────────────────────

class UserManager(BaseUserManager):
    """Custom manager — password is optional at creation time."""

    def create_user(self, email: str, name: str, password=None, **extra):
        if not email:
            raise ValueError("Email is required.")
        if not name:
            raise ValueError("Name is required.")

        email = self.normalize_email(email)
        extra.setdefault("username", _generate_username(name))

        user = self.model(email=email, name=name, **extra)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, email: str, name: str, password: str, **extra):
        extra.update(is_staff=True, is_superuser=True, status=User.Status.ACTIVE)
        return self.create_user(email, name, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """Custom user model — identified by email."""

    class Status(models.TextChoices):
        ACTIVE    = "active",    "Active"
        SUSPENDED = "suspended", "Suspended"

    class Role(models.TextChoices):
        OWNER   = "owner",   "Owner"      # account holder — full access
        ADMIN   = "admin",   "Admin"      # full access, can manage staff
        MANAGER = "manager", "Manager"    # can apply discounts, view reports
        CASHIER = "cashier", "Cashier"    # POS only; discounts need supervisor

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name           = models.CharField(max_length=150)
    email          = models.EmailField(unique=True, db_index=True, null=True, blank=True)
    username       = models.CharField(max_length=80, unique=True, db_index=True)
    phone          = models.CharField(max_length=30, blank=True)
    business_name  = models.CharField(max_length=200, blank=True)

    # ── Postal address (optional) ──────────────────────────────────────────
    address       = models.CharField(max_length=255, blank=True)
    thana         = models.CharField(max_length=120, blank=True)
    district      = models.CharField(max_length=120, blank=True)
    postal_code   = models.CharField(max_length=20, blank=True)

    status         = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE, db_index=True
    )
    role           = models.CharField(
        max_length=20, choices=Role.choices, default=Role.OWNER, db_index=True,
        help_text="Controls discount permission and supervisor override in POS.",
    )
    is_first_login = models.BooleanField(default=False)
    profile_picture = models.URLField(
        max_length=500, blank=True, default="",
        help_text="Absolute URL of the user's avatar. Empty = fall back to initials.",
    )
    is_active      = models.BooleanField(default=True)
    is_staff       = models.BooleanField(default=False)
    created_at     = models.DateTimeField(auto_now_add=True)

    # ── Sub-account linkage ────────────────────────────────────────────────
    # Staff users created from the "User Management" page link back to the
    # owner here. Owners have parent_owner=NULL.
    parent_owner   = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True,
        related_name="sub_users", db_index=True,
        help_text="Owner this sub-user reports to. NULL for owners.",
    )

    # ── Sales-staff economics ──────────────────────────────────────────────
    sales_commission_percent = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        help_text="Percentage of each finalized sale credited to this user.",
    )
    max_sales_discount_percent = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        help_text="Highest discount % this user can apply without supervisor approval.",
    )
    allow_selected_contacts = models.BooleanField(
        default=False,
        help_text="Restrict this user to selling only to a fixed customer list.",
    )
    allowed_contact_ids = models.JSONField(
        default=list, blank=True,
        help_text="Customer UUIDs the user can sell to. Empty = no restriction.",
    )

    # Optional custom role granting granular permissions on top of the built-in role.
    tenant_role = models.ForeignKey(
        "TenantRole", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="users",
    )

    # ── Branch tag (multi-branch) ──────────────────────────────────────────
    branch_id   = models.UUIDField(null=True, blank=True, db_index=True)
    branch_name = models.CharField(max_length=200, blank=True, default="")

    # ── Account lock / force-logout ────────────────────────────────────────
    is_locked   = models.BooleanField(default=False, db_index=True)
    locked_at   = models.DateTimeField(null=True, blank=True)
    force_logout_at = models.DateTimeField(null=True, blank=True)

    objects = UserManager()

    USERNAME_FIELD  = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        db_table = "users"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} <{self.email}>"

    # ── Domain helpers ──────────────────────────────────────────────────────

    @property
    def is_suspended(self):
        return self.status == self.Status.SUSPENDED

    @property
    def can_apply_discount(self) -> bool:
        return self.role in (self.Role.OWNER, self.Role.ADMIN, self.Role.MANAGER)

    @property
    def is_supervisor(self) -> bool:
        return self.role in (self.Role.OWNER, self.Role.ADMIN, self.Role.MANAGER)

    def suspend(self):
        self.status    = self.Status.SUSPENDED
        self.is_active = True
        self.save(update_fields=["status", "is_active"])

    def activate(self):
        self.status    = self.Status.ACTIVE
        self.is_active = True
        self.save(update_fields=["status", "is_active"])


# ──────────────────────────────────────────────────────────────────────────────
# 2. TenantRole  (custom role catalog with granular permissions)
# ──────────────────────────────────────────────────────────────────────────────

class TenantRole(models.Model):
    """A custom role beyond the built-in Admin / Manager / Cashier set."""

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner       = models.ForeignKey(
        "User", on_delete=models.CASCADE, related_name="tenant_roles",
        help_text="Owner this custom role belongs to.",
    )
    name        = models.CharField(max_length=80)
    description = models.TextField(blank=True, default="")
    permissions = models.JSONField(default=list, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        db_table        = "tenant_roles"
        unique_together = [("owner", "name")]
        ordering        = ["name"]

    def __str__(self):
        return self.name


# ──────────────────────────────────────────────────────────────────────────────
# 3. Permission  (RBAC)
# ──────────────────────────────────────────────────────────────────────────────

class Permission(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code        = models.CharField(max_length=100, unique=True)
    name        = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "rbac_permissions"
        ordering = ["code"]

    def __str__(self):
        return self.code


# ──────────────────────────────────────────────────────────────────────────────
# 4. RolePermission  (RBAC)
# ──────────────────────────────────────────────────────────────────────────────

class RolePermission(models.Model):
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role_code  = models.CharField(
        max_length=20, choices=User.Role.choices, db_index=True,
        help_text="Role code — must match one of User.Role choice values.",
    )
    permission = models.ForeignKey(
        Permission, on_delete=models.CASCADE, related_name="role_permissions",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table        = "rbac_role_permissions"
        unique_together = [("role_code", "permission")]
        ordering        = ["role_code", "permission__code"]

    def __str__(self):
        return f"{self.role_code} → {self.permission.code}"


# ──────────────────────────────────────────────────────────────────────────────
# 5. UserBranch  (multi-branch membership)
# ──────────────────────────────────────────────────────────────────────────────

class UserBranch(models.Model):
    """Branch membership for multi-branch data isolation.

    A tenant OWNER (parent_owner=NULL) implicitly has every branch; staff only
    see branches they have a row for. `can_manage` marks a branch-level manager.
    """
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user        = models.ForeignKey(
        "User", on_delete=models.CASCADE, related_name="branch_memberships",
    )
    branch_id   = models.UUIDField(db_index=True)            # soft ref → Location
    branch_name = models.CharField(max_length=200, blank=True, default="")
    can_manage  = models.BooleanField(default=False)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "user_branches"
        unique_together = [("user", "branch_id")]

    def __str__(self):
        return f"{self.user_id} → {self.branch_name or self.branch_id}"


# ──────────────────────────────────────────────────────────────────────────────
# 6. SecurityEvent  (append-only audit log)
# ──────────────────────────────────────────────────────────────────────────────

class SecurityEvent(models.Model):
    """Immutable log of security events — logins, logouts, password/admin actions."""

    class Event(models.TextChoices):
        LOGIN_SUCCESS = "login_success", "Login success"
        LOGIN_FAILURE = "login_failure", "Login failure"
        LOGOUT        = "logout",        "Logout"
        PASSWORD_SET  = "password_set",  "Password set/reset"
        ADMIN_ACTION  = "admin_action",  "Admin action"

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event       = models.CharField(max_length=24, choices=Event.choices, db_index=True)
    actor_id    = models.UUIDField(null=True, blank=True, db_index=True)
    actor_email = models.CharField(max_length=254, blank=True, default="")
    target      = models.CharField(max_length=254, blank=True, default="")
    success     = models.BooleanField(default=True)
    ip_address  = models.GenericIPAddressField(null=True, blank=True)
    user_agent  = models.CharField(max_length=500, blank=True, default="")
    detail      = models.JSONField(default=dict, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "security_events"
        ordering = ["-created_at"]
        indexes  = [
            models.Index(fields=["event", "created_at"],  name="secevt_event_time_idx"),
            models.Index(fields=["actor_id", "created_at"], name="secevt_actor_time_idx"),
        ]

    def __str__(self):
        return f"{self.created_at:%Y-%m-%d %H:%M}  {self.event}  {self.actor_email or self.actor_id}"
