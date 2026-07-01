"""
Reports URL routes — mounted at /api/reports/ in config/urls.py.
"""
from django.urls import path
from .views import (
    ExpenseReportView,
    ProductReportView,
    SalesReportView,
    StockReportView,
    TaxReportView,
)
from ._service_staff_report import ServiceStaffReportView
from ._sales_representative_report import SalesRepresentativeReportView
from ._register_report import RegisterReportView, RegisterDetailsView, RegisterCloseView
from ._sell_payment_report import SellPaymentReportView
from ._purchase_payment_report import PurchasePaymentReportView
from ._product_purchase_report import ProductPurchaseReportView
from ._purchase_sale_report import PurchaseSaleReportView
from ._contacts_report import ContactsReportView
from ._branch_comparison_report import BranchComparisonReportView, BranchDashboardView

app_name = "reports"

urlpatterns = [
    path("sales/",          SalesReportView.as_view(),        name="sales"),
    path("stock/",          StockReportView.as_view(),        name="stock"),
    path("expenses/",       ExpenseReportView.as_view(),      name="expenses"),
    path("tax/",            TaxReportView.as_view(),          name="tax"),
    path("products/",       ProductReportView.as_view(),      name="products"),
    path("service-staff/",        ServiceStaffReportView.as_view(),        name="service-staff"),
    path("sales-representative/", SalesRepresentativeReportView.as_view(), name="sales-representative"),
    path("register/",             RegisterReportView.as_view(),            name="register"),
    path("register/details/",     RegisterDetailsView.as_view(),           name="register-details"),
    path("register/close/",       RegisterCloseView.as_view(),             name="register-close"),
    path("sell-payment/",         SellPaymentReportView.as_view(),         name="sell-payment"),
    path("purchase-payment/",     PurchasePaymentReportView.as_view(),     name="purchase-payment"),
    path("product-purchases/",    ProductPurchaseReportView.as_view(),     name="product-purchases"),
    path("purchase-sale/",        PurchaseSaleReportView.as_view(),        name="purchase-sale"),
    path("contacts/",             ContactsReportView.as_view(),            name="contacts"),
    path("branch-comparison/",    BranchComparisonReportView.as_view(),    name="branch-comparison"),
    path("branch-dashboard/",     BranchDashboardView.as_view(),           name="branch-dashboard"),
]
