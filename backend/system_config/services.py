"""
System Configuration services.

Public API
──────────
  SettingKeys          — constant class for all known setting keys
  get_setting(key, default=None)  → typed Python value (Redis-cached)
  set_setting(key, value, *, updated_by_id=None)  → SystemSetting
  get_all_settings()   → dict[key → typed_value]
  invalidate_setting_cache(key)   → None

Cache behaviour
───────────────
• get_setting() is cached in Redis under 'saas:syscfg:<key>' for 10 minutes.
• set_setting() immediately invalidates the cache for that key.
• All cache failures are silent — falls back to DB read.

Value serialisation
───────────────────
• Python value → value_str:
    - bool: "true" / "false"
    - int / float / Decimal: str(value)
    - dict / list: json.dumps(value)
    - str: as-is
• value_type is inferred from the Python type of `value`
  when calling set_setting().
"""

import json
import logging
from decimal import Decimal

from accounts.tenant_db import get_current_db_alias


def _current_db() -> str:
    """Return the active tenant DB alias, falling back to 'default'."""
    return get_current_db_alias() or "default"

logger = logging.getLogger(__name__)

_CACHE_PREFIX = "syscfg:"
_CACHE_TTL    = 600   # 10 minutes


# ──────────────────────────────────────────────────────────────────────────────
# Setting key constants
# ──────────────────────────────────────────────────────────────────────────────

class SettingKeys:
    """
    All known system setting keys.

    Grouped by subsystem.  Import this class wherever you need a setting key
    to avoid typos and enable IDE navigation.
    """

    # Currency
    CURRENCY_SYMBOL   = "currency.symbol"      # e.g. "USD"
    CURRENCY_CODE     = "currency.code"        # e.g. "USD"
    CURRENCY_POSITION = "currency.position"    # "before" | "after"

    # Tax
    TAX_DEFAULT_RATE      = "tax.default_rate"      # Decimal, e.g. "0"
    TAX_INCLUSIVE         = "tax.inclusive"          # bool: price includes tax
    TAX_REGISTRATION_NO   = "tax.registration_no"   # string

    # Barcode
    BARCODE_AUTO_GENERATE = "barcode.auto_generate"   # bool: auto EAN-13 on new product
    BARCODE_PREFIX        = "barcode.prefix"          # string, e.g. "2"

    # Receipt
    RECEIPT_HEADER        = "receipt.header"          # store name / header text
    RECEIPT_FOOTER        = "receipt.footer"          # thank-you message
    RECEIPT_SHOW_TAX      = "receipt.show_tax"        # bool

    # Low stock
    LOW_STOCK_CHECK_ENABLED = "low_stock.check_enabled"   # bool
    LOW_STOCK_DEFAULT_QTY   = "low_stock.default_qty"     # int fallback reorder level

    # Sales
    SALES_ALLOW_NEGATIVE_STOCK = "sales.allow_negative_stock"  # bool

    # Date/time
    TIMEZONE = "timezone"   # e.g. "UTC", "Africa/Nairobi"

    # ── Company / tenant profile ────────────────────────────────────────────
    # Source of truth for the sidebar header + invoice footer + receipt
    # branding. All optional — the tenant can leave them blank and the UI
    # falls back to the User.business_name from signup.
    COMPANY_NAME       = "company.name"
    COMPANY_LOGO_URL   = "company.logo_url"
    COMPANY_ADDRESS    = "company.address"
    COMPANY_PHONE      = "company.phone"
    COMPANY_EMAIL      = "company.email"
    COMPANY_TAX_NUMBER = "company.tax_number"
    COMPANY_WEBSITE    = "company.website"

    # ── Invoice slip design (per-tenant) ────────────────────────────────────
    # Rendered by frontend `<InvoiceSlip>` everywhere an invoice / receipt
    # is printed. Each key is optional — UI falls back to sensible defaults
    # so a fresh tenant still gets a valid-looking invoice. The design is
    # SHARED but every tenant's brand block (logo, name, tagline) and
    # payment / terms blocks are pulled from these keys, guaranteeing that
    # tenant A's printed invoice is visually distinct from tenant B's.
    # Invoice number prefix template — controls _generate_invoice_number()
    # in sales/services.py. The default `INV` (literal) is replaced at
    # render time with the tenant's company code and the day's date:
    #   INV-<CODE>-DDMMYYYY-NNN     →   INV-ONG-06062026-001
    # The tenant can change this to anything — e.g. `BILL` would yield
    #   BILL-ONG-06062026-001
    # Empty string falls back to the literal `INV`.
    INVOICE_PREFIX               = "invoice.prefix"                  # "INV"
    INVOICE_TAGLINE              = "invoice.tagline"                 # "TAGLINE SPACE HERE"
    INVOICE_THANK_YOU            = "invoice.thank_you"               # "Thank you for your business"
    INVOICE_PAYMENT_BANK_ACCOUNT = "invoice.payment.bank_account"    # "1234 5678 9012"
    INVOICE_PAYMENT_AC_NAME      = "invoice.payment.ac_name"         # "Iffaa Stationery Ltd"
    INVOICE_PAYMENT_BANK_DETAILS = "invoice.payment.bank_details"    # "ABC Bank, Gulshan Branch"
    INVOICE_TERMS                = "invoice.terms"                   # Terms & Conditions block
    INVOICE_PRIMARY_COLOR        = "invoice.primary_color"           # hex, e.g. "#14b8a6"
    INVOICE_AUTHORISED_SIGN      = "invoice.authorised_sign"         # label, e.g. "Authorised Sign"
    INVOICE_FOOTER_NOTE          = "invoice.footer_note"             # optional small text below totals


# ──────────────────────────────────────────────────────────────────────────────
# Cache helpers
# ──────────────────────────────────────────────────────────────────────────────

def _cache_key(db_alias: str, key: str) -> str:
    return f"{_CACHE_PREFIX}{db_alias}:{key}"


def _get_cache(cache_key: str):
    try:
        from django.core.cache import cache
        return cache.get(cache_key)
    except Exception as exc:
        logger.debug("Cache get failed for %s: %s", cache_key, exc)
        return None


def _set_cache(cache_key: str, value) -> None:
    try:
        from django.core.cache import cache
        cache.set(cache_key, value, _CACHE_TTL)
    except Exception as exc:
        logger.debug("Cache set failed for %s: %s", cache_key, exc)


def _delete_cache(cache_key: str) -> None:
    try:
        from django.core.cache import cache
        cache.delete(cache_key)
    except Exception as exc:
        logger.debug("Cache delete failed for %s: %s", cache_key, exc)


# ──────────────────────────────────────────────────────────────────────────────
# Serialisation
# ──────────────────────────────────────────────────────────────────────────────

def _to_str_and_type(value) -> tuple[str, str]:
    """
    Convert a Python value to (value_str, value_type) for storage.
    value_type corresponds to SystemSetting.ValueType choices.
    """
    if isinstance(value, bool):
        return ("true" if value else "false"), "BOOLEAN"
    if isinstance(value, int):
        return str(value), "INTEGER"
    if isinstance(value, (float, Decimal)):
        return str(value), "FLOAT"
    if isinstance(value, (dict, list)):
        return json.dumps(value), "JSON"
    return str(value), "STRING"


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def get_setting(key: str, default=None):
    """
    Retrieve a setting by key, returning its typed Python value.

    Priority: Redis cache → DB → default.
    """
    db = _current_db()
    ck = _cache_key(db, key)

    cached = _get_cache(ck)
    if cached is not None:
        return cached

    from .models import SystemSetting
    try:
        obj = SystemSetting.objects.using(db).get(key=key)
        value = obj.typed_value
        _set_cache(ck, value)
        return value
    except SystemSetting.DoesNotExist:
        return default
    except Exception as exc:
        logger.error("get_setting('%s') DB error: %s", key, exc)
        return default


def set_setting(key: str, value, *, updated_by_id=None, description: str = ""):
    """
    Create or update a setting.  Invalidates the Redis cache immediately.

    Returns the SystemSetting instance.
    """
    from .models import SystemSetting
    db = _current_db()

    value_str, value_type = _to_str_and_type(value)

    defaults = {"value_str": value_str, "value_type": value_type}
    if description:
        defaults["description"] = description
    if updated_by_id is not None:
        defaults["updated_by_id"] = updated_by_id

    obj, _ = SystemSetting.objects.using(db).update_or_create(
        key=key, defaults=defaults
    )

    invalidate_setting_cache(key)
    logger.info("Setting '%s' updated to %r by user %s", key, value_str, updated_by_id)
    return obj


def get_all_settings() -> dict:
    """
    Return all settings as a dict of {key: typed_value}.

    Useful for the settings management page; not cached as a whole.
    """
    from .models import SystemSetting
    db = _current_db()
    return {obj.key: obj.typed_value
            for obj in SystemSetting.objects.using(db).all()}


def invalidate_setting_cache(key: str) -> None:
    """Remove a specific key from the Redis cache."""
    db = _current_db()
    _delete_cache(_cache_key(db, key))


def get_tax_groups(*, active_only: bool = True) -> list:
    """Return all TaxGroup rows, optionally filtered to active only."""
    from .models import TaxGroup
    db = _current_db()
    qs = TaxGroup.objects.using(db)
    if active_only:
        qs = qs.filter(is_active=True)
    return list(qs)


def get_default_tax_group():
    """Return the default TaxGroup or None."""
    from .models import TaxGroup
    db = _current_db()
    return TaxGroup.objects.using(db).filter(is_default=True, is_active=True).first()
