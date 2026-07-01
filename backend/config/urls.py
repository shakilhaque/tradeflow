from decouple import config
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularSwaggerView,
    SpectacularRedocView,
)

urlpatterns = [
    # ── Django admin ─────────────────────────────────────────────────────────
    path("admin/", admin.site.urls),

    # ── App routes ────────────────────────────────────────────────────────────
    path("api/",               include("accounts.urls",       namespace="accounts")),
    path("api/inventory/",     include("inventory.urls",      namespace="inventory")),
    path("api/sales/",         include("sales.urls",          namespace="sales")),
    path("api/purchases/",     include("purchases.urls",      namespace="purchases")),
    path("api/accounting/",    include("accounting.urls",     namespace="accounting")),
    path("api/reports/",       include("reports.urls",        namespace="reports")),
    path("api/audit-logs/",    include("audit.urls",          namespace="audit")),
    path("api/imports/",       include("imports.urls",        namespace="imports")),
    path("api/notifications/", include("notifications.urls",  namespace="notifications")),
    path("api/settings/",      include("system_config.urls",  namespace="system_config")),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# ── API documentation ─────────────────────────────────────────────────────────
# The interactive schema / Swagger / ReDoc pages expose the entire API surface
# and every model field, so they are only mounted in DEBUG (dev). In production
# they 404 — set EXPOSE_API_DOCS=True in .env to re-enable behind your own auth.
if settings.DEBUG or config("EXPOSE_API_DOCS", cast=bool, default=False):
    urlpatterns += [
        path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
        path("api/docs/",   SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
        path("api/redoc/",  SpectacularRedocView.as_view(url_name="schema"),   name="redoc"),
    ]
