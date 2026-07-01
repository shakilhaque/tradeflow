"""
Subscription Plans Management — Super-Admin API.

Full CRUD over the master-DB Plan catalogue plus clone / activate /
subscribers / usage. Platform-admin only. `price` + `billing_cycle` +
`duration_days` stay authoritative for billing; the extra fields
(monthly/yearly headline price, trial_days, limits, module_features) are
managed here for the plan cards + comparison table.
"""
from decimal import Decimal

from django.db.models import Q
from rest_framework import serializers, status as http, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Plan, Subscription

MODULE_KEYS = ["pos", "inventory", "accounting", "purchase",
               "sales", "reports", "multi_branch", "api_access"]


def _normalize_modules(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {k: bool(raw.get(k, True)) for k in MODULE_KEYS}


# ──────────────────────────────────────────────────────────────────────────────
# Serializer
# ──────────────────────────────────────────────────────────────────────────────

class AdminPlanSerializer(serializers.ModelSerializer):
    subscriber_count        = serializers.SerializerMethodField()
    active_subscriber_count = serializers.SerializerMethodField()

    class Meta:
        model  = Plan
        fields = [
            "id", "name", "code", "description",
            "price", "billing_cycle", "duration_days",
            "monthly_price", "yearly_price", "yearly_discount_percent", "trial_days",
            "max_sub_accounts", "max_branches", "max_products", "max_storage_mb",
            "per_branch_fee", "module_features", "features",
            "is_active", "is_trial", "is_custom", "sort_order",
            "subscriber_count", "active_subscriber_count",
            "created_at",
        ]
        read_only_fields = ["id", "created_at", "subscriber_count", "active_subscriber_count"]

    def get_subscriber_count(self, obj):
        return Subscription.objects.filter(plan=obj).count()

    def get_active_subscriber_count(self, obj):
        return Subscription.objects.filter(plan=obj, status=Subscription.Status.ACTIVE).count()

    # ── Validation rules ──────────────────────────────────────────────
    def validate_name(self, v):
        v = (v or "").strip()
        if not v:
            raise serializers.ValidationError("Plan name is required.")
        qs = Plan.objects.filter(name__iexact=v)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A plan with this name already exists.")
        return v

    def _non_negative(self, v, label):
        if v is not None and Decimal(str(v)) < 0:
            raise serializers.ValidationError(f"{label} cannot be negative.")
        return v

    def validate_price(self, v):         return self._non_negative(v, "Price")
    def validate_monthly_price(self, v): return self._non_negative(v, "Monthly price")
    def validate_yearly_price(self, v):  return self._non_negative(v, "Yearly price")
    def validate_per_branch_fee(self, v): return self._non_negative(v, "Per-branch fee")

    def validate_yearly_discount_percent(self, v):
        if v is None:
            return 0
        if not (0 <= int(v) <= 100):
            raise serializers.ValidationError("Yearly discount % must be between 0 and 100.")
        return int(v)

    def validate_module_features(self, v):
        return _normalize_modules(v)

    def validate(self, attrs):
        # Keep duration_days sensible vs billing cycle when not given.
        if not attrs.get("duration_days") and "billing_cycle" in attrs:
            attrs["duration_days"] = 365 if attrs["billing_cycle"] == Plan.BillingCycle.YEARLY else 30
        return attrs

    def create(self, validated):
        validated["module_features"] = _normalize_modules(validated.get("module_features"))
        return super().create(validated)


# ──────────────────────────────────────────────────────────────────────────────
# ViewSet
# ──────────────────────────────────────────────────────────────────────────────

class AdminPlanViewSet(viewsets.ModelViewSet):
    """
    GET    /api/admin/plans/             list (search / filter / sort)
    POST   /api/admin/plans/             create
    GET    /api/admin/plans/<id>/        retrieve
    PATCH  /api/admin/plans/<id>/        update
    DELETE /api/admin/plans/<id>/        delete (blocked if it has subscribers)
    POST   /api/admin/plans/<id>/clone/         duplicate (inactive)
    POST   /api/admin/plans/<id>/toggle_active/ activate / deactivate
    GET    /api/admin/plans/<id>/subscribers/   tenants on this plan
    GET    /api/admin/plans/<id>/usage/         usage statistics
    """
    serializer_class   = AdminPlanSerializer
    permission_classes = [IsAuthenticated]

    def check_permissions(self, request):
        super().check_permissions(request)
        if not (request.user.is_staff or request.user.is_superuser):
            raise PermissionDenied("Platform admin only.")

    def get_queryset(self):
        qs = Plan.objects.all()
        p = self.request.query_params
        if search := p.get("search", "").strip():
            qs = qs.filter(Q(name__icontains=search) | Q(code__icontains=search) | Q(description__icontains=search))
        flt = (p.get("filter") or "all").lower()
        if flt == "active":     qs = qs.filter(is_active=True)
        elif flt == "inactive": qs = qs.filter(is_active=False)
        elif flt == "trial":    qs = qs.filter(is_trial=True)
        elif flt == "monthly":  qs = qs.filter(billing_cycle=Plan.BillingCycle.MONTHLY)
        elif flt == "yearly":   qs = qs.filter(billing_cycle=Plan.BillingCycle.YEARLY)
        sort_map = {"name": "name", "price": "price", "created": "created_at", "sort_order": "sort_order"}
        field = sort_map.get((p.get("sort_by") or "sort_order").lower(), "sort_order")
        if (p.get("sort_dir") or "asc").lower() == "desc":
            field = "-" + field
        return qs.order_by(field, "price")

    def destroy(self, request, *args, **kwargs):
        plan = self.get_object()
        if Subscription.objects.filter(plan=plan).exists():
            return Response(
                {"detail": "This plan has subscribers and can't be deleted. "
                           "Deactivate it instead, or move subscribers to another plan."},
                status=http.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    @action(detail=True, methods=["post"])
    def clone(self, request, pk=None):
        src = self.get_object()
        base = f"{src.name} (Copy)"
        name, i = base, 2
        while Plan.objects.filter(name=name).exists():
            name, i = f"{base} {i}", i + 1
        code = None
        if src.code:
            code, j = f"{src.code}-copy", 2
            while Plan.objects.filter(code=code).exists():
                code, j = f"{src.code}-copy{j}", j + 1
        clone = Plan.objects.create(
            name=name, code=code, description=src.description,
            price=src.price, billing_cycle=src.billing_cycle, duration_days=src.duration_days,
            monthly_price=src.monthly_price, yearly_price=src.yearly_price,
            yearly_discount_percent=src.yearly_discount_percent, trial_days=src.trial_days,
            max_sub_accounts=src.max_sub_accounts, max_branches=src.max_branches,
            max_products=src.max_products, max_storage_mb=src.max_storage_mb,
            per_branch_fee=src.per_branch_fee, module_features=src.module_features or {},
            features=src.features or [], is_active=False, is_trial=src.is_trial,
            is_custom=src.is_custom, sort_order=src.sort_order + 1,
        )
        return Response(AdminPlanSerializer(clone).data, status=http.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def toggle_active(self, request, pk=None):
        plan = self.get_object()
        plan.is_active = not plan.is_active
        plan.save(update_fields=["is_active"])
        return Response(AdminPlanSerializer(plan).data)

    @action(detail=True, methods=["get"])
    def subscribers(self, request, pk=None):
        plan = self.get_object()
        qs = Subscription.objects.filter(plan=plan).select_related("user").order_by("-created_at")
        return Response({
            "count": qs.count(),
            "results": [
                {
                    "subscription_id":   str(s.id),
                    "user_id":           str(s.user_id),
                    "name":              getattr(s.user, "name", ""),
                    "email":             getattr(s.user, "email", ""),
                    "status":            s.status,
                    "next_billing_date": s.next_billing_date.isoformat() if s.next_billing_date else None,
                }
                for s in qs[:500]
            ],
        })

    @action(detail=True, methods=["get"])
    def usage(self, request, pk=None):
        plan = self.get_object()
        qs = Subscription.objects.filter(plan=plan)
        from .subscription_admin import _monthly_fee
        active = qs.filter(status=Subscription.Status.ACTIVE).count()
        mrr = (_monthly_fee(plan) * Decimal(active)).quantize(Decimal("0.01")) if active else Decimal("0")
        return Response({
            "total_subscribers":     qs.count(),
            "active_subscribers":    active,
            "suspended_subscribers": qs.filter(status=Subscription.Status.SUSPENDED).count(),
            "cancelled_subscribers": qs.filter(status=Subscription.Status.CANCELLED).count(),
            "mrr":                   str(mrr),
            "arr":                   str((mrr * Decimal("12")).quantize(Decimal("0.01"))),
        })
