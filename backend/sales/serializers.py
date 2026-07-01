"""
Sales serializers.

Input serializers   (validate request bodies)
──────────────────
  SaleItemInputSerializer       — one line item in a create/update payload
  CreateSaleSerializer          — POST /sales/
  UpdateSaleSerializer          — PATCH /sales/<id>/
  FinalizeSerializer            — POST /sales/<id>/finalize/
  AddPaymentSerializer          — POST /sales/<id>/payments/
  CreateBackOrderSerializer     — POST /sales/<id>/backorder/

Output serializers  (read-only representation)
───────────────────
  CustomerSerializer
  SaleItemSerializer
  SalePaymentSerializer
  BackOrderSerializer
  SaleListSerializer            — compact list view
  SaleDetailSerializer          — full detail with items, payments, backorders
"""
from decimal import Decimal

from rest_framework import serializers

from .models import (
    BackOrder, Customer, CustomerGroup, Discount,
    Sale, SaleItem, SalePayment, SellReturn, SellReturnItem,
)


# ──────────────────────────────────────────────────────────────────────────────
# Customer Group
# ──────────────────────────────────────────────────────────────────────────────

class CustomerGroupSerializer(serializers.ModelSerializer):
    class Meta:
        model  = CustomerGroup
        fields = [
            "id", "name",
            "price_calculation_type", "calc_percentage",
            "price_group", "description", "is_active",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


# ──────────────────────────────────────────────────────────────────────────────
# Customer
# ──────────────────────────────────────────────────────────────────────────────

class CustomerSerializer(serializers.ModelSerializer):
    # Computed fields surfaced on list endpoints (the viewset annotates them
    # so these are just simple SerializerMethodFields — no extra query).
    display_code         = serializers.SerializerMethodField()
    total_sale_due       = serializers.SerializerMethodField()
    total_sell_return_due = serializers.SerializerMethodField()
    customer_group_name  = serializers.CharField(source="customer_group.name", read_only=True)

    # `name` is composed by Customer.save() from the individual/business
    # inputs, so the API doesn't need it on input. Explicitly override the
    # auto-derived field here so DRF doesn't reject the request with
    # {"name": ["This field is required."]} before save() ever runs.
    name = serializers.CharField(max_length=200, required=False, allow_blank=True)

    class Meta:
        model  = Customer
        fields = [
            "id", "name", "business_name",
            # Type discriminator + individual/business breakdown
            "contact_type", "is_individual", "contact_id",
            "prefix", "first_name", "middle_name", "last_name",
            "date_of_birth",
            # Contact
            "email", "phone", "alternate_phone", "landline",
            # Address (structured)
            "address", "address_line_2", "city", "state", "country", "zip_code",
            "shipping_address",
            # Billing
            "tax_number", "notes", "is_active",
            "pay_term_value", "pay_term_period",
            "opening_balance", "advance_balance",
            "credit_limit",
            "custom_field_1", "custom_field_2", "custom_field_3", "custom_field_4",
            "customer_group", "customer_group_name",
            "created_at", "updated_at",
            "display_code",
            "total_sale_due", "total_sell_return_due",
        ]
        extra_kwargs = {
            "customer_group": {"required": False, "allow_null": True},
        }

    def get_display_code(self, obj):
        # 'C' + first 6 hex chars of the UUID — stable, no schema change.
        return "C-" + str(obj.id).replace("-", "")[:6].upper()

    def get_total_sale_due(self, obj):
        return str(getattr(obj, "total_sale_due", 0) or 0)

    def get_total_sell_return_due(self, obj):
        return str(getattr(obj, "total_sell_return_due", 0) or 0)

    # ── Cross-field validation matching the new form contract ────────────────
    def validate(self, attrs):
        # When editing, fall back to the existing instance values for any
        # field the form omitted (PATCH semantics).
        inst = self.instance
        is_individual = attrs.get(
            "is_individual",
            getattr(inst, "is_individual", True) if inst else True,
        )

        if is_individual:
            # Only the FIRST name is required for an individual; last name is
            # optional (the Add Contact modal marks it optional too).
            first = (attrs.get("first_name") or (inst.first_name if inst else "")).strip()
            if not first:
                raise serializers.ValidationError({"first_name": "First name is required for individuals."})
        else:
            biz = (attrs.get("business_name") or (inst.business_name if inst else "")).strip()
            if not biz:
                raise serializers.ValidationError({"business_name": "Business name is required for businesses."})

        # Mobile is mandatory on both branches (matches the screenshot spec).
        phone = (attrs.get("phone") or (inst.phone if inst else "")).strip()
        if not phone:
            raise serializers.ValidationError({"phone": "Mobile number is required."})

        # Normalise BD mobiles to the canonical 11-digit "01XXXXXXXXX"
        # form so the DB never holds leading-zero-less or country-code
        # variants. Imported CSVs sometimes lose the leading 0 (Excel
        # turns "01712..." into 1712...); we restore it here so the
        # Customers / All Sales / Shipments tables render correctly.
        d = "".join(c for c in phone if c.isdigit())
        if len(d) == 10 and d.startswith("1"):
            phone = "0" + d
        elif len(d) == 13 and d.startswith("880"):
            phone = "0" + d[3:]
        elif len(d) == 14 and d.startswith("8800"):
            phone = "0" + d[4:]
        attrs["phone"] = phone

        # Same treatment for alternate_phone when present.
        alt = (attrs.get("alternate_phone") or "").strip()
        if alt:
            d2 = "".join(c for c in alt if c.isdigit())
            if len(d2) == 10 and d2.startswith("1"):
                alt = "0" + d2
            elif len(d2) == 13 and d2.startswith("880"):
                alt = "0" + d2[3:]
            attrs["alternate_phone"] = alt

        return attrs

    def create(self, validated_data):
        # New customers get a default credit ceiling so they can buy on
        # credit right away. When the form leaves Credit Limit blank/0 we
        # apply the 5000 default; the operator can still set it to 0 later
        # to force a customer cash-only. Walk-in (no customer) is unaffected.
        from .models import DEFAULT_CREDIT_LIMIT  # noqa: PLC0415
        if not validated_data.get("credit_limit"):
            validated_data["credit_limit"] = DEFAULT_CREDIT_LIMIT
        instance = super().create(validated_data)
        self._mirror_supplier_if_both(instance)
        return instance

    def update(self, instance, validated_data):
        instance = super().update(instance, validated_data)
        self._mirror_supplier_if_both(instance)
        return instance

    def _mirror_supplier_if_both(self, customer):
        """When contact_type='both', create / update a matching Supplier row.

        Strategy: look up an existing Supplier by phone (the only field
        we require on both) — if found, sync; otherwise create. We don't
        delete the Supplier when the type flips back to 'customer' (data
        loss risk) — the operator can soft-delete from the Suppliers page
        if they want to.
        """
        if customer.contact_type != "both":
            return
        from purchases.models import Supplier  # noqa: PLC0415

        match = Supplier.objects.filter(phone=customer.phone).first() if customer.phone else None
        common = {
            "name":            customer.name,
            "business_name":   customer.business_name,
            "email":           customer.email,
            "phone":           customer.phone,
            "address":         customer.address,
            "tax_number":      customer.tax_number,
            "pay_term_value":  customer.pay_term_value,
            "pay_term_period": customer.pay_term_period,
            "opening_balance": customer.opening_balance,
            "advance_balance": customer.advance_balance,
            "notes":           customer.notes,
            "is_active":       customer.is_active,
        }
        if match:
            for k, v in common.items():
                setattr(match, k, v)
            match.save()
        else:
            Supplier.objects.create(**common)


# ──────────────────────────────────────────────────────────────────────────────
# Sale input serializers
# ──────────────────────────────────────────────────────────────────────────────

class SaleItemInputSerializer(serializers.Serializer):
    """One line item in a sale create / update payload."""
    product_id    = serializers.UUIDField()
    quantity      = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0.0001"))
    unit_price    = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    item_discount = serializers.DecimalField(
        max_digits=14, decimal_places=2,
        min_value=Decimal("0"), required=False, default=Decimal("0"),
    )
    # Per-line note (IMEI / serial / free text) printed on the invoice. POS
    # sends it as meta.description; Add Sale may send `note` directly — the
    # service layer accepts either.
    note = serializers.CharField(required=False, allow_blank=True, default="")
    meta = serializers.JSONField(required=False, default=dict)

    def validate(self, attrs):
        if attrs["item_discount"] > attrs["unit_price"]:
            raise serializers.ValidationError(
                "item_discount cannot exceed unit_price."
            )
        return attrs


class CreateSaleSerializer(serializers.Serializer):
    """POST /api/sales/"""
    location_id         = serializers.UUIDField()
    items               = SaleItemInputSerializer(many=True)
    status              = serializers.ChoiceField(
        choices=[Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT],
        default=Sale.Status.DRAFT,
    )
    customer_id         = serializers.UUIDField(required=False, allow_null=True, default=None)
    discount            = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("0"),
        required=False, default=Decimal("0"),
    )
    tax_rate            = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=Decimal("0"),
        required=False, default=Decimal("0"),
    )
    notes               = serializers.CharField(required=False, allow_blank=True, default="")
    # The POS form (and Add Sale) tags each sale with source / table_ref /
    # service_staff inside meta. We accept it as an arbitrary JSON object
    # so the field round-trips cleanly through to Sale.meta and views like
    # PosSaleListView can filter on meta.source = "POS".
    meta                = serializers.JSONField(required=False, default=dict)
    supervisor_password = serializers.CharField(
        required=False, allow_blank=True, default=None,
        help_text="Required only when a cashier applies a non-zero discount.",
        write_only=True,
    )

    def validate_items(self, value):
        if not value:
            raise serializers.ValidationError("At least one item is required.")
        return value

    def validate_meta(self, value):
        # Defensive: ignore anything that isn't an object — never crash.
        return value if isinstance(value, dict) else {}


class UpdateSaleSerializer(serializers.Serializer):
    """PATCH /api/sales/<id>/"""
    items               = SaleItemInputSerializer(many=True, required=False)
    customer_id         = serializers.UUIDField(required=False, allow_null=True)
    discount            = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False,
    )
    tax_rate            = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=Decimal("0"), required=False,
    )
    notes               = serializers.CharField(required=False, allow_blank=True)
    supervisor_password = serializers.CharField(
        required=False, allow_blank=True, default=None, write_only=True,
    )


class FinalizeSerializer(serializers.Serializer):
    """POST /api/sales/<id>/finalize/  — no body fields required."""
    pass


class AddPaymentSerializer(serializers.Serializer):
    """POST /api/sales/<id>/payments/"""
    amount             = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))
    method             = serializers.ChoiceField(choices=SalePayment.Method.choices)
    reference          = serializers.CharField(required=False, allow_blank=True, default="")
    notes              = serializers.CharField(required=False, allow_blank=True, default="")
    payment_account_id = serializers.UUIDField(required=False, allow_null=True, default=None,
                                               help_text="Optional — PaymentAccount the money landed in.")


class CreateBackOrderSerializer(serializers.Serializer):
    """POST /api/sales/<id>/backorder/  — no extra body fields required."""
    pass


class AdditionalExpenseSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))


class SalePaymentInputSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    paid_on = serializers.DateField(required=False, allow_null=True)
    method = serializers.ChoiceField(choices=SalePayment.Method.choices)
    # payment_account_id is the FK to the tenant's PaymentAccount and
    # drives WHICH Account Book ledger row the payment lands in. Legacy
    # `payment_account` (free-text label) is still accepted for
    # backward compatibility.
    payment_account_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    payment_account    = serializers.CharField(required=False, allow_blank=True, default="")
    reference          = serializers.CharField(required=False, allow_blank=True, default="")
    note               = serializers.CharField(required=False, allow_blank=True, default="")
    # Method-specific extras — every field is optional and only consumed
    # when the chosen method actually uses it. The serializer accepts
    # them so the frontend can send the whole form without conditional
    # payload-shaping.
    card_number         = serializers.CharField(required=False, allow_blank=True, default="")
    card_holder_name    = serializers.CharField(required=False, allow_blank=True, default="")
    card_transaction_no = serializers.CharField(required=False, allow_blank=True, default="")
    card_type           = serializers.CharField(required=False, allow_blank=True, default="")
    card_month          = serializers.CharField(required=False, allow_blank=True, default="")
    card_year           = serializers.CharField(required=False, allow_blank=True, default="")
    card_security_code  = serializers.CharField(required=False, allow_blank=True, default="")
    bank_account_no     = serializers.CharField(required=False, allow_blank=True, default="")


class AdvancedCreateSaleSerializer(serializers.Serializer):
    location_id = serializers.UUIDField()
    customer_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    pay_term_days = serializers.IntegerField(required=False, min_value=0, default=0)
    pay_term_value = serializers.IntegerField(required=False, allow_null=True, min_value=0, default=None)
    pay_term_period = serializers.ChoiceField(choices=["", "days", "months"], required=False, allow_blank=True, default="")
    sale_date = serializers.DateTimeField(required=False, allow_null=True, default=None)
    status = serializers.ChoiceField(
        choices=[Sale.Status.QUOTATION, Sale.Status.PROFORMA, Sale.Status.DRAFT, Sale.Status.FINAL],
        default=Sale.Status.DRAFT,
    )
    invoice_no = serializers.CharField(required=False, allow_blank=True, allow_null=True, default=None)
    invoice_scheme = serializers.CharField(required=False, allow_blank=True, default="")
    service_staff = serializers.CharField(required=False, allow_blank=True, default="")
    table_ref = serializers.CharField(required=False, allow_blank=True, default="")
    source = serializers.CharField(required=False, allow_blank=True, default="POS")
    attach_document_name = serializers.CharField(required=False, allow_blank=True, default="")
    sell_note = serializers.CharField(required=False, allow_blank=True, default="")
    staff_note = serializers.CharField(required=False, allow_blank=True, default="")

    items = SaleItemInputSerializer(many=True)

    discount_type = serializers.ChoiceField(choices=["PERCENTAGE", "FIXED"], default="FIXED")
    discount_value = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"), default=Decimal("0"))
    order_tax = serializers.DecimalField(max_digits=5, decimal_places=2, min_value=Decimal("0"), default=Decimal("0"))

    shipping_details = serializers.CharField(required=False, allow_blank=True, default="")
    shipping_address = serializers.CharField(required=False, allow_blank=True, default="")
    shipping_charges = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"), default=Decimal("0"))
    shipping_status = serializers.CharField(required=False, allow_blank=True, default="")
    delivered_to = serializers.CharField(required=False, allow_blank=True, default="")
    shipping_documents = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        default=list,
    )

    additional_expenses = AdditionalExpenseSerializer(many=True, required=False, default=list)
    payment = SalePaymentInputSerializer(required=False, allow_null=True, default=None)
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    supervisor_password = serializers.CharField(required=False, allow_blank=True, default=None, write_only=True)


# ──────────────────────────────────────────────────────────────────────────────
# Output serializers
# ──────────────────────────────────────────────────────────────────────────────

class SaleItemSerializer(serializers.ModelSerializer):
    product_name         = serializers.CharField(source="product.name", read_only=True)
    product_sku          = serializers.CharField(source="product.sku", read_only=True)
    effective_unit_price = serializers.DecimalField(
        max_digits=14, decimal_places=2, read_only=True,
    )
    gross_profit         = serializers.DecimalField(
        max_digits=14, decimal_places=4, read_only=True, allow_null=True,
    )

    class Meta:
        model  = SaleItem
        fields = [
            "id", "product", "product_name", "product_sku",
            "quantity", "unit_price", "item_discount",
            "effective_unit_price", "total_price",
            "cogs", "gross_profit", "note",
        ]


class SalePaymentSerializer(serializers.ModelSerializer):
    class Meta:
        model  = SalePayment
        fields = [
            "id", "amount", "method", "reference", "notes",
            "received_by_id", "created_at",
        ]


class BackOrderSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model  = BackOrder
        fields = [
            "id", "product", "product_name",
            "requested_qty", "available_qty", "shortfall_qty",
            "status", "notes", "created_at", "fulfilled_at",
        ]


class SaleListSerializer(serializers.ModelSerializer):
    """Compact representation for list views."""
    customer_name = serializers.CharField(source="customer.name", read_only=True, allow_null=True)
    contact_number = serializers.CharField(source="customer.phone", read_only=True, allow_null=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    item_count    = serializers.SerializerMethodField()
    invoice_no    = serializers.CharField(source="invoice_number", read_only=True, allow_null=True)
    date          = serializers.DateTimeField(source="created_at", read_only=True)
    total_amount  = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)
    total_paid    = serializers.DecimalField(source="amount_paid", max_digits=14, decimal_places=2, read_only=True)
    sell_due      = serializers.DecimalField(source="balance_due", max_digits=14, decimal_places=2, read_only=True)
    sell_return_due = serializers.SerializerMethodField()
    payment_method = serializers.CharField(read_only=True, allow_null=True)
    shipping_status = serializers.SerializerMethodField()
    shipping_details = serializers.SerializerMethodField()
    sell_note = serializers.SerializerMethodField()
    staff_note = serializers.SerializerMethodField()
    table = serializers.SerializerMethodField()
    added_by = serializers.CharField(source="created_by_id", read_only=True)
    created_by_name   = serializers.SerializerMethodField()
    finalized_by_name = serializers.SerializerMethodField()
    meta = serializers.JSONField(read_only=True)

    def _user_name(self, uid):
        if not uid:
            return None
        cache = self.context.setdefault("_user_name_cache", {}) if hasattr(self, "context") else {}
        if uid in cache:
            return cache[uid]
        try:
            from accounts.models import User
            name = User.objects.using("default").filter(id=uid).values_list("name", flat=True).first()
        except Exception:
            name = None
        cache[uid] = name
        return name

    def get_created_by_name(self, obj):
        return self._user_name(obj.created_by_id)

    def get_finalized_by_name(self, obj):
        return self._user_name(obj.finalized_by_id)

    # Service staff stored on Add Sale screen → meta.service_staff holds
    # a User UUID. Resolve it to the user's name so the list/POS table
    # can show "Added by · Service Staff" without an extra round-trip.
    service_staff_name = serializers.SerializerMethodField()

    def get_service_staff_name(self, obj):
        ss = (obj.meta or {}).get("service_staff") if hasattr(obj, "meta") else None
        if not ss:
            # Legacy rows (pre meta.service_staff) — the finaliser
            # acted as service staff. Mirrors the filter fallback in
            # SalesListView so a filtered list never shows "—" in
            # the very column it was filtered on.
            if obj.finalized_by_id:
                return self._user_name(obj.finalized_by_id)
            return None
        # If it looks like a UUID, resolve to the user's display name.
        # Otherwise (legacy free-text rows) just echo the string.
        import uuid as _uuid
        try:
            _uuid.UUID(str(ss))
            return self._user_name(ss) or ss
        except (ValueError, TypeError):
            return str(ss)

    class Meta:
        model  = Sale
        fields = [
            "id", "invoice_no", "invoice_number", "date", "created_at",
            "status", "payment_status", "payment_method",
            "customer_name", "contact_number", "location_name", "item_count",
            "subtotal", "discount", "tax_amount", "total_amount", "total_paid",
            "amount_paid", "sell_due", "balance_due", "sell_return_due",
            "created_by_id", "created_by_name",
            "finalized_by_id", "finalized_by_name", "finalized_at",
            "service_staff_name",
            "shipping_status", "shipping_details", "sell_note", "staff_note", "table", "added_by", "meta",
        ]

    def get_item_count(self, obj):
        # "Total Items" = total UNITS sold on this sale (sum of every line's
        # quantity), NOT the number of line rows. So a single line of "50
        # photocopies" counts as 50. This matches the dashboard's "Items
        # Sold Today" metric (reports.services.get_sales_summary sums the
        # same quantities), so the All Sales footer total and the dashboard
        # KPI always agree. Summed in Python over the prefetched items
        # (see SaleListCreateView .prefetch_related("items")) → no N+1.
        total = sum((i.quantity or Decimal("0")) for i in obj.items.all())
        return total or Decimal("0")

    def get_sell_return_due(self, obj):
        # Placeholder until sale return module is implemented.
        return Decimal("0.00")

    def _meta(self, obj):
        return getattr(obj, "meta", {}) or {}

    def get_shipping_status(self, obj):
        return self._meta(obj).get("shipping_status", "")

    def get_shipping_details(self, obj):
        return self._meta(obj).get("shipping_details", "")

    def get_sell_note(self, obj):
        return self._meta(obj).get("sell_note", "")

    def get_staff_note(self, obj):
        return self._meta(obj).get("staff_note", "")

    def get_table(self, obj):
        return self._meta(obj).get("table_ref", "")


class SaleDetailSerializer(serializers.ModelSerializer):
    """Full representation with nested items, payments, and back-orders."""
    customer      = CustomerSerializer(read_only=True, allow_null=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    location_code = serializers.CharField(source="location.code", read_only=True)
    items         = SaleItemSerializer(many=True, read_only=True)
    sale_payments = SalePaymentSerializer(many=True, read_only=True)
    backorders    = BackOrderSerializer(many=True, read_only=True)
    created_by_name   = serializers.SerializerMethodField()
    finalized_by_name = serializers.SerializerMethodField()
    meta              = serializers.JSONField(read_only=True)

    class Meta:
        model  = Sale
        fields = [
            "id", "invoice_number", "status", "payment_status",
            "customer", "location", "location_name", "location_code",
            "subtotal", "discount", "tax_rate", "tax_amount",
            "total_amount", "amount_paid", "balance_due",
            "pay_term_days", "pay_term_value", "pay_term_period",
            "shipping_charges",
            "items", "sale_payments", "backorders",
            "notes",
            "created_by_id",   "created_by_name",
            "finalized_by_id", "finalized_by_name",
            "created_at", "finalized_at", "updated_at",
            "meta",
        ]

    def _user_name(self, uid):
        if not uid:
            return None
        # Per-request cache lives on the serializer's context, not the class,
        # so concurrent requests can't read each other's data.
        cache = self.context.setdefault("_user_name_cache", {}) if hasattr(self, "context") else {}
        if uid in cache:
            return cache[uid]
        try:
            from accounts.models import User
            name = User.objects.using("default").filter(id=uid).values_list("name", flat=True).first()
        except Exception:
            name = None
        cache[uid] = name
        return name

    def get_created_by_name(self, obj):
        return self._user_name(obj.created_by_id)

    def get_finalized_by_name(self, obj):
        return self._user_name(obj.finalized_by_id)


class SellReturnItemSerializer(serializers.ModelSerializer):
    product_id   = serializers.UUIDField(source="product.id", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    sku          = serializers.CharField(source="product.sku", read_only=True)

    class Meta:
        model  = SellReturnItem
        fields = ["id", "product_id", "product_name", "sku",
                  "quantity", "unit_price", "line_total", "reason"]


class SellReturnDetailSerializer(serializers.ModelSerializer):
    customer_name      = serializers.CharField(source="customer.name", read_only=True, allow_null=True)
    location_name      = serializers.CharField(source="location.name", read_only=True)
    parent_sale_id     = serializers.UUIDField(source="parent_sale.id", read_only=True)
    parent_invoice_no  = serializers.CharField(source="parent_sale.invoice_number", read_only=True)
    invoice_no         = serializers.CharField(source="invoice_number", read_only=True)
    items              = SellReturnItemSerializer(many=True, read_only=True)

    class Meta:
        model  = SellReturn
        fields = [
            "id", "invoice_no", "invoice_number",
            "parent_sale_id", "parent_invoice_no",
            "customer", "customer_name",
            "location", "location_name",
            "return_date", "refund_method",
            "payment_status",
            "total_amount", "restocking_fee",
            "refunded_amount", "amount_paid", "balance_due",
            "notes", "meta", "items",
            "created_by_id", "created_at", "updated_at",
        ]


class CreateSellReturnItemSerializer(serializers.Serializer):
    product_id = serializers.UUIDField()
    quantity   = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0.0001"))
    unit_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    reason     = serializers.CharField(max_length=30, required=False, allow_blank=True)


class CreateSellReturnSerializer(serializers.Serializer):
    parent_sale_id  = serializers.UUIDField()
    location_id     = serializers.UUIDField()
    items           = CreateSellReturnItemSerializer(many=True)
    return_date     = serializers.DateField(required=False)
    refund_method   = serializers.CharField(max_length=20, required=False, allow_blank=True)
    refunded_amount = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=Decimal("0"))
    # Cashier's specific Payment Account choice — drives WHICH ledger
    # the refund debits (e.g. "City Bank" vs the generic 1002 Bank).
    payment_account_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    restocking_fee  = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=Decimal("0"))
    notes           = serializers.CharField(required=False, allow_blank=True)

    def validate_items(self, value):
        if not value:
            raise serializers.ValidationError("At least one return item is required.")
        return value


class SellReturnListSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.name", read_only=True, allow_null=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    date = serializers.DateTimeField(source="created_at", read_only=True)
    invoice_no = serializers.CharField(source="invoice_number", read_only=True)
    parent_sale_id = serializers.UUIDField(source="parent_sale.id", read_only=True)
    payment_due = serializers.DecimalField(source="balance_due", max_digits=14, decimal_places=2, read_only=True)

    class Meta:
        model = SellReturn
        fields = [
            "id",
            "date",
            "invoice_no",
            "invoice_number",
            "parent_sale_id",
            "customer_name",
            "location_name",
            "payment_status",
            "total_amount",
            "amount_paid",
            "payment_due",
            "balance_due",
            "created_by_id",
            "meta",
        ]


class DiscountSerializer(serializers.ModelSerializer):
    product_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        write_only=True,
    )
    products_count = serializers.SerializerMethodField(read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)

    class Meta:
        model = Discount
        fields = [
            "id",
            "name",
            "starts_at",
            "ends_at",
            "discount_amount",
            "discount_type",
            "selling_price_group",
            "priority",
            "brand",
            "category",
            "product_ids",
            "products_count",
            "location",
            "location_name",
            "is_active",
            "created_at",
        ]
        extra_kwargs = {
            # `starts_at` / `ends_at` are required in the model but the
            # UI auto-generates sensible defaults so we let the
            # serializer accept blanks without erroring.
            "starts_at": {"required": False},
            "ends_at":   {"required": False},
        }

    def get_products_count(self, obj):
        return obj.products.count()

    def create(self, validated_data):
        product_ids = validated_data.pop("product_ids", [])
        instance = Discount.objects.create(**validated_data)
        if product_ids:
            instance.products.set(product_ids)
        return instance
