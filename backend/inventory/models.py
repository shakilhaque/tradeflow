"""
Inventory module models — stored in each TENANT's dedicated PostgreSQL database.

The TenantDatabaseRouter routes all queries for the `inventory` app label to the
thread-local tenant alias set by TenantMiddleware.  These tables are NEVER
created in the master (default) database.

Model hierarchy
───────────────
  Unit, Brand, Category          — master data (no FK deps)
  Location                       — company branches / warehouses
  Product                        — product master (refs Unit, Brand, Category)
  ProductStock                   — per-location quantity snapshot (denormalized)
  FIFOLayer                      — global FIFO cost queue (one layer per purchase batch)
  StockMovement                  — immutable audit trail of every stock change

FIFO contract
─────────────
  • FIFOLayer rows are GLOBAL per product — NOT per location.
  • FIFO order is created_at ASC (oldest layers consumed first).
  • remaining_qty starts equal to initial_qty and only decreases.
  • ProductStock is a fast-read snapshot; FIFOLayer is the source of truth for cost.
"""

import uuid
import secrets
import string
from decimal import Decimal

from django.db import models
from django.utils import timezone

from accounts.soft_delete import SoftDeleteMixin


# ──────────────────────────────────────────────────────────────────────────────
# Barcode / SKU helpers
# ──────────────────────────────────────────────────────────────────────────────

def _generate_sku() -> str:
    """
    Auto-generate a unique-looking SKU: 'SKU-' + 8 uppercase alphanumeric chars.
    Uniqueness is enforced at the DB level; callers may regenerate on collision.
    Example: SKU-A3F9K2XP
    """
    alphabet = string.ascii_uppercase + string.digits
    return "SKU-" + "".join(secrets.choice(alphabet) for _ in range(8))


def generate_ean13() -> str:
    """
    Generate a valid EAN-13 barcode in the internal-use range (prefix 2xx).

    Structure: [2][11 random digits][1 check digit]
    Check digit = (10 - (weighted_sum % 10)) % 10
    Weights alternate 1, 3, 1, 3 … for positions 1-12.
    """
    body = "2" + "".join(str(secrets.randbelow(10)) for _ in range(11))
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(body))
    check = (10 - (total % 10)) % 10
    return body + str(check)


# ──────────────────────────────────────────────────────────────────────────────
# 1. Unit
# ──────────────────────────────────────────────────────────────────────────────

class Unit(models.Model):
    """Unit of measure — Piece, Kilogram, Litre, Box …"""

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name          = models.CharField(max_length=50, unique=True)         # "Kilogram"
    abbreviation  = models.CharField(max_length=10, unique=True)         # "kg"
    allow_decimal = models.BooleanField(default=False)                   # 1.5kg allowed?
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "units"
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.abbreviation})"


# ──────────────────────────────────────────────────────────────────────────────
# 2. Brand
# ──────────────────────────────────────────────────────────────────────────────

class Brand(models.Model):
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name       = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "brands"
        ordering = ["name"]

    def __str__(self):
        return self.name


# ──────────────────────────────────────────────────────────────────────────────
# 3. Category
# ──────────────────────────────────────────────────────────────────────────────

class Category(models.Model):
    """
    Hierarchical product category (parent → children).
    Parent is nullable → top-level categories have no parent.
    """

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name        = models.CharField(max_length=100)
    code        = models.CharField(max_length=30, blank=True, default="", db_index=True)
    description = models.TextField(blank=True, default="")
    parent      = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="children",
    )
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table        = "categories"
        ordering        = ["name"]
        unique_together = [["name", "parent"]]

    def __str__(self):
        return self.name

    @property
    def full_path(self) -> str:
        """Breadcrumb-style name: Electronics > Phones > Smartphones"""
        parts = [self.name]
        node  = self.parent
        while node:
            parts.insert(0, node.name)
            node = node.parent
        return " > ".join(parts)


# ──────────────────────────────────────────────────────────────────────────────
# 4. Location
# ──────────────────────────────────────────────────────────────────────────────

class Location(models.Model):
    """Company branch or warehouse."""

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name       = models.CharField(max_length=100)
    code       = models.CharField(max_length=20, unique=True, db_index=True)
    address    = models.TextField(blank=True)
    is_active  = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "locations"
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.code})"


# ──────────────────────────────────────────────────────────────────────────────
# 5. Product
# ──────────────────────────────────────────────────────────────────────────────

class Product(SoftDeleteMixin, models.Model):
    """
    Product master record.

    cost_price is informational only — FIFO layers hold the authoritative cost.
    selling_price is the default retail price; can be overridden at sale time.

    Soft-delete: product.delete() sets is_deleted=True.  The default manager
    (objects) hides soft-deleted products.  Use Product.all_objects to include
    deleted records (e.g. for audit purposes or restoring).
    """

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name          = models.CharField(max_length=200, db_index=True)
    sku           = models.CharField(
        max_length=50,
        unique=True,
        default=_generate_sku,
        db_index=True,
        help_text="Auto-generated if not provided. Format: SKU-XXXXXXXX.",
    )
    barcode       = models.CharField(
        max_length=20,
        unique=True,
        null=True,
        blank=True,
        db_index=True,
        help_text="EAN-13 or other barcode. Auto-generated on request.",
    )
    category      = models.ForeignKey(
        Category,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="products",
    )
    brand         = models.ForeignKey(
        Brand,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="products",
    )
    unit          = models.ForeignKey(
        Unit,
        on_delete=models.PROTECT,
        related_name="products",
    )
    warranty_days = models.PositiveIntegerField(
        default=0,
        help_text="Warranty period in days. 0 = no warranty.",
    )
    # Named warranty term (defined on the Warranties page) assigned to this
    # product. Shown as the "Warranty" column on the List Products page.
    warranty = models.ForeignKey(
        "Warranty",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="products",
        help_text="Optional warranty term assigned to this product.",
    )
    reorder_level = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        default=Decimal("0"),
        help_text="Minimum stock quantity before a low-stock alert fires.",
    )
    selling_price = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        default=Decimal("0"),
    )
    cost_price    = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        default=Decimal("0"),
        help_text="Default purchase / unit cost (informational; FIFO layers are authoritative).",
    )
    tax_rate      = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=Decimal("0"),
        help_text="Default tax % applied at sale time.",
    )
    tax_type      = models.CharField(
        max_length=10,
        default="exclusive",
        choices=[("inclusive", "Inclusive"), ("exclusive", "Exclusive")],
    )
    product_type  = models.CharField(
        max_length=10,
        default="single",
        choices=[("single", "Single"), ("variable", "Variable"), ("combo", "Combo")],
    )
    barcode_type  = models.CharField(
        max_length=15,
        default="C128",
        help_text="Barcode standard: C128, EAN13, EAN8, UPC-A, UPC-E …",
    )
    weight        = models.DecimalField(
        max_digits=10, decimal_places=3, null=True, blank=True,
    )
    not_for_selling = models.BooleanField(default=False, db_index=True)
    image_url     = models.URLField(blank=True, default="")
    meta          = models.JSONField(default=dict, blank=True)
    # `extras` is the destination for tenant CSV/XLSX columns that don't
    # map to any typed field on this model. The importer's column mapper
    # stashes {normalised_header: raw_string_value} here so nothing in the
    # source file is lost. Queryable with Postgres operators:
    #   Product.objects.filter(extras__has_key="Total unit sold")
    #   Product.objects.filter(extras__supplier__icontains="acme")
    extras        = models.JSONField(default=dict, blank=True,
                                     help_text="Tenant-specific columns from imports that don't map to typed fields.")
    is_active     = models.BooleanField(default=True, db_index=True)
    notes         = models.TextField(blank=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "products"
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} [{self.sku}]"

    # ── Derived stock properties (read from FIFO layers) ──────────────────────

    @property
    def total_stock(self) -> Decimal:
        """
        Global available quantity = SUM(remaining_qty) across all FIFO layers.
        This is the authoritative total — not the sum of ProductStock rows.
        """
        from django.db.models import Sum
        result = self.fifo_layers.filter(remaining_qty__gt=0).aggregate(
            total=Sum("remaining_qty")
        )
        return result["total"] or Decimal("0")

    @property
    def inventory_value(self) -> Decimal:
        """
        Total inventory value = SUM(remaining_qty × unit_cost) across all FIFO layers.
        """
        from django.db.models import Sum, F, ExpressionWrapper, DecimalField as DF
        result = self.fifo_layers.filter(remaining_qty__gt=0).aggregate(
            value=Sum(
                ExpressionWrapper(
                    F("remaining_qty") * F("unit_cost"),
                    output_field=DF(max_digits=20, decimal_places=6),
                )
            )
        )
        return result["value"] or Decimal("0")

    @property
    def avg_cost(self) -> Decimal:
        """Weighted average cost from active FIFO layers."""
        stock = self.total_stock
        if not stock:
            return Decimal("0")
        return (self.inventory_value / stock).quantize(Decimal("0.0001"))


# ──────────────────────────────────────────────────────────────────────────────
# 5b. Variation  (one row per variant of a 'variable' product)
# ──────────────────────────────────────────────────────────────────────────────

class Variation(models.Model):
    """
    One variant of a 'variable' product — e.g. 'Red T-shirt (M)'.

    Each variation has its own SKU, purchase/selling price and (optionally)
    image. Inventory tracking remains at the parent-product level for now —
    a follow-up migration can extend ProductStock / FIFOLayer to point at
    Variation if per-variant stock is needed later.
    """
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product       = models.ForeignKey(
        "Product", on_delete=models.CASCADE, related_name="variations",
    )
    type          = models.CharField(
        max_length=50, blank=True,
        help_text="Variation dimension — e.g. 'Color', 'Size'. Free-text.",
    )
    value         = models.CharField(
        max_length=100,
        help_text="Concrete value — e.g. 'Red', 'XL'.",
    )
    sku           = models.CharField(max_length=50, blank=True, db_index=True)
    cost_price    = models.DecimalField(
        max_digits=14, decimal_places=4, default=Decimal("0"),
    )
    selling_price = models.DecimalField(
        max_digits=14, decimal_places=4, default=Decimal("0"),
    )
    image_url     = models.URLField(blank=True, default="", max_length=500)
    sort_order    = models.PositiveIntegerField(default=0, db_index=True)
    is_active     = models.BooleanField(default=True, db_index=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "product_variations"
        ordering = ["sort_order", "created_at"]
        indexes  = [
            models.Index(fields=["product", "sort_order"], name="variation_prod_order_idx"),
        ]

    def __str__(self):
        return f"{self.product.name} — {self.type}: {self.value}".strip(" —")


# ──────────────────────────────────────────────────────────────────────────────
# 5c. ComboItem  (one component line of a 'combo' product)
# ──────────────────────────────────────────────────────────────────────────────

class ComboItem(models.Model):
    """
    One component of a 'combo' parent product. A combo represents a bundle
    sold as a single SKU but composed of N existing component products.

    Example: 'Stationery Starter Pack' (combo) = 1× Notebook + 2× Pen + 1× Eraser.

    The parent's selling_price is set by the user (default suggestion =
    sum of component costs × (1 + margin)); component products keep their
    own stock independently.
    """
    id        = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    combo     = models.ForeignKey(
        "Product", on_delete=models.CASCADE, related_name="combo_items",
        help_text="The PARENT combo product.",
    )
    component = models.ForeignKey(
        "Product", on_delete=models.PROTECT, related_name="used_in_combos",
        help_text="The COMPONENT product included in the combo. PROTECT prevents "
                  "deletion of a product that's still referenced.",
    )
    quantity  = models.DecimalField(max_digits=14, decimal_places=4, default=Decimal("1"))
    sort_order = models.PositiveIntegerField(default=0, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "product_combo_items"
        ordering = ["sort_order", "created_at"]
        indexes  = [
            models.Index(fields=["combo", "sort_order"], name="combo_parent_order_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["combo", "component"], name="uniq_combo_component",
            ),
        ]

    def __str__(self):
        return f"{self.combo.name}  ←  {self.quantity} × {self.component.name}"


# ──────────────────────────────────────────────────────────────────────────────
# 6. ProductStock  (per-location snapshot — denormalized for speed)
# ──────────────────────────────────────────────────────────────────────────────

class ProductStock(models.Model):
    """
    Fast-read per-location quantity snapshot.

    ⚠️  This is a CACHE, not the source of truth.
    The source of truth for total company quantity = SUM(FIFOLayer.remaining_qty).
    ProductStock is maintained via atomic F() updates on every stock movement.

    One row per (product, location) pair — created on first stock-in.
    """

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product    = models.ForeignKey(
        Product, on_delete=models.CASCADE, related_name="stocks",
    )
    location   = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name="stocks",
    )
    quantity   = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        default=Decimal("0"),
        help_text="Current on-hand quantity at this location.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table        = "product_stocks"
        unique_together = [["product", "location"]]
        ordering        = ["product", "location"]

    def __str__(self):
        return f"{self.product.sku} @ {self.location.code}: {self.quantity}"


# ──────────────────────────────────────────────────────────────────────────────
# 7. FIFOLayer  (global FIFO cost queue — CRITICAL)
# ──────────────────────────────────────────────────────────────────────────────

class FIFOLayer(models.Model):
    """
    One FIFO cost layer — created once per stock-in event.

    FIFO rules (enforced by services.py, not the model):
      • Layers are GLOBAL per product. When stock is consumed, the oldest
        layer (by created_at) is deducted from first, regardless of which
        location the sale happens at.
      • remaining_qty only ever decreases.
      • When remaining_qty == 0 the layer is exhausted (kept for audit).
      • SELECT FOR UPDATE is used during consumption to prevent races.

    created_at determines FIFO order.
    For imports, created_at is set to the purchase date (backdating allowed).
    """

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product       = models.ForeignKey(
        Product, on_delete=models.CASCADE, related_name="fifo_layers",
    )
    location      = models.ForeignKey(
        Location,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="fifo_layers",
        help_text="Where this batch was received (audit only — FIFO deduction is global).",
    )
    initial_qty   = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        help_text="Quantity at creation. Never modified after creation.",
    )
    remaining_qty = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        help_text="Remaining unconsumed quantity. Decreases as stock is sold.",
    )
    unit_cost     = models.DecimalField(
        max_digits=14,
        decimal_places=6,
        help_text="Purchase cost per unit. Used for COGS calculation.",
    )
    reference_type = models.CharField(
        max_length=50,
        blank=True,
        db_index=True,
        help_text="Source document type: 'purchase', 'import', 'adjustment'.",
    )
    reference_id  = models.UUIDField(
        null=True,
        blank=True,
        help_text="Source document UUID.",
    )
    created_at    = models.DateTimeField(
        default=timezone.now,
        db_index=True,
        help_text="FIFO order key. Set to purchase date for backdated imports.",
    )
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "fifo_layers"
        ordering = ["created_at"]   # oldest first — always
        indexes  = [
            models.Index(
                fields=["product", "created_at"],
                name="fifo_product_date_idx",
            ),
            models.Index(
                fields=["product", "remaining_qty"],
                name="fifo_product_qty_idx",
            ),
        ]

    def __str__(self):
        return (
            f"FIFOLayer [{self.product.sku}] "
            f"cost={self.unit_cost} "
            f"rem={self.remaining_qty}/{self.initial_qty}"
        )

    @property
    def is_exhausted(self) -> bool:
        return self.remaining_qty <= Decimal("0")

    @property
    def consumed_qty(self) -> Decimal:
        return self.initial_qty - self.remaining_qty

    @property
    def layer_value(self) -> Decimal:
        """Current value of remaining stock in this layer."""
        return (self.remaining_qty * self.unit_cost).quantize(Decimal("0.0001"))


# ──────────────────────────────────────────────────────────────────────────────
# 8. StockMovement  (immutable audit trail)
# ──────────────────────────────────────────────────────────────────────────────

class StockMovement(models.Model):
    """
    Immutable record of every stock change.

    quantity is always positive.
    Direction is encoded in movement_type:
      IN       — stock received    (purchase, return, import, positive adjustment)
      OUT      — stock dispatched  (sale, transfer-out, negative adjustment)
      TRANSFER — internal location transfer (creates paired IN + OUT records)
      ADJUST   — manual count correction

    For OUT movements, cogs holds the FIFO-computed cost.
    """

    class Type(models.TextChoices):
        IN       = "IN",       "Stock In"
        OUT      = "OUT",      "Stock Out"
        TRANSFER = "TRANSFER", "Transfer"
        ADJUST   = "ADJUST",   "Adjustment"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product       = models.ForeignKey(
        Product, on_delete=models.CASCADE, related_name="movements",
    )
    location      = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name="movements",
    )
    movement_type = models.CharField(
        max_length=10,
        choices=Type.choices,
        db_index=True,
    )
    quantity      = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        help_text="Always positive. Direction implied by movement_type.",
    )
    unit_cost     = models.DecimalField(
        max_digits=14,
        decimal_places=6,
        null=True,
        blank=True,
        help_text="Cost per unit at time of movement.",
    )
    cogs          = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="FIFO-computed COGS for OUT movements.",
    )
    reference_type = models.CharField(max_length=50, blank=True, db_index=True)
    reference_id  = models.UUIDField(null=True, blank=True)
    notes         = models.TextField(blank=True)
    created_at    = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "stock_movements"
        ordering = ["-created_at"]
        indexes  = [
            models.Index(
                fields=["product", "created_at"],
                name="mov_product_date_idx",
            ),
            models.Index(
                fields=["location", "created_at"],
                name="mov_location_date_idx",
            ),
            models.Index(
                fields=["reference_type", "reference_id"],
                name="mov_reference_idx",
            ),
        ]

    def __str__(self):
        return (
            f"[{self.movement_type}] {self.product.sku} "
            f"qty={self.quantity} @ {self.location.code}"
        )


# ──────────────────────────────────────────────────────────────────────────────
# Warranty
# ──────────────────────────────────────────────────────────────────────────────

class Warranty(models.Model):
    """
    Reusable warranty term that can be attached to products.
    Duration is stored as a value + unit (days/months/years) so the UI can
    display either '12 Months' or '2 Years' verbatim.
    """

    class DurationUnit(models.TextChoices):
        DAYS   = "days",   "Days"
        MONTHS = "months", "Months"
        YEARS  = "years",  "Years"

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name           = models.CharField(max_length=100, unique=True)
    description    = models.TextField(blank=True, default="")
    duration_value = models.PositiveIntegerField(default=0)
    duration_unit  = models.CharField(
        max_length=10,
        choices=DurationUnit.choices,
        default=DurationUnit.MONTHS,
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "warranties"
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.duration_value} {self.duration_unit})"

    @property
    def duration_label(self) -> str:
        unit = self.duration_unit
        if self.duration_value == 1 and unit.endswith("s"):
            unit = unit[:-1]
        return f"{self.duration_value} {unit.capitalize()}"


# ──────────────────────────────────────────────────────────────────────────────
# Stock Transfer (header + items)
# ──────────────────────────────────────────────────────────────────────────────

def _generate_transfer_ref() -> str:
    """Reference like ST-2026-AB12CDEF"""
    yr = timezone.now().year
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    return f"ST-{yr}-{suffix}"


class StockTransfer(models.Model):
    """
    Header record for a stock movement between two locations.

    Each transfer wraps one or more StockTransferItem rows. When a transfer is
    marked COMPLETED, services.transfer_stock() is called for every item to
    update ProductStock + write paired StockMovement audit records.
    """

    class Status(models.TextChoices):
        PENDING    = "pending",    "Pending"
        IN_TRANSIT = "in_transit", "In Transit"
        COMPLETED  = "completed",  "Completed"
        CANCELLED  = "cancelled",  "Cancelled"

    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_no     = models.CharField(max_length=40, unique=True, default=_generate_transfer_ref)
    transfer_date    = models.DateField(default=timezone.now)
    from_location    = models.ForeignKey(
        Location, on_delete=models.PROTECT, related_name="outgoing_transfers"
    )
    to_location      = models.ForeignKey(
        Location, on_delete=models.PROTECT, related_name="incoming_transfers"
    )
    status           = models.CharField(
        max_length=15, choices=Status.choices, default=Status.COMPLETED, db_index=True
    )
    shipping_charges = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    total_amount     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    notes            = models.TextField(blank=True, default="")
    added_by_name    = models.CharField(max_length=120, blank=True, default="")

    created_at       = models.DateTimeField(auto_now_add=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "stock_transfers"
        ordering = ["-transfer_date", "-created_at"]
        indexes = [
            models.Index(fields=["status"]),
            models.Index(fields=["from_location", "to_location"]),
        ]

    def __str__(self):
        return f"{self.reference_no} ({self.from_location_id} → {self.to_location_id})"


class StockTransferItem(models.Model):
    """One product line on a stock transfer."""

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    stock_transfer = models.ForeignKey(
        StockTransfer, on_delete=models.CASCADE, related_name="items"
    )
    product        = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity       = models.DecimalField(max_digits=12, decimal_places=2)
    unit_cost      = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    line_total     = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))

    class Meta:
        db_table = "stock_transfer_items"
        ordering = ["id"]
