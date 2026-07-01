"""
DRF serializers for the inventory module.

Read serializers  — used for GET responses (include computed fields).
Write serializers — used for POST/PATCH input validation only.
"""
from decimal import Decimal

from django.db.models import Sum

from rest_framework import serializers

from accounts.branch_context import active_branch_id

from .models import Brand, Category, ComboItem, FIFOLayer, Location, Product, ProductStock, StockMovement, Unit, Variation, Warranty


# ──────────────────────────────────────────────────────────────────────────────
# Master data
# ──────────────────────────────────────────────────────────────────────────────

class UnitSerializer(serializers.ModelSerializer):
    # Alias used by the Units screen ("Short name" column)
    short_name = serializers.CharField(source="abbreviation", required=False)

    class Meta:
        model  = Unit
        fields = ["id", "name", "abbreviation", "short_name", "allow_decimal", "created_at"]

    def validate(self, attrs):
        # Accept either abbreviation or short_name from the client.
        if "abbreviation" not in attrs and self.initial_data.get("short_name"):
            attrs["abbreviation"] = self.initial_data["short_name"]
        return attrs


class BrandSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Brand
        fields = ["id", "name", "created_at"]


class CategorySerializer(serializers.ModelSerializer):
    parent_name = serializers.CharField(source="parent.name", read_only=True, default=None)
    # Explicitly mark parent as optional + nullable. DRF normally
    # picks this up from the model's null=True + blank=True, but some
    # client payloads omit the key entirely OR send "" — both used to
    # raise "parent: This field is required." Now omitting or
    # null-ing parent creates a top-level category, which is exactly
    # what the Add Category modal expects.
    parent = serializers.PrimaryKeyRelatedField(
        queryset=Category.objects.all(),
        required=False, allow_null=True, default=None,
    )

    def to_internal_value(self, data):
        # Treat empty-string parent as null so the frontend doesn't
        # have to remember to send `null` vs omit the key.
        if isinstance(data, dict) and data.get("parent") in ("", "null", "None"):
            data = {**data, "parent": None}
        return super().to_internal_value(data)

    class Meta:
        model  = Category
        fields = ["id", "name", "code", "description", "parent", "parent_name", "created_at"]


class LocationSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Location
        fields = ["id", "name", "code", "address", "is_active", "created_at"]


class WarrantySerializer(serializers.ModelSerializer):
    duration_label = serializers.CharField(read_only=True)

    class Meta:
        model  = Warranty
        fields = [
            "id", "name", "description",
            "duration_value", "duration_unit", "duration_label",
            "created_at",
        ]


# ──────────────────────────────────────────────────────────────────────────────
# Product
# ──────────────────────────────────────────────────────────────────────────────

class ProductListSerializer(serializers.ModelSerializer):
    """
    Lean list representation — used for GET /products/ and nested references.
    Computes total_stock and inventory_value from FIFO layers.
    """
    category_name  = serializers.CharField(source="category.name",         read_only=True, default=None)
    brand_name     = serializers.CharField(source="brand.name",             read_only=True, default=None)
    unit_name      = serializers.CharField(source="unit.name",              read_only=True)
    unit_abbr      = serializers.CharField(source="unit.abbreviation",      read_only=True)
    # Assigned warranty term (name + duration label) for the List Products
    # "Warranty" column. warranty (id) lets the Edit Product form rehydrate.
    warranty       = serializers.PrimaryKeyRelatedField(read_only=True)
    warranty_name  = serializers.CharField(source="warranty.name",          read_only=True, default=None)
    warranty_label = serializers.CharField(source="warranty.duration_label", read_only=True, default=None)
    total_stock    = serializers.SerializerMethodField()
    inventory_value = serializers.SerializerMethodField()
    avg_cost       = serializers.SerializerMethodField()
    # Real-time movement aggregates for the Stock Report tab. All
    # three pull straight from the immutable StockMovement ledger
    # the inventory services write on every sale / transfer / manual
    # count change, so the numbers update on the next page load with
    # zero caching.
    units_sold         = serializers.SerializerMethodField()
    units_transferred  = serializers.SerializerMethodField()
    units_adjusted     = serializers.SerializerMethodField()
    # Every active location this product has any presence in — i.e.
    # at least one ProductStock row with quantity > 0 OR an opening
    # FIFO layer. Used by the All Products tab on the List Products
    # page (Business Location column). When the tenant filters by a
    # single location the serializer still returns the full list so
    # the column shows the same answer regardless of filter.
    location_names = serializers.SerializerMethodField()
    # Whether stock tracking is on for this product (Add Product's
    # "Manage Stock?" toggle, persisted in meta). Stock-management-OFF
    # products are SERVICES — POS / Add Sale must let them sell freely
    # with no out-of-stock guard. The flag lives in meta, which the
    # list payload doesn't carry, so surface it as a real field.
    manage_stock = serializers.SerializerMethodField()

    class Meta:
        model  = Product
        fields = [
            "id", "name", "sku", "barcode", "barcode_type",
            "category_name", "brand_name", "unit_name", "unit_abbr",
            "selling_price", "cost_price", "tax_rate", "tax_type",
            "product_type", "not_for_selling", "weight", "image_url",
            "warranty_days", "warranty", "warranty_name", "warranty_label", "reorder_level",
            "total_stock", "inventory_value", "avg_cost",
            "units_sold", "units_transferred", "units_adjusted",
            "location_names", "manage_stock",
            "is_active", "created_at",
        ]

    def get_manage_stock(self, obj):
        return (obj.meta or {}).get("manage_stock", True) is not False

    def get_total_stock(self, obj):
        """Authoritative on-hand stock for the product list page.

        The FIFO layers are the ground truth — every sale consumes them,
        every receive adds to them. ProductStock is a denormalised
        per-location snapshot that's kept in sync by the inventory
        services but can drift in edge cases (e.g. a location's row
        ends up at 0 even though FIFO globally has stock left from
        another location). Earlier this serializer trusted the
        snapshot first, so any product whose location row hit 0 was
        rendered as "Out" on the list page even though stock was
        actually available — that's the symptom the user reported.
        We now take MAX(FIFO-total, snapshot-sum) so the displayed
        number is never artificially lower than what's truly on hand.
        """
        # Multi-branch: when a branch is active, the on-hand figure is the
        # stock at THAT branch only (products are shared, stock is per-branch).
        bid = active_branch_id()
        if bid:
            fifo = (obj.fifo_layers.filter(remaining_qty__gt=0, location_id=bid)
                    .aggregate(t=Sum("remaining_qty")).get("t"))
            snap = obj.stocks.filter(location_id=bid).aggregate(total=Sum("quantity")).get("total")
            return max(Decimal(str(fifo or 0)), Decimal(str(snap or 0)))
        fifo_total = Decimal(str(obj.total_stock or 0))
        snap = obj.stocks.aggregate(total=Sum("quantity")).get("total")
        snap_total = Decimal(str(snap or 0))
        return max(fifo_total, snap_total)

    def get_inventory_value(self, obj):
        stock = Decimal(str(self.get_total_stock(obj) or 0))
        avg = Decimal(str(self.get_avg_cost(obj) or 0))
        return (stock * avg).quantize(Decimal("0.0001"))

    def get_avg_cost(self, obj):
        # Keep existing FIFO-driven average cost behavior.
        return obj.avg_cost

    # ── Movement aggregates (used by the Stock Report tab) ──────────
    def _movement_sum(self, obj, movement_type):
        # StockMovement.quantity is always positive; the direction is
        # in movement_type. We just sum the absolute quantities for
        # each ledger kind.
        from django.db.models import Sum
        movements = obj.movements.filter(movement_type=movement_type)
        bid = active_branch_id()
        if bid:
            movements = movements.filter(location_id=bid)
        agg = movements.aggregate(t=Sum("quantity"))
        return Decimal(str(agg.get("t") or 0))

    def get_units_sold(self, obj):
        # Every sale finalisation writes an OUT StockMovement, so the
        # OUT sum IS the total ever sold (minus voids which write the
        # reverse IN — netting them out correctly). Sell Returns also
        # write IN movements when restocked, so this gives the
        # net-sold-and-not-returned figure.
        out_qty = self._movement_sum(obj, "OUT")
        return str(out_qty)

    def get_units_transferred(self, obj):
        # A transfer writes one OUT + one IN with movement_type=TRANSFER
        # (paired); we count each TRANSFER line once → divide by 2.
        t = self._movement_sum(obj, "TRANSFER")
        return str((t / Decimal("2")).quantize(Decimal("0.0001")))

    def get_units_adjusted(self, obj):
        return str(self._movement_sum(obj, "ADJUST"))

    def get_location_names(self, obj):
        """Names of every active location where this product has any
        presence — defined as a ProductStock row OR a FIFOLayer row
        (so a product that's been received but not yet sold still
        shows its receiving location).

        Returning the full list — not the filtered subset — means
        the column shows the same answer whether the user has
        location_id="all" or location_id=<one>. Pure DB lookup; no
        hardcoded mapping. Safe on legacy tenants (location FK is
        nullable so we drop NULL rows).
        """
        from .models import Location  # noqa: PLC0415
        loc_ids = set()
        # ProductStock snapshot (one row per location).
        for lid in obj.stocks.values_list("location_id", flat=True):
            if lid:
                loc_ids.add(lid)
        # FIFOLayer audit (covers products with stock received but
        # not yet snapped into ProductStock).
        for lid in obj.fifo_layers.values_list("location_id", flat=True):
            if lid:
                loc_ids.add(lid)
        if not loc_ids:
            return []
        names = list(
            Location.objects
            .filter(id__in=loc_ids, is_active=True)
            .order_by("name")
            .values_list("name", flat=True)
        )
        return names


class ProductPickerSerializer(serializers.ModelSerializer):
    """Ultra-lean payload for the POS / Add Sale / Add Quotation product
    pickers (GET /products/?light=true).

    ProductListSerializer is the *report* representation: for every product
    it computes inventory value, weighted avg cost, three movement-ledger
    sums and the location-name list — roughly nine extra DB round-trips per
    row (classic N+1). On a tenant with a few hundred products that meant
    thousands of queries just to fill a dropdown, which is why the Add Sale /
    Add Quotation pages took so long to load.

    The picker only ever needs pricing, tax, unit, the manage_stock flag and
    the on-hand quantity (for the "Only X available" cart guard). We surface
    exactly those. `total_stock` is read from the `_picker_stock` annotation
    the view adds (one aggregate over the whole queryset) so there is no
    per-row query at all; it falls back to the model property if the
    annotation is absent.
    """
    category_name  = serializers.CharField(source="category.name",        read_only=True, default=None)
    brand_name     = serializers.CharField(source="brand.name",            read_only=True, default=None)
    unit_name      = serializers.CharField(source="unit.name",             read_only=True)
    unit_abbr      = serializers.CharField(source="unit.abbreviation",     read_only=True)
    total_stock    = serializers.SerializerMethodField()
    manage_stock   = serializers.SerializerMethodField()

    class Meta:
        model  = Product
        fields = [
            "id", "name", "sku", "barcode", "barcode_type",
            "category_name", "brand_name", "unit_name", "unit_abbr",
            "selling_price", "cost_price", "tax_rate", "tax_type",
            "product_type", "not_for_selling", "image_url",
            "warranty_days", "total_stock", "manage_stock",
            "is_active",
        ]

    def get_total_stock(self, obj):
        # Prefer the queryset annotation (no extra query). Fall back to the
        # model property only if the view didn't annotate.
        val = getattr(obj, "_picker_stock", None)
        if val is None:
            val = obj.total_stock
        return Decimal(str(val or 0))

    def get_manage_stock(self, obj):
        return (obj.meta or {}).get("manage_stock", True) is not False


class VariationSerializer(serializers.ModelSerializer):
    """Read serializer for a Variation row."""
    class Meta:
        model  = Variation
        fields = [
            "id", "type", "value", "sku",
            "cost_price", "selling_price", "image_url",
            "sort_order", "is_active",
        ]


class VariationInputSerializer(serializers.Serializer):
    """One row in the create/update payload's `variations` array."""
    value         = serializers.CharField(max_length=100, allow_blank=True, required=False, default="")
    sku           = serializers.CharField(max_length=50,  allow_blank=True, required=False, default="")
    cost_price    = serializers.DecimalField(
        max_digits=14, decimal_places=4, required=False, default=Decimal("0"), min_value=Decimal("0"),
    )
    selling_price = serializers.DecimalField(
        max_digits=14, decimal_places=4, required=False, default=Decimal("0"), min_value=Decimal("0"),
    )
    image_url     = serializers.URLField(required=False, allow_blank=True, default="")


class ComboItemSerializer(serializers.ModelSerializer):
    """Read serializer for a ComboItem row. Eager-loads the component name
    and cost so the Edit Product page can render the row without an extra
    fetch per component."""
    component_id   = serializers.UUIDField  (source="component.id",            read_only=True)
    component_name = serializers.CharField  (source="component.name",          read_only=True)
    component_sku  = serializers.CharField  (source="component.sku",           read_only=True)
    component_cost = serializers.DecimalField(
        source="component.cost_price", read_only=True,
        max_digits=14, decimal_places=4,
    )

    class Meta:
        model  = ComboItem
        fields = [
            "id", "component_id", "component_name", "component_sku",
            "component_cost", "quantity", "sort_order",
        ]


class ComboItemInputSerializer(serializers.Serializer):
    """One row in the create/update payload's `combo_items` array."""
    component_id = serializers.UUIDField()
    quantity     = serializers.DecimalField(
        max_digits=14, decimal_places=4, default=Decimal("1"), min_value=Decimal("0"),
    )


class ProductDetailSerializer(ProductListSerializer):
    """Full detail — adds notes, category/brand IDs for editing.

    Also surfaces the per-variant `variations` list, the parent product's
    `variation_type`, and (for combo products) the `combo_items` list so the
    Edit Product page can rehydrate every variant / component row exactly as
    the user left them.
    """
    variations     = VariationSerializer(many=True, read_only=True)
    variation_type = serializers.SerializerMethodField()
    combo_items    = ComboItemSerializer(many=True, read_only=True)

    class Meta(ProductListSerializer.Meta):
        fields = ProductListSerializer.Meta.fields + [
            "category", "brand", "unit", "notes", "meta", "updated_at",
            "variations", "variation_type", "combo_items",
        ]

    def get_variation_type(self, obj):
        # First variant's `type` is the canonical type for the product. All
        # variants share the same type today; promote to a Product-level
        # column when that assumption no longer holds.
        first = obj.variations.first()
        return first.type if first else (obj.meta or {}).get("variation_type", "")


class ProductCreateSerializer(serializers.Serializer):
    """Input validation for POST /products/."""

    name             = serializers.CharField(max_length=200)
    unit_id          = serializers.UUIDField()
    selling_price    = serializers.DecimalField(
        max_digits=14, decimal_places=4, default=Decimal("0"), min_value=Decimal("0"),
    )
    category_id      = serializers.UUIDField(required=False, allow_null=True, default=None)
    brand_id         = serializers.UUIDField(required=False, allow_null=True, default=None)
    sku              = serializers.CharField(
        required=False, allow_blank=True, allow_null=True, default=None, max_length=50,
    )
    barcode          = serializers.CharField(
        required=False, allow_blank=True, allow_null=True, default=None, max_length=20,
    )
    generate_barcode = serializers.BooleanField(default=False)
    barcode_type     = serializers.CharField(required=False, allow_blank=True, default="C128", max_length=15)
    cost_price       = serializers.DecimalField(
        max_digits=14, decimal_places=4, required=False, default=Decimal("0"), min_value=Decimal("0"),
    )
    tax_rate         = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, default=Decimal("0"), min_value=Decimal("0"),
    )
    tax_type         = serializers.ChoiceField(
        choices=[("inclusive", "Inclusive"), ("exclusive", "Exclusive")],
        required=False, default="exclusive",
    )
    product_type     = serializers.ChoiceField(
        choices=[("single", "Single"), ("variable", "Variable"), ("combo", "Combo")],
        required=False, default="single",
    )
    not_for_selling  = serializers.BooleanField(required=False, default=False)
    weight           = serializers.DecimalField(
        max_digits=10, decimal_places=3, required=False, allow_null=True, default=None,
    )
    image_url        = serializers.URLField(required=False, allow_blank=True, default="")
    warranty_days    = serializers.IntegerField(default=0, min_value=0)
    warranty_id      = serializers.UUIDField(required=False, allow_null=True, default=None)
    notes            = serializers.CharField(required=False, allow_blank=True, default="")
    meta             = serializers.JSONField(required=False, default=dict)
    # Alert / reorder threshold + opening stock so the POS "Quick add"
    # modal can record an initial inventory level in one round-trip.
    reorder_level    = serializers.DecimalField(
        max_digits=14, decimal_places=4, required=False,
        default=Decimal("0"), min_value=Decimal("0"),
    )
    # opening_stock is a list of {location_id, quantity, unit_cost}
    # rows. Validated + stocked-in by the create_product service after
    # the Product row is saved.
    opening_stock    = serializers.JSONField(required=False, default=list)
    # Variable-product payload — only consulted when product_type='variable'.
    variation_type   = serializers.CharField(
        max_length=50, required=False, allow_blank=True, default="",
    )
    variations       = VariationInputSerializer(many=True, required=False, default=list)
    # Combo-product payload — only consulted when product_type='combo'.
    combo_items      = ComboItemInputSerializer(many=True, required=False, default=list)

    def validate_sku(self, value):
        if value and Product.objects.filter(sku=value).exists():
            raise serializers.ValidationError("A product with this SKU already exists.")
        return value or None

    def validate_barcode(self, value):
        if value and Product.objects.filter(barcode=value).exists():
            raise serializers.ValidationError("A product with this barcode already exists.")
        return value or None

    def validate(self, attrs):
        if attrs.get("barcode") and attrs.get("generate_barcode"):
            raise serializers.ValidationError(
                "Provide either 'barcode' or 'generate_barcode=true', not both."
            )
        return attrs


# ──────────────────────────────────────────────────────────────────────────────
# Stock In
# ──────────────────────────────────────────────────────────────────────────────

class StockInSerializer(serializers.Serializer):
    """Input validation for POST /stock-in/."""

    product_id     = serializers.UUIDField()
    location_id    = serializers.UUIDField()
    quantity       = serializers.DecimalField(
        max_digits=14, decimal_places=4, min_value=Decimal("0.0001"),
    )
    unit_cost      = serializers.DecimalField(
        max_digits=14, decimal_places=6, min_value=Decimal("0"),
    )
    reference_type = serializers.CharField(
        default="purchase", max_length=50, required=False,
    )
    reference_id   = serializers.UUIDField(required=False, allow_null=True, default=None)
    layer_date     = serializers.DateTimeField(
        required=False,
        allow_null=True,
        default=None,
        help_text="Override FIFO layer date (for backdated purchases).",
    )

    def validate_product_id(self, value):
        if not Product.objects.filter(id=value, is_active=True).exists():
            raise serializers.ValidationError("Product not found or inactive.")
        return value

    def validate_location_id(self, value):
        if not Location.objects.filter(id=value, is_active=True).exists():
            raise serializers.ValidationError("Location not found or inactive.")
        return value


# ──────────────────────────────────────────────────────────────────────────────
# Bulk Import
# ──────────────────────────────────────────────────────────────────────────────

class ImportRowSerializer(serializers.Serializer):
    """One row in a bulk import payload."""

    quantity  = serializers.DecimalField(
        max_digits=14, decimal_places=4, min_value=Decimal("0.0001"),
    )
    unit_cost = serializers.DecimalField(
        max_digits=14, decimal_places=6, min_value=Decimal("0"),
    )
    date      = serializers.DateTimeField(
        required=False, allow_null=True, default=None,
        help_text="Purchase date — sets FIFO layer order for historical imports.",
    )


class StockImportSerializer(serializers.Serializer):
    """Input for POST /stock-in/import/."""

    product_id  = serializers.UUIDField()
    location_id = serializers.UUIDField()
    rows        = ImportRowSerializer(many=True, min_length=1)

    def validate_product_id(self, value):
        if not Product.objects.filter(id=value, is_active=True).exists():
            raise serializers.ValidationError("Product not found or inactive.")
        return value

    def validate_location_id(self, value):
        if not Location.objects.filter(id=value, is_active=True).exists():
            raise serializers.ValidationError("Location not found or inactive.")
        return value


# ──────────────────────────────────────────────────────────────────────────────
# Transfer
# ──────────────────────────────────────────────────────────────────────────────

class StockTransferSerializer(serializers.Serializer):
    """Input for POST /stock-transfer/."""

    product_id       = serializers.UUIDField()
    from_location_id = serializers.UUIDField()
    to_location_id   = serializers.UUIDField()
    quantity         = serializers.DecimalField(
        max_digits=14, decimal_places=4, min_value=Decimal("0.0001"),
    )
    notes            = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["from_location_id"] == attrs["to_location_id"]:
            raise serializers.ValidationError(
                "Source and destination locations must be different."
            )
        return attrs


# ── Stock Transfer header (list / create / detail) ────────────────────────────

from .models import StockTransfer, StockTransferItem  # noqa: E402  (after class above)


class StockTransferItemInputSerializer(serializers.Serializer):
    product_id = serializers.UUIDField()
    quantity   = serializers.DecimalField(
        max_digits=14, decimal_places=4, min_value=Decimal("0.0001"),
    )
    unit_cost  = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False, default=Decimal("0"),
    )


class StockTransferItemOutputSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    product_sku  = serializers.CharField(source="product.sku",  read_only=True)

    class Meta:
        model  = StockTransferItem
        fields = ["id", "product", "product_name", "product_sku", "quantity", "unit_cost", "line_total"]


class StockTransferListSerializer(serializers.ModelSerializer):
    from_location_name = serializers.CharField(source="from_location.name", read_only=True)
    to_location_name   = serializers.CharField(source="to_location.name",   read_only=True)
    item_count         = serializers.IntegerField(source="items.count", read_only=True)

    class Meta:
        model  = StockTransfer
        fields = [
            "id", "reference_no", "transfer_date",
            "from_location", "from_location_name",
            "to_location",   "to_location_name",
            "status", "shipping_charges", "total_amount", "notes",
            "added_by_name", "item_count", "created_at",
        ]


class StockTransferDetailSerializer(serializers.ModelSerializer):
    from_location_name = serializers.CharField(source="from_location.name", read_only=True)
    to_location_name   = serializers.CharField(source="to_location.name",   read_only=True)
    items              = StockTransferItemOutputSerializer(many=True, read_only=True)

    class Meta:
        model  = StockTransfer
        fields = [
            "id", "reference_no", "transfer_date",
            "from_location", "from_location_name",
            "to_location",   "to_location_name",
            "status", "shipping_charges", "total_amount", "notes",
            "added_by_name", "items", "created_at", "updated_at",
        ]


class CreateStockTransferSerializer(serializers.Serializer):
    """Input for POST /stock-transfers/."""

    transfer_date    = serializers.DateField(required=False)
    from_location_id = serializers.UUIDField()
    to_location_id   = serializers.UUIDField()
    status           = serializers.ChoiceField(
        choices=StockTransfer.Status.choices, required=False, default=StockTransfer.Status.COMPLETED,
    )
    shipping_charges = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=Decimal("0"),
    )
    notes            = serializers.CharField(required=False, allow_blank=True, default="")
    items            = StockTransferItemInputSerializer(many=True)

    def validate(self, attrs):
        if attrs["from_location_id"] == attrs["to_location_id"]:
            raise serializers.ValidationError("Source and destination locations must differ.")
        if not attrs.get("items"):
            raise serializers.ValidationError("At least one item is required.")
        return attrs


# ──────────────────────────────────────────────────────────────────────────────
# FIFO Layer (read-only, for inspection / audit)
# ──────────────────────────────────────────────────────────────────────────────

class FIFOLayerSerializer(serializers.ModelSerializer):
    location_name = serializers.CharField(source="location.name", read_only=True, default=None)
    consumed_qty  = serializers.DecimalField(max_digits=14, decimal_places=4, read_only=True)
    layer_value   = serializers.DecimalField(max_digits=14, decimal_places=4, read_only=True)
    is_exhausted  = serializers.BooleanField(read_only=True)

    class Meta:
        model  = FIFOLayer
        fields = [
            "id", "product", "location", "location_name",
            "initial_qty", "remaining_qty", "consumed_qty",
            "unit_cost", "layer_value", "is_exhausted",
            "reference_type", "reference_id", "created_at",
        ]


# ──────────────────────────────────────────────────────────────────────────────
# Stock Movement (read-only audit log)
# ──────────────────────────────────────────────────────────────────────────────

class StockMovementSerializer(serializers.ModelSerializer):
    product_name  = serializers.CharField(source="product.name",  read_only=True)
    product_sku   = serializers.CharField(source="product.sku",   read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)

    class Meta:
        model  = StockMovement
        fields = [
            "id",
            "product", "product_name", "product_sku",
            "location", "location_name", "location_code",
            "movement_type", "quantity",
            "unit_cost", "cogs",
            "reference_type", "reference_id",
            "notes", "created_at",
        ]


# ──────────────────────────────────────────────────────────────────────────────
# ProductStock snapshot (read-only)
# ──────────────────────────────────────────────────────────────────────────────

class ProductStockSerializer(serializers.ModelSerializer):
    product_name  = serializers.CharField(source="product.name",  read_only=True)
    product_sku   = serializers.CharField(source="product.sku",   read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)

    class Meta:
        model  = ProductStock
        fields = [
            "id", "product", "product_name", "product_sku",
            "location", "location_name", "location_code",
            "quantity", "updated_at",
        ]
