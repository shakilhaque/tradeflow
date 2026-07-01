"""
Inventory URL routes — mounted at /api/inventory/ in config/urls.py.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .uploads import ImageUploadView
from .views import (
    BrandViewSet,
    CategoryViewSet,
    FIFOLayerListView,
    LocationViewSet,
    ProductDetailView,
    ProductListCreateView,
    ProductScanView,
    LowStockListView,
    StockImportView,
    StockInView,
    StockMovementListView,
    ProductStockHistoryView,
    OpeningStockView,
    StockReportView,
    StockTransferDetailView,
    StockTransferListCreateView,
    StockTransferView,
    UnitViewSet,
    WarrantyViewSet,
)

# ── DRF router — master data CRUD ────────────────────────────────────────────
router = DefaultRouter(trailing_slash=True)
router.register("units",       UnitViewSet,      basename="unit")
router.register("brands",      BrandViewSet,     basename="brand")
router.register("categories",  CategoryViewSet,  basename="category")
router.register("locations",   LocationViewSet,  basename="location")
router.register("warranties",  WarrantyViewSet,  basename="warranty")

# ── URL patterns ──────────────────────────────────────────────────────────────
app_name = "inventory"

urlpatterns = [
    # Master data (CRUD via router)
    path("", include(router.urls)),

    # Products
    # NOTE: 'products/import/' must come BEFORE 'products/<uuid:pk>/' so Django
    # tries the literal path first (even though 'import' is not a UUID, being
    # explicit avoids any future ambiguity).
    path("products/",                 ProductListCreateView.as_view(), name="product-list"),
    path("products/import/",          StockImportView.as_view(),       name="stock-import"),
    # 'scan/' must come before <uuid:pk>/ so the literal segment wins
    path("products/scan/",            ProductScanView.as_view(),       name="product-scan"),
    path("low-stock/",                LowStockListView.as_view(),      name="low-stock"),
    path("products/<uuid:pk>/",       ProductDetailView.as_view(),     name="product-detail"),

    # Stock operations
    path("stock-in/",                 StockInView.as_view(),           name="stock-in"),
    path("stock-transfer/",           StockTransferView.as_view(),     name="stock-transfer"),

    # Stock transfer history (header records)
    path("stock-transfers/",          StockTransferListCreateView.as_view(), name="stock-transfer-list"),
    path("stock-transfers/<uuid:pk>/", StockTransferDetailView.as_view(),     name="stock-transfer-detail"),

    # File uploads (S3 if configured, local /media fallback otherwise)
    path("uploads/image/",            ImageUploadView.as_view(),       name="upload-image"),

    # Reports & audit
    path("stock-report/",             StockReportView.as_view(),       name="stock-report"),
    path("fifo-layers/",              FIFOLayerListView.as_view(),     name="fifo-layers"),
    path("movements/",                       StockMovementListView.as_view(),  name="movements"),
    path("products/<uuid:pk>/stock-history/", ProductStockHistoryView.as_view(), name="product-stock-history"),
    path("products/<uuid:pk>/opening-stock/", OpeningStockView.as_view(),       name="product-opening-stock"),
]
