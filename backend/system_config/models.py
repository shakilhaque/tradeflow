"""
System Configuration models — stored in each TENANT's dedicated PostgreSQL database.

Tables
──────
  system_settings — key/value store for tenant-level configuration
  tax_groups      — named tax rates that can be applied to sales

Design
──────
• Settings are stored as strings and coerced to the appropriate Python type
  by SystemSetting.typed_value (controlled by the `value_type` field).
• The service layer caches settings in Redis; never read SystemSetting directly —
  always use system_config.services.get_setting() / set_setting().
• TaxGroup rows are referenced by the sales module at checkout time.
"""

import uuid
from django.db import models
from django.utils import timezone


class SystemSetting(models.Model):
    """
    Tenant-scoped key/value configuration store.

    Keys are defined as constants in system_config.services.SettingKeys.
    value_type determines how value_str is coerced when read via typed_value.
    """

    class ValueType(models.TextChoices):
        STRING  = "STRING",  "String"
        INTEGER = "INTEGER", "Integer"
        FLOAT   = "FLOAT",   "Float / Decimal"
        BOOLEAN = "BOOLEAN", "Boolean"
        JSON    = "JSON",    "JSON Object"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key            = models.CharField(
        max_length=100, unique=True, db_index=True,
        help_text="Dot-separated key, e.g. 'currency.symbol'.",
    )
    value_str      = models.TextField(
        help_text="Stored as text; see value_type for how to interpret.",
    )
    value_type     = models.CharField(
        max_length=10,
        choices=ValueType.choices,
        default=ValueType.STRING,
    )
    description    = models.CharField(max_length=300, blank=True)
    updated_by_id  = models.UUIDField(
        null=True, blank=True,
        help_text="UUID of the User who last changed this setting.",
    )
    updated_at     = models.DateTimeField(auto_now=True)
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "system_settings"
        ordering = ["key"]

    def __str__(self):
        return f"{self.key} = {self.value_str!r}"

    @property
    def typed_value(self):
        """Coerce value_str to its native Python type."""
        import json
        v = self.value_str
        if self.value_type == self.ValueType.INTEGER:
            return int(v)
        if self.value_type == self.ValueType.FLOAT:
            from decimal import Decimal
            return Decimal(v)
        if self.value_type == self.ValueType.BOOLEAN:
            return v.lower() in ("1", "true", "yes", "on")
        if self.value_type == self.ValueType.JSON:
            return json.loads(v)
        return v  # STRING


class TaxGroup(models.Model):
    """
    Named tax rate (e.g. VAT 15%, No Tax 0%).

    One TaxGroup can be marked as is_default; it pre-selects in the POS UI.
    The rate field holds the tax percentage (e.g. 15 for 15%).
    """

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code         = models.CharField(max_length=20, unique=True, db_index=True)
    name         = models.CharField(max_length=100)
    rate         = models.DecimalField(
        max_digits=6,
        decimal_places=4,
        help_text="Tax rate as a percentage, e.g. 15.0000 for 15%.",
    )
    is_default   = models.BooleanField(
        default=False,
        help_text="Only one TaxGroup should be marked as default.",
    )
    is_active    = models.BooleanField(default=True, db_index=True)
    description  = models.CharField(max_length=300, blank=True)
    created_at   = models.DateTimeField(auto_now_add=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tax_groups"
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.rate}%)"

    @property
    def rate_decimal(self):
        """Rate as a multiplier: 15% → Decimal('0.15')."""
        from decimal import Decimal
        return (self.rate / Decimal("100")).quantize(Decimal("0.0001"))
