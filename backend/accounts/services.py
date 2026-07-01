"""
Service layer — all multi-step business operations.
Isolated from HTTP concerns so they can be unit-tested, reused from
management commands, admin actions, and Celery tasks.
"""
import hmac
import hashlib
import logging
import secrets
import json
from datetime import timedelta
from decimal import Decimal
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import User, Plan, Subscription, Payment, PasswordSetupToken, Tenant, LoginOtp
from .tenant_db import build_tenant_identifiers
from . import sms as sms_service
from . import referrals as referrals_service

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Custom exceptions
# ──────────────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────────────
# SMS messaging templates + helpers — used by trial signup, paid signup, and
# the password-set confirmation flow. The previous email-link flow is fully
# replaced by these (see commits "OTP-based first login").
# ──────────────────────────────────────────────────────────────────────────────


def _otp_message(user: User, code: str) -> str:
    """Welcome / first-login SMS body. Kept short — most BD gateways charge
    per 160-char segment."""
    return (
        f"Welcome to IFFAA. Username: {user.username}. "
        f"Your one-time login code is {code}. Valid for 10 minutes. "
        "Do not share this code."
    )


def _password_set_message(user: User) -> str:
    return (
        f"IFFAA: Hi {user.name.split()[0] if user.name else user.username}, "
        "your password has been set. You can now log in with your username and password."
    )


def _safe_after_commit(label: str, fn) -> None:
    """Run a post-commit task, logging+swallowing any exception.

    Django executes transaction.on_commit callbacks in order and STOPS at the
    first one that raises — which previously meant a failed invoice email
    aborted the login-OTP SMS that was registered after it. Wrapping each task
    keeps them independent so one failure never blocks the others.
    """
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        logger.exception("post-commit task %r failed: %s", label, exc)


def send_login_otp(user: User) -> LoginOtp:
    """
    Issue a fresh LoginOtp for `user` and dispatch it via SMS.

    Safe to call from inside an atomic block — the actual SMS send happens
    here synchronously (no on_commit wrap) because the OTP row is already
    persisted; if the gateway call fails, the user can request a resend.

    Returns the LoginOtp row so callers can surface metadata (e.g. expiry).
    """
    otp = LoginOtp.issue(user=user)
    try:
        sms_service.send_sms(user.phone or "", _otp_message(user, otp.code))
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("SMS dispatch failed for user=%s: %s", user.email, exc)
    # Cache the code so the dev console can hand it back to the dev frontend.
    sms_service.remember_dev_otp(user.id, otp.code)
    return otp


def send_password_set_sms(user: User) -> None:
    """Best-effort confirmation SMS after a password is set."""
    if not user.phone:
        return
    try:
        sms_service.send_sms(user.phone, _password_set_message(user))
    except Exception as exc:  # pragma: no cover
        logger.exception("Password-set SMS failed for user=%s: %s", user.email, exc)


class WebhookError(Exception):
    """Raised for any webhook validation failure — caller returns 400."""


class DuplicateWebhookError(WebhookError):
    """Raised when a webhook for an already-processed transaction arrives."""


class PasswordSetupError(Exception):
    """Raised for any user-facing password-setup failure."""


class PaymentGatewayError(Exception):
    """Raised when payment gateway session/init fails."""


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def resolve_user_by_identifier(ident: str):
    """
    Look up a User by email / username / mobile number — whichever the
    operator passed on the command line.

    Mobile lookup uses the same BD-MSISDN normalisation as LoginSerializer
    so 01830...,  +8801830..., 8801830..., "01 830 ..." all match the same
    row. When multiple users share the same number (the edge case
    LoginSerializer also has to handle), the same tie-break wins:
      1. user with a usable password (i.e. completed first-login setup)
      2. otherwise the earliest-created row.

    Returns the User or None.
    """
    from .models import User  # local import — avoids any module-load cycles
    from .sms import _normalize_msisdn

    ident = (ident or "").strip()
    if not ident:
        return None

    # 1. Email (anything with an @ goes here, never to the phone path)
    if "@" in ident:
        return User.objects.filter(email__iexact=ident).first()

    # 2. Username (exact match)
    user = User.objects.filter(username__iexact=ident).first()
    if user:
        return user

    # 3. Phone — normalise, then narrow by the last 9 digits and re-check
    msisdn = _normalize_msisdn(ident) or ident
    tail   = (msisdn or ident).strip()[-9:]
    if not tail:
        return None

    candidates = list(
        User.objects.filter(phone__icontains=tail)
        .order_by("created_at")
        .only("id", "email", "phone", "username", "created_at", "password")
    )
    matches = [u for u in candidates if _normalize_msisdn(u.phone) == msisdn]
    if not matches:
        return None

    usable = [u for u in matches if u.has_usable_password()]
    return usable[0] if usable else matches[0]


def generate_username(name: str) -> str:
    """
    DEPRECATED for new signups — users now pick their own username on the
    Subscribe page. Kept as a fallback for code paths (admin shell, legacy
    tests) that haven't been migrated yet.

    Build a unique username from a display name.
    Loops (up to 5 times) until uniqueness is confirmed.
    e.g. "Acme Ltd" → "acme_ltd_3f9a"
    """
    base = "".join(c for c in name.lower().replace(" ", "_") if c.isalnum() or c == "_")
    base = base or "user"
    for _ in range(5):
        candidate = f"{base}_{secrets.token_hex(2)}"
        if not User.objects.filter(username=candidate).exists():
            return candidate
    return f"user_{secrets.token_hex(8)}"


# ──────────────────────────────────────────────────────────────────────────────
# Username — user-chosen on the Subscribe page (new flow)
# ──────────────────────────────────────────────────────────────────────────────

import re as _re  # noqa: E402 — local re alias to avoid colliding with anything below

# Allowed: 3–30 chars, lowercase letters/digits/underscores. Cannot start
# with a digit (keeps DB/file identifiers sane downstream). Case is
# normalised to lowercase before any check so the rule is forgiving on
# input but strict in storage.
USERNAME_MIN_LEN = 3
USERNAME_MAX_LEN = 30
_USERNAME_RE = _re.compile(r"^[a-z][a-z0-9_]{2,29}$")


class UsernameError(Exception):
    """Raised when a chosen username is invalid or already taken."""


def normalize_username(raw: str) -> str:
    """Lowercase + strip. Caller still has to validate the result."""
    return (raw or "").strip().lower()


def is_valid_username_format(username: str) -> bool:
    return bool(_USERNAME_RE.match(username or ""))


def is_username_available(username: str) -> bool:
    """True if no User row owns this username (case-insensitive)."""
    from .models import User  # local import — avoids module-load cycles
    return not User.objects.filter(username__iexact=username).exists()


def suggest_usernames(base: str, *, max_suggestions: int = 5) -> list[str]:
    """
    Given a desired-but-taken username (or a free-form business name), return
    a short list of unused alternatives.

    Strategy, in order — stop once we have enough:
      1. base + numeric suffix (2, 3, … 9)
      2. base + 4-hex-char salt (matches the auto-generated style for visual
         consistency with existing accounts on the system)
    """
    from .models import User  # local import

    # Sanitize the seed: same rules as a real username, but more forgiving.
    seed = _re.sub(r"[^a-z0-9_]", "_", (base or "").strip().lower())
    seed = _re.sub(r"_+", "_", seed).strip("_")
    if not seed or seed[0].isdigit():
        seed = f"user_{seed}".rstrip("_")
    seed = seed[:USERNAME_MAX_LEN - 5]  # leave room for the suffix

    out: list[str] = []
    taken: set[str] = set(
        User.objects.filter(username__startswith=seed)
        .values_list("username", flat=True)
    )

    # Pass 1 — numeric suffix
    for n in range(2, 10):
        cand = f"{seed}{n}"
        if len(cand) > USERNAME_MAX_LEN: continue
        if not is_valid_username_format(cand): continue
        if cand in taken: continue
        out.append(cand)
        if len(out) >= max_suggestions:
            return out

    # Pass 2 — hex salt
    for _ in range(20):
        cand = f"{seed}_{secrets.token_hex(2)}"
        if len(cand) > USERNAME_MAX_LEN: continue
        if not is_valid_username_format(cand): continue
        if cand in taken: continue
        out.append(cand)
        if len(out) >= max_suggestions:
            break

    return out


def validate_and_reserve_username(raw: str, *, fallback_seed: str = "") -> str:
    """
    Called from the Subscribe / Trial serializers BEFORE we know we'll
    actually create the user (payment may not even succeed). We don't
    actually reserve anything in the DB yet — just normalise + validate
    so the operator can give the buyer a precise error before they pay.

    Returns the normalised username, or raises UsernameError with a
    user-facing message.
    """
    username = normalize_username(raw)
    if not username:
        # Empty → derive one from fallback_seed so the buyer isn't stuck
        # on a confusing "username required" error if the field is left
        # blank by an older client.
        if fallback_seed:
            for cand in suggest_usernames(fallback_seed, max_suggestions=1):
                return cand
        raise UsernameError("Username is required.")

    if not is_valid_username_format(username):
        raise UsernameError(
            f"Username must be {USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} characters, "
            "start with a lowercase letter, and contain only lowercase letters, "
            "digits, or underscores."
        )

    if not is_username_available(username):
        raise UsernameError("This username has already been used.")

    return username


def generate_transaction_id() -> str:
    """
    Internal merchant order reference — sent to the gateway.
    Format: TXN-<16 uppercase hex chars>.
    """
    return f"TXN-{secrets.token_hex(8).upper()}"


def build_gateway_url(payment: Payment) -> str:
    """
    Return the payment-gateway redirect URL.
    Uses SSLCommerz if configured; otherwise falls back to dummy URL.
    """
    provider = getattr(settings, "PAYMENT_GATEWAY_PROVIDER", "").lower()
    if provider == "sslcommerz" or (
        getattr(settings, "SSL_STORE_ID", "") and getattr(settings, "SSL_STORE_PASSWORD", "")
    ):
        return _build_sslcommerz_gateway_url(payment)

    base = getattr(settings, "PAYMENT_GATEWAY_URL", "https://pay.example.com/checkout")
    return f"{base}?txn={payment.transaction_id}&amount={payment.amount}"


def _build_sslcommerz_gateway_url(payment: Payment) -> str:
    store_id = getattr(settings, "SSL_STORE_ID", "")
    store_password = getattr(settings, "SSL_STORE_PASSWORD", "")
    if not store_id or not store_password:
        raise PaymentGatewayError("SSLCommerz credentials are missing.")

    sandbox = getattr(settings, "SSL_SANDBOX", True)
    init_url = (
        "https://sandbox.sslcommerz.com/gwprocess/v4/api.php"
        if sandbox else
        "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
    )

    backend_base = getattr(settings, "BACKEND_BASE_URL", "http://127.0.0.1:8003").rstrip("/")
    frontend_base = getattr(settings, "FRONTEND_URL", "http://localhost:3050").rstrip("/")
    meta = payment.metadata or {}

    customer_name = meta.get("name") or (payment.user.name if payment.user else "Customer")
    customer_email = meta.get("email") or (payment.user.email if payment.user else "")
    customer_phone = meta.get("phone") or (payment.user.phone if payment.user else "")
    business_name = meta.get("business_name") or (payment.user.business_name if payment.user else "Business")
    plan_name = meta.get("plan_name", "Subscription Plan")

    return_url = f"{backend_base}/api/payment/return/"
    payload = {
        "store_id": store_id,
        "store_passwd": store_password,
        "total_amount": str(payment.amount),
        "currency": "BDT",
        "tran_id": payment.transaction_id,
        "success_url": f"{return_url}?result=success",
        "fail_url": f"{return_url}?result=failed",
        "cancel_url": f"{return_url}?result=cancelled",
        "ipn_url": f"{backend_base}/api/payment/webhook/",
        "product_name": plan_name,
        "product_category": "Subscription",
        "product_profile": "non-physical-goods",
        "shipping_method": "NO",
        "num_of_item": "1",
        "cus_name": customer_name,
        "cus_email": customer_email,
        "cus_add1": business_name,
        "cus_city": "Dhaka",
        "cus_country": "Bangladesh",
        "cus_phone": customer_phone or "01700000000",
        "value_a": "subscription",
        "value_b": str(payment.id),
    }

    body = urlencode(payload).encode("utf-8")
    req = Request(init_url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urlopen(req, timeout=20) as resp:
            response_body = resp.read().decode("utf-8")
    except Exception as exc:
        logger.exception("SSLCommerz init request failed for txn=%s", payment.transaction_id)
        raise PaymentGatewayError(f"Failed to initialize SSLCommerz payment: {exc}") from exc

    try:
        payload = json.loads(response_body)
    except json.JSONDecodeError as exc:
        logger.error("SSLCommerz init non-JSON response for txn=%s: %s", payment.transaction_id, response_body)
        raise PaymentGatewayError("Invalid response from SSLCommerz.") from exc

    gateway_url = payload.get("GatewayPageURL")
    if not gateway_url:
        logger.error("SSLCommerz init failed for txn=%s payload=%s", payment.transaction_id, payload)
        raise PaymentGatewayError(payload.get("failedreason") or "SSLCommerz did not return payment URL.")

    return gateway_url


def normalize_webhook_payload(raw_payload: dict) -> dict:
    """
    Normalizes multiple gateway webhook payload shapes into:
    { transaction_id, payment_status, amount, signature }.
    """
    if "tran_id" in raw_payload:
        status_map = {
            "VALID": "SUCCESS",
            "VALIDATED": "SUCCESS",
            "SUCCESS": "SUCCESS",
            "FAILED": "FAILED",
            "FAILED_PAYMENT": "FAILED",
            "CANCELLED": "FAILED",
            "PENDING": "PENDING",
            "PROCESSING": "PENDING",
        }
        raw_status = str(raw_payload.get("status", "")).upper()
        mapped = status_map.get(raw_status, "PENDING")
        return {
            "transaction_id": raw_payload.get("tran_id", ""),
            "payment_status": mapped,
            "amount": raw_payload.get("amount", "0"),
            "signature": "",
        }

    return {
        "transaction_id": raw_payload.get("transaction_id", ""),
        "payment_status": raw_payload.get("payment_status", ""),
        "amount": raw_payload.get("amount", "0"),
        "signature": raw_payload.get("signature", ""),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Subscribe — create a PENDING payment (no user yet)
# ──────────────────────────────────────────────────────────────────────────────

@transaction.atomic
def create_pending_payment(
    *,
    plan: Plan,
    name: str,
    username: str,
    email: str,
    phone: str,
    business_name: str,
    address: str = "",
    thana: str = "",
    district: str = "",
    postal_code: str = "",
    extra_branches: int = 0,
    referral_phone: str = "",
    coupon_code: str = "",
) -> Payment:
    """
    Called by POST /api/subscribe/.
    Creates a PENDING Payment and stashes buyer info in metadata.
    The User is NOT created here — only after the gateway confirms payment.

    For custom (multi-branch) plans, `extra_branches` adjusts the amount
    server-side; never trust the frontend price.

    The chosen `username` was already format-checked + uniqueness-checked
    by SubscribeSerializer.validate_username, but we re-check uniqueness
    here in case two buyers raced — whichever payment lands second will
    be rejected at process_successful_payment time.
    """
    amount = plan.compute_price(extra_branches=extra_branches)

    # ── Apply a coupon (optional) ───────────────────────────────────────────
    # Validate server-side against the same rules the admin set; never trust a
    # discount sent from the browser. Money coupons reduce the charged amount;
    # free-trial coupons add days post-payment instead.
    coupon_meta = {}
    code = (coupon_code or "").strip()
    if code:
        from . import coupon_admin  # noqa: PLC0415
        coupon, discount, _msg = coupon_admin.validate(
            code, amount=amount, plan_id=str(plan.id), email=(email or "").lower(), is_renewal=False,
        )
        if coupon.discount_type != coupon.Type.FREE_TRIAL:
            amount = max(amount - discount, Decimal("0"))
        coupon_meta = {
            "coupon_code":            coupon.code,
            "coupon_id":              str(coupon.id),
            "coupon_discount":        str(discount),
            "coupon_free_trial_days": int(coupon.free_trial_days) if coupon.discount_type == coupon.Type.FREE_TRIAL else 0,
        }

    payment = Payment.objects.create(
        user           = None,
        subscription   = None,
        amount         = amount,
        status         = Payment.Status.PENDING,
        transaction_id = generate_transaction_id(),
        metadata = {
            "plan_id":        str(plan.id),
            "plan_name":      plan.name,
            "plan_code":      plan.code or "",
            "billing_cycle":  plan.billing_cycle,
            "extra_branches": int(extra_branches or 0),
            "name":           name,
            "username":       username,                 # NEW — buyer-chosen
            "email":          email.lower(),
            "phone":          phone,
            "business_name":  business_name,
            # Postal address — copied onto the User row in
            # process_successful_payment so the admin Client's Info page
            # has it without joining Payment.metadata.
            "address":        address,
            "thana":          thana,
            "district":       district,
            "postal_code":    postal_code,
            # Stashed so the payment webhook can record the Referral once the
            # User row finally exists (post-payment).
            "referral_phone": (referral_phone or "").strip(),
            **coupon_meta,
        },
    )
    logger.info(
        "Pending payment created: txn=%s email=%s plan=%s amount=%s extra_branches=%s referral=%s",
        payment.transaction_id, email, plan.name, amount, extra_branches,
        bool(referral_phone),
    )
    return payment


# ──────────────────────────────────────────────────────────────────────────────
# Trial signup — free 14-day account, no payment
# ──────────────────────────────────────────────────────────────────────────────

class TrialSignupError(Exception):
    """Raised when a trial signup cannot be completed."""


@transaction.atomic
def create_trial_account(
    *,
    name: str,
    username: str,
    email: str,
    phone: str,
    business_name: str,
    address: str = "",
    thana: str = "",
    district: str = "",
    postal_code: str = "",
    referral_phone: str = "",
) -> dict:
    """
    Create user + 14-day trial subscription + tenant record, all atomic.
    After commit: schedules tenant DB provisioning + sends SMS OTP for first login.
    """
    if User.objects.filter(email__iexact=email).exists():
        raise TrialSignupError(f"An account already exists for {email}.")

    # Re-verify the chosen username is still available — guards against the
    # rare race where two trial signups picked the same one between the
    # serializer check and now.
    if not is_username_available(username):
        raise TrialSignupError("This username has already been used.")

    # Pick the seeded trial plan (code='free-trial').
    try:
        trial_plan = Plan.objects.get(code="free-trial", is_trial=True, is_active=True)
    except Plan.DoesNotExist:
        raise TrialSignupError("Free Trial plan is not configured. Contact support.")

    # 1. Create user
    user = User(
        email          = email.lower(),
        name           = name,
        username       = username,                       # buyer-chosen, not auto-generated
        phone          = phone,
        business_name  = business_name,
        address        = address,
        thana          = thana,
        district       = district,
        postal_code    = postal_code,
        status         = User.Status.ACTIVE,
        is_first_login = True,
    )
    user.set_unusable_password()
    user.save()

    # 2. Create subscription (status=ACTIVE, expires in 14 days)
    sub = create_subscription(user=user, plan=trial_plan)

    # 3. Tenant placeholder — DB names slugged from the user's business name.
    db_alias, db_name = build_tenant_identifiers(user)
    tenant = Tenant.objects.create(
        user     = user,
        db_name  = db_name,
        db_alias = db_alias,
        is_provisioned = False,
    )

    # Record referral if one was supplied. Trial signups never award the
    # referrer immediately — awarded_at stays NULL until this trial user
    # makes a non-trial payment (caught by the webhook or daily scheduler).
    if referral_phone:
        referrals_service.record_referral_from_phone(
            new_user=user, referrer_phone=referral_phone, plan=trial_plan,
        )

    logger.info(
        "Trial account provisioned: user=%s expires=%s tenant=%s referral=%s",
        user.email, sub.next_billing_date, tenant.db_name, bool(referral_phone),
    )

    # Send the first-login OTP after the transaction commits so the row is
    # visible to the SMS task. The OTP is the only thing the user needs to
    # reach the password-setup screen — no email link anymore.
    transaction.on_commit(lambda: send_login_otp(user))

    # NB: tenant DB provisioning is INTENTIONALLY deferred until the
    # buyer actually verifies their OTP (see OtpLoginView). Provisioning
    # immediately at signup means abandoned trial sign-ups still show
    # up as fully-provisioned tenants in the admin panel — a real bug
    # we hit when a user submitted the form but never received / typed
    # the OTP. Gating on OTP verify ensures the platform only spends a
    # tenant DB slot on accounts that proved they own the phone number.

    return {
        "user":         user,
        "subscription": sub,
        "tenant":       tenant,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Webhook signature verification
# ──────────────────────────────────────────────────────────────────────────────

def verify_webhook_signature(payload: dict, signature: str) -> bool:
    """
    HMAC-SHA256 signature check for the GENERIC webhook shape.

    Expected signature = hex(hmac(secret, "{txn}|{status}|{amount}")).
    SSLCommerz IPNs are NOT verified here — they carry a `val_id` that must be
    confirmed server-to-server against SSLCommerz's validator API. See
    `validate_sslcommerz_ipn()` and the webhook view, which routes any payload
    carrying `tran_id`/`val_id` through that path instead of this one.

    In DEBUG with no secret configured the check is skipped (dev convenience);
    in production an unsigned/misconfigured webhook is rejected (fail closed).
    """
    secret = getattr(settings, "PAYMENT_GATEWAY_WEBHOOK_SECRET", "")
    if not secret:
        if settings.DEBUG:
            logger.warning("Webhook secret not configured — skipping check (DEBUG mode).")
            return True
        return False   # in production, reject unsigned webhooks

    message = f"{payload['transaction_id']}|{payload['payment_status']}|{payload['amount']}"
    expected = hmac.new(
        secret.encode(), message.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature or "")


# SSLCommerz validator endpoints (server-to-server transaction validation).
_SSLCZ_VALIDATOR_LIVE    = "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
_SSLCZ_VALIDATOR_SANDBOX = "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php"


def validate_sslcommerz_ipn(raw_payload: dict) -> tuple[bool, dict]:
    """
    Authoritatively validate an SSLCommerz IPN / success callback.

    SSLCommerz callbacks are public, unsigned, and trivially forgeable — a buyer
    can replay the browser redirect to self-provision a paid account WITHOUT
    paying. The only trustworthy confirmation is to call SSLCommerz's validator
    API server-to-server with the `val_id` and our store credentials, then
    cross-check the status, transaction id, and amount returned BY SSLCommerz
    (never the values in the incoming request body).

    Returns (ok, confirmed) where `confirmed` carries the SSLCommerz-reported
    {transaction_id, amount, currency, status, raw}. `ok` is True only when the
    validator reports VALID/VALIDATED for the same tran_id.

    Fail-closed: if store credentials are missing, returns False in production
    (DEBUG returns True for local testing without live SSLCommerz access).
    """
    import json
    from urllib.parse import urlencode
    from urllib.request import urlopen
    from urllib.error import URLError, HTTPError

    tran_id = str(raw_payload.get("tran_id", "")).strip()
    val_id  = str(raw_payload.get("val_id", "")).strip()

    store_id   = getattr(settings, "SSL_STORE_ID", "") or ""
    store_pass = getattr(settings, "SSL_STORE_PASSWORD", "") or ""

    if not store_id or not store_pass:
        if settings.DEBUG:
            logger.warning("SSLCommerz store creds not set — skipping IPN validation (DEBUG).")
            return True, {
                "transaction_id": tran_id,
                "amount": raw_payload.get("amount", "0"),
                "currency": raw_payload.get("currency", "BDT"),
                "status": "DEBUG_SKIP",
                "raw": {},
            }
        logger.error("SSLCommerz store creds not configured — rejecting IPN for txn=%s.", tran_id)
        return False, {"detail": "Payment validation not configured."}

    if not val_id:
        logger.warning("SSLCommerz IPN for txn=%s has no val_id — rejecting.", tran_id)
        return False, {"detail": "Missing val_id."}

    base = _SSLCZ_VALIDATOR_SANDBOX if getattr(settings, "SSL_SANDBOX", True) else _SSLCZ_VALIDATOR_LIVE
    query = urlencode({
        "val_id":      val_id,
        "store_id":    store_id,
        "store_passwd": store_pass,
        "format":      "json",
        "v":           "1",
    })
    url = f"{base}?{query}"
    try:
        with urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (HTTPError, URLError, json.JSONDecodeError) as exc:
        logger.error("SSLCommerz validator call failed for txn=%s: %s", tran_id, exc)
        return False, {"detail": "Could not reach the payment validator."}

    status = str(data.get("status", "")).upper()
    confirmed_tran = str(data.get("tran_id", "")).strip()
    ok = status in {"VALID", "VALIDATED"} and confirmed_tran == tran_id and bool(tran_id)
    if not ok:
        logger.warning(
            "SSLCommerz validation rejected txn=%s (status=%s, validator_tran=%s).",
            tran_id, status, confirmed_tran,
        )
    return ok, {
        "transaction_id": confirmed_tran or tran_id,
        # Trust the validator's amount, NOT the request body.
        "amount":   data.get("amount", "0"),
        "currency": data.get("currency", "BDT"),
        "status":   status,
        "raw":      data,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Payment webhook — atomic account provisioning
# ──────────────────────────────────────────────────────────────────────────────

@transaction.atomic
def process_successful_payment(*, transaction_id: str, amount: Decimal) -> dict:
    """
    The core flow triggered by a SUCCESS webhook.

    Steps (all-or-nothing inside one DB transaction):
        1. Lock the Payment row (SELECT FOR UPDATE) — prevents races.
        2. Reject duplicate / already-failed webhooks.
        3. Verify amount hasn't been tampered.
        4. Create the User (status=ACTIVE, unusable password).
        5. Create the Subscription (ACTIVE, start today).
        6. Link payment → user + subscription, mark SUCCESS.
        7. Schedule the first-login SMS OTP to fire AFTER commit.
    """
    # 1. Lock payment row
    try:
        payment = Payment.objects.select_for_update().get(transaction_id=transaction_id)
    except Payment.DoesNotExist:
        raise WebhookError(f"Unknown transaction_id: {transaction_id}")

    # 2. Idempotency check
    if payment.status == Payment.Status.SUCCESS:
        raise DuplicateWebhookError(f"Transaction {transaction_id} already processed.")
    if payment.status == Payment.Status.FAILED:
        raise WebhookError(f"Transaction {transaction_id} is already FAILED.")

    # 3. Amount tamper check
    if Decimal(str(amount)) != payment.amount:
        raise WebhookError(
            f"Amount mismatch: gateway sent {amount}, expected {payment.amount}."
        )

    # 4. Recover buyer info + plan
    meta = payment.metadata or {}
    try:
        plan = Plan.objects.get(id=meta["plan_id"])
    except (Plan.DoesNotExist, KeyError):
        raise WebhookError("Payment metadata is corrupt or plan was deleted.")

    email = meta["email"].lower()
    name  = meta.get("name", "User")

    if User.objects.filter(email__iexact=email).exists():
        raise WebhookError(f"User with email {email} already exists.")

    # Buyer-chosen username from /api/subscribe/. Legacy payments created
    # before this feature shipped still have no `username` key in metadata
    # — we fall back to the auto-generator in that case so old pending
    # transactions don't fail on processing.
    chosen_username = (meta.get("username") or "").strip()
    if chosen_username and is_username_available(chosen_username):
        username = chosen_username
    elif chosen_username:
        # Race: someone took it between subscribe and payment-success.
        # Don't fail the webhook (the buyer already paid) — pick the
        # closest available variant instead.
        suggestions = suggest_usernames(chosen_username, max_suggestions=1)
        username = suggestions[0] if suggestions else generate_username(name)
        logger.warning(
            "Chosen username '%s' was taken by the time webhook fired; "
            "falling back to '%s' for user %s",
            chosen_username, username, email,
        )
    else:
        # Legacy / pre-feature path.
        username = generate_username(name)

    # 5. Create user
    user = User(
        email         = email,
        name          = name,
        username      = username,
        phone         = meta.get("phone", ""),
        business_name = meta.get("business_name", ""),
        address       = meta.get("address", ""),
        thana         = meta.get("thana", ""),
        district      = meta.get("district", ""),
        postal_code   = meta.get("postal_code", ""),
        status        = User.Status.ACTIVE,
        is_first_login = True,
    )
    user.set_unusable_password()
    user.save()

    # 6. Create subscription
    subscription = create_subscription(user=user, plan=plan)

    # 7. Finalise payment
    payment.user         = user
    payment.subscription = subscription
    payment.status       = Payment.Status.SUCCESS
    payment.paid_at      = timezone.now()
    payment.save(update_fields=["user", "subscription", "status", "paid_at"])

    # 8. Create the Tenant mapping record (DB not yet provisioned).
    #    The Celery task fired below will create the physical DB and flip
    #    is_provisioned to True asynchronously. DB names are slugged from
    #    the user's business_name so pgAdmin shows e.g. 'saas_ongko_stationery'.
    db_alias, db_name = build_tenant_identifiers(user)
    tenant = Tenant.objects.create(
        user     = user,
        db_name  = db_name,
        db_alias = db_alias,
        is_provisioned = False,
    )

    # Record + award referral from the metadata stashed at /subscribe time.
    # This is a paid plan, so the reward fires immediately (unlike trial).
    referral_phone = (meta.get("referral_phone") or "").strip()
    if referral_phone:
        referrals_service.record_referral_from_phone(
            new_user=user, referrer_phone=referral_phone, plan=plan,
        )

    # Record a coupon redemption (if one was applied at /subscribe time) and
    # extend the trial for free-trial coupons.
    coupon_code = (meta.get("coupon_code") or "").strip()
    if coupon_code:
        try:
            from . import coupon_admin  # noqa: PLC0415
            from .models import Coupon  # noqa: PLC0415
            coupon = Coupon.objects.filter(code__iexact=coupon_code).first()
            if coupon:
                disc = Decimal(str(meta.get("coupon_discount") or 0))
                coupon_admin.record_redemption(
                    coupon, user=user, payment=payment, subscription=subscription,
                    amount_discounted=disc, gross_amount=payment.amount, is_new=True,
                )
                free_days = int(meta.get("coupon_free_trial_days") or 0)
                if free_days > 0:
                    subscription.next_billing_date = subscription.next_billing_date + timedelta(days=free_days)
                    subscription.save(update_fields=["next_billing_date"])
        except Exception:  # noqa: BLE001
            logger.exception("Failed to record coupon redemption for txn=%s", payment.transaction_id)

    logger.info(
        "Account provisioned: user=%s plan=%s subscription=%s tenant=%s",
        user.email, plan.name, subscription.id, tenant.db_name,
    )

    # After the transaction commits:
    #   • Email the subscription invoice / payment receipt (restored — the
    #     buyer used to get this on every new subscription).
    #   • Dispatch the first-login SMS OTP (replaces the old email link).
    #   • Kick off async tenant DB provisioning (create PostgreSQL DB + migrate).
    #   • Fire the referral reward (paid signup — non-trial, awarded right now).
    # Each task is isolated via _safe_after_commit so a failure in one (most
    # commonly the invoice EMAIL when SMTP isn't configured) can never abort
    # the others. The OTP goes first since it's the most critical — the buyer
    # cannot reach the password-setup screen without it.
    transaction.on_commit(lambda: _safe_after_commit("login_otp", lambda: send_login_otp(user)))
    transaction.on_commit(lambda: _safe_after_commit("subscription_invoice", lambda: _send_subscription_invoice(user, subscription, payment)))
    transaction.on_commit(lambda: _safe_after_commit("tenant_provisioning", lambda: _schedule_tenant_provisioning(str(user.id))))
    transaction.on_commit(lambda: _safe_after_commit("referral_reward", lambda: referrals_service.award_for_first_paid_payment(payment)))

    return {
        "user":         user,
        "subscription": subscription,
        "payment":      payment,
        "tenant":       tenant,
    }


def _schedule_tenant_provisioning(user_id: str) -> None:
    """
    Provision the tenant database synchronously, in-process, right after
    the payment webhook commits.

    History
    ───────
    This used to dispatch a Celery task and only fall back to synchronous
    if the dispatch raised. That check was broken in the common production
    setup where Redis was up but no Celery worker was running: .delay()
    happily pushed the task to Redis, returned an AsyncResult with an id,
    and the code assumed someone would consume it. Nobody did, so every
    brand-new tenant stayed is_provisioned=False forever and the operator
    had to manually run `provision_tenant_now` for each one.

    The fix
    ───────
    Just provision synchronously. CREATE DATABASE + migrate takes a few
    seconds and the user is already waiting on the webhook response — the
    payment gateway is happy to wait that long for a 200. Trading 5s of
    request latency for "every tenant works automatically" is the right
    deal.

    If you ever want async provisioning back, set
    CELERY_TASK_ALWAYS_EAGER=False in .env AND make sure a `celery -A
    config worker` process is actually running and consuming the queue
    — then revert this function to dispatch the task.
    """
    from .tenant_db import provision_tenant  # noqa: PLC0415
    try:
        provision_tenant(user_id)
        logger.info("Tenant DB provisioned synchronously for user_id=%s", user_id)
    except Exception as exc:
        # Don't crash the response — but loudly log so the operator can
        # repair the tenant via `python manage.py provision_tenant_now`.
        logger.exception(
            "Synchronous tenant provisioning FAILED for user_id=%s: %s. "
            "Run `python manage.py provision_tenant_now <email>` to retry.",
            user_id, exc,
        )


def _send_subscription_invoice(user, subscription, payment) -> None:
    """Email the subscription invoice after a new payment commits.

    Imported locally and wrapped in a broad try/except so a rendering or
    SMTP error can never bubble up into the payment webhook response.
    """
    try:
        from .emails import send_subscription_invoice_email  # noqa: PLC0415
        send_subscription_invoice_email(user, subscription, payment)
    except Exception:
        logger.exception("Failed to send subscription invoice email to %s", getattr(user, "email", "?"))


@transaction.atomic
def process_webhook_success(*, transaction_id: str, amount: Decimal) -> dict:
    """
    Unified webhook success handler.

    Routes to the correct flow by inspecting whether the Payment already
    has a user attached:
        payment.user is None  →  new subscription (create user + subscription)
        payment.user is set   →  renewal         (renew existing subscription)
    """
    try:
        payment = Payment.objects.select_related("user").get(transaction_id=transaction_id)
    except Payment.DoesNotExist:
        raise WebhookError(f"Unknown transaction_id: {transaction_id}")

    if payment.user_id is None:
        # New subscription flow
        return process_successful_payment(
            transaction_id=transaction_id,
            amount=amount,
        )
    else:
        # Renewal flow
        return process_renewal_webhook(
            transaction_id=transaction_id,
            amount=amount,
        )


@transaction.atomic
def process_failed_payment(transaction_id: str) -> Payment:
    """Mark a PENDING payment as FAILED. Idempotent."""
    try:
        payment = Payment.objects.select_for_update().get(transaction_id=transaction_id)
    except Payment.DoesNotExist:
        raise WebhookError(f"Unknown transaction_id: {transaction_id}")
    if payment.status == Payment.Status.FAILED:
        return payment
    if payment.status == Payment.Status.SUCCESS:
        raise WebhookError("Cannot mark a SUCCESS payment as FAILED.")
    payment.mark_failed()
    return payment


# ──────────────────────────────────────────────────────────────────────────────
# Subscription helper — reusable
# ──────────────────────────────────────────────────────────────────────────────

def create_subscription(*, user: User, plan: Plan) -> Subscription:
    """Create an ACTIVE subscription starting today."""
    today = timezone.localdate()
    return Subscription.objects.create(
        user              = user,
        plan              = plan,
        start_date        = today,
        next_billing_date = today + timedelta(days=plan.duration_days),
        status            = Subscription.Status.ACTIVE,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Password setup
# ──────────────────────────────────────────────────────────────────────────────

@transaction.atomic
def consume_setup_token(token_str: str, new_password: str) -> User:
    """
    Validate the token, set the user's password, mark is_first_login=False,
    destroy the token (single-use), and send a confirmation SMS.
    """
    try:
        token = (
            PasswordSetupToken.objects
            .select_for_update()
            .select_related("user")
            .get(token=token_str)
        )
    except PasswordSetupToken.DoesNotExist:
        raise PasswordSetupError("Invalid or already-used link.")

    if not token.is_valid:
        token.delete()
        raise PasswordSetupError("This link has expired. Please request a new one.")

    user = token.user
    user.set_password(new_password)
    user.is_first_login = False
    user.save(update_fields=["password", "is_first_login"])
    token.delete()

    # SMS confirmation that the password was set successfully.
    transaction.on_commit(lambda: send_password_set_sms(user))
    return user


# ──────────────────────────────────────────────────────────────────────────────
# Renewal billing — pay-now flow
# ──────────────────────────────────────────────────────────────────────────────

class RenewalError(Exception):
    """Raised when a renewal payment cannot be initiated."""


@transaction.atomic
def create_renewal_payment(*, user: User) -> Payment:
    """
    Called by POST /api/pay-now/ for an authenticated user.

    Finds the user's most recent subscription (ACTIVE or SUSPENDED),
    creates a PENDING Payment linked to that subscription, and returns
    the payment so the caller can redirect to the gateway.

    Raises RenewalError if no eligible subscription exists.
    """
    sub = (
        Subscription.objects
        .filter(user=user, status__in=[Subscription.Status.ACTIVE, Subscription.Status.SUSPENDED])
        .select_related("plan")
        .order_by("-created_at")
        .first()
    )
    if not sub:
        raise RenewalError("No active or suspended subscription found for this account.")

    # Consume the oldest pending DiscountCredit (if any) before creating the
    # Payment row. The credit row is finalised after the payment commits so
    # both rows reference each other.
    base_amount = sub.plan.price
    discounted, credit = referrals_service.apply_pending_discount(
        user=user, base_amount=base_amount,
    )

    payment = Payment.objects.create(
        user           = user,
        subscription   = sub,
        amount         = discounted,
        status         = Payment.Status.PENDING,
        transaction_id = generate_transaction_id(),
        metadata = {
            "type":            "renewal",
            "subscription_id": str(sub.id),
            "plan_id":         str(sub.plan.id),
            "plan_name":       sub.plan.name,
            "base_amount":     str(base_amount),
            "discount_credit_id": str(credit.id) if credit else "",
            "discount_percent":   str(credit.percent) if credit else "0",
        },
    )

    if credit:
        referrals_service.finalize_applied_credit(credit, payment)

    logger.info(
        "Renewal payment created: txn=%s user=%s plan=%s base=%s charged=%s credit=%s",
        payment.transaction_id, user.email, sub.plan.name,
        base_amount, discounted, credit.id if credit else "—",
    )
    return payment


@transaction.atomic
def process_renewal_webhook(*, transaction_id: str, amount: Decimal) -> dict:
    """
    Called by the payment webhook when a SUCCESS event arrives for a
    renewal payment (payment.user is already set — distinguishes from
    new-subscription payments where user is NULL).

    Steps (atomic):
        1. Lock + validate the payment row.
        2. Verify amount.
        3. Renew the subscription (reset next_billing_date + ACTIVE).
        4. Reactivate the user if they were SUSPENDED.
        5. Mark payment SUCCESS.
        6. Send reactivation / renewal-confirmation email.
    """
    from .emails import send_reactivation_email, send_renewal_confirmation_email

    # 1. Lock
    try:
        payment = Payment.objects.select_for_update().get(transaction_id=transaction_id)
    except Payment.DoesNotExist:
        raise WebhookError(f"Unknown transaction_id: {transaction_id}")

    if payment.status == Payment.Status.SUCCESS:
        raise DuplicateWebhookError(f"Transaction {transaction_id} already processed.")
    if payment.status == Payment.Status.FAILED:
        raise WebhookError(f"Transaction {transaction_id} is already FAILED.")

    # 2. Amount check
    if Decimal(str(amount)) != payment.amount:
        raise WebhookError(
            f"Amount mismatch: expected {payment.amount}, got {amount}."
        )

    user = payment.user
    sub  = payment.subscription

    if not user or not sub:
        raise WebhookError("Renewal payment is missing user or subscription reference.")

    was_suspended = (user.status == User.Status.SUSPENDED)

    # 3. Renew subscription
    sub.renew()     # resets start_date, next_billing_date, status = ACTIVE

    # 4. Reactivate user
    user.status    = User.Status.ACTIVE
    user.is_active = True
    user.save(update_fields=["status", "is_active"])

    # 5. Finalise payment
    payment.status  = Payment.Status.SUCCESS
    payment.paid_at = timezone.now()
    payment.save(update_fields=["status", "paid_at"])

    logger.info(
        "Renewal processed: user=%s subscription=%s next_billing=%s was_suspended=%s",
        user.email, sub.id, sub.next_billing_date, was_suspended,
    )

    # 6. Email — reactivation if they were suspended, else a quiet confirmation
    if was_suspended:
        transaction.on_commit(lambda: send_reactivation_email(user, sub))
    else:
        transaction.on_commit(lambda: send_renewal_confirmation_email(user, sub))

    # 7. Referral programme — if this user was referred and the referral
    # hasn't been awarded yet, this is their first non-trial payment, so
    # credit the referrer with 20% off their next month. Idempotent.
    transaction.on_commit(
        lambda: referrals_service.award_for_first_paid_payment(payment)
    )

    return {
        "user":         user,
        "subscription": sub,
        "payment":      payment,
        "reactivated":  was_suspended,
    }


def find_user_by_identifier(identifier: str):
    """Resolve a User from a free-form identifier the person typed: their
    username, email, OR mobile number (any common BD format). Used by the
    self-service forgot-password / OTP flow where the tenant only knows their
    login phone, not the auto-generated username. Returns the User or None.
    """
    identifier = (identifier or "").strip()
    if not identifier:
        return None
    user = User.objects.filter(username__iexact=identifier).first()
    if not user and "@" in identifier:
        user = User.objects.filter(email__iexact=identifier).first()
    if not user:
        from .sms import _normalize_msisdn
        cands = {identifier}
        norm = _normalize_msisdn(identifier)
        if norm:
            cands.add(norm)                                  # 8801XXXXXXXXX
            if norm.startswith("88") and len(norm) == 13:
                cands.add("0" + norm[2:])                    # 01XXXXXXXXX
                cands.add("+" + norm)                        # +8801XXXXXXXXX
        user = User.objects.filter(phone__in=list(cands)).first()
    return user


@transaction.atomic
def resend_login_otp(*, username: str = "", email: str = "", identifier: str = "") -> bool:
    """
    Re-issue an SMS OTP. Resolved by `identifier` (username/email/phone) when
    given, else by username then email — so the same helper works from the
    /login-otp resend button (which knows the username) AND the forgot-password
    flow (which only has the mobile number).

    Always returns True — identical response for unknown identifiers prevents
    user enumeration.
    """
    user = None
    if identifier:
        user = find_user_by_identifier(identifier)
    if not user and username:
        user = User.objects.filter(username__iexact=username).first()
    if not user and email:
        user = User.objects.filter(email__iexact=email).first()
    if not user:
        logger.info(
            "OTP resend requested for unknown identifier (username=%r email=%r id=%r) — ignored.",
            username, email, identifier,
        )
        return True

    # Always issue a fresh OTP for a real user who asked to resend. We used to
    # silently ignore users who already had a password (has_usable_password and
    # not is_first_login). That broke the OTP screen: once a code was consumed
    # (or an admin reset the account), "Resend code" produced nothing, so the
    # next verify reported "No active code" with no way to recover. Issuing a
    # new OTP is safe — it's throttled, anti-enumeration, and the code alone
    # grants no access (it only unlocks the forced password-setup step).
    send_login_otp(user)
    return True


# Back-compat alias — anything still importing the old name keeps working.
def resend_setup_link(email: str) -> bool:
    return resend_login_otp(email=email)
