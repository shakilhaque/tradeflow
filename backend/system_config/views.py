"""
System Configuration views.

Endpoints
─────────
  GET  /api/settings/              — list all settings (CAN_MANAGE_SETTINGS)
  PATCH /api/settings/             — bulk-update multiple settings (CAN_MANAGE_SETTINGS)
  GET  /api/settings/<key>/        — get one setting
  PUT  /api/settings/<key>/        — update one setting (CAN_MANAGE_SETTINGS)

  GET  /api/settings/tax-groups/   — list tax groups
  POST /api/settings/tax-groups/   — create tax group (CAN_MANAGE_SETTINGS)
  PUT  /api/settings/tax-groups/<id>/ — update tax group (CAN_MANAGE_SETTINGS)
"""

import logging

from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Perm, require_permission
from accounts.tenant_db import get_current_db_alias
from .services import get_setting, set_setting, get_all_settings, SettingKeys


def _current_db() -> str:
    return get_current_db_alias() or "default"

logger = logging.getLogger(__name__)


def _serialize_setting(obj) -> dict:
    return {
        "key":         obj.key,
        "value":       obj.typed_value,
        "value_str":   obj.value_str,
        "value_type":  obj.value_type,
        "description": obj.description,
        "updated_at":  obj.updated_at.isoformat(),
    }


def _serialize_tax_group(tg) -> dict:
    return {
        "id":          str(tg.pk),
        "code":        tg.code,
        "name":        tg.name,
        "rate":        str(tg.rate),
        "is_default":  tg.is_default,
        "is_active":   tg.is_active,
        "description": tg.description,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Settings CRUD
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Settings"])
class SettingsListView(APIView):
    """
    GET  — list all settings (managers and above)
    PATCH — bulk-update: {key1: value1, key2: value2, ...}  (CAN_MANAGE_SETTINGS)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="settings_list",
        summary="List all system settings",
        description="Returns all key-value system settings for the tenant. Requires `can_manage_settings` (OWNER only).",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from accounts.permissions import has_permission
        if not has_permission(request.user, Perm.CAN_MANAGE_SETTINGS):
            return Response(
                {"detail": "You do not have permission to view system settings."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return Response(get_all_settings())

    @extend_schema(
        summary="Bulk update system settings",
        description=(
            "Update multiple settings in one request. Body: `{\"key1\": value1, \"key2\": value2, ...}`. "
            "Returns the updated key-value pairs. Requires `can_manage_settings`."
        ),
        responses={200: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_MANAGE_SETTINGS)
    def patch(self, request):
        if not isinstance(request.data, dict):
            return Response(
                {"detail": "Request body must be a JSON object {key: value, ...}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        updated = {}
        for key, value in request.data.items():
            obj = set_setting(key, value, updated_by_id=request.user.pk)
            updated[key] = obj.typed_value
        return Response({"updated": updated})


@extend_schema(tags=["Settings"])
class SettingDetailView(APIView):
    """
    GET  /api/settings/<key>/   — read one setting
    PUT  /api/settings/<key>/   — update one setting body: {"value": ...}
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="settings_retrieve",
        summary="Get one setting",
        description="Returns the value and metadata for a single setting by its key.",
        responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    def get(self, request, key: str):
        from .models import SystemSetting
        db = _current_db()
        try:
            obj = SystemSetting.objects.using(db).get(key=key)
        except SystemSetting.DoesNotExist:
            return Response({"detail": "Setting not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_serialize_setting(obj))

    @extend_schema(
        summary="Update one setting",
        description='Update the value of a single setting. Body: `{"value": <new_value>}`. Requires `can_manage_settings`.',
        responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_MANAGE_SETTINGS)
    def put(self, request, key: str):
        if "value" not in request.data:
            return Response(
                {"detail": "Body must contain a 'value' field."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        obj = set_setting(key, request.data["value"], updated_by_id=request.user.pk)
        return Response(_serialize_setting(obj))


# ──────────────────────────────────────────────────────────────────────────────
# Tax Groups
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Settings"])
class TaxGroupListCreateView(APIView):
    """
    GET  — list all tax groups (authenticated)
    POST — create tax group (CAN_MANAGE_SETTINGS)
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="settings_tax_groups_list",
        summary="List tax groups",
        description="Returns all tax groups (active and inactive). Any authenticated user can read tax groups.",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        from .services import get_tax_groups
        groups = get_tax_groups(active_only=False)
        return Response([_serialize_tax_group(g) for g in groups])

    @extend_schema(
        summary="Create tax group",
        description=(
            "Create a new tax group with a unique code, name, and rate. "
            "If `is_default` is `true`, all other groups are unset as default. "
            "Requires `can_manage_settings`."
        ),
        responses={201: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_MANAGE_SETTINGS)
    def post(self, request):
        from .models import TaxGroup
        from decimal import Decimal, InvalidOperation
        db = _current_db()

        code = (request.data.get("code") or "").strip()
        name = (request.data.get("name") or "").strip()
        rate_raw = str(request.data.get("rate", "0")).strip()
        description = (request.data.get("description") or "").strip()
        is_default = bool(request.data.get("is_default", False))

        errors = {}
        if not code:
            errors["code"] = "Code is required."
        if not name:
            errors["name"] = "Name is required."
        try:
            rate = Decimal(rate_raw)
            if rate < 0:
                errors["rate"] = "Rate cannot be negative."
        except InvalidOperation:
            errors["rate"] = f"'{rate_raw}' is not a valid decimal."

        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        if TaxGroup.objects.using(db).filter(code__iexact=code).exists():
            return Response({"code": f"Code '{code}' already exists."}, status=status.HTTP_400_BAD_REQUEST)

        if is_default:
            TaxGroup.objects.using(db).filter(is_default=True).update(is_default=False)

        tg = TaxGroup.objects.using(db).create(
            code=code.upper(),
            name=name,
            rate=rate,
            is_default=is_default,
            description=description,
        )
        return Response(_serialize_tax_group(tg), status=status.HTTP_201_CREATED)


@extend_schema(tags=["Settings"])
class TaxGroupDetailView(APIView):
    """
    GET  /api/settings/tax-groups/<id>/
    PUT  /api/settings/tax-groups/<id>/  (CAN_MANAGE_SETTINGS)
    DELETE /api/settings/tax-groups/<id>/ (CAN_MANAGE_SETTINGS)
    """
    permission_classes = [IsAuthenticated]

    def _get_object(self, tax_group_id):
        from .models import TaxGroup
        db = _current_db()
        try:
            return TaxGroup.objects.using(db).get(pk=tax_group_id)
        except TaxGroup.DoesNotExist:
            return None

    @extend_schema(
        operation_id="settings_tax_groups_retrieve",
        summary="Get tax group",
        description="Returns detail for a single tax group by ID.",
        responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    def get(self, request, tax_group_id):
        obj = self._get_object(tax_group_id)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_serialize_tax_group(obj))

    @extend_schema(
        summary="Update tax group",
        description="Update name, rate, description, is_active, or is_default for a tax group. Requires `can_manage_settings`.",
        responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_MANAGE_SETTINGS)
    def put(self, request, tax_group_id):
        from decimal import Decimal, InvalidOperation
        from .models import TaxGroup
        db = _current_db()

        obj = self._get_object(tax_group_id)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        name = (request.data.get("name") or obj.name).strip()
        description = request.data.get("description", obj.description)
        is_active = request.data.get("is_active", obj.is_active)
        is_default = request.data.get("is_default", obj.is_default)
        rate_raw = str(request.data.get("rate", str(obj.rate))).strip()

        try:
            rate = Decimal(rate_raw)
        except InvalidOperation:
            return Response({"rate": f"'{rate_raw}' is not a valid decimal."}, status=status.HTTP_400_BAD_REQUEST)

        if is_default and not obj.is_default:
            TaxGroup.objects.using(db).filter(is_default=True).update(is_default=False)

        obj.name = name
        obj.rate = rate
        obj.description = description
        obj.is_active = bool(is_active)
        obj.is_default = bool(is_default)
        obj.save(using=db)
        return Response(_serialize_tax_group(obj))

    @extend_schema(
        summary="Delete tax group",
        description="Delete a tax group. The default tax group cannot be deleted — set another as default first. Requires `can_manage_settings`.",
        responses={204: None, 400: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    @require_permission(Perm.CAN_MANAGE_SETTINGS)
    def delete(self, request, tax_group_id):
        obj = self._get_object(tax_group_id)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if obj.is_default:
            return Response(
                {"detail": "Cannot delete the default tax group. Set another as default first."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Company profile — tenant-side branding (sidebar header, invoices, receipts)
# ──────────────────────────────────────────────────────────────────────────────

class CompanyProfileView(APIView):
    """GET / PATCH /api/settings/company-profile/

    Backed by the SystemSetting key/value store. Returns the seven
    company.* keys as a single object so the frontend can render the
    sidebar header in one request:

      {
        "name":       "Iffaa Stationery",   // company.name
        "logo_url":   "/media/...",          // company.logo_url
        "address":    "House 12, ...",      // company.address
        "phone":      "01XXXXXXXXX",        // company.phone
        "email":      "...",                 // company.email
        "tax_number": "VAT-...",             // company.tax_number
        "website":    "https://..."          // company.website
      }

    The tenant's display name in the sidebar reads `name`, falling back
    to the User.business_name from signup on the client. No hardcoded
    "Iffaa" anywhere.
    """
    permission_classes = [IsAuthenticated]

    _FIELDS = [
        # Core branding (sidebar, invoice header)
        ("name",       SettingKeys.COMPANY_NAME),
        ("logo_url",   SettingKeys.COMPANY_LOGO_URL),
        ("address",    SettingKeys.COMPANY_ADDRESS),
        ("phone",      SettingKeys.COMPANY_PHONE),
        ("email",      SettingKeys.COMPANY_EMAIL),
        ("tax_number", SettingKeys.COMPANY_TAX_NUMBER),
        ("website",    SettingKeys.COMPANY_WEBSITE),
        # Invoice slip per-tenant design
        ("invoice_prefix",               SettingKeys.INVOICE_PREFIX),
        ("invoice_tagline",              SettingKeys.INVOICE_TAGLINE),
        ("invoice_thank_you",            SettingKeys.INVOICE_THANK_YOU),
        ("invoice_payment_bank_account", SettingKeys.INVOICE_PAYMENT_BANK_ACCOUNT),
        ("invoice_payment_ac_name",      SettingKeys.INVOICE_PAYMENT_AC_NAME),
        ("invoice_payment_bank_details", SettingKeys.INVOICE_PAYMENT_BANK_DETAILS),
        ("invoice_terms",                SettingKeys.INVOICE_TERMS),
        ("invoice_primary_color",        SettingKeys.INVOICE_PRIMARY_COLOR),
        ("invoice_authorised_sign",      SettingKeys.INVOICE_AUTHORISED_SIGN),
        ("invoice_footer_note",          SettingKeys.INVOICE_FOOTER_NOTE),
    ]

    def get(self, request):
        from .services import get_setting
        return Response({
            api_name: (get_setting(key) or "")
            for api_name, key in self._FIELDS
        })

    def patch(self, request):
        """Bulk-update any subset of the seven keys. Only fields present
        in the request body are touched. Empty string clears the key.
        """
        from .services import set_setting
        for api_name, key in self._FIELDS:
            if api_name in request.data:
                set_setting(
                    key,
                    str(request.data[api_name] or ""),
                    updated_by_id=getattr(request.user, "id", None),
                )
        # Echo the new state back so the frontend can update its local cache.
        return self.get(request)


class CompanyLogoUploadView(APIView):
    """POST /api/settings/company-profile/logo/

    Multipart upload — field name 'file'. Stores via Django's default
    storage backend (local /media in dev, S3 in prod when configured)
    and writes the resulting URL to SystemSetting[company.logo_url] so
    every browser tab picks it up on next reload.

    Returns: {"logo_url": "<new-url>"}
    """
    permission_classes = [IsAuthenticated]
    parser_classes     = [MultiPartParser]

    _MAX_BYTES   = 5 * 1024 * 1024   # 5 MB
    # SVG is intentionally NOT allowed — it can carry inline <script> (stored
    # XSS when the logo is rendered). Raster formats only, verified by content.
    _ALLOWED_EXT = ("png", "jpg", "jpeg", "webp")

    def post(self, request):
        import uuid as _uuid
        from django.core.files.storage import default_storage
        from core.uploads import validate_image, UploadValidationError
        from .services import set_setting

        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file uploaded. Send the file in the 'file' field."},
                            status=status.HTTP_400_BAD_REQUEST)

        try:
            ext = validate_image(file, allow=self._ALLOWED_EXT, max_bytes=self._MAX_BYTES)
        except UploadValidationError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Path includes a UUID so re-uploads don't clobber cached old
        # logos (browsers cache by URL — a new URL forces a re-fetch).
        path = f"company_logos/{_uuid.uuid4().hex}.{ext}"
        saved_path = default_storage.save(path, file)
        url = default_storage.url(saved_path)

        set_setting(
            SettingKeys.COMPANY_LOGO_URL, url,
            updated_by_id=getattr(request.user, "id", None),
        )
        return Response({"logo_url": url}, status=status.HTTP_201_CREATED)
