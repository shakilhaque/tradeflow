"""
Purchases serializers — list, detail, create, update.
"""
from decimal import Decimal
from rest_framework import serializers

from inventory.models import Product
from .models import (
    Supplier, Purchase, PurchaseItem, PurchasePayment,
    PurchaseReturn, PurchaseReturnItem,
)


# ── Supplier ─────────────────────────────────────────────────────────────────

class SupplierSerializer(serializers.ModelSerializer):
    # Computed fields surfaced by SupplierViewSet's annotated queryset.
    display_code              = serializers.SerializerMethodField()
    total_purchase_due        = serializers.SerializerMethodField()
    total_purchase_return_due = serializers.SerializerMethodField()

    # `name` is composed by Supplier.save() from individual/business inputs,
    # so the API doesn't need it on input. Mirrors CustomerSerializer.
    name = serializers.CharField(max_length=200, required=False, allow_blank=True)

    class Meta:
        model  = Supplier
        fields = [
            "id", "name", "business_name",
            "is_individual", "contact_id",
            "prefix", "first_name", "middle_name", "last_name",
            "date_of_birth",
            "contact", "email", "phone", "alternate_phone", "landline",
            "address", "address_line_2", "city", "state", "country", "zip_code",
            "shipping_address",
            "tax_number", "notes", "is_active",
            "pay_term_value", "pay_term_period",
            "opening_balance", "advance_balance",
            "custom_field_1", "custom_field_2", "custom_field_3", "custom_field_4",
            "created_at", "updated_at",
            "display_code",
            "total_purchase_due", "total_purchase_return_due",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def get_display_code(self, obj):
        return "S-" + str(obj.id).replace("-", "")[:6].upper()

    def get_total_purchase_due(self, obj):
        return str(getattr(obj, "total_purchase_due", 0) or 0)

    def get_total_purchase_return_due(self, obj):
        return str(getattr(obj, "total_purchase_return_due", 0) or 0)

    # ── Per-branch validation (Individual vs Business) ──────────────────────
    def validate(self, attrs):
        inst = self.instance
        is_individual = attrs.get(
            "is_individual",
            getattr(inst, "is_individual", False) if inst else False,
        )
        if is_individual:
            first = (attrs.get("first_name") or (inst.first_name if inst else "")).strip()
            last  = (attrs.get("last_name")  or (inst.last_name  if inst else "")).strip()
            if not first:
                raise serializers.ValidationError({"first_name": "First name is required for individuals."})
            if not last:
                raise serializers.ValidationError({"last_name":  "Last name is required for individuals."})
        else:
            biz = (attrs.get("business_name") or (inst.business_name if inst else "")).strip()
            if not biz:
                raise serializers.ValidationError({"business_name": "Business name is required."})

        phone = (attrs.get("phone") or (inst.phone if inst else "")).strip()
        if not phone:
            raise serializers.ValidationError({"phone": "Mobile number is required."})
        return attrs


# ── Purchase items ───────────────────────────────────────────────────────────

class PurchaseItemInputSerializer(serializers.Serializer):
    product_id = serializers.UUIDField()
    quantity   = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0.0001"))
    unit_cost  = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0"))
    tax_rate   = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, default=Decimal("0"), min_value=Decimal("0")
    )
    discount   = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=Decimal("0"), min_value=Decimal("0")
    )


class PurchaseItemOutputSerializer(serializers.ModelSerializer):
    class Meta:
        model  = PurchaseItem
        fields = [
            "id", "product", "product_name", "sku",
            "quantity", "unit_cost", "tax_rate", "discount", "line_total", "received_qty",
        ]


# ── Purchase payments ────────────────────────────────────────────────────────

class PurchasePaymentSerializer(serializers.ModelSerializer):
    # Resolved live from the accounting app — the View Payments modal
    # shows which ledger the money came out of without a second
    # roundtrip. Falls back to None for legacy rows / missing accounts.
    payment_account_name = serializers.SerializerMethodField()

    class Meta:
        model  = PurchasePayment
        fields = [
            "id", "amount", "method", "reference", "notes", "paid_at", "created_at",
            "payment_account_id", "payment_account_name",
        ]
        read_only_fields = ["id", "created_at"]

    def get_payment_account_name(self, obj):
        if not getattr(obj, "payment_account_id", None):
            return None
        try:
            from accounting.models import PaymentAccount  # noqa: PLC0415
            acct = PaymentAccount.objects.filter(id=obj.payment_account_id).only("name").first()
            return acct.name if acct else None
        except Exception:
            return None


class PurchaseReturnPaymentSerializer(serializers.ModelSerializer):
    """Mirrors PurchasePaymentSerializer — exposes the live
    payment_account_name so the View Payments modal on the Purchase
    Returns page can show the Payment Account column without a
    second roundtrip."""
    from .models import PurchaseReturnPayment as _PRP  # noqa: PLC0415
    payment_account_name = serializers.SerializerMethodField()

    class Meta:
        from .models import PurchaseReturnPayment as PRP  # noqa: PLC0415
        model  = PRP
        fields = [
            "id", "reference_no", "amount", "method", "reference", "notes",
            "paid_at", "created_at", "updated_at",
            "payment_account_id", "payment_account_name",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def get_payment_account_name(self, obj):
        if not getattr(obj, "payment_account_id", None):
            return None
        try:
            from accounting.models import PaymentAccount  # noqa: PLC0415
            acct = PaymentAccount.objects.filter(id=obj.payment_account_id).only("name").first()
            return acct.name if acct else None
        except Exception:
            return None


# ── Purchase create / update ─────────────────────────────────────────────────

class CreatePurchaseSerializer(serializers.Serializer):
    reference_no    = serializers.CharField(max_length=80, required=False, allow_blank=True)
    supplier_id     = serializers.UUIDField()
    location_id     = serializers.UUIDField()
    purchase_date   = serializers.DateField(required=False)
    status          = serializers.ChoiceField(choices=Purchase.Status.choices, required=False)
    discount_amount = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=Decimal("0"))
    shipping_cost   = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=Decimal("0"))
    notes           = serializers.CharField(required=False, allow_blank=True)
    shipping_details = serializers.CharField(required=False, allow_blank=True)

    items           = PurchaseItemInputSerializer(many=True)

    # Optional initial payment
    payment_amount  = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=Decimal("0"))
    payment_method  = serializers.ChoiceField(choices=PurchasePayment.Method.choices, required=False)
    payment_reference = serializers.CharField(max_length=120, required=False, allow_blank=True)
    # Cash box / bank / wallet the supplier payment is paid FROM — so the
    # purchase posts a WITHDRAWAL and the return can refund it later.
    payment_account_id = serializers.UUIDField(required=False, allow_null=True, default=None)

    def validate_items(self, items):
        if not items:
            raise serializers.ValidationError("At least one item is required.")
        return items


# ── Purchase list / detail ───────────────────────────────────────────────────

class PurchaseListSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    payment_due   = serializers.SerializerMethodField()
    # Return tracking — has this purchase been (partly) returned?
    has_returns   = serializers.SerializerMethodField()
    return_total  = serializers.SerializerMethodField()
    # Effective status the list should show: "returned" once a non-cancelled
    # return exists, otherwise the purchase's own status.
    status_display = serializers.SerializerMethodField()

    class Meta:
        model  = Purchase
        fields = [
            "id", "reference_no", "purchase_date",
            "supplier", "supplier_name",
            "location", "location_name",
            "status", "payment_status",
            "has_returns", "return_total", "status_display",
            "subtotal", "discount_amount", "tax_amount", "shipping_cost",
            "grand_total", "paid_amount", "payment_due",
            "added_by_name", "created_at",
        ]

    def get_payment_due(self, obj):
        return str(obj.payment_due)

    def _active_returns(self, obj):
        # Uses the prefetched `returns` so there's no per-row query.
        return [r for r in obj.returns.all() if r.status != "cancelled"]

    def get_has_returns(self, obj):
        return bool(self._active_returns(obj))

    def get_return_total(self, obj):
        from decimal import Decimal as _D
        return str(sum((_D(str(r.total_amount or 0)) for r in self._active_returns(obj)), _D("0")))

    def get_status_display(self, obj):
        return "returned" if self._active_returns(obj) else obj.status


class PurchaseDetailSerializer(serializers.ModelSerializer):
    # Embed supplier + location address/phone/email so the new
    # View Purchase modal on the All Purchases page can render
    # the full document without a second roundtrip.
    supplier_name    = serializers.CharField(source="supplier.name",    read_only=True)
    supplier_phone   = serializers.CharField(source="supplier.phone",   read_only=True)
    supplier_email   = serializers.CharField(source="supplier.email",   read_only=True)
    supplier_address = serializers.CharField(source="supplier.address", read_only=True)
    location_name    = serializers.CharField(source="location.name",    read_only=True)
    location_address = serializers.CharField(source="location.address", read_only=True)
    items         = PurchaseItemOutputSerializer(many=True, read_only=True)
    payments      = PurchasePaymentSerializer(many=True, read_only=True)
    payment_due   = serializers.SerializerMethodField()

    class Meta:
        model  = Purchase
        fields = [
            "id", "reference_no", "purchase_date",
            "supplier", "supplier_name", "supplier_phone", "supplier_email", "supplier_address",
            "location", "location_name", "location_address",
            "status", "payment_status",
            "subtotal", "discount_amount", "tax_amount", "shipping_cost",
            "grand_total", "paid_amount", "payment_due",
            "notes", "shipping_details", "edit_history",
            "added_by_id", "added_by_name",
            "items", "payments",
            "created_at", "updated_at",
        ]

    def get_payment_due(self, obj):
        return str(obj.payment_due)


# ── Purchase Return ──────────────────────────────────────────────────────────

class PurchaseReturnItemInputSerializer(serializers.Serializer):
    product_id = serializers.UUIDField()
    quantity   = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0.0001"))
    unit_cost  = serializers.DecimalField(max_digits=14, decimal_places=4, min_value=Decimal("0"))


class PurchaseReturnItemOutputSerializer(serializers.ModelSerializer):
    class Meta:
        model = PurchaseReturnItem
        fields = ["id", "product", "product_name", "sku", "quantity", "unit_cost", "line_total"]


class CreatePurchaseReturnSerializer(serializers.Serializer):
    reference_no = serializers.CharField(max_length=80, required=False, allow_blank=True)
    purchase_id  = serializers.UUIDField(required=False, allow_null=True)
    supplier_id  = serializers.UUIDField()
    location_id  = serializers.UUIDField()
    return_date  = serializers.DateField(required=False)
    notes        = serializers.CharField(required=False, allow_blank=True)
    items        = PurchaseReturnItemInputSerializer(many=True)

    def validate_items(self, items):
        if not items:
            raise serializers.ValidationError("At least one item is required.")
        return items


class PurchaseReturnListSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    location_name = serializers.CharField(source="location.name", read_only=True)
    purchase_ref  = serializers.CharField(source="purchase.reference_no", read_only=True)

    class Meta:
        model = PurchaseReturn
        fields = [
            "id", "reference_no", "return_date",
            "supplier", "supplier_name",
            "location", "location_name",
            "purchase", "purchase_ref",
            "status", "total_amount",
            "added_by_name", "created_at",
        ]


class PurchaseReturnDetailSerializer(serializers.ModelSerializer):
    supplier_name    = serializers.CharField(source="supplier.name",    read_only=True)
    supplier_phone   = serializers.CharField(source="supplier.phone",   read_only=True)
    supplier_address = serializers.CharField(source="supplier.address", read_only=True)
    location_name    = serializers.CharField(source="location.name",    read_only=True)
    location_address = serializers.CharField(source="location.address", read_only=True)
    items         = PurchaseReturnItemOutputSerializer(many=True, read_only=True)
    payments      = PurchaseReturnPaymentSerializer(many=True, read_only=True)

    class Meta:
        model = PurchaseReturn
        fields = [
            "id", "reference_no", "return_date",
            "supplier", "supplier_name", "supplier_phone", "supplier_address",
            "location", "location_name", "location_address",
            "purchase",
            "status", "total_amount", "notes",
            "added_by_name",
            "items", "payments",
            "created_at", "updated_at",
        ]
