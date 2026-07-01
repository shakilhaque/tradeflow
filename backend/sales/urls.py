"""
Sales URL routes — mounted at /api/sales/ in config/urls.py.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from ._product_sell_report import ProductSellReportView
from .views import (
    BackOrderView,
    ContactImportTemplateView,
    ContactImportView,
    CustomerGroupViewSet,
    CustomerViewSet,
    DailyItemsSoldView,
    DiscountBulkDeactivateView,
    DiscountListCreateView,
    DraftSaleListView,
    FinalizeSaleView,
    SaleShippingView,
    SaleHeaderView,
    PosSaleListView,
    QuotationSaleListView,
    ShipmentListView,
    SellReturnListView,
    SellReturnCreateView,
    SellReturnDetailView,
    SellReturnRefundView,
    SaleCreateAdvancedView,
    SaleDetailView,
    SaleListCreateView,
    SalePaymentView,
    VoidSaleView,
)

# ── DRF router — customer CRUD ────────────────────────────────────────────────
router = DefaultRouter(trailing_slash=True)
router.register("customers", CustomerViewSet, basename="customer")
router.register("customer-groups", CustomerGroupViewSet, basename="customer-group")

app_name = "sales"

urlpatterns = [
    # Customer CRUD
    path("", include(router.urls)),

    # Sale lifecycle
    path("create/",                  SaleCreateAdvancedView.as_view(), name="sale-create-advanced-short"),
    path("all-sales/",               SaleListCreateView.as_view(), name="sale-list-all"),
    path("drafts/",                  DraftSaleListView.as_view(), name="sale-list-drafts"),
    path("pos-sales/",               PosSaleListView.as_view(), name="sale-list-pos"),
    path("quotations/",              QuotationSaleListView.as_view(), name="sale-list-quotations"),
    path("shipments/",               ShipmentListView.as_view(), name="sale-list-shipments"),
    path("sell-returns/",            SellReturnListView.as_view(), name="sale-list-sell-returns"),
    path("sell-returns/create/",     SellReturnCreateView.as_view(), name="sell-return-create"),
    path("sell-returns/<uuid:pk>/",         SellReturnDetailView.as_view(), name="sell-return-detail"),
    path("sell-returns/<uuid:pk>/refund/",  SellReturnRefundView.as_view(), name="sell-return-refund"),
    path("discounts/",               DiscountListCreateView.as_view(), name="discount-list-create"),
    path("discounts/deactivate/",    DiscountBulkDeactivateView.as_view(), name="discount-bulk-deactivate"),
    path("daily-items/",             DailyItemsSoldView.as_view(), name="sale-daily-items"),
    path("sales/",                   SaleListCreateView.as_view(), name="sale-list"),
    path("sales/create/",            SaleCreateAdvancedView.as_view(), name="sale-create-advanced"),
    # Accept either a UUID (legacy) or an invoice number like
    # 'INV-ONG-06062026-001' — services.get_sale_detail picks the
    # right lookup column. This lets the UI route by the human-readable
    # invoice number instead of a UUID.
    path("sales/<str:pk>/",          SaleDetailView.as_view(),     name="sale-detail"),
    path("sales/<uuid:pk>/shipping/", SaleShippingView.as_view(),  name="sale-shipping"),
    path("sales/<uuid:pk>/header/",   SaleHeaderView.as_view(),    name="sale-header"),
    path("sales/<uuid:pk>/finalize/", FinalizeSaleView.as_view(),  name="sale-finalize"),
    path("sales/<uuid:pk>/payments/", SalePaymentView.as_view(),   name="sale-payments"),
    path("sales/<uuid:pk>/backorder/", BackOrderView.as_view(),    name="sale-backorder"),
    path("sales/<uuid:pk>/void/",     VoidSaleView.as_view(),      name="sale-void"),

    # Product Sell Report
    path("product-sell-report/",      ProductSellReportView.as_view(), name="product-sell-report"),

    # Contacts import (Customers + Suppliers via CSV)
    path("contacts/import/",          ContactImportView.as_view(),         name="contacts-import"),
    path("contacts/import-template/", ContactImportTemplateView.as_view(), name="contacts-import-template"),
]
