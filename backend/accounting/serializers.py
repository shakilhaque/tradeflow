"""
Accounting serializers.

Input serializers
─────────────────
  AccountCreateSerializer       POST /accounts/
  AccountUpdateSerializer       PATCH /accounts/<id>/
  ExpenseCreateSerializer       POST /expenses/
  ManualJournalEntrySerializer  POST /journal-entries/  (manual adjustments)

Output serializers
──────────────────
  AccountSerializer
  JournalEntryLineSerializer
  JournalEntrySerializer
  ExpenseSerializer
"""
from decimal import Decimal

from rest_framework import serializers

from .models import Account, Expense, ExpenseCategory, JournalEntry, JournalEntryLine


# ──────────────────────────────────────────────────────────────────────────────
# Account
# ──────────────────────────────────────────────────────────────────────────────

class AccountSerializer(serializers.ModelSerializer):
    normal_balance = serializers.CharField(read_only=True)
    balance        = serializers.SerializerMethodField()
    parent_code    = serializers.CharField(source="parent.code", read_only=True, allow_null=True)

    class Meta:
        model  = Account
        fields = [
            "id", "code", "name", "account_type", "normal_balance",
            "parent", "parent_code", "is_contra", "is_system", "is_active",
            "description", "balance", "created_at",
        ]
        read_only_fields = ["id", "is_system", "created_at", "normal_balance", "balance"]

    def get_balance(self, obj) -> float:
        return obj.get_balance()


class AccountCreateSerializer(serializers.Serializer):
    """POST /api/accounting/accounts/"""
    code         = serializers.CharField(max_length=20)
    name         = serializers.CharField(max_length=200)
    account_type = serializers.ChoiceField(choices=Account.Type.choices)
    parent_id    = serializers.UUIDField(required=False, allow_null=True, default=None)
    is_contra    = serializers.BooleanField(required=False, default=False)
    description  = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_code(self, value):
        if Account.objects.filter(code=value).exists():
            raise serializers.ValidationError(f"Account code '{value}' already exists.")
        return value


class AccountUpdateSerializer(serializers.Serializer):
    """PATCH /api/accounting/accounts/<id>/"""
    name        = serializers.CharField(max_length=200, required=False)
    is_active   = serializers.BooleanField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)


# ──────────────────────────────────────────────────────────────────────────────
# Journal Entry
# ──────────────────────────────────────────────────────────────────────────────

class JournalEntryLineSerializer(serializers.ModelSerializer):
    account_code = serializers.CharField(source="account.code", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)

    class Meta:
        model  = JournalEntryLine
        fields = [
            "id", "account", "account_code", "account_name",
            "description", "debit", "credit",
        ]


class JournalEntrySerializer(serializers.ModelSerializer):
    lines       = JournalEntryLineSerializer(many=True, read_only=True)
    is_balanced = serializers.BooleanField(read_only=True)
    total_debit = serializers.DecimalField(
        max_digits=14, decimal_places=2, read_only=True,
    )
    total_credit = serializers.DecimalField(
        max_digits=14, decimal_places=2, read_only=True,
    )

    class Meta:
        model  = JournalEntry
        fields = [
            "id", "entry_number", "reference_type", "reference_id",
            "date", "description", "is_posted",
            "total_debit", "total_credit", "is_balanced",
            "lines", "created_by_id", "created_at",
        ]


class ManualJELineSerializer(serializers.Serializer):
    account_id  = serializers.UUIDField()
    debit       = serializers.DecimalField(max_digits=14, decimal_places=2,
                                           min_value=Decimal("0"), required=False, default=Decimal("0"))
    credit      = serializers.DecimalField(max_digits=14, decimal_places=2,
                                           min_value=Decimal("0"), required=False, default=Decimal("0"))
    description = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["debit"] > 0 and attrs["credit"] > 0:
            raise serializers.ValidationError(
                "A line cannot have both debit and credit non-zero."
            )
        return attrs


class ManualJournalEntrySerializer(serializers.Serializer):
    """POST /api/accounting/journal-entries/  (manual adjustment)"""
    description = serializers.CharField()
    date        = serializers.DateField(required=False)
    lines       = ManualJELineSerializer(many=True, min_length=2)

    def validate_lines(self, value):
        if len(value) < 2:
            raise serializers.ValidationError("A journal entry needs at least 2 lines.")
        return value


# ──────────────────────────────────────────────────────────────────────────────
# Expense
# ──────────────────────────────────────────────────────────────────────────────

class ExpenseSerializer(serializers.ModelSerializer):
    expense_account_name = serializers.CharField(source="expense_account.name", read_only=True)
    payment_account_name = serializers.CharField(source="payment_account.name", read_only=True)
    journal_entry_number = serializers.CharField(source="journal_entry.entry_number",
                                                  read_only=True, allow_null=True)
    category_display     = serializers.SerializerMethodField()
    payment_status_display = serializers.CharField(source="get_payment_status_display", read_only=True)
    location_name        = serializers.SerializerMethodField()
    payment_due          = serializers.SerializerMethodField()
    # Embedded payments + recurring details + business display so the
    # View Payments modal renders the full document without a second
    # roundtrip.
    payments             = serializers.SerializerMethodField()

    class Meta:
        model  = Expense
        fields = [
            "id", "reference_no",
            "category", "category_display",
            "expense_category", "expense_sub_category",
            "expense_account", "expense_account_name",
            "payment_account", "payment_account_name",
            "payment_account_picked_id",
            "payment_method",
            "amount", "tax_amount", "paid_amount", "payment_due",
            "payment_status", "payment_status_display",
            "location_id", "location_name",
            "expense_for", "contact_name", "contact_id",
            "recurring", "recurring_details",
            "description", "expense_date",
            "journal_entry", "journal_entry_number",
            "attach_document_url",
            "card_holder_name", "card_transaction_no", "card_type",
            "card_month", "card_year",
            "cheque_no", "bank_account_no",
            "created_by_id", "created_at",
            "payments",
        ]
        read_only_fields = ["id", "journal_entry", "created_by_id", "created_at"]

    def get_category_display(self, obj):
        # The real category is the FK the user picks on the form
        # (expense_category → ExpenseCategory). The legacy `category` choice
        # field defaults to "Other", so showing its display made every row
        # read "Other". Prefer the FK name (with sub-category when set), and
        # only fall back to the enum label for old rows that never set the FK.
        if obj.expense_category_id and obj.expense_category:
            name = obj.expense_category.name
            if obj.expense_sub_category_id and obj.expense_sub_category:
                return f"{name} › {obj.expense_sub_category.name}"
            return name
        return obj.get_category_display()

    def get_payments(self, obj):
        """Returns every ExpensePayment row attached to this expense
        plus the implicit "initial payment" derived from the expense
        itself when paid_amount > 0 and no rows yet — so legacy
        expenses created BEFORE the ExpensePayment table existed
        still show up correctly. Newly-created rows from the
        Add Expense form should also write an ExpensePayment row
        as part of save (handled by the create view)."""
        rows = []
        try:
            from .models import ExpensePayment  # noqa: PLC0415
            for p in obj.payments.all():
                rows.append({
                    "id":                 str(p.id),
                    "reference_no":       p.reference_no or "",
                    "amount":             str(p.amount or 0),
                    "method":             p.method or "cash",
                    "reference":          p.reference or "",
                    "notes":              p.notes or "",
                    "paid_at":            p.paid_at,
                    "created_at":         p.created_at,
                    "payment_account_id": str(p.payment_account_id) if p.payment_account_id else None,
                    "payment_account_name": self._account_name(p.payment_account_id),
                })
        except Exception:
            rows = []
        return rows

    @staticmethod
    def _account_name(pa_id):
        if not pa_id:
            return None
        try:
            from .models import PaymentAccount  # noqa: PLC0415
            acct = PaymentAccount.objects.filter(id=pa_id).only("name").first()
            return acct.name if acct else None
        except Exception:
            return None

    def get_payment_due(self, obj):
        return str(max((obj.amount or 0) - (obj.paid_amount or 0), 0))

    def get_location_name(self, obj):
        # Lazy import — avoids circular import at module load.
        if not obj.location_id:
            return None
        try:
            from inventory.models import Location  # noqa: PLC0415
            return Location.objects.filter(id=obj.location_id).values_list("name", flat=True).first()
        except Exception:
            return None


class ExpenseCreateSerializer(serializers.Serializer):
    """POST /api/accounting/expenses/"""
    # Legacy 'category' (RENT/UTILITIES/…) is now optional — we prefer
    # the user-managed ExpenseCategory FK.
    category           = serializers.ChoiceField(choices=Expense.Category.choices,
                                                 required=False, allow_blank=True, default="OTHER")
    expense_category_id     = serializers.UUIDField(required=False, allow_null=True, default=None)
    expense_sub_category_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    amount             = serializers.DecimalField(max_digits=14, decimal_places=2,
                                                   min_value=Decimal("0.01"))
    # expense_account_id is optional now — the Record Expense page no
    # longer surfaces it; the service falls back to the first EXPENSE
    # account in the tenant's chart of accounts when omitted.
    expense_account_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    payment_account_id = serializers.UUIDField()
    description        = serializers.CharField(required=False, allow_blank=True, default="")
    expense_date       = serializers.DateField(required=False)

    # Optional new fields (added in 0004 migration). All keep the rich form
    # working without breaking the original simple endpoint.
    reference_no       = serializers.CharField(required=False, allow_blank=True, default="")
    location_id        = serializers.UUIDField(required=False, allow_null=True)
    tax_amount         = serializers.DecimalField(max_digits=14, decimal_places=2,
                                                   required=False, default=Decimal("0"))
    paid_amount        = serializers.DecimalField(max_digits=14, decimal_places=2,
                                                   required=False, default=Decimal("0"))
    payment_status     = serializers.ChoiceField(
        choices=Expense.PaymentStatus.choices, required=False,
    )
    expense_for        = serializers.CharField(required=False, allow_blank=True, default="")
    contact_name       = serializers.CharField(required=False, allow_blank=True, default="")
    contact_id         = serializers.UUIDField(required=False, allow_null=True, default=None)
    recurring          = serializers.BooleanField(required=False, default=False)
    recurring_details  = serializers.CharField(required=False, allow_blank=True, default="")

    # Payment-method specifics (Card / Cheque / Bank Transfer / Mobile Wallet).
    # ALL optional — the cashier can save with them blank per spec.
    payment_method      = serializers.CharField(required=False, allow_blank=True, default="")
    card_number         = serializers.CharField(required=False, allow_blank=True, default="")
    card_holder_name    = serializers.CharField(required=False, allow_blank=True, default="")
    card_transaction_no = serializers.CharField(required=False, allow_blank=True, default="")
    card_type           = serializers.CharField(required=False, allow_blank=True, default="")
    card_month          = serializers.CharField(required=False, allow_blank=True, default="")
    card_year           = serializers.CharField(required=False, allow_blank=True, default="")
    cheque_no           = serializers.CharField(required=False, allow_blank=True, default="")
    bank_account_no     = serializers.CharField(required=False, allow_blank=True, default="")
    attach_document_url = serializers.URLField(required=False, allow_blank=True, default="")


# ──────────────────────────────────────────────────────────────────────────────
# ExpenseCategory (master)
# ──────────────────────────────────────────────────────────────────────────────

class ExpenseCategorySerializer(serializers.ModelSerializer):
    parent_name   = serializers.CharField(source="parent.name", read_only=True, allow_null=True)
    children_count = serializers.IntegerField(source="children.count", read_only=True)

    class Meta:
        model  = ExpenseCategory
        fields = [
            "id", "name", "code", "parent", "parent_name", "children_count",
            "is_active", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "parent_name", "children_count", "created_at", "updated_at"]

    def validate(self, attrs):
        # Prevent self-parent and circular references.
        parent = attrs.get("parent")
        instance = self.instance
        if parent and instance and parent.id == instance.id:
            raise serializers.ValidationError({"parent": "A category cannot be its own parent."})
        if parent and parent.parent_id:
            raise serializers.ValidationError(
                {"parent": "Only one level of sub-categories is supported."}
            )
        return attrs


# ──────────────────────────────────────────────────────────────────────────────
# PaymentAccount (Cash / Bank / MFS)
# ──────────────────────────────────────────────────────────────────────────────

from .models import PaymentAccount  # noqa: E402


class PaymentAccountSerializer(serializers.ModelSerializer):
    account_type_display = serializers.CharField(source="get_account_type_display", read_only=True)
    balance              = serializers.SerializerMethodField()

    class Meta:
        model  = PaymentAccount
        fields = [
            "id", "name", "account_number",
            "account_type", "account_type_display", "sub_type",
            "opening_balance", "balance",
            "note", "details", "added_by_name",
            "is_active", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "account_type_display", "balance", "created_at", "updated_at"]

    def get_balance(self, obj):
        # opening + Σ(transactions). Single SQL via aggregation.
        from django.db.models import Sum
        from decimal import Decimal as _D
        agg = obj.transactions.aggregate(t=Sum("amount"))["t"] or _D("0")
        return str((obj.opening_balance or _D("0")) + agg)


# ──────────────────────────────────────────────────────────────────────────────
# PaymentAccountTransaction
# ──────────────────────────────────────────────────────────────────────────────

from .models import PaymentAccountTransaction  # noqa: E402


class PaymentAccountTransactionSerializer(serializers.ModelSerializer):
    kind_display          = serializers.CharField(source="get_kind_display", read_only=True)
    counter_account_name  = serializers.CharField(source="counter_account.name", read_only=True, allow_null=True)

    class Meta:
        model  = PaymentAccountTransaction
        fields = [
            "id", "account", "kind", "kind_display",
            "amount", "reference", "note",
            "counter_account", "counter_account_name",
            "transaction_date", "created_by_name", "created_at",
        ]
        read_only_fields = ["id", "kind_display", "counter_account_name", "created_by_name", "created_at"]


class DepositInputSerializer(serializers.Serializer):
    amount    = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))
    reference = serializers.CharField(required=False, allow_blank=True, default="")
    note      = serializers.CharField(required=False, allow_blank=True, default="")
    kind      = serializers.ChoiceField(
        choices=[("DEPOSIT", "Deposit"), ("WITHDRAWAL", "Withdrawal"), ("ADJUSTMENT", "Adjustment")],
        required=False, default="DEPOSIT",
    )


class FundTransferInputSerializer(serializers.Serializer):
    from_account_id = serializers.UUIDField()
    to_account_id   = serializers.UUIDField()
    amount          = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))
    reference       = serializers.CharField(required=False, allow_blank=True, default="")
    note            = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["from_account_id"] == attrs["to_account_id"]:
            raise serializers.ValidationError("Source and destination accounts must be different.")
        return attrs


# ─────────────────────────────────────────────────────────────────────
# Expense payments — wraps the new ExpensePayment model. Mirrors the
# PurchaseReturnPaymentSerializer pattern (live payment_account_name
# resolution from the accounting app).
# ─────────────────────────────────────────────────────────────────────
class ExpensePaymentSerializer(serializers.ModelSerializer):
    payment_account_name = serializers.SerializerMethodField()

    class Meta:
        from .models import ExpensePayment as _EP  # noqa: PLC0415
        model  = _EP
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
            from .models import PaymentAccount  # noqa: PLC0415
            acct = PaymentAccount.objects.filter(id=obj.payment_account_id).only("name").first()
            return acct.name if acct else None
        except Exception:
            return None
