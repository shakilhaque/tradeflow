"""
Django settings — TradeFlow (single-client POS & Accounting)
"""
from datetime import timedelta
from pathlib import Path
import dj_database_url
from decouple import config, Csv

BASE_DIR = Path(__file__).resolve().parent.parent

# ── Core ──────────────────────────────────────────────────────────────────────
SECRET_KEY    = config("SECRET_KEY")
DEBUG         = config("DEBUG", cast=bool, default=True)
ALLOWED_HOSTS = config("ALLOWED_HOSTS", cast=Csv(), default="localhost,127.0.0.1")

# ── Apps ──────────────────────────────────────────────────────────────────────
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "rest_framework_simplejwt",
    # Stores outstanding + blacklisted refresh tokens so logout / rotation can
    # truly revoke a session. Routed to the master DB (see db_router.MASTER_APPS).
    "rest_framework_simplejwt.token_blacklist",
    "django_celery_beat",
    "drf_spectacular",
    # Our apps
    "core",        # shared response utilities (no models, no migrations)
    "accounts",
    # Tenant-scoped apps (routed to each tenant's database by TenantDatabaseRouter)
    "inventory",
    "sales",
    "purchases",
    "accounting",
    "audit",
    "imports",
    "notifications",
    "system_config",
    # Read-only reporting layer (no models — queries tenant DB via router)
    "reports",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Single-client build: no multi-tenant DB routing and no subscription
    # gating. BranchMiddleware still resolves the active branch (X-Branch-Id)
    # for multi-branch data isolation within the single database.
    "accounts.middleware.BranchMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# ── Templates ─────────────────────────────────────────────────────────────────
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

# ── Database ──────────────────────────────────────────────────────────────────
# Single-client build: one database holds everything (users, products, sales,
# accounting, …). No multi-tenant routing.
DATABASES = {
    "default": dj_database_url.config(
        default=config(
            "DATABASE_URL",
            default="postgresql://postgres:postgres@localhost:5432/nsl_pos",
        )
    )
}

# ── Custom user model ─────────────────────────────────────────────────────────
AUTH_USER_MODEL = "accounts.User"

# ── Password hashing — bcrypt (most secure, resistant to brute-force) ─────────
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.BCryptSHA256PasswordHasher",  # primary
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",        # legacy fallback
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
]

# ── Password validation ───────────────────────────────────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 8},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    # Product rule: must contain uppercase + lowercase + digit + special.
    # Enforced server-side so the UI checklist on SetPasswordPage isn't
    # the only line of defence. See accounts/password_validators.py.
    {"NAME": "accounts.password_validators.ComplexityValidator"},
]

# ── Internationalisation ──────────────────────────────────────────────────────
LANGUAGE_CODE = "en-us"
TIME_ZONE     = "UTC"
USE_I18N      = True
USE_TZ        = True

# ── Static files ──────────────────────────────────────────────────────────────
STATIC_URL  = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"      # destination of `collectstatic`
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ── Media / uploads ───────────────────────────────────────────────────────────
MEDIA_URL  = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# ── AWS S3 (optional — falls back to local /media if creds absent) ───────────
AWS_ACCESS_KEY_ID     = config("AWS_ACCESS_KEY_ID",     default="")
AWS_SECRET_ACCESS_KEY = config("AWS_SECRET_ACCESS_KEY", default="")
AWS_S3_REGION_NAME    = config("AWS_S3_REGION_NAME",    default="us-east-1")
AWS_STORAGE_BUCKET_NAME = config("AWS_STORAGE_BUCKET_NAME", default="")
AWS_S3_CUSTOM_DOMAIN  = config("AWS_S3_CUSTOM_DOMAIN",  default="")  # e.g. cdn.example.com
AWS_S3_ENABLED = bool(AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY and AWS_STORAGE_BUCKET_NAME)

# ── SMS (SSL Wireless, with console fallback) ────────────────────────────────
# When the token / SID are blank, accounts.sms automatically falls back to a
# console backend that prints the SMS body to the logs — perfect for testing
# without a real SIM card. To send real SMS, set these in the env (.env):
#     SSL_WIRELESS_API_TOKEN=<token-from-sslwireless-dashboard>
#     SSL_WIRELESS_SID=IFFAA          # your approved sender ID / mask
SSL_WIRELESS_API_TOKEN = config("SSL_WIRELESS_API_TOKEN", default="")
SSL_WIRELESS_SID       = config("SSL_WIRELESS_SID",       default="")
SSL_WIRELESS_URL       = config(
    "SSL_WIRELESS_URL",
    default="https://smsplus.sslwireless.com/api/v3/send-sms",
)
# Optional: also append every outgoing SMS to this file when the console
# backend is in use. Useful for `tail -f` during development.
SMS_LOG_FILE = config("SMS_LOG_FILE", default="")

# ── Email ─────────────────────────────────────────────────────────────────────
EMAIL_BACKEND     = config("EMAIL_BACKEND", default="django.core.mail.backends.console.EmailBackend")
EMAIL_HOST        = config("EMAIL_HOST",    default="smtp.sendgrid.net")
EMAIL_PORT        = config("EMAIL_PORT",    cast=int, default=587)
EMAIL_USE_TLS     = config("EMAIL_USE_TLS", cast=bool, default=True)
EMAIL_HOST_USER   = config("EMAIL_HOST_USER",     default="apikey")
EMAIL_HOST_PASSWORD = config("EMAIL_HOST_PASSWORD", default="")
DEFAULT_FROM_EMAIL = config("DEFAULT_FROM_EMAIL",  default="noreply@example.com")

# ── App-level config ──────────────────────────────────────────────────────────
SUPPORT_EMAIL          = config("SUPPORT_EMAIL",          default="infoiffaa@gmail.com")
SUPPORT_PHONE          = config("SUPPORT_PHONE",          default="01833387744")
SUPPORT_OFFICE_ADDRESS = config("SUPPORT_OFFICE_ADDRESS", default="House #12, Road 7, Dhanmondi, Dhaka 1209, Bangladesh")
SUPPORT_HOURS          = config("SUPPORT_HOURS",          default="Sun – Thu, 10 am – 6 pm (BD time)")
FRONTEND_URL   = config("FRONTEND_URL",   default="http://localhost:3050")
APP_NAME       = config("APP_NAME",       default="TradeFlow")

PAYMENT_GATEWAY_URL            = config("PAYMENT_GATEWAY_URL",            default="")
PAYMENT_GATEWAY_WEBHOOK_SECRET = config("PAYMENT_GATEWAY_WEBHOOK_SECRET", default="")
PAYMENT_GATEWAY_PROVIDER       = config("PAYMENT_GATEWAY_PROVIDER",       default="")
BACKEND_BASE_URL               = config("BACKEND_BASE_URL",               default="http://127.0.0.1:8003")

# SSLCommerz (sandbox/live)
SSL_STORE_ID                   = config("SSL_STORE_ID",       default="")
SSL_STORE_PASSWORD             = config("SSL_STORE_PASSWORD", default="")
SSL_SANDBOX                    = config("SSL_SANDBOX", cast=bool, default=True)

# ── drf-spectacular (OpenAPI / Swagger) ───────────────────────────────────────
SPECTACULAR_SETTINGS = {
    "TITLE":       "IFFAA Accounting System API",
    "DESCRIPTION": (
        "Complete REST API for the multi-tenant SaaS point-of-sale and accounting system.\n\n"
        "## Authentication\n"
        "All endpoints (except `/api/plans/`, `/api/subscribe/`, `/api/payment/webhook/`, "
        "`/api/set-password/`, and `/api/auth/login/`) require a JWT Bearer token.\n\n"
        "Obtain a token via **POST /api/auth/login/** and include it in the "
        "`Authorization: Bearer <token>` header.\n\n"
        "## Standard Response Envelope\n"
        "Every response (success or error) is wrapped in a standard JSON envelope:\n\n"
        "**Success:**\n```json\n{\"status\": \"success\", \"data\": {}, \"message\": \"\"}\n```\n\n"
        "**Error:**\n```json\n{\"status\": \"error\", \"data\": null, "
        "\"message\": \"...\", \"errors\": {}}\n```\n\n"
        "## Role Permissions\n"
        "| Role | Permissions |\n"
        "|---|---|\n"
        "| **owner** | All 13 permissions |\n"
        "| **admin** | All except `can_manage_settings` |\n"
        "| **manager** | Sales, products, expenses, reports, audit |\n"
        "| **cashier** | Create and edit sales only |\n"
    ),
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,

    # Security scheme — Bearer JWT
    "SECURITY": [{"BearerAuth": []}],
    "SCHEMA_PATH_PREFIX": "/api/",
    "COMPONENT_SPLIT_REQUEST": True,

    # Use our custom renderer so content type is correct
    "DEFAULT_GENERATOR_CLASS": "drf_spectacular.generators.SchemaGenerator",

    # Postprocessing: apply standard envelope wrapper to every response schema
    "POSTPROCESSING_HOOKS": [
        "drf_spectacular.hooks.postprocess_schema_enums",
        "core.schema.wrap_envelope_hook",
    ],

    # Tags ordering for clean Swagger UI sidebar
    "TAGS": [
        {"name": "Auth",          "description": "Login, token refresh, password setup"},
        {"name": "Plans",         "description": "Subscription plans (public)"},
        {"name": "Billing",       "description": "Subscription status and payment history"},
        {"name": "Inventory",     "description": "Products, stock, FIFO layers"},
        {"name": "Sales",         "description": "Sales lifecycle, payments, back-orders"},
        {"name": "Customers",     "description": "Customer CRUD"},
        {"name": "Accounting",    "description": "Chart of accounts, journal entries, expenses"},
        {"name": "Reports",       "description": "Sales, stock, expense, tax, product reports"},
        {"name": "Audit",         "description": "Audit trail"},
        {"name": "Imports",       "description": "CSV/XLSX bulk import (validate → commit)"},
        {"name": "Notifications", "description": "In-app notifications"},
        {"name": "Settings",      "description": "System settings and tax groups"},
    ],

    # Enum suffixes
    "ENUM_GENERATE_CHOICE_DESCRIPTION": True,
    "ENUM_ADD_EXPLICIT_BLANK_NULL_CHOICE": False,

    # Disambiguate colliding enum names (status / payment_status appear in multiple models)
    "ENUM_NAME_OVERRIDES": {
        "SaleStatusEnum":        "sales.models.Sale.Status",
        "PaymentStatusEnum":     "sales.models.Sale.PaymentStatus",
        "BackOrderStatusEnum":   "sales.models.BackOrder.Status",
        "ImportBatchStatusEnum": "imports.models.ImportBatch.Status",
        "NotificationStatusEnum": "notifications.models.Notification.Status",
        "SalePaymentMethodEnum": "sales.models.SalePayment.Method",
    },

    # Sorting
    "SORT_OPERATIONS": False,

    # Swagger UI config
    "SWAGGER_UI_SETTINGS": {
        "deepLinking": True,
        "persistAuthorization": True,
        "displayOperationId": False,
        "defaultModelsExpandDepth": 2,
        "defaultModelExpandDepth": 3,
        "docExpansion": "list",
        "filter": True,
    },

    # ReDoc config
    "REDOC_UI_SETTINGS": {
        "hideDownloadButton": False,
        "expandResponses": "200,201",
        "pathInMiddlePanel": True,
    },
}

# OpenAPI security scheme definition (JWT Bearer)
SPECTACULAR_SETTINGS["APPEND_COMPONENTS"] = {
    "securitySchemes": {
        "BearerAuth": {
            "type":   "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": (
                "JWT access token obtained from **POST /api/auth/login/**. "
                "Token lifetime: 30 minutes. Use the refresh token to obtain a new access token."
            ),
        }
    }
}

# ── DRF ───────────────────────────────────────────────────────────────────────
REST_FRAMEWORK = {
    # Standard JSON envelope: {"status": "success"|"error", "data": ..., "message": ...}
    "DEFAULT_RENDERER_CLASSES": [
        "core.responses.StandardJSONRenderer",
    ],
    "EXCEPTION_HANDLER": "core.responses.api_custom_exception_handler",
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    # Fail CLOSED: every endpoint requires authentication unless it explicitly
    # opts out with `permission_classes = [AllowAny]` (all public auth /
    # marketing / webhook views already do). This guarantees a newly-added view
    # that forgets to set permissions is private by default, not world-open.
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_AUTHENTICATION_CLASSES": [
        # Force-logout-aware JWT: rejects tokens issued before the user's
        # force_logout_at (Super Admin "Force Logout"). Falls back to normal
        # JWT behaviour for everyone else.
        "accounts.auth.ForceLogoutAwareJWTAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "200/hour",
        "user": "2000/hour",
        # Dedicated, tight scopes for credential / OTP endpoints (brute-force
        # defence — see the views that set `throttle_scope`). Keyed by IP for
        # anonymous callers. Tunable via .env without a code change.
        "login":      config("THROTTLE_LOGIN",      default="8/min"),
        "otp":        config("THROTTLE_OTP",        default="5/min"),
        "otp_resend": config("THROTTLE_OTP_RESEND", default="3/min"),
    },
}

# ── JWT ───────────────────────────────────────────────────────────────────────
# Access token lifetime = 30 min inactivity auto-logout.
# Refresh token = 1 day (sliding window; frontend should refresh on activity).
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME":    timedelta(minutes=config("JWT_ACCESS_MINUTES",  cast=int, default=30)),
    "REFRESH_TOKEN_LIFETIME":   timedelta(days   =config("JWT_REFRESH_DAYS",   cast=int, default=1)),
    "ROTATE_REFRESH_TOKENS":    True,
    # Blacklist the OLD refresh token on every rotation, so a captured/replayed
    # refresh token stops working as soon as the legitimate client refreshes,
    # and an explicit logout can hard-revoke the session.
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN":        True,   # update User.last_login on token refresh
    "AUTH_HEADER_TYPES":        ("Bearer",),
    "USER_ID_FIELD":            "id",
    "USER_ID_CLAIM":            "user_id",
    # Security: include role in token so the frontend can show/hide UI elements
    "TOKEN_OBTAIN_SERIALIZER":  "accounts.serializers.CustomTokenObtainPairSerializer",
    # Allow suspended (is_active=False) users to authenticate so they can reach
    # the billing / pay-now endpoints. The SubscriptionMiddleware then restricts
    # which routes a suspended user is actually allowed to hit.
    "USER_AUTHENTICATION_RULE": "accounts.auth.allow_suspended_user_rule",
}

# ── Redis cache — used for report caching and rate limiting ───────────────────
REDIS_URL = config("REDIS_URL", default="redis://localhost:6379/3")

if DEBUG:
    # Development: use in-memory cache so Redis is not required locally.
    CACHES = {
        "default": {
            "BACKEND":    "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION":   "saas-dev-cache",
            "KEY_PREFIX": "saas",
            "TIMEOUT":    300,
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND":    "django.core.cache.backends.redis.RedisCache",
            "LOCATION":   REDIS_URL,
            "KEY_PREFIX": "saas",
            "TIMEOUT":    300,
        }
    }

# ── Security hardening ────────────────────────────────────────────────────────
SECURE_PROXY_SSL_HEADER   = ("HTTP_X_FORWARDED_PROTO", "https")
X_FRAME_OPTIONS           = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True
# Referrer-Policy + cross-origin isolation — sane modern defaults (no breakage
# for a same-origin SPA). `SECURE_BROWSER_XSS_FILTER` was removed: the legacy
# X-XSS-Protection header it emits is deprecated and a no-op in current browsers.
SECURE_REFERRER_POLICY    = config("SECURE_REFERRER_POLICY", default="strict-origin-when-cross-origin")

# In production, set these via environment:
#   DEBUG=False
#   SECURE_SSL_REDIRECT=True
#   SESSION_COOKIE_SECURE=True
#   CSRF_COOKIE_SECURE=True
#   SECURE_HSTS_SECONDS=31536000   (only once HTTPS is confirmed everywhere)
SECURE_SSL_REDIRECT      = config("SECURE_SSL_REDIRECT",      cast=bool, default=False)
SESSION_COOKIE_SECURE    = config("SESSION_COOKIE_SECURE",    cast=bool, default=False)
CSRF_COOKIE_SECURE       = config("CSRF_COOKIE_SECURE",       cast=bool, default=False)
SESSION_COOKIE_HTTPONLY  = True
SESSION_COOKIE_SAMESITE  = config("SESSION_COOKIE_SAMESITE", default="Lax")
CSRF_COOKIE_SAMESITE     = config("CSRF_COOKIE_SAMESITE",    default="Lax")
# HSTS — opt-in via env so a misconfigured cert can't lock users out. Set
# SECURE_HSTS_SECONDS=31536000 in prod once HTTPS is verified on every host.
SECURE_HSTS_SECONDS           = config("SECURE_HSTS_SECONDS",           cast=int,  default=0)
SECURE_HSTS_INCLUDE_SUBDOMAINS = config("SECURE_HSTS_INCLUDE_SUBDOMAINS", cast=bool, default=True)
SECURE_HSTS_PRELOAD            = config("SECURE_HSTS_PRELOAD",            cast=bool, default=True)
SESSION_COOKIE_AGE       = 1800   # 30 minutes — matches JWT access token lifetime
SESSION_EXPIRE_AT_BROWSER_CLOSE = True

# ── Celery ────────────────────────────────────────────────────────────────────
CELERY_BROKER_URL         = config("CELERY_BROKER_URL",      default="redis://localhost:6379/1")
CELERY_RESULT_BACKEND     = config("CELERY_RESULT_BACKEND",  default="redis://localhost:6379/2")
CELERY_ACCEPT_CONTENT     = ["json"]
CELERY_TASK_SERIALIZER    = "json"
CELERY_RESULT_SERIALIZER  = "json"
CELERY_TIMEZONE           = "UTC"
CELERY_BEAT_SCHEDULER     = "django_celery_beat.schedulers:DatabaseScheduler"

# Eager mode: when True, .delay() runs the task INSIDE the current
# request instead of pushing it to Redis. We need this in every prod
# deployment that doesn't have an actual `celery worker` process running,
# otherwise tasks (welcome SMS, OTP emails, etc.) silently vanish into
# Redis and never execute.
#
# Default = True in DEBUG, True in prod unless explicitly opted out by
# setting CELERY_TASK_ALWAYS_EAGER=False in .env (which you should only
# do once you've set up a real worker + beat process).
CELERY_TASK_ALWAYS_EAGER = config("CELERY_TASK_ALWAYS_EAGER", cast=bool, default=True)
if CELERY_TASK_ALWAYS_EAGER:
    CELERY_TASK_EAGER_PROPAGATES = True               # raise exceptions inline (easier debugging)
    CELERY_RESULT_BACKEND        = "cache+memory://"  # no broker needed

# ── Subscription rules ────────────────────────────────────────────────────────
# Grace period in days before a subscription is hard-suspended after expiry.
SUBSCRIPTION_GRACE_DAYS   = config("SUBSCRIPTION_GRACE_DAYS", cast=int, default=0)
# Days before expiry to send the renewal reminder email.
SUBSCRIPTION_REMINDER_DAYS = config("SUBSCRIPTION_REMINDER_DAYS", cast=int, default=3)

# ── Logging ───────────────────────────────────────────────────────────────────
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {"format": "[{levelname}] {asctime} {name}: {message}", "style": "{"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "accounts": {"handlers": ["console"], "level": "DEBUG", "propagate": False},
    },
}
