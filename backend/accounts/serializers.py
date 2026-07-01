"""
DRF serializers — all API inputs and outputs.
"""
import re
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import Plan, Payment, PasswordSetupToken
from .permissions import get_user_permissions


# ──────────────────────────────────────────────────────────────────────────────
# Shared validators — used by both Subscribe and Trial signup
# ──────────────────────────────────────────────────────────────────────────────

# BD mobile: 11 digits, must start with 01. Frontend pins a visual "+88 "
# prefix; we store and validate just the 11-digit national form.
_BD_PHONE_RE = re.compile(r"^01[0-9]{9}$")

# Personal names: letters + spaces + a handful of common punctuation
# (apostrophe for "O'Brien", hyphen for "Mary-Anne", period for initials).
# No digits, no @/# etc.
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z\s\.\-']{0,148}[A-Za-z\.]$")

# Business names: same as personal name + ampersand and comma which show
# up in real company names ("A & B Trading, Ltd."). Still no digits to
# match the spec; if a tenant actually needs digits (e.g. "Acme 2000")
# the admin can edit the row afterwards.
_BUSINESS_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z\s\.\-'&,]{0,198}[A-Za-z\.,]$")


def _validate_bd_phone(value: str, *, field: str = "phone") -> str:
    """Strip non-digits, accept either local (11d) or with-country-code (13d),
    and return the canonical 11-digit form. Raises ValidationError on miss.
    """
    digits = "".join(c for c in (value or "") if c.isdigit())
    # Accept '8801XXXXXXXXX' by stripping the country code prefix.
    if len(digits) == 13 and digits.startswith("880"):
        digits = "0" + digits[3:]
    if not _BD_PHONE_RE.match(digits):
        raise serializers.ValidationError(
            "Enter a valid Bangladesh mobile number — 11 digits starting with 01."
        )
    return digits


def _validate_name(value: str, *, field: str = "name") -> str:
    v = (value or "").strip()
    if not v:
        raise serializers.ValidationError("This field is required.")
    if not _NAME_RE.match(v):
        raise serializers.ValidationError(
            "Use letters and spaces only (no digits or special characters)."
        )
    return v


def _validate_business_name(value: str) -> str:
    v = (value or "").strip()
    if not v:
        raise serializers.ValidationError("Business name is required.")
    if not _BUSINESS_NAME_RE.match(v):
        raise serializers.ValidationError(
            "Use letters, spaces, &, ., -, ' or , (no digits)."
        )
    return v


def _validate_letters_only(value: str, field_label: str) -> str:
    v = (value or "").strip()
    if not v:
        raise serializers.ValidationError(f"{field_label} is required.")
    if not re.match(r"^[A-Za-z][A-Za-z\s\.\-']{0,118}[A-Za-z]$", v):
        raise serializers.ValidationError(
            f"{field_label} must contain only letters and spaces."
        )
    return v


# ──────────────────────────────────────────────────────────────────────────────
# Custom JWT serializer — embeds role + permissions in the token payload
# ──────────────────────────────────────────────────────────────────────────────

class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    """
    Extends the default JWT login serializer to include:
      • role          — user's role code
      • permissions   — list of permission codes (for frontend UI gating)
      • name          — display name

    These are embedded IN the access token so the frontend can read them
    without an extra profile API call.
    """

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"]            = user.role
        token["name"]            = user.name
        token["email"]           = user.email
        token["profile_picture"] = getattr(user, "profile_picture", "") or ""
        token["permissions"]     = sorted(get_user_permissions(user))
        return token


# ──────────────────────────────────────────────────────────────────────────────
# Subscribe — POST /api/subscribe/
# ──────────────────────────────────────────────────────────────────────────────

class SubscribeSerializer(serializers.Serializer):
    """
    Validates the plan selection and buyer details.
    User creation happens only AFTER payment is confirmed (in the webhook).

    For the custom Multi-Branch plan, `extra_branches` lets the buyer pick
    how many additional branches (each costing `plan.per_branch_fee`/month)
    on top of the included base branch.
    """
    plan_id        = serializers.UUIDField()
    name           = serializers.CharField(max_length=150, trim_whitespace=True)
    username       = serializers.CharField(
        max_length=30,
        trim_whitespace=True,
        help_text="Tenant-chosen login username. 3–30 chars, lowercase + digits + underscore, "
                  "must start with a letter. Checked for uniqueness.",
    )
    email          = serializers.EmailField()
    phone          = serializers.CharField(max_length=30, trim_whitespace=True)
    business_name  = serializers.CharField(max_length=200, trim_whitespace=True)

    # Postal address — required at checkout. Stored on the User after
    # payment success and surfaced on the admin "Client's Info" page.
    address        = serializers.CharField(max_length=255, trim_whitespace=True)
    thana          = serializers.CharField(max_length=120, trim_whitespace=True)
    district       = serializers.CharField(max_length=120, trim_whitespace=True)
    postal_code    = serializers.CharField(max_length=20,  trim_whitespace=True)

    extra_branches = serializers.IntegerField(
        required=False, default=0, min_value=0, max_value=100,
        help_text="Custom plan only: extra branches beyond the included one.",
    )
    referral_phone = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=30,
        help_text=(
            "Optional. Phone number of the existing tenant who referred this "
            "signup. Used by the referral programme — silently ignored if it "
            "doesn't match any tenant or is the buyer's own number."
        ),
    )
    coupon_code = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=40,
        help_text="Optional discount coupon code applied to this subscription.",
    )

    def validate_username(self, value):
        # Imported locally to avoid circulars at module import.
        from .services import UsernameError, validate_and_reserve_username
        try:
            return validate_and_reserve_username(value)
        except UsernameError as e:
            raise serializers.ValidationError(str(e))

    # Letters-only / digit-only validators applied per field. Each one
    # mirrors the equivalent client-side check; the server is the source
    # of truth so bypassing the UI doesn't punch through.
    def validate_name(self, value):          return _validate_name(value)
    def validate_business_name(self, value): return _validate_business_name(value)
    def validate_phone(self, value):         return _validate_bd_phone(value)
    def validate_thana(self, value):         return _validate_letters_only(value, "Thana")
    def validate_district(self, value):      return _validate_letters_only(value, "District")
    def validate_referral_phone(self, value):
        # Optional field. Empty/blank is fine; if supplied, must be a valid BD phone.
        if not value or not value.strip():
            return ""
        return _validate_bd_phone(value, field="referral_phone")

    def validate_plan_id(self, value):
        try:
            plan = Plan.objects.get(id=value, is_active=True)
        except Plan.DoesNotExist:
            raise serializers.ValidationError("Plan not found or inactive.")
        self.context["plan"] = plan
        return value

    def validate(self, attrs):
        plan = self.context.get("plan")
        if plan and not plan.is_custom and attrs.get("extra_branches"):
            # Silently ignore extra_branches when the plan is not customisable.
            attrs["extra_branches"] = 0
        if plan and plan.is_trial:
            raise serializers.ValidationError(
                {"plan_id": "Trial plans cannot be subscribed via /subscribe/. Use /signup-trial/."}
            )
        return attrs

    def validate_email(self, value):
        from .models import User
        if User.objects.filter(email__iexact=value, status="active").exists():
            raise serializers.ValidationError(
                "An active account already exists for this email. Please log in instead."
            )
        return value.lower()


# ──────────────────────────────────────────────────────────────────────────────
# Trial signup — POST /api/signup-trial/
# ──────────────────────────────────────────────────────────────────────────────

class TrialSignupSerializer(serializers.Serializer):
    """
    Free 14-day trial — no payment, no commitment. Lighter form than paid:
    only the basics are required (name, email, phone, business name).
    Address / thana / district / postal_code can be filled later from the
    Profile page; username is auto-derived from the buyer's name.
    """
    name          = serializers.CharField(max_length=150, trim_whitespace=True)
    email         = serializers.EmailField()
    phone         = serializers.CharField(max_length=30, trim_whitespace=True)
    business_name = serializers.CharField(max_length=200, trim_whitespace=True)

    # Optional on trial — present at signup only if the form happens to
    # collect them. The View defaults each one to "" when missing so the
    # admin Client's Info page renders an em-dash instead of crashing.
    username      = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=30,
        trim_whitespace=True,
        help_text="Optional on trial — auto-generated from `name` when blank.",
    )
    address       = serializers.CharField(required=False, allow_blank=True, default="", max_length=255, trim_whitespace=True)
    thana         = serializers.CharField(required=False, allow_blank=True, default="", max_length=120, trim_whitespace=True)
    district      = serializers.CharField(required=False, allow_blank=True, default="", max_length=120, trim_whitespace=True)
    postal_code   = serializers.CharField(required=False, allow_blank=True, default="", max_length=20,  trim_whitespace=True)

    referral_phone = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=30,
        help_text="Optional referrer phone.",
    )

    # ── Shared validators (same rules as SubscribeSerializer) ────────────────

    def validate_name(self, value):          return _validate_name(value)
    def validate_business_name(self, value): return _validate_business_name(value)
    def validate_phone(self, value):         return _validate_bd_phone(value)
    def validate_thana(self, value):
        return _validate_letters_only(value, "Thana") if value and value.strip() else ""
    def validate_district(self, value):
        return _validate_letters_only(value, "District") if value and value.strip() else ""
    def validate_referral_phone(self, value):
        if not value or not value.strip():
            return ""
        return _validate_bd_phone(value, field="referral_phone")

    def validate_username(self, value):
        # Empty allowed — caller (services.create_trial_account) auto-fills
        # from the user's name via suggest_usernames.
        if not value or not value.strip():
            return ""
        from .services import UsernameError, validate_and_reserve_username
        try:
            return validate_and_reserve_username(value)
        except UsernameError as e:
            raise serializers.ValidationError(str(e))

    def validate_email(self, value):
        from .models import User
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError(
                "An account already exists for this email. Please log in instead."
            )
        return value.lower()


class SubscribeResponseSerializer(serializers.Serializer):
    """Response body for POST /api/subscribe/."""
    payment_id     = serializers.UUIDField()
    transaction_id = serializers.CharField()
    amount         = serializers.DecimalField(max_digits=10, decimal_places=2)
    payment_url    = serializers.URLField()


# ──────────────────────────────────────────────────────────────────────────────
# Payment webhook — POST /api/payment/webhook/
# ──────────────────────────────────────────────────────────────────────────────

class PaymentWebhookSerializer(serializers.Serializer):
    """Incoming payload from the payment gateway."""
    transaction_id = serializers.CharField(max_length=255)
    payment_status = serializers.ChoiceField(choices=["SUCCESS", "FAILED", "PENDING"])
    amount         = serializers.DecimalField(max_digits=10, decimal_places=2)
    signature      = serializers.CharField(required=False, allow_blank=True, default="")


# ──────────────────────────────────────────────────────────────────────────────
# Set password — POST /api/set-password/
# ──────────────────────────────────────────────────────────────────────────────

class SetPasswordSerializer(serializers.Serializer):
    token            = serializers.CharField(max_length=64)
    new_password     = serializers.CharField(
        min_length=8,
        max_length=128,
        write_only=True,
        style={"input_type": "password"},
    )
    confirm_password = serializers.CharField(
        min_length=8,
        max_length=128,
        write_only=True,
        style={"input_type": "password"},
    )

    def validate_token(self, value):
        try:
            token = PasswordSetupToken.objects.select_related("user").get(token=value)
        except PasswordSetupToken.DoesNotExist:
            raise serializers.ValidationError("This link is invalid or has already been used.")
        if not token.is_valid:
            raise serializers.ValidationError("This link has expired. Please request a new one.")
        self.context["token_obj"] = token
        return value

    def validate_new_password(self, value):
        user = self.context.get("token_obj", None)
        user_obj = user.user if user else None
        try:
            validate_password(value, user=user_obj)
        except DjangoValidationError as e:
            raise serializers.ValidationError(list(e.messages))
        return value

    def validate(self, attrs):
        if attrs["new_password"] != attrs["confirm_password"]:
            raise serializers.ValidationError({"confirm_password": "Passwords do not match."})
        return attrs


# ──────────────────────────────────────────────────────────────────────────────
# Resend setup link — POST /api/resend-setup-link/
# ──────────────────────────────────────────────────────────────────────────────

class ResendSetupLinkSerializer(serializers.Serializer):
    email = serializers.EmailField()


# ──────────────────────────────────────────────────────────────────────────────
# Read-only Payment (status polling / admin receipt view)
# ──────────────────────────────────────────────────────────────────────────────

class PaymentSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Payment
        fields = ["id", "amount", "status", "transaction_id", "paid_at", "created_at"]
        read_only_fields = fields


# ──────────────────────────────────────────────────────────────────────────────
# Plan (public list)
# ──────────────────────────────────────────────────────────────────────────────

class PlanSerializer(serializers.ModelSerializer):
    multi_branch_enabled = serializers.BooleanField(read_only=True)

    class Meta:
        model  = Plan
        fields = [
            "id", "code", "name", "price", "billing_cycle", "duration_days",
            "description", "features",
            "is_trial", "is_custom",
            "max_branches", "max_sub_accounts", "max_products", "max_storage_mb",
            "per_branch_fee", "module_features", "yearly_discount_percent",
            "multi_branch_enabled", "sort_order",
        ]


# ──────────────────────────────────────────────────────────────────────────────
# JWT Login — POST /api/auth/login/
# ──────────────────────────────────────────────────────────────────────────────

def _enforce_tenant_provisioned(user) -> None:
    """
    Block login when the user is a tenant owner whose workspace DB has not
    been provisioned (or whose tenant row never got created).

    Allowed through:
      • Platform staff / superuser   — no Tenant row, runs against master DB only.
      • Sub-users (parent_owner set) — checked against the parent owner's tenant.

    Blocked:
      • Tenant owners whose Tenant row is missing.
      • Tenant owners whose Tenant.is_provisioned == False.

    Raises ValidationError with a structured payload so the frontend can
    distinguish this from "wrong password" and show a clear message
    (e.g. "Your workspace is being prepared. Contact support if this
    persists.") instead of a generic auth error.
    """
    from .models import Tenant  # local import — avoids circulars at module load

    # Platform staff don't have a tenant.
    if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
        return

    # Sub-users → resolve to the parent owner's tenant.
    owner_id = getattr(user, "parent_owner_id", None) or user.id

    tenant = Tenant.objects.filter(user_id=owner_id).only("is_provisioned").first()

    if tenant is None:
        # Owner exists but tenant row was never written — usually means the
        # payment webhook crashed mid-flight. Refuse login.
        raise serializers.ValidationError({
            "code":    "TENANT_NOT_READY",
            "detail": (
                "Your workspace is not ready yet. If your payment was "
                "successful, please contact support so we can finish "
                "setting up your account."
            ),
        })

    if not tenant.is_provisioned:
        raise serializers.ValidationError({
            "code":    "TENANT_NOT_READY",
            "detail": (
                "Your workspace is still being prepared. This usually "
                "completes within a minute of payment. If it has been "
                "longer, please contact support — we'll finish "
                "provisioning your account."
            ),
        })


class LoginSerializer(serializers.Serializer):
    """
    Validates email-or-mobile + password and returns JWT access/refresh pair.
    Works for SUSPENDED users so they can reach the billing pages.

    Accepts either:
      • `email` — full email address (legacy, still accepted), OR
      • `mobile` / `phone` / `identifier` — a Bangladesh-style mobile number;
        normalised against the User.phone column.

    The frontend's tenant login form sends `identifier` so the same input
    can carry either an email or a mobile number.
    """
    # Every field optional individually — we validate "at least one" below.
    email      = serializers.EmailField(required=False, allow_blank=True)
    mobile     = serializers.CharField(required=False, allow_blank=True, max_length=30)
    phone      = serializers.CharField(required=False, allow_blank=True, max_length=30)
    identifier = serializers.CharField(required=False, allow_blank=True, max_length=120,
                                       help_text="Mobile number or email — auto-detected.")
    password   = serializers.CharField(write_only=True, style={"input_type": "password"})

    def validate(self, attrs):
        from .models import User
        from .sms import _normalize_msisdn

        password = attrs["password"]
        # Collect every identifier the caller might have sent.
        raw_email = (attrs.get("email")      or "").strip()
        raw_phone = (attrs.get("mobile")     or attrs.get("phone") or "").strip()
        raw_any   = (attrs.get("identifier") or "").strip()

        # Auto-detect when only `identifier` is supplied: anything with "@"
        # routes to the email path; everything else is treated as a phone.
        if raw_any and not raw_email and not raw_phone:
            if "@" in raw_any:
                raw_email = raw_any
            else:
                raw_phone = raw_any

        if not raw_email and not raw_phone:
            raise serializers.ValidationError(
                "Enter your mobile number (or email) and password.",
            )

        user = None
        if raw_email:
            user = User.objects.filter(email__iexact=raw_email.lower()).first()
        if user is None and raw_phone:
            # Normalise the supplied number to a single MSISDN format and
            # collect EVERY User.phone that normalises to the same value.
            # Then deterministically pick the best candidate — the user
            # whose login is most likely correct:
            #   1. has a usable password (i.e. completed first-login setup)
            #   2. otherwise the earliest-created row (the original owner
            #      of the number).
            # Without this ordering, multiple users sharing a phone could
            # randomly resolve to a half-set-up account and the legit user
            # would get "Validation failed." with no recourse.
            msisdn = _normalize_msisdn(raw_phone) or raw_phone
            tail   = (msisdn or raw_phone).strip()[-9:]
            if tail:
                candidates = list(
                    User.objects.filter(phone__icontains=tail)
                    .order_by("created_at")
                    .only("id", "email", "phone", "username", "created_at", "password")
                )
                matches = [
                    u for u in candidates
                    if _normalize_msisdn(u.phone) == msisdn
                ]
                # Tier 1: usable-password matches, earliest-created first.
                usable = [u for u in matches if u.has_usable_password()]
                if usable:
                    user = usable[0]
                elif matches:
                    user = matches[0]

        if user is None:
            raise serializers.ValidationError({
                "detail": "Invalid mobile/email or password.",
            })

        # Single-client build: no first-login OTP / tenant-provisioning flow.
        # An account with an unusable password simply fails the standard
        # password check below.
        if not user.check_password(password):
            raise serializers.ValidationError("Invalid mobile/email or password.")

        # Use CustomTokenObtainPairSerializer.get_token() so the access token
        # carries role, name, email, and permissions claims.
        refresh = CustomTokenObtainPairSerializer.get_token(user)
        permissions = sorted(get_user_permissions(user))
        # Platform-admin section permissions (empty for tenant users).
        from .admin_perms import effective_admin_perms
        admin_permissions = effective_admin_perms(user)
        # Tenant owners have a Tenant record; platform admins don't.
        has_tenant = hasattr(user, "tenant") and user.tenant is not None

        # Surface the billing summary so the frontend can immediately render a
        # banner / redirect to Pay Bill page without an extra round-trip.
        billing = _build_billing_summary(user)

        return {
            "access":  str(refresh.access_token),
            "refresh": str(refresh),
            "user_id": str(user.id),
            "email": user.email,
            "name": user.name,
            "role": user.role,
            "status": user.status,
            "is_staff": user.is_staff,
            "is_superuser": user.is_superuser,
            "has_tenant": has_tenant,
            "profile_picture": getattr(user, "profile_picture", "") or "",
            "permissions": permissions,
            "admin_permissions": admin_permissions,
            "billing": billing,
            "user": {
                "id":       str(user.id),
                "email":    user.email,
                "name":     user.name,
                "username": user.username,
                "status":   user.status,
                "role":     user.role,
                "is_staff": user.is_staff,
                "is_superuser": user.is_superuser,
                "has_tenant": has_tenant,
                "profile_picture": getattr(user, "profile_picture", "") or "",
                "permissions": permissions,
                "admin_permissions": admin_permissions,
                "billing": billing,
            },
        }


def _build_billing_summary(user) -> dict:
    """Compact billing snapshot included in login + token-refresh responses."""
    from django.utils import timezone
    from .models import Subscription

    sub = (
        Subscription.objects
        .filter(user=user)
        .select_related("plan")
        .order_by("-created_at")
        .first()
    )
    if not sub:
        return {
            "has_subscription": False,
            "subscription_status": None,
            "user_status":   getattr(user, "status", "active"),
            "requires_payment": False,
            "next_billing_date": None,
            "days_remaining":    None,
        }
    days_remaining = (sub.next_billing_date - timezone.localdate()).days
    requires_payment = (
        getattr(user, "status", "active") == "suspended"
        or sub.status in ("suspended", "expired")
        or days_remaining < 0
    )
    # Use the canonical BDT price (300 / 900 / 1200) instead of whatever
    # legacy value is sitting in the Plan row.
    from .views import get_bdt_plan_price  # local import — avoids cycles
    plan_price_bdt = get_bdt_plan_price(sub.plan)

    return {
        "has_subscription":   True,
        "subscription_status": sub.status,
        "user_status":        getattr(user, "status", "active"),
        "plan_name":          getattr(sub.plan, "name", ""),
        "plan_price":         str(plan_price_bdt),
        "currency":           "BDT",
        # When the subscription was taken out — the dashboard's
        # "Subscription date & time" field reads this key; it was
        # never serialized before, so the card showed "—".
        "subscribed_at":      sub.created_at.isoformat() if getattr(sub, "created_at", None) else None,
        "next_billing_date":  sub.next_billing_date.isoformat(),
        "days_remaining":     days_remaining,
        "requires_payment":   requires_payment,
    }


class AdminLoginSerializer(LoginSerializer):
    """
    Staff/superuser login for platform administration.
    Blocks non-admin tenant users from this entry point.
    """

    def validate(self, attrs):
        data = super().validate(attrs)
        from .models import User

        email = attrs["email"].lower()
        user = User.objects.get(email__iexact=email)
        if not (user.is_staff or user.is_superuser):
            raise serializers.ValidationError(
                "Admin access denied. Use your tenant login link from email."
            )
        return data


# ──────────────────────────────────────────────────────────────────────────────
# Pay-now — POST /api/pay-now/
# ──────────────────────────────────────────────────────────────────────────────

class PayNowSerializer(serializers.Serializer):
    """
    Currently no required body fields — the user is identified by JWT.
    Add payment_method here if you want to pre-select the gateway method.
    """
    payment_method = serializers.ChoiceField(
        choices=["card", "mobile_banking", "bank_transfer"],
        required=False,
        default="card",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Billing status — GET /api/billing/status/
# ──────────────────────────────────────────────────────────────────────────────

class BillingStatusSerializer(serializers.Serializer):
    """Read-only subscription summary shown on the billing page."""
    id                = serializers.UUIDField()
    plan_name         = serializers.CharField(source="plan.name")
    plan_price        = serializers.SerializerMethodField()
    status            = serializers.CharField()
    start_date        = serializers.DateField()
    next_billing_date = serializers.DateField()
    days_remaining    = serializers.SerializerMethodField()
    currency          = serializers.SerializerMethodField()
    max_branches         = serializers.IntegerField(source="plan.max_branches")
    multi_branch_enabled = serializers.BooleanField(source="plan.multi_branch_enabled")

    def get_days_remaining(self, obj) -> int:
        from django.utils import timezone
        delta = obj.next_billing_date - timezone.localdate()
        return max(0, delta.days)

    def get_plan_price(self, obj):
        from .views import get_bdt_plan_price
        return str(get_bdt_plan_price(obj.plan))

    def get_currency(self, obj):
        return "BDT"


# ──────────────────────────────────────────────────────────────────────────────
# Payment history
# ──────────────────────────────────────────────────────────────────────────────

class PaymentHistorySerializer(serializers.ModelSerializer):
    plan_name = serializers.SerializerMethodField()

    class Meta:
        model  = Payment
        fields = ["id", "amount", "status", "transaction_id", "plan_name", "paid_at", "created_at"]
        read_only_fields = fields

    def get_plan_name(self, obj) -> str | None:
        meta = obj.metadata or {}
        return meta.get("plan_name") or (obj.subscription.plan.name if obj.subscription else None)


# ──────────────────────────────────────────────────────────────────────────────
# Platform Notice serializers
# ──────────────────────────────────────────────────────────────────────────────

class PlatformNoticeSerializer(serializers.ModelSerializer):
    """Used by both the admin CRUD endpoint and the tenant read-only feed.

    `is_visible_now` is read-only — derived from is_active + dates. The
    tenant-facing endpoint pre-filters to visible rows, so the field is
    mostly a debugging aid on the admin side.
    """
    created_by_name = serializers.SerializerMethodField()
    is_visible_now  = serializers.BooleanField(read_only=True)

    class Meta:
        from .models import PlatformNotice  # local — file is read top-to-bottom
        model  = PlatformNotice
        fields = [
            "id", "title", "body", "kind",
            "is_active", "is_marquee", "marquee_speed",
            "published_at", "expires_at", "target_user_ids",
            "created_by", "created_by_name",
            "created_at", "updated_at",
            "is_visible_now",
        ]
        read_only_fields = ["id", "created_by", "created_at", "updated_at", "is_visible_now"]

    def get_created_by_name(self, obj):
        return obj.created_by.name if obj.created_by else ""
