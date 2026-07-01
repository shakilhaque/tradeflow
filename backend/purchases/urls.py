"""
Purchases URL routes — mounted at /api/purchases/.
"""
from django.urls import include, path
from rest_framework.routers import SimpleRouter

from .views import (
    SupplierViewSet,
    PurchaseListCreateView,
    PurchaseDetailView,
    PurchasePaymentView,
    PurchaseNotificationView,
    PurchaseReturnListCreateView,
    PurchaseReturnDetailView,
    PurchaseReturnPaymentView,
    PurchaseReturnPaymentDetailView,
)

router = SimpleRouter(trailing_slash=True)
router.register("suppliers", SupplierViewSet, basename="supplier")

app_name = "purchases"

urlpatterns = [
    path("", include(router.urls)),

    path("returns/",                 PurchaseReturnListCreateView.as_view(), name="return-list-create"),
    path("returns/payments/<uuid:pk>/", PurchaseReturnPaymentDetailView.as_view(), name="return-payment-detail"),
    path("returns/<uuid:pk>/",       PurchaseReturnDetailView.as_view(),     name="return-detail"),
    path("returns/<uuid:pk>/payments/", PurchaseReturnPaymentView.as_view(), name="return-payments"),

    path("",                         PurchaseListCreateView.as_view(),       name="purchase-list-create"),
    path("<uuid:pk>/",               PurchaseDetailView.as_view(),           name="purchase-detail"),
    path("<uuid:pk>/payments/",      PurchasePaymentView.as_view(),          name="purchase-payments"),
    path("<uuid:pk>/notify/",        PurchaseNotificationView.as_view(),     name="purchase-notify"),
]
