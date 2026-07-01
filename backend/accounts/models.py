"""
SaaS Subscription System — Core Models  (Master Database)

All models here live in the master (default) PostgreSQL database.
Per-tenant business models (invoices, products, etc.) belong in separate
apps that the TenantDatabaseRouter routes to each tenant's own database.

Models:
    User                 — custom auth user (email-based, password nullable at creation)
    Plan                 — billing plan (Starter, Pro, etc.)
    Subscription         — user ↔ plan binding with billing dates
    Payment              — payment transaction record
    PasswordSetupToken   — one-time token for first-login password setup
    Tenant               — maps a User to their dedicated PostgreSQL database
"""
import uuid
import secrets
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _token_expiry():
    """15 minutes from now — default for PasswordSetupToken.expires_at."""
    return timezone.now() + timedelta(minutes=15)


def _generate_username(name: str) -> str:
    """
    Build a username from display name + short random hex suffix.
    e.g. "Jane Doe" → "jane_doe_3f9a"
    """
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
            # No password yet — user will set it via the token-link flow.
            user.set_unusable_password()

        user.save(using=self._db)
        return user

    def create_superuser(self, email: str, name: str, password: str, **extra):
        extra.update(is_staff=True, is_superuser=True, status=User.Status.ACTIVE)
        return self.create_user(email, name, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """
    Custom user model.
    - Identified by email (not username).
    - Password starts unusable; set via PasswordSetupToken after first payment.
    """

    class Status(models.TextChoices):
        ACTIVE    = "active",    "Active"
        SUSPENDED = "suspended", "Suspended"

    class Role(models.TextChoices):
        OWNER   = "owner",   "Owner"      # tenant account holder — full access
        ADMIN   = "admin",   "Admin"      # full access, can manage staff
        MANAGER = "manager", "Manager"    # can apply discounts, view reports
        CASHIER = "cashier", "Cashier"    # POS only; discounts need supervisor

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name           = models.CharField(max_length=150)
    # Email is optional now (mobile number is the primary identifier).
    # Stored as NULL when omitted so the unique index never collides
    # across multiple "no-email" users.
    email          = models.EmailField(unique=True, db_index=True, null=True, blank=True)
    username       = models.CharField(max_length=80, unique=True, db_index=True)
    phone          = models.CharField(max_length=30, blank=True)
    business_name  = models.CharField(max_length=200, blank=True)

    # ── Postal address (collected at checkout for paid + trial signups) ───
    # All four optional so existing rows (created before this feature) and
    # any future code path that creates a User outside the checkout flow
    # don't fail validation. The Subscribe/TrialSignup serializers require
    # them at the API boundary.
    address       = models.CharField(max_length=255, blank=True,
                                     help_text="Street address / building / area.")
    thana         = models.CharField(max_length=120, blank=True,
                                     help_text="Thana / upazila / sub-district.")
    district      = models.CharField(max_length=120, blank=True,
                                     help_text="District (Zila).")
    postal_code   = models.CharField(max_length=20, blank=True,
                                     help_text="Bangladesh postal code (e.g. 1207).")
    status         = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE, db_index=True
    )
    role           = models.CharField(
        max_length=20, choices=Role.choices, default=Role.OWNER, db_index=True,
        help_text="Controls discount permission and supervisor override in POS.",
    )
    is_first_login = models.BooleanField(
        default=True,
        help_text="True until the user sets their password and logs in.",
    )
    profile_picture = models.URLField(
        max_length=500, blank=True, default="",
        help_text="Absolute URL of the user's avatar (uploaded via /api/auth/me/avatar/). "
                  "Empty string means the UI should fall back to initials.",
    )
    is_active      = models.BooleanField(default=True)
    is_staff       = models.BooleanField(default=False)
    created_at     = models.DateTimeField(auto_now_add=True)

    # ── Sub-account linkage ────────────────────────────────────────────────
    # Owners have parent_owner=NULL. Staff users created from the
    # "User Management" page link back to the tenant owner here so the
    # TenantMiddleware can resolve them to the owner's Tenant DB at login.
    parent_owner   = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="sub_users",
        db_index=True,
        help_text="Tenant owner this sub-user reports to. NULL for owners.",
    )

    # ── Sales-staff economics (only meaningful for non-owner users) ────────
    sales_commission_percent = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        help_text="Percentage of each finalized sale credited to this user. 0 / blank = none.",
    )
    max_sales_discount_percent = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        help_text="Highest discount % this user can apply on a sale without supervisor approval.",
    )
    # When True, this user can only sell to the customers listed in
    # allowed_contact_ids. Useful for sales reps assigned to a customer book.
    allow_selected_contacts = models.BooleanField(
        default=False,
        help_text="Restrict this user to selling only to a fixed customer list.",
    )
    allowed_contact_ids = models.JSONField(
        default=list, blank=True,
        help_text="List of Customer UUIDs the user can sell to. Empty = no contact restriction.",
    )

    # When set, the user's effective permissions come from this custom
    # role's permissions JSON list (in addition to the built-in role
    # matrix). Owners and admins typically have this NULL — their
    # broad access flows from the built-in role. Cashiers / managers
    # / staff can be assigned a custom role for fine-grained control.
    tenant_role = models.ForeignKey(
        "TenantRole",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="users",
        help_text="Optional custom role granting granular permissions on top of the built-in role.",
    )

    # ── Branch / location tag (denormalised from the tenant DB) ─────────────
    # A tenant can run several branches (BusinessLocation rows in its own DB).
    # We tag each user with one branch and copy the name here so the Super
    # Admin "Users per Branch" view works without fanning out to every tenant
    # database. Optional — NULL means "unassigned".
    branch_id   = models.UUIDField(null=True, blank=True, db_index=True)
    branch_name = models.CharField(max_length=200, blank=True, default="")

    # ── Platform-admin section permissions (RBAC for the admin panel) ──────
    # For a STAFF (sub-admin) user this lists the platform-admin sections the
    # user may access — keys from accounts.admin_perms.ADMIN_PERMISSIONS, e.g.
    # ["support", "tenants"]. A superuser implicitly has every section, so
    # this list is ignored for them. Empty for tenant users.
    admin_permissions = models.JSONField(default=list, blank=True)

    # ── Account lock (Super Admin Tenant Users module) ─────────────────────
    # Distinct from status / is_active: a LOCKED user is blocked from logging
    # in even while their account is otherwise active. Activate/Deactivate
    # toggles status; Lock/Unlock toggles this flag.
    is_locked   = models.BooleanField(default=False, db_index=True)
    locked_at   = models.DateTimeField(null=True, blank=True)
    # Force-logout marker: any JWT issued (iat) before this instant is
    # rejected by ForceLogoutAwareJWTAuthentication, so a Super Admin can
    # end all of a user's active sessions without locking the account.
    force_logout_at = models.DateTimeField(null=True, blank=True)

    objects = UserManager()

    USERNAME_FIELD  = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        db_table = "users"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} <{self.email}>"

    # ── Domain helpers ────────────────────────────────────────────────────────

    @property
    def is_suspended(self):
        return self.status == self.Status.SUSPENDED

    @property
    def can_apply_discount(self) -> bool:
        """Owners, Admins and Managers may apply discounts without approval."""
        return self.role in (self.Role.OWNER, self.Role.ADMIN, self.Role.MANAGER)

    @property
    def is_supervisor(self) -> bool:
        """True if this user can authorise a cashier's discount override."""
        return self.role in (self.Role.OWNER, self.Role.ADMIN, self.Role.MANAGER)

    @property
    def has_active_subscription(self):
        return self.subscriptions.filter(status=Subscription.Status.ACTIVE).exists()

    def suspend(self):
        """Suspend account + all active subscriptions.

        We intentionally KEEP ``is_active = True``. Suspension is enforced by
        ``status == 'suspended'`` plus SubscriptionMiddleware (which lets the
        tenant reach only the Pay Bill / billing endpoints). If we flipped
        ``is_active`` off, SimpleJWT's auth layer would reject every request
        with "User is inactive" — so the tenant couldn't even load their
        billing status or pay their bill to reopen the account.
        """
        self.status    = self.Status.SUSPENDED
        self.is_active = True
        self.save(update_fields=["status", "is_active"])
        self.subscriptions.filter(
            status=Subscription.Status.ACTIVE
        ).update(status=Subscription.Status.SUSPENDED)

    def activate(self):
        self.status    = self.Status.ACTIVE
        self.is_active = True
        self.save(update_fields=["status", "is_active"])


# ──────────────────────────────────────────────────────────────────────────────
# 2. Plan
# ──────────────────────────────────────────────────────────────────────────────

class Plan(models.Model):
    """Billing plan definition.

    Supports:
      • Trial plans  (is_trial=True, price=0, duration_days=14)
      • Tiered plans (Basic/Standard/Premium × monthly/yearly)
      • Custom plans (is_custom=True, base price + per_branch_fee)
    """

    class BillingCycle(models.TextChoices):
        MONTHLY = "monthly", "Monthly"
        YEARLY  = "yearly",  "Yearly"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name          = models.CharField(max_length=100, unique=True)
    code          = models.SlugField(
        max_length=64,
        unique=True,
        null=True,
        blank=True,
        help_text="Stable machine code (e.g. 'basic-monthly', 'standard-yearly').",
    )
    price         = models.DecimalField(max_digits=10, decimal_places=2)
    billing_cycle = models.CharField(
        max_length=10,
        choices=BillingCycle.choices,
        default=BillingCycle.MONTHLY,
        db_index=True,
    )
    duration_days = models.PositiveIntegerField(
        default=30,
        help_text="Days of access per billing cycle.",
    )
    description   = models.TextField(blank=True)
    is_active     = models.BooleanField(
        default=True,
        help_text="Inactive plans are hidden from new sign-ups.",
    )
    is_trial      = models.BooleanField(
        default=False,
        help_text="Free trial plan — no payment required, auto-suspends on expiry.",
    )
    is_custom     = models.BooleanField(
        default=False,
        help_text="Customisable multi-branch plan — price = base_price + per_branch_fee × (branches - 1).",
    )
    max_branches  = models.PositiveIntegerField(
        default=1,
        help_text="Maximum active business locations allowed. 0 = unlimited.",
    )
    max_sub_accounts = models.PositiveIntegerField(
        default=10,
        help_text="Maximum sub-accounts (extra users) per tenant. 0 = unlimited.",
    )
    per_branch_fee = models.DecimalField(
        max_digits=10, decimal_places=2, default=0,
        help_text="Monthly fee per branch beyond the first (custom plans only).",
    )
    features      = models.JSONField(
        default=list, blank=True,
        help_text="Bullet-list of features shown on the public plan card.",
    )
    sort_order    = models.PositiveIntegerField(
        default=100, db_index=True,
        help_text="Lower numbers appear first on the public plan page.",
    )

    # ── Subscription Plans Management (Super-Admin) extras ──────────────
    # `price` + `billing_cycle` remain the authoritative figure the billing
    # flow charges; these let an admin manage a single plan card carrying
    # BOTH a monthly and a yearly headline price plus richer limits.
    monthly_price  = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True,
        help_text="Headline monthly price (management view). Blank = use `price`.",
    )
    yearly_price   = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True,
        help_text="Headline yearly price (management view).",
    )
    yearly_discount_percent = models.PositiveSmallIntegerField(
        default=0,
        help_text="Discount %% advertised on the public pricing page for "
                  "yearly plans (0 = derive from the monthly price). The "
                  "admin sets this; the landing page updates on save.",
    )
    trial_days     = models.PositiveIntegerField(
        default=0, help_text="Free trial length in days (0 = no trial).",
    )
    max_products   = models.PositiveIntegerField(
        default=0, help_text="Max products allowed. 0 = unlimited.",
    )
    max_storage_mb = models.PositiveIntegerField(
        default=0, help_text="Storage cap in MB. 0 = unlimited.",
    )
    module_features = models.JSONField(
        default=dict, blank=True,
        help_text="Per-module access toggles: pos, inventory, accounting, "
                  "purchase, sales, reports, multi_branch, api_access.",
    )

    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "plans"
        ordering = ["sort_order", "price"]

    def __str__(self):
        return f"{self.name} (৳{self.price} / {self.billing_cycle})"

    @property
    def multi_branch_enabled(self) -> bool:
        return self.max_branches == 0 or self.max_branches > 1

    def compute_price(self, *, extra_branches: int = 0) -> "Decimal":
        """Return final price for this plan + optional extra branches (custom plans)."""
        from decimal import Decimal
        base = Decimal(str(self.price or 0))
        if not self.is_custom or extra_branches <= 0:
            return base
        per = Decimal(str(self.per_branch_fee or 0))
        # custom plans are sold per month — yearly cycle gets 20% off applied later
        addon = per * Decimal(extra_branches)
        if self.billing_cycle == self.BillingCycle.YEARLY:
            # base is already the (discounted) yearly price; addon needs same treatment
            return base + (addon * Decimal(12) * Decimal("0.80"))
        return base + addon


# ──────────────────────────────────────────────────────────────────────────────
# 3. Subscription
# ──────────────────────────────────────────────────────────────────────────────

class Subscription(models.Model):
    """
    Ties a User to a Plan for a billing period.
    At most one ACTIVE subscription per user (enforced by partial unique constraint).
    """

    class Status(models.TextChoices):
        ACTIVE    = "active",    "Active"
        SUSPENDED = "suspended", "Suspended"
        EXPIRED   = "expired",   "Expired"
        CANCELLED = "cancelled", "Cancelled"

    id                = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user              = models.ForeignKey(User, on_delete=models.CASCADE, related_name="subscriptions")
    plan              = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name="subscriptions")
    start_date        = models.DateField(default=timezone.localdate)
    next_billing_date = models.DateField()
    status            = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE, db_index=True
    )
    created_at        = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "subscriptions"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user"],
                condition=models.Q(status="active"),
                name="unique_active_subscription_per_user",
            )
        ]

    def __str__(self):
        return f"{self.user.email} → {self.plan.name} [{self.status}]"

    def save(self, *args, **kwargs):
        # Auto-compute next_billing_date if not yet set.
        if not self.next_billing_date:
            self.next_billing_date = self.start_date + timedelta(days=self.plan.duration_days)
        super().save(*args, **kwargs)

    @property
    def is_expired(self):
        return timezone.localdate() > self.next_billing_date

    def renew(self):
        """Extend by one billing cycle. Called after a successful renewal payment."""
        self.start_date        = timezone.localdate()
        self.next_billing_date = self.start_date + timedelta(days=self.plan.duration_days)
        self.status            = self.Status.ACTIVE
        self.save(update_fields=["start_date", "next_billing_date", "status"])
        return self

    def cancel(self):
        self.status = self.Status.CANCELLED
        self.save(update_fields=["status"])

    def suspend(self):
        self.status = self.Status.SUSPENDED
        self.save(update_fields=["status"])


# ──────────────────────────────────────────────────────────────────────────────
# 3b. Subscription audit trail — history + status logs
# ──────────────────────────────────────────────────────────────────────────────

class SubscriptionHistory(models.Model):
    """
    Immutable audit record of everything that happens to a subscription:
    plan changes (upgrade / downgrade), extensions, bonus days, billing-date
    changes, suspensions, reactivations, renewals, cancellations and payments.

    Written by the admin subscription service (and the billing/payment flow)
    so the Super-Admin Subscription Details page can render a full timeline.
    """

    class Action(models.TextChoices):
        CREATED              = "created",               "Created"
        PLAN_CHANGED         = "plan_changed",          "Plan changed"
        UPGRADED             = "upgraded",               "Upgraded"
        DOWNGRADED           = "downgraded",             "Downgraded"
        EXTENDED             = "extended",               "Extended"
        BONUS_DAYS           = "bonus_days",             "Bonus days added"
        BILLING_DATE_CHANGED = "billing_date_changed",   "Billing date changed"
        SUSPENDED            = "suspended",              "Suspended"
        REACTIVATED          = "reactivated",            "Reactivated"
        RENEWED              = "renewed",                "Renewed"
        CANCELLED            = "cancelled",              "Cancelled"
        PAYMENT              = "payment",                "Payment"

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    subscription = models.ForeignKey(
        Subscription, on_delete=models.CASCADE, related_name="history",
    )
    user         = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="subscription_history",
        help_text="Denormalised subscriber for fast lookup / filtering.",
    )
    action       = models.CharField(max_length=32, choices=Action.choices, db_index=True)

    from_plan    = models.ForeignKey(
        Plan, on_delete=models.SET_NULL, null=True, blank=True, related_name="+",
    )
    to_plan      = models.ForeignKey(
        Plan, on_delete=models.SET_NULL, null=True, blank=True, related_name="+",
    )
    previous_billing_date = models.DateField(null=True, blank=True)
    new_billing_date      = models.DateField(null=True, blank=True)
    days_delta   = models.IntegerField(
        null=True, blank=True,
        help_text="Days added (extensions / bonus) or removed.",
    )
    amount       = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True,
        help_text="Money involved, when relevant (payments / renewals).",
    )
    note         = models.TextField(blank=True, default="")
    metadata     = models.JSONField(default=dict, blank=True)

    # Audit fields — who did it (admin user id from the master DB) + when.
    performed_by       = models.UUIDField(null=True, blank=True)
    performed_by_email = models.CharField(max_length=255, blank=True, default="")
    created_at         = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "subscription_history"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["subscription", "-created_at"], name="subhist_sub_created_idx"),
            models.Index(fields=["user", "-created_at"], name="subhist_user_created_idx"),
            models.Index(fields=["action"], name="subhist_action_idx"),
        ]

    def __str__(self):
        return f"{self.subscription_id} · {self.action} · {self.created_at:%Y-%m-%d}"


class SubscriptionStatusLog(models.Model):
    """
    Append-only log of every subscription STATUS transition
    (active → suspended → active → cancelled, etc.). Powers the
    "Suspension History" / status section of the details page and lets the
    platform audit exactly when and why a tenant was locked or restored.
    """

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    subscription = models.ForeignKey(
        Subscription, on_delete=models.CASCADE, related_name="status_logs",
    )
    user         = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="subscription_status_logs",
    )
    from_status  = models.CharField(max_length=20, blank=True, default="")
    to_status    = models.CharField(max_length=20, db_index=True)
    reason       = models.TextField(blank=True, default="")

    performed_by       = models.UUIDField(null=True, blank=True)
    performed_by_email = models.CharField(max_length=255, blank=True, default="")
    created_at         = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "subscription_status_logs"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["subscription", "-created_at"], name="substatus_sub_created_idx"),
            models.Index(fields=["to_status"], name="substatus_to_status_idx"),
        ]

    def __str__(self):
        return f"{self.subscription_id} · {self.from_status}→{self.to_status}"


# ──────────────────────────────────────────────────────────────────────────────
# 4. Payment
# ──────────────────────────────────────────────────────────────────────────────

class Payment(models.Model):
    """
    One payment transaction.
    Created as PENDING before the gateway call; updated to SUCCESS/FAILED
    via the webhook handler.
    The `metadata` JSON carries buyer info (name, email, phone, business_name,
    plan_id) from /subscribe so the webhook can provision the user account.
    """

    class Status(models.TextChoices):
        PENDING  = "pending",  "Pending"
        SUCCESS  = "success",  "Success"
        FAILED   = "failed",   "Failed"
        REFUNDED = "refunded", "Refunded"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user           = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="payments",
        null=True,
        blank=True,
        help_text="NULL until the webhook creates the user after successful payment.",
    )
    subscription   = models.ForeignKey(
        Subscription,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payments",
    )
    amount         = models.DecimalField(max_digits=10, decimal_places=2)
    status         = models.CharField(
        max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    transaction_id = models.CharField(
        max_length=255,
        unique=True,
        null=True,
        blank=True,
        help_text="Merchant order ID sent to the gateway; unique once assigned.",
    )
    paid_at        = models.DateTimeField(null=True, blank=True)
    gateway        = models.CharField(
        max_length=50, blank=True, default="",
        help_text="Payment gateway that processed the transaction (e.g. SSLCommerz, bKash).",
    )
    method         = models.CharField(
        max_length=50, blank=True, default="",
        help_text="Payment method/channel (e.g. card, mobile banking, bank transfer).",
    )
    refund_amount  = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True,
        help_text="Amount refunded when status is REFUNDED.",
    )
    refunded_at    = models.DateTimeField(null=True, blank=True)
    metadata       = models.JSONField(
        default=dict,
        blank=True,
        help_text="Buyer info stashed at subscribe time: name, email, phone, plan_id …",
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payments"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Payment {str(self.id)[:8]} — ${self.amount} [{self.status}]"

    def mark_success(self, transaction_id: str):
        """Called by the webhook handler after gateway confirmation."""
        self.status         = self.Status.SUCCESS
        self.transaction_id = transaction_id
        self.paid_at        = timezone.now()
        self.save(update_fields=["status", "transaction_id", "paid_at"])
        if self.subscription:
            self.subscription.renew()

    def mark_failed(self):
        self.status = self.Status.FAILED
        self.save(update_fields=["status"])


# ──────────────────────────────────────────────────────────────────────────────
# 5. Password Setup Token
# ──────────────────────────────────────────────────────────────────────────────

class PasswordSetupToken(models.Model):
    """
    One-time, 15-minute token emailed to new users so they can set a password
    without knowing any credentials yet.

    Lifecycle:
        1. System creates user (no password) + issues token.
        2. Token is emailed as: /set-password?token=<token>
        3. User clicks link → POST /api/set-password/ { token, new_password }.
        4. Token is deleted immediately — single use.
    """

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user       = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="password_setup_token",
        help_text="One pending token per user — replaced when re-issued.",
    )
    token      = models.CharField(
        max_length=64,
        unique=True,
        db_index=True,
        default=secrets.token_urlsafe,
    )
    expires_at = models.DateTimeField(default=_token_expiry)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "password_setup_tokens"

    def __str__(self):
        return f"Token for {self.user.email} (expires {self.expires_at:%Y-%m-%d %H:%M} UTC)"

    @property
    def is_valid(self):
        return timezone.now() < self.expires_at

    @classmethod
    def issue(cls, user):
        """Create (or replace) a setup token — always resets the 15-min clock."""
        cls.objects.filter(user=user).delete()
        return cls.objects.create(user=user)

    def consume(self, new_password: str):
        """
        Set the user's password and destroy this token.
        Raises ValueError if expired.
        """
        if not self.is_valid:
            raise ValueError("This setup link has expired. Please request a new one.")
        self.user.set_password(new_password)
        self.user.is_first_login = False
        self.user.save(update_fields=["password", "is_first_login"])
        self.delete()


# ──────────────────────────────────────────────────────────────────────────────
# 5b. Login OTP — short numeric code sent by SMS for first-time login
# ──────────────────────────────────────────────────────────────────────────────


def _otp_expiry():
    """10 minutes from now — default for LoginOtp.expires_at."""
    return timezone.now() + timedelta(minutes=10)


def _generate_otp_code() -> str:
    """6-digit zero-padded numeric code, cryptographically secure."""
    return f"{secrets.randbelow(10**6):06d}"


class LoginOtp(models.Model):
    """
    One-time SMS code used for the first login after payment / trial signup.

    Lifecycle:
        1. After payment succeeds (or a trial is created), the service layer
           generates a 6-digit OTP, saves a row here, and dispatches it to
           the user's phone via the SMS provider.
        2. The user enters their username + OTP on /login-otp.
        3. The view validates the code, marks the row consumed, and issues a
           single-use PasswordSetupToken so the user can set their password.
        4. After the password is set, an SMS confirmation goes out.

    The same row supports up to MAX_ATTEMPTS bad guesses before it is
    invalidated (forces a 'resend OTP').
    """

    MAX_ATTEMPTS = 5

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user        = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="login_otps",
    )
    code        = models.CharField(max_length=6, db_index=True, default=_generate_otp_code)
    attempts    = models.PositiveSmallIntegerField(default=0)
    expires_at  = models.DateTimeField(default=_otp_expiry, db_index=True)
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "login_otps"
        ordering = ["-created_at"]

    def __str__(self):
        state = "consumed" if self.consumed_at else (
            "expired" if self.is_expired else "active"
        )
        return f"OTP for {self.user.email} [{state}]"

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    @property
    def is_consumed(self) -> bool:
        return self.consumed_at is not None

    @property
    def is_valid(self) -> bool:
        return not self.is_consumed and not self.is_expired and self.attempts < self.MAX_ATTEMPTS

    @classmethod
    def issue(cls, user) -> "LoginOtp":
        """Invalidate any prior unconsumed OTPs and create a fresh one."""
        cls.objects.filter(user=user, consumed_at__isnull=True).update(
            consumed_at=timezone.now()
        )
        return cls.objects.create(user=user)

    def verify(self, code: str) -> bool:
        """
        Verify a user-supplied code against this row.
        Increments `attempts` on a miss and marks consumed on a hit.
        Returns True on success.
        """
        if not self.is_valid:
            return False
        if str(code).strip() != self.code:
            self.attempts += 1
            self.save(update_fields=["attempts"])
            return False
        self.consumed_at = timezone.now()
        self.save(update_fields=["consumed_at"])
        return True


# ──────────────────────────────────────────────────────────────────────────────
# 5c. Referral + DiscountCredit — phone-based referrer reward programme
#
#   Flow:
#     1. New signup includes optional `referral_phone`. Service layer looks up
#        the matching tenant; creates a Referral row tying (referrer ⇒ referred).
#     2. For paid signups, the reward fires when the payment lands SUCCESS.
#        For trial signups, awarded_at stays NULL until the trial user pays
#        for a real plan (caught by either the payment webhook or by the
#        daily safety-net task accounts.tasks.award_pending_referrals).
#     3. Awarding = creating a DiscountCredit row for the referrer.
#     4. The next renewal payment created for that user consumes the oldest
#        unapplied credit and applies the 20% off — see
#        accounts.referrals.apply_pending_discount().
# ──────────────────────────────────────────────────────────────────────────────


class Referral(models.Model):
    """
    Records who referred a new tenant. One Referral per referred user.
    `awarded_at` is set when the referrer's DiscountCredit is issued.
    """
    id        = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    referrer  = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name="referrals_made",
        help_text="The existing tenant whose phone the new tenant entered.",
    )
    referred  = models.OneToOneField(
        User, on_delete=models.CASCADE,
        related_name="referral_source",
        help_text="The new tenant who entered the referral phone.",
    )
    referrer_phone_snapshot = models.CharField(
        max_length=30, blank=True,
        help_text="The exact phone value entered at signup, for audit.",
    )
    plan_at_signup = models.ForeignKey(
        "Plan", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="The plan the referred user signed up under (Trial vs paid).",
    )
    awarded_at  = models.DateTimeField(
        null=True, blank=True, db_index=True,
        help_text="When the reward was issued (None until referred user pays).",
    )
    triggering_payment = models.ForeignKey(
        "Payment", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="referral_awards",
        help_text="The first non-trial successful payment that triggered the reward.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "referrals"
        ordering = ["-created_at"]

    def __str__(self):
        state = "awarded" if self.awarded_at else "pending"
        return f"Referral({self.referrer.email} → {self.referred.email}) [{state}]"


class DiscountCredit(models.Model):
    """
    A pending percent-off discount owed to a tenant. Consumed FIFO by the
    next renewal payment that's created for them.
    """
    DEFAULT_PERCENT = Decimal("20.00")

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user       = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="discount_credits",
    )
    referral   = models.ForeignKey(
        Referral, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="discount_credits",
        help_text="The referral that generated this credit, if any.",
    )
    percent    = models.DecimalField(
        max_digits=5, decimal_places=2, default=DEFAULT_PERCENT,
        help_text="Percent off — 20.00 means 20%.",
    )
    earned_at  = models.DateTimeField(auto_now_add=True, db_index=True)
    applied_at = models.DateTimeField(null=True, blank=True, db_index=True)
    applied_payment = models.ForeignKey(
        "Payment", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="discount_credits_consumed",
    )
    notes      = models.TextField(blank=True)

    class Meta:
        db_table = "discount_credits"
        ordering = ["earned_at"]   # FIFO by default

    def __str__(self):
        state = "applied" if self.applied_at else "pending"
        return f"DiscountCredit({self.user.email} {self.percent}%) [{state}]"

    @property
    def is_pending(self) -> bool:
        return self.applied_at is None


# ──────────────────────────────────────────────────────────────────────────────
# 6. Tenant
# ──────────────────────────────────────────────────────────────────────────────

class Tenant(models.Model):
    """
    Master-DB record that maps a User to their dedicated PostgreSQL database.

    Lifecycle:
        1. Created synchronously (is_provisioned=False) inside the payment
           webhook's atomic transaction — immediately after the User is created.
        2. A Celery task (provision_tenant_db_task) then:
              a. Creates the physical PostgreSQL database.
              b. Registers the alias in settings.DATABASES.
              c. Runs tenant-app migrations.
              d. Sets is_provisioned=True + provisioned_at.

    The TenantMiddleware reads this record on every authenticated request
    to resolve the correct DB alias for the TenantDatabaseRouter.
    """

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user           = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="tenant",
        help_text="One tenant record per user.",
    )
    db_name        = models.CharField(
        max_length=128,
        unique=True,
        help_text="Physical PostgreSQL database name, e.g. 'saas_tenant_e2c4eb3406d7'.",
    )
    db_alias       = models.CharField(
        max_length=128,
        unique=True,
        help_text="Django DATABASES key, e.g. 'tenant_e2c4eb3406d7'.",
    )
    is_provisioned = models.BooleanField(
        default=False,
        db_index=True,
        help_text="True once the physical DB is created and migrations are applied.",
    )
    provisioned_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Timestamp when provisioning completed.",
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tenants"
        ordering = ["-created_at"]

    def __str__(self):
        state = "ready" if self.is_provisioned else "pending"
        return f"Tenant({self.user.email} → {self.db_name} [{state}])"

    @property
    def is_ready(self) -> bool:
        """Convenience alias for is_provisioned."""
        return self.is_provisioned


# ──────────────────────────────────────────────────────────────────────────────
# 6b. TenantRole  (custom role catalog per tenant — master database)
# ──────────────────────────────────────────────────────────────────────────────

class TenantRole(models.Model):
    """
    A custom role label a tenant defines beyond the built-in
    Admin / Manager / Cashier set. Stored on the master DB and scoped to
    the tenant owner so each company owns its own catalog.

    The built-in roles are rendered virtually in the API response — they
    have no rows here and cannot be edited or deleted.
    """

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner       = models.ForeignKey(
        "User",
        on_delete=models.CASCADE,
        related_name="tenant_roles",
        help_text="Tenant owner this custom role belongs to.",
    )
    name        = models.CharField(
        max_length=80,
        help_text="Display name (e.g. 'Sub Company', 'Stock Auditor').",
    )
    description = models.TextField(blank=True, default="")
    # Granular permission codes this role grants. Stored as a JSON list of
    # strings like ["user.view", "sell.add", …] using the catalog rendered
    # on the Add Role / Edit Role UI. Built-in roles (Admin / Manager /
    # Cashier) ignore this and resolve via accounts.permissions.
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
# 7. Permission  (RBAC — master database)
# ──────────────────────────────────────────────────────────────────────────────

class Permission(models.Model):
    """
    Granular permission code stored in the master database.

    Seeded by migration 0005_seed_rbac.py from accounts.permissions.Perm.
    Allows future runtime overrides without code changes.
    """

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code        = models.CharField(
        max_length=100,
        unique=True,
        help_text="Machine-readable code matching a Perm.* constant.",
    )
    name        = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "rbac_permissions"
        ordering = ["code"]

    def __str__(self):
        return self.code


# ──────────────────────────────────────────────────────────────────────────────
# 8. RolePermission  (RBAC — master database)
# ──────────────────────────────────────────────────────────────────────────────

class RolePermission(models.Model):
    """
    Maps a role code (matching User.Role choices) to a Permission.

    The in-memory defaults in accounts.permissions._ROLE_PERMISSIONS are the
    fast path for runtime checks.  These DB rows exist so the assignment can be
    inspected, overridden, or extended via admin / API without redeploying.
    """

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role_code  = models.CharField(
        max_length=20,
        choices=User.Role.choices,
        db_index=True,
        help_text="Role code — must match one of User.Role choice values.",
    )
    permission = models.ForeignKey(
        Permission,
        on_delete=models.CASCADE,
        related_name="role_permissions",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table        = "rbac_role_permissions"
        unique_together = [("role_code", "permission")]
        ordering        = ["role_code", "permission__code"]

    def __str__(self):
        return f"{self.role_code} → {self.permission.code}"


# ──────────────────────────────────────────────────────────────────────────────
# Platform-wide Notice Board
# ──────────────────────────────────────────────────────────────────────────────

class PlatformNotice(models.Model):
    """A notice broadcast to every tenant — downtime warnings, maintenance
    updates, product announcements.

    Lives on the master DB (NOT in tenant DBs) so the platform admin posts
    once and every tenant's dashboard sees it. Visibility is gated by
    is_active + published_at <= now + (expires_at IS NULL OR expires_at > now).
    """

    class Kind(models.TextChoices):
        INFO        = "info",        "Info"
        WARNING     = "warning",     "Warning"
        CRITICAL    = "critical",    "Critical"
        MAINTENANCE = "maintenance", "Maintenance"

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title        = models.CharField(max_length=200)
    body         = models.TextField(help_text="Markdown / plain text. Shown verbatim in the tenant dashboard.")
    kind         = models.CharField(
        max_length=15, choices=Kind.choices, default=Kind.INFO, db_index=True,
        help_text="Determines the colour of the notice card on the dashboard.",
    )
    is_active    = models.BooleanField(default=True, db_index=True,
                                       help_text="Inactive notices are hidden everywhere.")
    is_marquee   = models.BooleanField(
        default=False, db_index=True,
        help_text="Render as a right-to-left scrolling marquee on every tenant "
                  "page. Only the newest is_marquee=True notice is shown.",
    )
    marquee_speed = models.PositiveSmallIntegerField(
        default=40,
        help_text="Marquee scroll duration in seconds (lower = faster). 40 is a "
                  "comfortable reading pace; 20 is fast, 80 is slow.",
    )
    published_at = models.DateTimeField(default=timezone.now, db_index=True,
                                        help_text="Notice becomes visible from this moment.")
    expires_at   = models.DateTimeField(null=True, blank=True, db_index=True,
                                        help_text="Hidden after this moment. Blank = no expiry.")
    target_user_ids = models.JSONField(
        default=list, blank=True,
        help_text="Tenant owner user-IDs this notice is for. EMPTY = broadcast "
                  "to every tenant; non-empty = only those tenants (and their "
                  "sub-users) see it. Used to send e.g. a referral-reward notice "
                  "to just the tenants who earned it.",
    )
    created_by   = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="platform_notices",
        help_text="Staff user who posted this notice.",
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "platform_notices"
        ordering = ["-published_at"]

    def __str__(self):
        return f"[{self.kind}] {self.title}"

    @property
    def is_visible_now(self) -> bool:
        """Whether this notice should appear on tenant dashboards RIGHT NOW."""
        now = timezone.now()
        if not self.is_active:
            return False
        if self.published_at and self.published_at > now:
            return False
        if self.expires_at and self.expires_at <= now:
            return False
        return True


class PlatformConfig(models.Model):
    """Key-value platform settings the admin edits from the admin panel.

    Lives on the MASTER DB so one update propagates to every tenant
    instantly (the tenant-facing endpoints read these keys live).
    First use-case: the Support card on the tenant dashboard
    (support.email / support.phone / support.office_address /
    support.hours).
    """

    key        = models.CharField(max_length=100, unique=True)
    value      = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "platform_config"

    def __str__(self):
        return f"{self.key} = {self.value[:40]}"


class PaymentGatewayConfig(models.Model):
    """Per-gateway configuration the platform admin manages from the Payment
    Gateway Settings page. Master DB (one config per gateway, platform-wide).

    Credentials live in `credentials` (JSON) — store_id / store_password for
    SSLCommerz, secret/publishable keys for Stripe, client_id/secret for PayPal.
    """

    class Code(models.TextChoices):
        SSLCOMMERZ = "sslcommerz", "SSLCommerz"
        STRIPE     = "stripe",     "Stripe"
        PAYPAL     = "paypal",     "PayPal"

    class Status(models.TextChoices):
        NOT_CONFIGURED = "not_configured", "Not configured"
        CONNECTED      = "connected",      "Connected"
        ERROR          = "error",          "Error"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code          = models.CharField(max_length=30, choices=Code.choices, unique=True, db_index=True)
    name          = models.CharField(max_length=80, blank=True, default="")
    is_enabled    = models.BooleanField(default=False)
    is_test_mode  = models.BooleanField(default=True)
    credentials   = models.JSONField(default=dict, blank=True)
    status        = models.CharField(max_length=20, choices=Status.choices, default=Status.NOT_CONFIGURED)
    last_tested_at = models.DateTimeField(null=True, blank=True)
    updated_at    = models.DateTimeField(auto_now=True)
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment_gateway_config"
        ordering = ["code"]

    def __str__(self):
        return f"{self.get_code_display()} ({'on' if self.is_enabled else 'off'})"


class SupportTicket(models.Model):
    """A support ticket raised by a tenant. Master DB so platform admins /
    support agents see tickets across every tenant."""

    class Category(models.TextChoices):
        BILLING       = "billing",       "Billing"
        SUBSCRIPTION  = "subscription",  "Subscription"
        POS           = "pos",           "POS"
        INVENTORY     = "inventory",     "Inventory"
        ACCOUNTING    = "accounting",    "Accounting"
        TECHNICAL     = "technical",     "Technical Issue"
        FEATURE       = "feature",       "Feature Request"
        GENERAL       = "general",       "General Inquiry"

    class Priority(models.TextChoices):
        LOW    = "low",    "Low"
        MEDIUM = "medium", "Medium"
        HIGH   = "high",   "High"
        URGENT = "urgent", "Urgent"

    class Status(models.TextChoices):
        OPEN        = "open",        "Open"
        PENDING     = "pending",     "Pending"
        IN_PROGRESS = "in_progress", "In Progress"
        RESOLVED    = "resolved",    "Resolved"
        CLOSED      = "closed",      "Closed"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ticket_number  = models.CharField(max_length=20, unique=True, db_index=True)
    user           = models.ForeignKey(User, on_delete=models.CASCADE, related_name="support_tickets")
    subject        = models.CharField(max_length=200)
    category       = models.CharField(max_length=20, choices=Category.choices, default=Category.GENERAL)
    priority       = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM, db_index=True)
    status         = models.CharField(max_length=15, choices=Status.choices, default=Status.OPEN, db_index=True)
    assigned_to    = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="assigned_tickets")
    merged_into    = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="merged_tickets")
    satisfaction   = models.PositiveSmallIntegerField(null=True, blank=True, help_text="CSAT rating 1-5 set when the tenant closes the ticket.")
    first_response_at = models.DateTimeField(null=True, blank=True)
    resolved_at    = models.DateTimeField(null=True, blank=True)
    closed_at      = models.DateTimeField(null=True, blank=True)
    last_activity_at = models.DateTimeField(auto_now_add=True, db_index=True)
    admin_unread   = models.BooleanField(default=True)   # unseen tenant activity for admins
    tenant_unread  = models.BooleanField(default=False)  # unseen admin activity for the tenant
    created_at     = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "support_tickets"
        ordering = ["-last_activity_at"]

    def __str__(self):
        return f"{self.ticket_number} — {self.subject[:40]}"


class SupportTicketMessage(models.Model):
    """One message in a ticket thread. `is_internal` notes are admin-only."""
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ticket      = models.ForeignKey(SupportTicket, on_delete=models.CASCADE, related_name="messages")
    author      = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="support_messages")
    author_role = models.CharField(max_length=10, default="tenant")  # tenant | admin
    body        = models.TextField(blank=True, default="")
    is_internal = models.BooleanField(default=False)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "support_ticket_messages"
        ordering = ["created_at"]


class SupportTicketAttachment(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ticket      = models.ForeignKey(SupportTicket, on_delete=models.CASCADE, related_name="attachments")
    message     = models.ForeignKey(SupportTicketMessage, on_delete=models.CASCADE, null=True, blank=True, related_name="attachments")
    file        = models.FileField(upload_to="support/%Y/%m/")
    name        = models.CharField(max_length=255, blank=True, default="")
    uploaded_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "support_ticket_attachments"
        ordering = ["created_at"]


class SupportTicketEvent(models.Model):
    """Activity/audit timeline: created, status/priority change, assignment,
    reply, note, close, reopen, merge."""
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ticket        = models.ForeignKey(SupportTicket, on_delete=models.CASCADE, related_name="events")
    action        = models.CharField(max_length=20, db_index=True)
    from_value    = models.CharField(max_length=60, blank=True, default="")
    to_value      = models.CharField(max_length=60, blank=True, default="")
    note          = models.CharField(max_length=300, blank=True, default="")
    actor         = models.UUIDField(null=True, blank=True)
    actor_email   = models.CharField(max_length=254, blank=True, default="")
    actor_role    = models.CharField(max_length=10, blank=True, default="")
    created_at    = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "support_ticket_events"
        ordering = ["created_at"]


class PaymentAuditLog(models.Model):
    """Audit trail for payment-management actions: verification, status
    changes, refunds, and gateway-configuration changes. Master DB.
    """

    class Action(models.TextChoices):
        VERIFY         = "verify",         "Payment verified"
        RETRY          = "retry",          "Verification retried"
        MARK_PAID      = "mark_paid",      "Marked as paid"
        MARK_FAILED    = "mark_failed",    "Marked as failed"
        REFUND         = "refund",         "Refund issued"
        GATEWAY_CONFIG = "gateway_config", "Gateway configuration changed"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payment       = models.ForeignKey(
        "Payment", on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs",
    )
    action        = models.CharField(max_length=30, choices=Action.choices, db_index=True)
    from_status   = models.CharField(max_length=20, blank=True, default="")
    to_status     = models.CharField(max_length=20, blank=True, default="")
    gateway_code  = models.CharField(max_length=30, blank=True, default="")
    note          = models.TextField(blank=True, default="")
    metadata      = models.JSONField(default=dict, blank=True)
    performed_by  = models.UUIDField(null=True, blank=True)
    performed_by_email = models.CharField(max_length=254, blank=True, default="")
    created_at    = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "payment_audit_log"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.action} @ {self.created_at:%Y-%m-%d %H:%M}"


class Coupon(models.Model):
    """A discount coupon managed by the platform admin (master DB)."""

    class Type(models.TextChoices):
        PERCENTAGE      = "percentage",      "Percentage Discount"
        FIXED           = "fixed",           "Fixed Amount Discount"
        FREE_TRIAL      = "free_trial",      "Free Trial Extension"
        FIRST_TIME      = "first_time",      "First-Time Customer Discount"
        RENEWAL         = "renewal",         "Renewal Discount"
        PROMOTIONAL     = "promotional",     "Promotional Discount"

    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code            = models.CharField(max_length=40, unique=True, db_index=True)
    name            = models.CharField(max_length=120)
    description     = models.TextField(blank=True, default="")
    discount_type   = models.CharField(max_length=20, choices=Type.choices, default=Type.PERCENTAGE)
    discount_value  = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    free_trial_days = models.PositiveIntegerField(default=0, help_text="Days added for FREE_TRIAL coupons.")
    max_usage_limit   = models.PositiveIntegerField(null=True, blank=True, help_text="Total redemptions allowed; blank = unlimited.")
    per_tenant_limit  = models.PositiveIntegerField(null=True, blank=True, help_text="Redemptions per tenant; blank = unlimited.")
    min_purchase_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    applicable_plans  = models.ManyToManyField(Plan, blank=True, related_name="coupons", help_text="Empty = all plans.")
    start_date      = models.DateField(null=True, blank=True)
    end_date        = models.DateField(null=True, blank=True)
    is_active       = models.BooleanField(default=True)
    created_by      = models.UUIDField(null=True, blank=True)
    created_at      = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "coupons"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.code} ({self.discount_type})"

    @property
    def is_percentage(self) -> bool:
        return self.discount_type in (self.Type.PERCENTAGE, self.Type.FIRST_TIME,
                                      self.Type.RENEWAL, self.Type.PROMOTIONAL)


class CouponRedemption(models.Model):
    """One use of a coupon — drives usage counts + revenue/conversion analytics."""
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    coupon        = models.ForeignKey(Coupon, on_delete=models.CASCADE, related_name="redemptions")
    user          = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="coupon_redemptions")
    payment       = models.ForeignKey("Payment", on_delete=models.SET_NULL, null=True, blank=True, related_name="coupon_redemptions")
    subscription  = models.ForeignKey("Subscription", on_delete=models.SET_NULL, null=True, blank=True, related_name="coupon_redemptions")
    amount_discounted = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    gross_amount  = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    is_new_subscription = models.BooleanField(default=True)
    created_at    = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "coupon_redemptions"
        ordering = ["-created_at"]


class PromotionCampaign(models.Model):
    """A scheduled campaign bundling one or more coupons at a tenant segment."""

    class Target(models.TextChoices):
        ALL        = "all",        "All Tenants"
        TRIAL      = "trial",      "Trial Tenants"
        ACTIVE     = "active",     "Active Tenants"
        EXPIRING   = "expiring",   "Expiring Tenants"
        SUSPENDED  = "suspended",  "Suspended Tenants"
        PLANS      = "plans",      "Specific Plans"

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name         = models.CharField(max_length=120)
    description  = models.TextField(blank=True, default="")
    coupons      = models.ManyToManyField(Coupon, blank=True, related_name="campaigns")
    target       = models.CharField(max_length=20, choices=Target.choices, default=Target.ALL)
    target_plans = models.ManyToManyField(Plan, blank=True, related_name="campaigns")
    start_date   = models.DateField(null=True, blank=True)
    end_date     = models.DateField(null=True, blank=True)
    is_active    = models.BooleanField(default=True)
    created_by   = models.UUIDField(null=True, blank=True)
    created_at   = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "promotion_campaigns"
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


class CouponAuditLog(models.Model):
    """Audit trail for coupon + campaign activity."""
    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    coupon       = models.ForeignKey(Coupon, on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs")
    campaign     = models.ForeignKey(PromotionCampaign, on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs")
    action       = models.CharField(max_length=24, db_index=True)
    note         = models.CharField(max_length=300, blank=True, default="")
    metadata     = models.JSONField(default=dict, blank=True)
    actor        = models.UUIDField(null=True, blank=True)
    actor_email  = models.CharField(max_length=254, blank=True, default="")
    created_at   = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "coupon_audit_log"
        ordering = ["-created_at"]


# ──────────────────────────────────────────────────────────────────────────────
# Website CMS — manage public marketing-site content from the admin portal
# ──────────────────────────────────────────────────────────────────────────────

class CmsBlock(models.Model):
    """A singleton content section keyed by `key` (hero, stats, contact,
    pricing_intro, seo.home, seo.services …). `content` is a free-form JSON
    blob whose shape depends on the block — flexible enough for any section
    without a migration per field."""

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key          = models.CharField(max_length=60, unique=True, db_index=True)
    content      = models.JSONField(default=dict, blank=True)
    is_published = models.BooleanField(default=True)
    sort_order   = models.PositiveIntegerField(default=0)
    updated_by   = models.CharField(max_length=254, blank=True, default="")
    updated_at   = models.DateTimeField(auto_now=True)
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "cms_blocks"
        ordering = ["sort_order", "key"]

    def __str__(self):
        return self.key


class CmsItem(models.Model):
    """A repeatable content entry inside a collection: features, testimonials,
    faq, services, products. `data` holds all the fields as JSON so each
    collection can carry its own shape."""

    class Collection(models.TextChoices):
        FEATURE     = "features",     "Features"
        TESTIMONIAL = "testimonials", "Testimonials"
        FAQ         = "faq",          "FAQ"
        SERVICE     = "services",     "Services"
        PRODUCT     = "products",     "Products"
        STAT        = "stats",        "Statistics"

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    collection   = models.CharField(max_length=20, choices=Collection.choices, db_index=True)
    slug         = models.CharField(max_length=120, blank=True, default="", db_index=True)
    data         = models.JSONField(default=dict, blank=True)
    sort_order   = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)
    created_at   = models.DateTimeField(auto_now_add=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "cms_items"
        ordering = ["collection", "sort_order", "created_at"]
        indexes = [models.Index(fields=["collection", "slug"])]

    def __str__(self):
        return f"{self.collection}:{self.slug or str(self.id)[:8]}"


class CmsMedia(models.Model):
    """Centralised media library — uploaded images reusable across the CMS."""
    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file         = models.FileField(upload_to="cms/%Y/%m/")
    name         = models.CharField(max_length=255, blank=True, default="")
    folder       = models.CharField(max_length=120, blank=True, default="", db_index=True)
    content_type = models.CharField(max_length=100, blank=True, default="")
    size         = models.PositiveIntegerField(default=0)
    uploaded_by  = models.CharField(max_length=254, blank=True, default="")
    created_at   = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "cms_media"
        ordering = ["-created_at"]

    def __str__(self):
        return self.name or (self.file.name if self.file else str(self.id))


class CmsAuditLog(models.Model):
    """Audit trail for CMS content / publish / delete / media actions."""
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    action      = models.CharField(max_length=24, db_index=True)   # update | publish | unpublish | delete | upload | reorder
    target      = models.CharField(max_length=120, blank=True, default="")  # block:hero / item:services:<id> / media:<id>
    note        = models.CharField(max_length=300, blank=True, default="")
    metadata    = models.JSONField(default=dict, blank=True)
    actor       = models.UUIDField(null=True, blank=True)
    actor_email = models.CharField(max_length=254, blank=True, default="")
    created_at  = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "cms_audit_log"
        ordering = ["-created_at"]


class UserBranch(models.Model):
    """Branch membership for multi-branch data isolation (master DB).

    Branches are Locations that live in each tenant's own DB, so we store the
    branch as a soft UUID reference (`branch_id`) plus a denormalised name —
    the same pattern as User.branch_id. A row grants `user` access to that
    branch.

    Access model:
      • Tenant OWNER (User.parent_owner_id is NULL) implicitly has EVERY
        branch of the tenant and the consolidated/all-branches view — no rows
        are required for them.
      • Staff (sub-users) only see branches they have a UserBranch row for.
        `can_manage` marks a branch-level manager (broader permissions within
        that branch); plain members get operational access only.
    """
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user        = models.ForeignKey(
        "User", on_delete=models.CASCADE, related_name="branch_memberships",
    )
    branch_id   = models.UUIDField(db_index=True)            # soft ref → tenant Location
    branch_name = models.CharField(max_length=200, blank=True, default="")
    can_manage  = models.BooleanField(
        default=False,
        help_text="Branch-level manager — broader permissions within this branch.",
    )
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "user_branches"
        unique_together = [("user", "branch_id")]

    def __str__(self):
        return f"{self.user_id} → {self.branch_name or self.branch_id}"


class SecurityEvent(models.Model):
    """Immutable master-DB log of platform-level security events.

    The tenant-scoped `audit.AuditLog` records business CRUD inside each tenant
    DB; this table captures the cross-tenant, master-level events SOC2 cares
    about — who logged in (and who failed), who logged out, password
    set/reset, platform-admin actions on tenants, and credential changes.
    Rows are append-only (no update/delete API). Write via
    `record_security_event()`, which never raises into the request path.
    """

    class Event(models.TextChoices):
        LOGIN_SUCCESS   = "login_success",   "Login success"
        LOGIN_FAILURE   = "login_failure",   "Login failure"
        LOGOUT          = "logout",          "Logout"
        PASSWORD_SET    = "password_set",    "Password set/reset"
        TENANT_DELETE   = "tenant_delete",   "Tenant deleted"
        SMS_CONFIG      = "sms_config",      "SMS credentials changed"
        ADMIN_ACTION    = "admin_action",    "Platform-admin action"

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event       = models.CharField(max_length=24, choices=Event.choices, db_index=True)
    # Who performed it (master User UUID + a snapshot of their email/identifier).
    actor_id    = models.UUIDField(null=True, blank=True, db_index=True)
    actor_email = models.CharField(max_length=254, blank=True, default="")
    # What it acted on (e.g. the deleted tenant's email, or the SMS key).
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
