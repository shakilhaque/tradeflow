from django.urls import path
from . import views

app_name = "system_config"

urlpatterns = [
    # Settings list / bulk-update  (must come before the <str:key>/ catch-all)
    path("", views.SettingsListView.as_view(), name="settings-list"),

    # Tax groups  (must come before <str:key>/ to avoid shadowing)
    path("tax-groups/", views.TaxGroupListCreateView.as_view(), name="tax-group-list"),
    path("tax-groups/<uuid:tax_group_id>/", views.TaxGroupDetailView.as_view(), name="tax-group-detail"),

    # Company profile — sidebar branding + invoice header / footer.
    # MUST come before the <str:key>/ catch-all below.
    path("company-profile/",      views.CompanyProfileView.as_view(),     name="company-profile"),
    path("company-profile/logo/", views.CompanyLogoUploadView.as_view(),  name="company-logo-upload"),

    # Individual setting by key (catch-all — keep last)
    path("<str:key>/", views.SettingDetailView.as_view(), name="setting-detail"),
]
