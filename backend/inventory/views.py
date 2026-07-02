"""
Inventory API views.

All views require JWT authentication (IsAuthenticated).
The TenantMiddleware resolves the correct DB alias before each request, so
all ORM queries here transparently hit the correct tenant database.

Endpoints
─────────
Master data (DRF ModelViewSet via router):
  GET/POST   /api/inventory/units/
  GET/POST   /api/inventory/brands/
  GET/POST   /api/inventory/categories/
  GET/POST   /api/inventory/locations/

Product:
  GET        /api/inventory/products/           list (with search, category filter)
  POST       /api/inventory/products/           create
  GET        /api/inventory/products/<id>/      detail
  PATCH      /api/inventory/products/<id>/      update (name, price, etc.)

Stock operations:
  POST       /api/inventory/stock-in/           add stock (single FIFO layer)
  POST       /api/inventory/stock-in/import/    bulk import (multi-layer)
  POST       /api/inventory/stock-transfer/     transfer between locations
  GET        /api/inventory/stock-report/       per-location snapshot + FIFO value

Audit:
  GET        /api/inventory/fifo-layers/        FIFO queue inspection
  GET        /api/inventory/movements/          stock movement audit log
"""
import logging
from decimal import Decimal

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, OpenApiTypes, extend_schema, extend_schema_view
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.branch_context import branch_scope, active_branch_id
from . import services
from .models import (
    Brand, Category, FIFOLayer, Location, Product, StockMovement,
    StockTransfer, StockTransferItem, Unit, Warranty,
)
from .serializers import (
    BrandSerializer,
    CategorySerializer,
    CreateStockTransferSerializer,
    FIFOLayerSerializer,
    ImportRowSerializer,
    LocationSerializer,
    ProductCreateSerializer,
    ProductDetailSerializer,
    ProductListSerializer,
    ProductPickerSerializer,
    StockImportSerializer,
    StockInSerializer,
    StockMovementSerializer,
    StockTransferDetailSerializer,
    StockTransferListSerializer,
    StockTransferSerializer,
    UnitSerializer,
    WarrantySerializer,
)

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Master data — simple ModelViewSets (registered with DRF router)
# ──────────────────────────────────────────────────────────────────────────────

class ProtectedDeleteMixin:
    """Mixin for master-data ModelViewSets (Unit / Brand / Category).

    Deleting a row that's still referenced by products (Unit and
    Category.parent use on_delete=PROTECT) raises ProtectedError, which
    DRF turns into a bare 500. This mixin catches it and returns a
    friendly 400 naming what's still using the record so the operator
    knows to reassign those products first.
    """

    # Human label for the thing being deleted; subclasses override.
    _delete_label = "record"

    def destroy(self, request, *args, **kwargs):
        from django.db.models.deletion import ProtectedError
        instance = self.get_object()
        try:
            instance.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        except ProtectedError as exc:
            try:
                count = len(exc.protected_objects)
            except Exception:  # noqa: BLE001
                count = 0
            label = getattr(self, "_delete_label", "record")
            n = f"{count} " if count else "some "
            return Response(
                {"detail": (
                    f"This {label} can't be deleted because {n}product(s) "
                    f"still use it. Reassign those products to another "
                    f"{label} first, then try again."
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Delete failed for %s %s: %s",
                             getattr(self, "_delete_label", "record"),
                             getattr(instance, "pk", "?"), exc)
            return Response(
                {"detail": f"Could not delete this {getattr(self, '_delete_label', 'record')}: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

@extend_schema_view(
    list=extend_schema(summary="List units of measure", tags=["Inventory"]),
    retrieve=extend_schema(summary="Get unit detail", tags=["Inventory"]),
    create=extend_schema(summary="Create unit of measure", tags=["Inventory"]),
    update=extend_schema(summary="Update unit of measure", tags=["Inventory"]),
    partial_update=extend_schema(summary="Partial update unit of measure", tags=["Inventory"]),
    destroy=extend_schema(summary="Delete unit of measure", tags=["Inventory"]),
)
@extend_schema(tags=["Inventory"])
class UnitViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    queryset           = Unit.objects.all()
    serializer_class   = UnitSerializer
    permission_classes = [IsAuthenticated]
    _delete_label      = "unit"

    def list(self, request, *args, **kwargs):
        services.ensure_default_master_data()
        return super().list(request, *args, **kwargs)


@extend_schema_view(
    list=extend_schema(summary="List brands", tags=["Inventory"]),
    retrieve=extend_schema(summary="Get brand detail", tags=["Inventory"]),
    create=extend_schema(summary="Create brand", tags=["Inventory"]),
    update=extend_schema(summary="Update brand", tags=["Inventory"]),
    partial_update=extend_schema(summary="Partial update brand", tags=["Inventory"]),
    destroy=extend_schema(summary="Delete brand", tags=["Inventory"]),
)
@extend_schema(tags=["Inventory"])
class BrandViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    queryset           = Brand.objects.all()
    serializer_class   = BrandSerializer
    permission_classes = [IsAuthenticated]
    _delete_label      = "brand"

    def list(self, request, *args, **kwargs):
        services.ensure_default_master_data()
        return super().list(request, *args, **kwargs)


@extend_schema_view(
    list=extend_schema(summary="List categories", tags=["Inventory"]),
    retrieve=extend_schema(summary="Get category detail", tags=["Inventory"]),
    create=extend_schema(summary="Create category", tags=["Inventory"]),
    update=extend_schema(summary="Update category", tags=["Inventory"]),
    partial_update=extend_schema(summary="Partial update category", tags=["Inventory"]),
    destroy=extend_schema(summary="Delete category", tags=["Inventory"]),
)
@extend_schema(tags=["Inventory"])
class CategoryViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    queryset           = Category.objects.select_related("parent").all()
    serializer_class   = CategorySerializer
    permission_classes = [IsAuthenticated]
    _delete_label      = "category"

    def list(self, request, *args, **kwargs):
        services.ensure_default_master_data()
        return super().list(request, *args, **kwargs)


@extend_schema_view(
    list=extend_schema(
        summary="List locations",
        tags=["Inventory"],
        parameters=[
            OpenApiParameter(
                name="active_only",
                location=OpenApiParameter.QUERY,
                description="Set to 'true' to return only active locations.",
                type=OpenApiTypes.STR,
            ),
        ],
    ),
    retrieve=extend_schema(summary="Get location detail", tags=["Inventory"]),
    create=extend_schema(summary="Create location", tags=["Inventory"]),
    update=extend_schema(summary="Update location", tags=["Inventory"]),
    partial_update=extend_schema(summary="Partial update location", tags=["Inventory"]),
    destroy=extend_schema(summary="Delete location", tags=["Inventory"]),
)
@extend_schema(tags=["Inventory"])
class LocationViewSet(viewsets.ModelViewSet):
    queryset           = Location.objects.all()
    serializer_class   = LocationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active_only") == "true":
            qs = qs.filter(is_active=True)
        return qs

    def list(self, request, *args, **kwargs):
        # POS requires at least one active location to enable "Charge".
        services.ensure_default_master_data()
        return super().list(request, *args, **kwargs)

    def _plan_limits(self, request):
        """Single-client build: unlimited branches (no subscription plan gating)."""
        return 0, None

    def _current_active_count(self, exclude_id=None):
        qs = Location.objects.filter(is_active=True)
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        return qs.count()

    def _branch_limit_response(self, limit, used, plan_name):
        return Response(
            {
                "code": "BRANCH_LIMIT",
                "detail": (
                    f"Your '{plan_name or 'current'}' plan allows up to {limit} "
                    f"active branch{'es' if limit != 1 else ''}. Upgrade to add more."
                ),
                "limit": limit,
                "current": used,
                "upgrade_url": "/pricing/accounting",
            },
            status=status.HTTP_403_FORBIDDEN,
        )

    def create(self, request, *args, **kwargs):
        limit, plan_name = self._plan_limits(request)
        if limit > 0:
            used = self._current_active_count()
            if used >= limit:
                return self._branch_limit_response(limit, used, plan_name)
        return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        going_active = bool(request.data.get("is_active", instance.is_active))
        if going_active and not instance.is_active:
            limit, plan_name = self._plan_limits(request)
            if limit > 0:
                used = self._current_active_count(exclude_id=instance.id)
                if used >= limit:
                    return self._branch_limit_response(limit, used, plan_name)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        """Delete a branch — or soft-delete it when historical rows reference it.

        Most tables that point at Location use `on_delete=PROTECT`
        (purchases, sales, returns, stock movements, …). A hard DELETE
        on a location with even one referencing row raises
        ProtectedError → Django's default handler returns 500. Some
        FKs are CASCADE/SET_NULL which trigger IntegrityError or other
        database-level failures. This handler defensively catches
        ALL of them and falls back to setting is_active=False so the
        endpoint NEVER 500s.

        Behaviour:
          • No references and clean delete → hard DELETE, 204
          • Any DB-level conflict          → soft-delete (is_active=False),
                                             200 with {soft_deleted:true, detail}
          • Unknown error                  → soft-delete fallback (we'd rather
                                             keep the row than break the page),
                                             but log the original exception.
        """
        from django.db.models.deletion import ProtectedError
        from django.db import IntegrityError
        instance = self.get_object()

        # First attempt — hard DELETE. We deliberately don't wrap it in
        # transaction.atomic here because Django ORM .delete() runs its
        # own transaction internally and adding another atomic() makes
        # the post-rollback save in the fallback path harder to reason
        # about.
        try:
            instance.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        except ProtectedError as exc:
            try:
                blocking_models = {str(obj._meta.verbose_name_plural or obj._meta.verbose_name)
                                   for obj in (exc.protected_objects or [])}
                reason = ", ".join(sorted(blocking_models)) if blocking_models else "linked transactions"
            except Exception:
                reason = "linked transactions"
        except (IntegrityError, Exception) as exc:
            # CASCADE chain blew up, FK constraint violation, or anything
            # else weird. Log and fall through to soft-delete.
            logger.exception("Hard delete of Location %s failed; falling back to soft-delete: %s", instance.pk, exc)
            reason = "linked records"

        # Soft-delete fallback — preserve history, free the plan slot.
        try:
            instance.is_active = False
            instance.save(update_fields=["is_active"])
        except Exception as exc:
            logger.exception("Soft-delete of Location %s also failed: %s", instance.pk, exc)
            return Response(
                {"detail": f"Could not delete or deactivate branch: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response({
            "code":   "BRANCH_SOFT_DELETED",
            "detail": (
                f"'{instance.name}' has historical records ({reason}) "
                "so it was deactivated instead of removed. It no longer counts "
                "against your plan's branch limit."
            ),
            "soft_deleted": True,
        }, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="limits")
    def limits(self, request):
        try:
            limit, plan_name = self._plan_limits(request)
            used = self._current_active_count()
        except Exception as exc:
            logger.warning("locations/limits failed: %s", exc)
            limit, plan_name, used = 1, None, 0
        return Response({
            "limit": limit,                       # 0 = unlimited
            "current": used,
            "remaining": None if limit == 0 else max(0, limit - used),
            "can_add": limit == 0 or used < limit,
            "multi_branch_enabled": limit == 0 or limit > 1,
            "plan_name": plan_name,
        })


@extend_schema_view(
    list=extend_schema(summary="List warranties", tags=["Inventory"]),
    retrieve=extend_schema(summary="Get warranty detail", tags=["Inventory"]),
    create=extend_schema(summary="Create warranty", tags=["Inventory"]),
    update=extend_schema(summary="Update warranty", tags=["Inventory"]),
    partial_update=extend_schema(summary="Partial update warranty", tags=["Inventory"]),
    destroy=extend_schema(summary="Delete warranty", tags=["Inventory"]),
)
@extend_schema(tags=["Inventory"])
class WarrantyViewSet(viewsets.ModelViewSet):
    queryset           = Warranty.objects.all()
    serializer_class   = WarrantySerializer
    permission_classes = [IsAuthenticated]


# ──────────────────────────────────────────────────────────────────────────────
# Products
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class ProductListCreateView(APIView):
    """
    GET  /api/inventory/products/   — paginated product list with stock info.
    POST /api/inventory/products/   — create a new product.

    Query params (GET):
        search      — filter by name or SKU (case-insensitive)
        category_id — filter by category UUID
        brand_id    — filter by brand UUID
        is_active   — "true" / "false"  (default: only active)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List products",
        description=(
            "Returns an ordered list of products with stock info. "
            "Supports filtering by search term, category, brand, and active status."
        ),
        responses={200: ProductListSerializer(many=True)},
        parameters=[
            OpenApiParameter(
                name="search",
                location=OpenApiParameter.QUERY,
                description="Filter by product name or SKU (case-insensitive).",
                type=OpenApiTypes.STR,
            ),
            OpenApiParameter(
                name="category_id",
                location=OpenApiParameter.QUERY,
                description="Filter by category UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="brand_id",
                location=OpenApiParameter.QUERY,
                description="Filter by brand UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="is_active",
                location=OpenApiParameter.QUERY,
                description="'true' returns active products only; 'false' returns inactive. Defaults to 'true'.",
                type=OpenApiTypes.STR,
            ),
        ],
    )
    def get(self, request):
        qs = Product.objects.select_related("category", "brand", "unit", "warranty").order_by("name")

        search = request.query_params.get("search", "").strip()
        if search:
            from django.db.models import Q
            # Barcode is matched exactly first (case-insensitive) so scanners
            # land on the right SKU even when the code happens to be a
            # substring of another product's name. Then we widen to the
            # familiar name/SKU/barcode contains-match so typing partial
            # text still works.
            qs = qs.filter(
                Q(barcode__iexact=search) |
                Q(name__icontains=search) |
                Q(sku__icontains=search) |
                Q(barcode__icontains=search)
            )

        category_id = request.query_params.get("category_id")
        if category_id:
            qs = qs.filter(category_id=category_id)

        brand_id = request.query_params.get("brand_id")
        if brand_id:
            qs = qs.filter(brand_id=brand_id)

        unit_id = request.query_params.get("unit_id")
        if unit_id:
            qs = qs.filter(unit_id=unit_id)

        # Location filter — surface products that have ANY history at
        # the picked location: a FIFO layer, a per-location stock
        # snapshot, or at least a recorded movement. Catches products
        # that were sold then went to zero (still relevant on the
        # report) as well as currently-stocked items.
        location_id = request.query_params.get("location_id")
        if location_id:
            from django.db.models import Q as _Q
            qs = qs.filter(
                _Q(fifo_layers__location_id=location_id) |
                _Q(stocks__location_id=location_id) |
                _Q(movements__location_id=location_id)
            ).distinct()

        product_type = request.query_params.get("product_type")
        if product_type:
            qs = qs.filter(product_type=product_type)

        active_param = request.query_params.get("is_active", "true")
        if active_param.lower() == "false":
            qs = qs.filter(is_active=False)
        else:
            qs = qs.filter(is_active=True)

        # Lightweight mode for the POS / Add Sale / Add Quotation product
        # pickers. They only need pricing, unit, manage_stock and on-hand
        # qty — not the heavy per-row report aggregates (inventory value,
        # avg cost, movement sums, location names) that cause ~9 queries
        # per product. In light mode we annotate the FIFO on-hand quantity
        # once over the whole queryset (no N+1) and use the lean serializer.
        light = request.query_params.get("light", "").lower() in ("1", "true", "yes")
        if light:
            from django.db.models import Sum as _Sum, Q as _LQ
            # Multi-branch: the picker's on-hand qty is the active branch's
            # stock only (None branch = all branches, owner consolidated).
            _bid = active_branch_id()
            _flt = _LQ(fifo_layers__remaining_qty__gt=0)
            if _bid:
                _flt &= _LQ(fifo_layers__location_id=_bid)
            qs = qs.annotate(
                _picker_stock=_Sum("fifo_layers__remaining_qty", filter=_flt)
            )
            return Response(ProductPickerSerializer(qs, many=True).data)

        return Response(ProductListSerializer(qs, many=True).data)

    @extend_schema(
        summary="Create product",
        description=(
            "Creates a new product record in the inventory. "
            "The product is active by default and must have a unique SKU."
        ),
        request=ProductCreateSerializer,
        responses={201: ProductDetailSerializer},
    )
    def post(self, request):
        serializer = ProductCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            product = services.create_product(**serializer.validated_data)
        except services.StockServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            ProductDetailSerializer(product).data,
            status=status.HTTP_201_CREATED,
        )


# Default low-stock threshold used when a product has no custom alert
# quantity (reorder_level). Mirrors the All Products page badge, which marks
# any product with on-hand <= 5 as low stock (ProductsListPage StockPill).
_DEFAULT_LOW_STOCK_THRESHOLD = Decimal("5")


@extend_schema(tags=["Inventory"])
class LowStockListView(APIView):
    """GET /api/inventory/low-stock/

    Return every active product whose on-hand stock is at or below
    its reorder_level (the per-product "Alert quantity" the cashier
    set when creating the product).

    Powers the Dashboard Low Stock Alert card and the count badge.
    The FIFO totals + ProductStock snapshots are the same authority
    the product list uses, so this never disagrees with the rest of
    the UI.

    Query params:
      limit   — cap rows returned (default 100). Use ?limit=5 on the
                dashboard widget; ?limit=1 + counting on the badge.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from decimal import Decimal as _D
        try:
            limit = max(1, min(int(request.query_params.get("limit", 100)), 500))
        except (ValueError, TypeError):
            limit = 100

        # Iterate PRODUCTS (not ProductStock rows) so a tracked product that
        # has never been stocked — and therefore has no ProductStock row —
        # still surfaces at 0 on-hand. The old query keyed off ProductStock
        # AND required reorder_level > 0, so brand-new out-of-stock products
        # were invisible and the dashboard card stayed empty.
        qs = (
            Product.objects
            .filter(is_active=True)
            .select_related("unit", "category", "brand", "warranty")
            .prefetch_related("stocks")
        )

        low_products = []   # tracked products at/below their alert qty (or out)
        services     = []   # manage_stock OFF — shown as N/A
        for p in qs.iterator():
            manage = (p.meta or {}).get("manage_stock", True) is not False
            unit   = getattr(p.unit, "name", "") if p.unit_id else ""
            base   = {
                "id":           str(p.id),
                "name":         p.name,
                "sku":          p.sku or "",
                "unit":         unit,
                "category":     getattr(p.category, "name", "") if p.category_id else "",
                "location":     "",
                "manage_stock": manage,
            }
            if not manage:
                # Services don't track stock — current stock is N/A
                # (qty/on_hand None so both alert cards render N/A or blank).
                services.append({**base, "qty": None, "on_hand": None,
                                 "reorder_level": "0", "shortfall": _D("0")})
                continue
            # On-hand: same MAX(FIFO_total, snapshot_sum) rule as the list.
            # Sum the prefetched ProductStock rows in Python (no per-row query).
            fifo = _D(str(p.total_stock or 0))
            snap = sum((_D(str(s.quantity or 0)) for s in p.stocks.all()), _D("0"))
            on_hand = fifo if fifo > snap else snap
            reorder = _D(str(p.reorder_level or 0))
            # Alert threshold = the product's own alert quantity when set,
            # otherwise the system default of 5 — mirroring the All Products
            # "Current stock" badge (qty <= 5 shows yellow). So a product with
            # 1/3/5 left and no custom alert qty still surfaces here.
            threshold = reorder if reorder > 0 else _DEFAULT_LOW_STOCK_THRESHOLD
            if on_hand <= threshold:
                low_products.append({**base, "qty": str(on_hand),
                                     "on_hand": str(on_hand),
                                     # Effective threshold (the product's own
                                     # alert qty, or the default 5) so the card
                                     # shows a meaningful "3 / 5".
                                     "reorder_level": str(threshold),
                                     "shortfall": max(threshold - on_hand, _D("0"))})

        # Worst-short products first, then services (alphabetical).
        low_products.sort(key=lambda r: r["shortfall"], reverse=True)
        services.sort(key=lambda r: r["name"].lower())
        combined = low_products + services
        out = combined[:limit]
        for r in out:
            r["shortfall"] = str(r.get("shortfall", "0"))
        # count = low tracked products only (services aren't "low stock").
        return Response({"count": len(low_products), "results": out})


@extend_schema(tags=["Inventory"])
class ProductScanView(APIView):
    """
    GET /api/inventory/products/scan/?code=<barcode_or_sku>

    Exact-match lookup for barcode scanners. Tries:
      1. barcode (case-insensitive exact)
      2. sku (case-insensitive exact)
    Returns the single product or 404. POS pipes the scanner buffer here
    on Enter so the matching SKU is added to the cart instantly.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Scan a barcode / SKU",
        description=(
            "Exact-match product lookup for barcode scanners. "
            "Pass `?code=<value>` — returns one product or 404. "
            "Tries barcode first, then SKU, both case-insensitive."
        ),
        parameters=[
            OpenApiParameter(name="code", location=OpenApiParameter.QUERY,
                             required=True, type=str,
                             description="The scanned barcode (or typed SKU)."),
        ],
        responses={200: ProductDetailSerializer, 404: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        code = (request.query_params.get("code") or "").strip()
        if not code:
            return Response({"detail": "Pass a non-empty `code` query parameter."},
                            status=status.HTTP_400_BAD_REQUEST)

        qs = (
            Product.objects
            .select_related("category", "brand", "unit", "warranty")
            .filter(is_active=True)
        )
        # Barcode first (matches printed labels), then SKU as a fallback so
        # an operator who knows the SKU by heart can type it in too.
        product = qs.filter(barcode__iexact=code).first() or qs.filter(sku__iexact=code).first()
        if product is None:
            return Response(
                {"detail": f"No active product matches barcode/SKU '{code}'."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(ProductDetailSerializer(product).data)


@extend_schema(tags=["Inventory"])
class ProductDetailView(APIView):
    """
    GET   /api/inventory/products/<id>/  — full product detail.
    PATCH /api/inventory/products/<id>/  — update editable fields.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Get product detail",
        description="Returns the full detail of a single product including category, brand, and unit information.",
        responses={200: ProductDetailSerializer},
    )
    def get(self, request, pk):
        product = get_object_or_404(Product.objects.select_related("category", "brand", "unit", "warranty"), pk=pk)
        return Response(ProductDetailSerializer(product).data)

    @extend_schema(
        summary="Update product",
        description=(
            "Partially updates editable product fields such as name, selling price, category, "
            "brand, warranty days, notes, and active status."
        ),
        responses={200: ProductDetailSerializer},
    )
    def patch(self, request, pk):
        product = get_object_or_404(Product, pk=pk)
        allowed = {"name", "selling_price", "cost_price", "tax_rate", "tax_type",
                   "product_type", "barcode_type", "not_for_selling", "weight",
                   "image_url", "category_id", "brand_id",
                   "warranty_days", "warranty_id", "notes", "meta", "is_active",
                   # Alert / reorder threshold — the per-product "Alert
                   # quantity". Without this in the allow-list, editing it
                   # was silently dropped and the low-stock alert never fired.
                   "reorder_level"}
        data = {k: v for k, v in request.data.items() if k in allowed}
        # Optional FK — an empty string from the form means "no warranty".
        if "warranty_id" in data and not data["warranty_id"]:
            data["warranty_id"] = None
        for field, value in data.items():
            setattr(product, field, value)
        if data:
            product.save(update_fields=list(data.keys()) + ["updated_at"])

        # Replace variations if the client sent them (only meaningful for
        # variable products). Sending `variations=[]` clears them.
        if "variations" in request.data:
            services.replace_variations(
                product        = product,
                variation_type = request.data.get("variation_type", "") or "",
                variations     = request.data.get("variations") or [],
            )

        # Same pattern for combo components.
        if "combo_items" in request.data:
            services.replace_combo_items(
                product = product,
                items   = request.data.get("combo_items") or [],
            )

        return Response(ProductDetailSerializer(
            Product.objects.select_related("category", "brand", "unit", "warranty").get(pk=pk)
        ).data)

    @extend_schema(
        summary="Soft-delete a product",
        description=(
            "Soft-deletes a product by setting is_active=False. Past sales, "
            "purchases and stock records continue to reference the row; it "
            "just stops appearing in product pickers and the active list."
        ),
        responses={204: None},
    )
    def delete(self, request, pk):
        product = get_object_or_404(Product, pk=pk)
        if product.is_active:
            product.is_active = False
            product.save(update_fields=["is_active", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Stock In
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class StockInView(APIView):
    """
    POST /api/inventory/stock-in/

    Receive a single batch of stock. Creates one FIFO layer.

    Request body:
        product_id     UUID
        location_id    UUID
        quantity       Decimal
        unit_cost      Decimal
        reference_type str       (default: "purchase")
        reference_id   UUID|null
        layer_date     ISO datetime|null   ← override FIFO position
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Receive stock (single FIFO layer)",
        description=(
            "Records a single stock receipt and creates one FIFO cost layer for the product. "
            "Use the bulk import endpoint for multiple layers at once."
        ),
        request=StockInSerializer,
        responses={201: None},
    )
    def post(self, request):
        serializer = StockInSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            layer = services.add_stock_fifo(**serializer.validated_data)
        except services.StockServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "message":        "Stock received successfully.",
                "layer_id":       str(layer.id),
                "product_id":     str(layer.product_id),
                "location_id":    str(layer.location_id),
                "initial_qty":    layer.initial_qty,
                "remaining_qty":  layer.remaining_qty,
                "unit_cost":      layer.unit_cost,
                "created_at":     layer.created_at,
            },
            status=status.HTTP_201_CREATED,
        )


@extend_schema(tags=["Inventory"])
class StockImportView(APIView):
    """
    POST /api/inventory/stock-in/import/

    Bulk stock import. Each row creates one FIFO layer.

    Request body:
        product_id   UUID
        location_id  UUID
        rows: [
            { "quantity": 100, "unit_cost": 12.50, "date": "2026-01-15" },
            ...
        ]
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Bulk import stock (multiple FIFO layers)",
        description=(
            "Imports multiple stock rows for a single product at a single location. "
            "Each row creates an independent FIFO cost layer with its own date and unit cost."
        ),
        request=StockImportSerializer,
        responses={201: None},
    )
    def post(self, request):
        serializer = StockImportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            layers = services.import_stock_rows(**serializer.validated_data)
        except services.StockServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "message":      f"{len(layers)} stock layer(s) imported.",
                "total_qty":    sum(l.initial_qty for l in layers),
                "layers": [
                    {
                        "layer_id":   str(l.id),
                        "quantity":   l.initial_qty,
                        "unit_cost":  l.unit_cost,
                        "created_at": l.created_at,
                    }
                    for l in layers
                ],
            },
            status=status.HTTP_201_CREATED,
        )


# ──────────────────────────────────────────────────────────────────────────────
# Stock Transfer
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class StockTransferView(APIView):
    """
    POST /api/inventory/stock-transfer/

    Move stock between locations without touching FIFO layers.
    Only the per-location ProductStock snapshots are updated.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Transfer stock between locations",
        description=(
            "Moves a quantity of a product from one location to another. "
            "FIFO cost layers are not modified; only the per-location stock snapshots are updated."
        ),
        request=StockTransferSerializer,
        responses={200: None},
    )
    def post(self, request):
        serializer = StockTransferSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            result = services.transfer_stock(**serializer.validated_data)
        except (services.InsufficientStockError, services.StockServiceError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "message":         "Stock transferred successfully.",
                "qty_transferred": result["qty_transferred"],
                "from_qty":        result["from_qty"],
                "to_qty":          result["to_qty"],
            },
            status=status.HTTP_200_OK,
        )


# ──────────────────────────────────────────────────────────────────────────────
# Stock Transfer history (header records)
# ──────────────────────────────────────────────────────────────────────────────

from decimal import Decimal as _Decimal
from django.db import transaction as _transaction
from django.db.models import Q


@extend_schema(tags=["Inventory"])
class StockTransferListCreateView(APIView):
    """
    GET  /api/inventory/stock-transfers/   — paginated list with filters
    POST /api/inventory/stock-transfers/   — create a multi-line transfer
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List stock transfers",
        responses={200: None},
        parameters=[
            OpenApiParameter("page",       OpenApiTypes.INT, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("limit",      OpenApiTypes.INT, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("search",     OpenApiTypes.STR, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("status",     OpenApiTypes.STR, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("from_id",    OpenApiTypes.UUID, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("to_id",      OpenApiTypes.UUID, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("date_from",  OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("date_to",    OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
        ],
    )
    def get(self, request):
        qs = StockTransfer.objects.select_related("from_location", "to_location").all()
        # Multi-branch: show transfers that touch the active branch (in or out).
        if _bid := active_branch_id():
            from django.db.models import Q as _Q
            qs = qs.filter(_Q(from_location_id=_bid) | _Q(to_location_id=_bid))

        if s := request.query_params.get("status"):
            qs = qs.filter(status=s)
        if frm := request.query_params.get("from_id"):
            qs = qs.filter(from_location_id=frm)
        if to := request.query_params.get("to_id"):
            qs = qs.filter(to_location_id=to)
        if df := request.query_params.get("date_from"):
            qs = qs.filter(transfer_date__gte=df)
        if dt := request.query_params.get("date_to"):
            qs = qs.filter(transfer_date__lte=dt)
        if q := request.query_params.get("search"):
            qs = qs.filter(
                Q(reference_no__icontains=q)
                | Q(from_location__name__icontains=q)
                | Q(to_location__name__icontains=q)
                | Q(notes__icontains=q)
            )

        try:
            page  = max(int(request.query_params.get("page",  1)), 1)
            limit = max(min(int(request.query_params.get("limit", 25)), 200), 1)
        except (TypeError, ValueError):
            page, limit = 1, 25

        total       = qs.count()
        total_pages = max((total + limit - 1) // limit, 1)
        offset      = (page - 1) * limit
        rows        = qs[offset:offset + limit]

        # Aggregate summary across the FILTERED set (not just the page)
        from django.db.models import Sum, Value
        from django.db.models.functions import Coalesce
        agg = qs.aggregate(
            total_amount     = Coalesce(Sum("total_amount"),     Value(_Decimal("0"))),
            total_shipping   = Coalesce(Sum("shipping_charges"), Value(_Decimal("0"))),
        )

        return Response({
            "results":     StockTransferListSerializer(rows, many=True).data,
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "summary": {
                "total_amount":   str(agg["total_amount"]),
                "total_shipping": str(agg["total_shipping"]),
            },
        })

    @extend_schema(
        summary="Create stock transfer",
        request=CreateStockTransferSerializer,
        responses={201: None, 400: None},
    )
    def post(self, request):
        ser = CreateStockTransferSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        from django.utils import timezone as _tz

        items = data["items"]

        # ── Out-of-stock pre-check ──────────────────────────────────
        # A COMPLETED transfer deducts stock from the source location
        # immediately, so every line must be coverable there. Sum the
        # requested qty per product (the same product can appear on
        # multiple lines) and compare against the source location's
        # ProductStock. Shortfalls return a structured 409 the
        # frontend renders in the OutOfStockModal — previously the
        # in-loop InsufficientStockError was re-raised as a
        # TransactionManagementError, which surfaced as an opaque 500.
        new_status = data.get("status") or StockTransfer.Status.COMPLETED
        if new_status == StockTransfer.Status.COMPLETED:
            from .models import ProductStock as _PS  # noqa: PLC0415
            from django.db.models import Sum as _Sum  # noqa: PLC0415
            requested = {}
            for item in items:
                pid = item["product_id"]
                # Services (Manage Stock off) have no inventory — they
                # can never be "short", so they're excluded from the
                # availability pre-check entirely. Mirrors the sale
                # path (_check_stock_availability skips manage_stock=False)
                # so every stock decision keys off the same flag.
                prod = Product.objects.filter(pk=pid).only("meta").first()
                if prod and (prod.meta or {}).get("manage_stock", True) is False:
                    continue
                requested[pid] = requested.get(pid, _Decimal("0")) + _Decimal(str(item["quantity"]))
            shortfalls = []
            for pid, qty in requested.items():
                available = (
                    _PS.objects
                    .filter(product_id=pid, location_id=data["from_location_id"])
                    .aggregate(t=_Sum("quantity"))["t"]
                ) or _Decimal("0")
                if available < 0:
                    available = _Decimal("0")
                if available < qty:
                    prod = Product.objects.filter(pk=pid).only("name").first()
                    shortfalls.append({
                        "product_id":   str(pid),
                        "product_name": prod.name if prod else str(pid),
                        "requested":    str(qty),
                        "available":    str(available),
                        "shortfall":    str(qty - available),
                    })
            if shortfalls:
                names = ", ".join(s["product_name"] for s in shortfalls[:3])
                if len(shortfalls) > 3:
                    names += f", and {len(shortfalls) - 3} more"
                # Pre-wrapped in the standard envelope — the
                # StandardJSONRenderer's error safety-net would
                # otherwise strip the out_of_stock / shortfalls keys
                # (it only keeps detail→message), which left the
                # frontend unable to tell this 409 from a generic
                # error and broke the pop-up.
                return Response({
                    "status":  "error",
                    "data":    {"out_of_stock": True, "shortfalls": shortfalls},
                    "message": (
                        f"Not enough stock at the source location for: {names}. "
                        "Reduce the quantity or restock first — stock can never go negative."
                    ),
                    "errors":  None,
                }, status=status.HTTP_409_CONFLICT)

        try:
            transfer = self._create_transfer(request, data, items)
        except (services.InsufficientStockError, services.StockServiceError) as exc:
            # Race fallback — stock changed between the pre-check and
            # the FIFO deduction. The atomic block already rolled
            # back; surface the same structured 409 envelope.
            return Response({
                "status":  "error",
                "data":    {"out_of_stock": True, "shortfalls": []},
                "message": str(exc),
                "errors":  None,
            }, status=status.HTTP_409_CONFLICT)

        return Response(
            StockTransferDetailSerializer(transfer).data,
            status=status.HTTP_201_CREATED,
        )

    def _create_transfer(self, request, data, items):
        with _transaction.atomic():
            kwargs = {
                "from_location_id": data["from_location_id"],
                "to_location_id":   data["to_location_id"],
                "status":           data.get("status") or StockTransfer.Status.COMPLETED,
                "shipping_charges": data.get("shipping_charges") or _Decimal("0"),
                "notes":            data.get("notes") or "",
                "added_by_name":    (
                    getattr(request.user, "name", None) or getattr(request.user, "email", "")
                ) if request.user.is_authenticated else "",
            }
            if data.get("transfer_date"):
                kwargs["transfer_date"] = data["transfer_date"]
            transfer = StockTransfer.objects.create(**kwargs)

            running_total = _Decimal("0")
            for item in items:
                line_total = (_Decimal(str(item["quantity"])) * _Decimal(str(item.get("unit_cost") or 0)))
                StockTransferItem.objects.create(
                    stock_transfer = transfer,
                    product_id     = item["product_id"],
                    quantity       = item["quantity"],
                    unit_cost      = item.get("unit_cost") or _Decimal("0"),
                    line_total     = line_total,
                )
                running_total += line_total

                # Apply stock movement only for COMPLETED transfers.
                # InsufficientStockError / StockServiceError propagate
                # to the caller (post), rolling back the atomic block
                # and returning a structured 409.
                if transfer.status == StockTransfer.Status.COMPLETED:
                    services.transfer_stock(
                        product_id       = item["product_id"],
                        from_location_id = data["from_location_id"],
                        to_location_id   = data["to_location_id"],
                        quantity         = item["quantity"],
                        notes            = f"Ref {transfer.reference_no}",
                    )

            transfer.total_amount = running_total + transfer.shipping_charges
            transfer.save(update_fields=["total_amount"])

        return transfer


@extend_schema(tags=["Inventory"])
class StockTransferDetailView(APIView):
    """GET / DELETE a single stock transfer."""
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        obj = get_object_or_404(
            StockTransfer.objects.select_related("from_location", "to_location").prefetch_related("items__product"),
            pk=pk,
        )
        return Response(StockTransferDetailSerializer(obj).data)

    def delete(self, request, pk):
        obj = get_object_or_404(StockTransfer, pk=pk)
        if obj.status == StockTransfer.Status.COMPLETED:
            return Response(
                {"detail": "Cannot delete a completed transfer. Cancel it instead or contact admin."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Stock Report
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class StockReportView(APIView):
    """
    GET /api/inventory/stock-report/

    Per-location stock snapshot enriched with global FIFO valuation.

    Query params:
        product_id   — narrow to one product
        location_id  — narrow to one location
        include_zero — include rows with zero quantity ("true" / "false")
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Get stock report",
        description=(
            "Returns a per-location stock snapshot for all products, enriched with FIFO-based valuation. "
            "Can be filtered by product or location, and optionally includes zero-quantity rows."
        ),
        responses={200: None},
        parameters=[
            OpenApiParameter(
                name="product_id",
                location=OpenApiParameter.QUERY,
                description="Filter the report to a single product UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="location_id",
                location=OpenApiParameter.QUERY,
                description="Filter the report to a single location UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="include_zero",
                location=OpenApiParameter.QUERY,
                description="Set to 'true' to include products with zero on-hand quantity.",
                type=OpenApiTypes.STR,
            ),
        ],
    )
    def get(self, request):
        product_id   = request.query_params.get("product_id")
        location_id  = request.query_params.get("location_id")
        include_zero = request.query_params.get("include_zero", "false").lower() == "true"

        report = services.get_stock_report(
            product_id=product_id,
            location_id=location_id,
            include_zero=include_zero,
        )
        return Response(report)


# ──────────────────────────────────────────────────────────────────────────────
# FIFO Layers (audit / inspection)
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class FIFOLayerListView(APIView):
    """
    GET /api/inventory/fifo-layers/

    Inspect the raw FIFO cost queue for a product.
    Requires product_id query param.

    Query params:
        product_id        UUID (required)
        include_exhausted "true" includes fully-consumed layers
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List FIFO cost layers for a product",
        description=(
            "Returns the raw FIFO cost queue for a given product. "
            "Useful for auditing cost basis, checking remaining quantities per layer, "
            "and inspecting historical purchase costs."
        ),
        responses={200: None},
        parameters=[
            OpenApiParameter(
                name="product_id",
                location=OpenApiParameter.QUERY,
                description="UUID of the product whose FIFO layers to inspect. Required.",
                type=OpenApiTypes.UUID,
                required=True,
            ),
            OpenApiParameter(
                name="include_exhausted",
                location=OpenApiParameter.QUERY,
                description="Set to 'true' to include fully-consumed (zero remaining) layers.",
                type=OpenApiTypes.STR,
            ),
        ],
    )
    def get(self, request):
        product_id = request.query_params.get("product_id")
        if not product_id:
            return Response(
                {"detail": "product_id query param is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        include_exhausted = (
            request.query_params.get("include_exhausted", "false").lower() == "true"
        )

        data = services.get_fifo_layers(
            product_id=product_id,
            include_exhausted=include_exhausted,
        )
        return Response(data)


# ──────────────────────────────────────────────────────────────────────────────
# Stock Movement Log
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Inventory"])
class StockMovementListView(APIView):
    """
    GET /api/inventory/movements/

    Audit log of all stock movements.

    Query params:
        product_id    — filter by product
        location_id   — filter by location
        type          — IN | OUT | TRANSFER | ADJUST
        limit         — max results (default 50)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List stock movements",
        description=(
            "Returns a reverse-chronological audit log of all stock movements. "
            "Can be filtered by product, location, and movement type."
        ),
        responses={200: StockMovementSerializer(many=True)},
        parameters=[
            OpenApiParameter(
                name="product_id",
                location=OpenApiParameter.QUERY,
                description="Filter movements to a single product UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="location_id",
                location=OpenApiParameter.QUERY,
                description="Filter movements to a single location UUID.",
                type=OpenApiTypes.UUID,
            ),
            OpenApiParameter(
                name="type",
                location=OpenApiParameter.QUERY,
                description="Filter by movement type: IN, OUT, TRANSFER, or ADJUST.",
                type=OpenApiTypes.STR,
            ),
            OpenApiParameter(
                name="limit",
                location=OpenApiParameter.QUERY,
                description="Maximum number of results to return (default 50, max 500).",
                type=OpenApiTypes.INT,
            ),
        ],
    )
    def get(self, request):
        qs = branch_scope(StockMovement.objects.select_related(
            "product", "location"
        ).order_by("-created_at"))

        product_id = request.query_params.get("product_id")
        if product_id:
            qs = qs.filter(product_id=product_id)

        location_id = request.query_params.get("location_id")
        if location_id:
            qs = qs.filter(location_id=location_id)

        movement_type = request.query_params.get("type")
        if movement_type:
            qs = qs.filter(movement_type=movement_type.upper())

        try:
            limit = min(int(request.query_params.get("limit", 50)), 500)
        except (ValueError, TypeError):
            limit = 50

        return Response(
            StockMovementSerializer(qs[:limit], many=True).data
        )


@extend_schema(tags=["Inventory"])
class ProductStockHistoryView(APIView):
    """GET /api/inventory/products/<id>/stock-history/?location_id=<>

    Bundles everything the Product Stock History page needs in one
    call:
      • Product header (name + SKU)
      • Quantities In aggregates (purchase, opening, sell-return,
        transfers-in)
      • Quantities Out aggregates (sold, adjusted, purchase-return,
        transfers-out)
      • Current stock total (FIFO total or per-location snapshot
        when a location filter is active)
      • Movement ledger rows (most recent first) with type / qty
        change / running balance / date / reference number

    All sums come straight from the per-tenant StockMovement +
    related tables, so the numbers reflect every sale / transfer /
    adjustment the moment the page reloads.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        from decimal import Decimal as _D
        from django.db.models import Sum
        try:
            product = Product.objects.select_related("unit").get(pk=pk)
        except Product.DoesNotExist:
            return Response({"detail": "Product not found."}, status=status.HTTP_404_NOT_FOUND)

        location_id = request.query_params.get("location_id") or None

        movements = StockMovement.objects.filter(product=product)
        if location_id:
            movements = movements.filter(location_id=location_id)

        def _sum(qs):
            return _D(str(qs.aggregate(s=Sum("quantity")).get("s") or 0))

        # Bucket movements by what triggered them (movement_type +
        # reference_type). The inventory services tag each row at
        # creation time, so we just sum from the ledger.
        in_qs  = movements.filter(movement_type="IN")
        out_qs = movements.filter(movement_type="OUT")
        adj_qs = movements.filter(movement_type="ADJUST")
        tfr_qs = movements.filter(movement_type="TRANSFER")

        total_purchase     = _sum(in_qs.filter(reference_type__iexact="purchase"))
        opening_stock      = _sum(in_qs.filter(reference_type__iexact="opening"))
        total_sell_return  = _sum(in_qs.filter(reference_type__iexact="sell_return"))
        # IN movements we can't classify go to a misc bucket but stay
        # included in totals via the running balance computation.
        total_sold          = _sum(out_qs.filter(reference_type__iexact="sale"))
        total_stock_adjust  = _sum(adj_qs)
        total_purch_return  = _sum(out_qs.filter(reference_type__iexact="purchase_return"))

        # Transfers — paired IN+OUT rows tagged TRANSFER. Split by
        # whether THIS location was the source or destination.
        tfr_in  = _D("0")
        tfr_out = _D("0")
        if location_id:
            tfr_in  = _sum(tfr_qs.filter(location_id=location_id).filter(
                reference_type__iexact="transfer_in"))
            tfr_out = _sum(tfr_qs.filter(location_id=location_id).filter(
                reference_type__iexact="transfer_out"))
        else:
            # Global view → each transfer pair adds to BOTH directions
            # so we just split the total in half for display.
            tfr_total = _sum(tfr_qs)
            tfr_in = tfr_out = (tfr_total / _D("2")).quantize(_D("0.0001"))

        # Current stock — match the products list "MAX(FIFO, snapshot)"
        # rule. With a location filter, prefer the per-location
        # ProductStock snapshot at that branch.
        if location_id:
            row = product.stocks.filter(location_id=location_id).aggregate(t=Sum("quantity"))
            current_stock = _D(str(row.get("t") or 0))
        else:
            fifo_total = _D(str(product.total_stock or 0))
            snap = product.stocks.aggregate(t=Sum("quantity")).get("t")
            current_stock = max(fifo_total, _D(str(snap or 0)))

        # Movement list — most recent first, with a running "new
        # quantity" computed from oldest → newest then reversed.
        try:
            limit = max(1, min(int(request.query_params.get("limit", 100)), 500))
        except (TypeError, ValueError):
            limit = 100
        all_moves = list(
            movements.order_by("created_at").only(
                "id", "movement_type", "reference_type",
                "reference_id", "quantity", "created_at",
            )
        )
        running = _D("0")
        ledger = []
        for m in all_moves:
            q = _D(str(m.quantity or 0))
            # IN, ADJUST add; OUT subtracts; TRANSFER depends on
            # reference_type tag.
            mt = m.movement_type
            ref = (m.reference_type or "").lower()
            if mt == "IN":
                delta = q
            elif mt == "OUT":
                delta = -q
            elif mt == "ADJUST":
                # ADJUST quantity sign isn't carried; assume positive
                # corrections — operator can still see the magnitude.
                delta = q
            elif mt == "TRANSFER":
                delta = q if "in" in ref else -q
            else:
                delta = q
            running = (running + delta).quantize(_D("0.0001"))
            ledger.append({
                "id":             str(m.id),
                "type":           _type_label(mt, ref),
                "qty_change":     str(delta),
                "new_quantity":   str(running),
                "date":           m.created_at,
                "reference_no":   _reference_no_for_movement(m),
            })
        ledger.reverse()  # newest first for display
        ledger = ledger[:limit]

        return Response({
            "product": {
                "id":     str(product.id),
                "name":   product.name,
                "sku":    product.sku or "",
                "unit":   getattr(product.unit, "abbreviation", "") if product.unit_id else "",
            },
            "quantities_in": {
                "total_purchase":     str(total_purchase),
                "opening_stock":      str(opening_stock),
                "total_sell_return":  str(total_sell_return),
                "stock_transfers_in": str(tfr_in),
            },
            "quantities_out": {
                "total_sold":             str(total_sold),
                "total_stock_adjustment": str(total_stock_adjust),
                "total_purchase_return":  str(total_purch_return),
                "stock_transfers_out":    str(tfr_out),
            },
            "current_stock": str(current_stock),
            "movements":     ledger,
        })


def _type_label(mt, ref):
    """Friendly label for the ledger Type column."""
    if mt == "OUT" and "sale" in ref:
        return "Sell"
    if mt == "IN" and "purchase" in ref:
        return "Purchase"
    if mt == "IN" and "sell_return" in ref:
        return "Sell Return"
    if mt == "OUT" and "purchase_return" in ref:
        return "Purchase Return"
    if mt == "TRANSFER":
        return "Transfer (In)" if "in" in ref else "Transfer (Out)"
    if mt == "ADJUST":
        return "Stock Adjustment"
    if mt == "IN" and "opening" in ref:
        return "Opening Stock"
    return mt.title()


def _reference_no_for_movement(m):
    """Best-effort look-up of a human-readable reference number for
    the linked sale / purchase / transfer / adjustment. Falls back
    to the first 6 chars of the reference UUID."""
    rid = getattr(m, "reference_id", None)
    if not rid:
        return ""
    ref = (m.reference_type or "").lower()
    try:
        if "sale" in ref:
            from sales.models import Sale
            s = Sale.objects.filter(pk=rid).only("invoice_number").first()
            if s and s.invoice_number:
                return s.invoice_number
        # Purchases / transfers / adjustments — just show the short id.
    except Exception:  # noqa: BLE001
        pass
    return str(rid)[:8]


# ─────────────────────────────────────────────────────────────────────────────
# OpeningStockView — GET + POST endpoint the new
# "Add or Edit Opening Stock" modal on the List Products page hits.
# Per-product, per-location upsert of the "opening stock" FIFO layer.
# ─────────────────────────────────────────────────────────────────────────────
@extend_schema(tags=["Inventory"])
class OpeningStockView(APIView):
    """
    GET  /api/inventory/products/<id>/opening-stock/
         → returns one row per active business location:
           { location_id, location_name, location_code, quantity,
             unit_cost, layer_date, note }

         For each location we look up the most-recent unconsumed
         opening-stock FIFO layer (initial_qty == remaining_qty AND
         reference_type='opening_stock'). If none exists, all fields
         come back as zero / today so the modal starts empty.

    POST /api/inventory/products/<id>/opening-stock/
         body: { rows: [{ location_id, quantity, unit_cost,
                          layer_date?, note? }] }

         For each row:
           - 0 quantity → ignore.
           - If an unconsumed opening-stock FIFO layer already exists
             for (product × location), UPDATE its qty / cost / date /
             note in-place AND keep ProductStock in sync by adjusting
             by the delta.
           - Otherwise call services.add_stock_fifo() with
             reference_type='opening_stock' which creates a fresh
             layer + updates ProductStock + writes a StockMovement.

         Returns the saved rows so the modal can re-render with the
         persisted state.
    """
    permission_classes = [IsAuthenticated]

    def _current_row(self, product_id, loc):
        """Pull the most recent untouched opening-stock layer for this
        product × location. Returns a serialised row (zeros if none)."""
        from .models import FIFOLayer  # noqa: PLC0415
        from decimal import Decimal as _D  # noqa: PLC0415
        layer = (
            FIFOLayer.objects
            .filter(
                product_id     = product_id,
                location_id    = loc.id,
                reference_type = "opening_stock",
            )
            .order_by("-created_at")
            .first()
        )
        if layer:
            return {
                "location_id":    str(loc.id),
                "location_name":  loc.name,
                "location_code":  loc.code or "",
                "layer_id":       str(layer.id),
                "quantity":       str(layer.remaining_qty),
                "initial_qty":    str(layer.initial_qty),
                "unit_cost":      str(layer.unit_cost),
                "subtotal":       str((layer.remaining_qty or _D("0")) * (layer.unit_cost or _D("0"))),
                "layer_date":     layer.created_at,
                "is_untouched":   bool(layer.initial_qty == layer.remaining_qty),
            }
        # No existing layer — return a blank row keyed to this loc.
        return {
            "location_id":   str(loc.id),
            "location_name": loc.name,
            "location_code": loc.code or "",
            "layer_id":      None,
            "quantity":      "0",
            "initial_qty":   "0",
            "unit_cost":     "0",
            "subtotal":      "0",
            "layer_date":    None,
            "is_untouched":  True,
        }

    def get(self, request, pk):
        from .models import Product, Location  # noqa: PLC0415
        if not Product.objects.filter(id=pk).exists():
            return Response({"detail": "Product not found."}, status=status.HTTP_404_NOT_FOUND)
        product = Product.objects.filter(id=pk).only("id", "name", "sku", "unit_id").first()
        unit_name = ""
        try:
            from .models import Unit  # noqa: PLC0415
            if product.unit_id:
                u = Unit.objects.filter(id=product.unit_id).only("abbreviation", "name").first()
                if u:
                    unit_name = u.abbreviation or u.name or ""
        except Exception:
            unit_name = ""
        locs = list(Location.objects.filter(is_active=True).order_by("name"))
        rows = [self._current_row(pk, l) for l in locs]
        return Response({
            "product": {
                "id":   str(product.id),
                "name": product.name,
                "sku":  product.sku or "",
                "unit": unit_name or "Pc(s)",
            },
            "rows": rows,
        })

    def post(self, request, pk):
        from .models import Product, Location, FIFOLayer, ProductStock, StockMovement  # noqa: PLC0415
        from decimal import Decimal as _D  # noqa: PLC0415
        from django.db.models import F  # noqa: PLC0415

        if not Product.objects.filter(id=pk).exists():
            return Response({"detail": "Product not found."}, status=status.HTTP_404_NOT_FOUND)

        rows = request.data.get("rows") or []
        if not isinstance(rows, list):
            return Response({"detail": "Body must include a `rows` array."}, status=status.HTTP_400_BAD_REQUEST)

        saved = []
        errors = []
        for raw in rows:
            try:
                loc_id   = raw.get("location_id")
                qty      = _D(str(raw.get("quantity") or "0"))
                unit_cost = _D(str(raw.get("unit_cost") or "0"))
                layer_dt = raw.get("layer_date") or None
                # 0-qty rows are simply skipped (matches the modal's
                # "I haven't set opening stock for this location" case).
                if qty <= 0:
                    continue
                if unit_cost < 0:
                    errors.append({"location_id": loc_id, "error": "Unit cost cannot be negative."})
                    continue
                if not Location.objects.filter(id=loc_id, is_active=True).exists():
                    errors.append({"location_id": loc_id, "error": "Location not found or inactive."})
                    continue

                # Existing untouched opening-stock layer — update in place
                # so we don't pollute the FIFO queue with duplicates.
                existing = (
                    FIFOLayer.objects.select_for_update()
                    .filter(
                        product_id     = pk,
                        location_id    = loc_id,
                        reference_type = "opening_stock",
                    )
                    .order_by("-created_at")
                    .first()
                )
                if existing and existing.initial_qty == existing.remaining_qty:
                    delta = qty - existing.remaining_qty
                    existing.initial_qty   = qty
                    existing.remaining_qty = qty
                    existing.unit_cost     = unit_cost
                    if layer_dt:
                        try:
                            from django.utils.dateparse import parse_datetime, parse_date  # noqa: PLC0415
                            dt = parse_datetime(str(layer_dt)) or parse_date(str(layer_dt))
                            if dt:
                                existing.created_at = dt if hasattr(dt, "hour") else dt
                        except Exception:
                            pass
                    existing.save()
                    # Adjust ProductStock by the delta.
                    ProductStock.objects.filter(product_id=pk, location_id=loc_id)\
                        .update(quantity=F("quantity") + delta)
                    # Audit movement (positive or negative).
                    if delta != 0:
                        StockMovement.objects.create(
                            product_id     = pk,
                            location_id    = loc_id,
                            movement_type  = "IN" if delta > 0 else "ADJUSTMENT",
                            quantity       = abs(delta),
                            reference_type = "opening_stock_edit",
                            reference_id   = existing.id,
                        )
                else:
                    # Use the shared service so ProductStock + StockMovement
                    # are kept in sync atomically.
                    services.add_stock_fifo(
                        product_id     = pk,
                        location_id    = loc_id,
                        quantity       = qty,
                        unit_cost      = unit_cost,
                        reference_type = "opening_stock",
                        layer_date     = layer_dt,
                    )
                # Re-fetch the persisted row for the response payload.
                loc = Location.objects.filter(id=loc_id).only("id", "name", "code").first()
                saved.append(self._current_row(pk, loc))
            except services.StockServiceError as e:
                errors.append({"location_id": raw.get("location_id"), "error": str(e)})
            except Exception as e:  # noqa: BLE001
                errors.append({"location_id": raw.get("location_id"), "error": str(e) or "Failed to save."})

        return Response({"saved": saved, "errors": errors}, status=status.HTTP_200_OK)
