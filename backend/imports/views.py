"""
Import module views.

Endpoints
─────────
  GET  /api/imports/<type>/template/          — download CSV template
  POST /api/imports/<type>/validate/          — upload file, validate, return batch
  POST /api/imports/<batch_id>/commit/        — commit a VALIDATED batch
  GET  /api/imports/<batch_id>/               — retrieve batch status/errors

Access control
──────────────
  Products → CAN_MANAGE_PRODUCTS
  Expenses → CAN_RECORD_EXPENSE
  Orders   → CAN_CREATE_SALE
"""

import csv
import io
import logging

from django.http import HttpResponse
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Perm, require_permission
from accounts.tenant_db import get_current_db_alias
from .models import ImportBatch


def _current_db() -> str:
    return get_current_db_alias() or "default"
from .services import validate_import, commit_import, analyze_import

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# CSV template definitions
# ──────────────────────────────────────────────────────────────────────────────

_TEMPLATES: dict[str, list[str]] = {
    "PRODUCT": [
        "Product Name", "SKU", "Category", "Brand", "Unit",
        "Opening Qty", "Unit Cost", "Selling Price", "Stock Date",
        "Reorder Level", "Barcode", "Warranty Days", "Notes",
    ],
    "SUPPLIER": [
        "Supplier Name", "Business Name", "Contact Person", "Email", "Phone",
        "Address", "Tax Number", "Pay Term (days)", "Opening Balance", "Notes",
    ],
    "CONTACT": [
        "Contact Type", "Prefix", "First Name", "Middle Name", "Last Name",
        "Business Name", "Email", "Mobile", "Alternate Contact", "Landline",
        "Address Line 1", "Address Line 2", "City", "State", "Country",
        "Zip Code", "Tax Number", "Pay Term (days)", "Opening Balance",
        "Credit Limit", "Notes",
    ],
    "EXPENSE": [
        "Date", "Category", "Payment Account", "Amount", "Note",
    ],
    "ORDER": [
        "Date", "Customer Name", "Product SKU", "Quantity",
        "Price", "Payment Status", "Notes",
    ],
}

_TEMPLATE_EXAMPLES: dict[str, list[list[str]]] = {
    "PRODUCT": [
        ["Widget Pro", "WGT-001", "Electronics", "Acme Corp", "Piece",
         "50", "12.50", "25.00", "2026-01-15",
         "5", "", "365", "Flagship widget"],
    ],
    "SUPPLIER": [
        ["Acme Trading Ltd", "Acme Trading", "Rakib Hossain",
         "rakib@acme.com", "01712345678",
         "123 Tejgaon I/A, Dhaka", "VAT-12345", "30", "0",
         "Net 30 supplier"],
    ],
    "CONTACT": [
        ["Customer", "Mr", "Najnin", "", "Ferdousi", "",
         "najnin@example.com", "01633176082", "", "",
         "House #12, Road 7", "Dhanmondi", "Dhaka", "Dhaka", "Bangladesh",
         "1209", "VAT-0001", "30", "0", "10000", "Walk-in regular"],
    ],
    "EXPENSE": [
        ["2026-04-01", "RENT", "1001", "1500.00", "April office rent"],
    ],
    "ORDER": [
        ["2026-04-20", "Jane Doe", "WGT-001", "3", "25.00", "PAID", ""],
    ],
}


def _perm_for_type(import_type: str) -> str:
    return {
        "PRODUCT":  Perm.CAN_MANAGE_PRODUCTS,
        "SUPPLIER": Perm.CAN_MANAGE_PRODUCTS,   # closest existing permission
        "CONTACT":  Perm.CAN_MANAGE_PRODUCTS,   # contacts: re-using the same gate
        "EXPENSE":  Perm.CAN_RECORD_EXPENSE,
        "ORDER":    Perm.CAN_CREATE_SALE,
    }.get(import_type.upper(), Perm.CAN_MANAGE_PRODUCTS)


def _serialize_batch(batch: ImportBatch) -> dict:
    return {
        "id": str(batch.pk),
        "import_type": batch.import_type,
        "status": batch.status,
        "file_name": batch.file_name,
        "total_rows": batch.total_rows,
        "valid_rows": batch.valid_rows,
        "error_count": batch.error_count,
        "errors": batch.errors,
        "committed_rows": batch.committed_rows,
        "committed_at": batch.committed_at.isoformat() if batch.committed_at else None,
        "created_at": batch.created_at.isoformat(),
        "expires_at": batch.expires_at.isoformat(),
        "can_commit": batch.can_commit,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Template download
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportTemplateView(APIView):
    """
    GET /api/imports/<type>/template/

    Returns a CSV file with the correct header row + one example row.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Download CSV import template",
        description=(
            "Returns a CSV file with the correct column headers and one example data row "
            "for the given import type.\n\n"
            "**import_type** must be one of: `PRODUCT`, `EXPENSE`, `ORDER`.\n\n"
            "The response `Content-Type` is `text/csv` — not wrapped in the standard JSON envelope."
        ),
        parameters=[
            OpenApiParameter("import_type", OpenApiTypes.STR, location=OpenApiParameter.PATH,
                             description="Import type: PRODUCT | EXPENSE | ORDER"),
        ],
        responses={
            200: OpenApiTypes.BINARY,
            400: OpenApiTypes.OBJECT,
        },
    )
    def get(self, request, import_type: str):
        import_type = import_type.upper()
        if import_type not in _TEMPLATES:
            return Response(
                {"detail": f"Unknown import type '{import_type}'. "
                            f"Choices: {', '.join(_TEMPLATES)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(_TEMPLATES[import_type])
        for example in _TEMPLATE_EXAMPLES.get(import_type, []):
            writer.writerow(example)

        response = HttpResponse(
            output.getvalue(),
            content_type="text/csv",
        )
        response["Content-Disposition"] = (
            f'attachment; filename="{import_type.lower()}_import_template.csv"'
        )
        return response


# ──────────────────────────────────────────────────────────────────────────────
# Analyze — auto-detect column mapping for the "Map columns" wizard step
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportAnalyzeView(APIView):
    """
    POST /api/imports/<type>/analyze/

    Multipart upload (field name 'file'). Returns the auto-detected
    column mapping + a 5-row sample so the frontend wizard can let the
    tenant override before validation runs. No DB writes.

    Response shape:
        {
          "headers":     ["SKU", "Product", "Location", ...],
          "row_count":   156,
          "sample_rows": [{"SKU": "02", "Product": "...", ...}, ...],
          "mapping": {
            "matches": {
              "name":          {"field": "name", "source_header": "Product", "confidence": 1.0, "match_kind": "exact"},
              "sku":           {"field": "sku",  "source_header": "SKU",     "confidence": 1.0, "match_kind": "exact"},
              "selling_price": {"field": "selling_price", "source_header": "Unit Price", "confidence": 0.9, "match_kind": "exact"},
              ...
            },
            "extras": ["Current Stock Value (By purchase price)", "Total unit sold", ...]
          }
        }
    """
    permission_classes = [IsAuthenticated]
    parser_classes     = [MultiPartParser]

    @extend_schema(
        summary="Analyze import file headers (no DB writes)",
        description=(
            "Inspect the uploaded file's header row and return an auto-detected "
            "column mapping plus a small data sample. Used by the frontend "
            "'Map columns' wizard step before running full validation."
        ),
        parameters=[
            OpenApiParameter("import_type", OpenApiTypes.STR, location=OpenApiParameter.PATH,
                             description="Import type: PRODUCT | EXPENSE | ORDER"),
        ],
        responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
    )
    def post(self, request, import_type: str):
        import_type = import_type.upper()
        if import_type not in _TEMPLATES:
            return Response({"detail": f"Unknown import type '{import_type}'."},
                            status=status.HTTP_400_BAD_REQUEST)
        if "file" not in request.FILES:
            return Response({"detail": "No file uploaded. Send the file in the 'file' field."},
                            status=status.HTTP_400_BAD_REQUEST)
        uploaded = request.FILES["file"]
        try:
            result = analyze_import(
                import_type=import_type,
                file=uploaded,
                file_name=uploaded.name,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            logger.exception("Analyze failed: %s", exc)
            return Response(
                {"detail": f"File could not be inspected ({exc}). Ensure it is a valid CSV or XLSX."},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        return Response(result, status=status.HTTP_200_OK)


# ──────────────────────────────────────────────────────────────────────────────
# Validate
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportValidateView(APIView):
    """
    POST /api/imports/<type>/validate/

    Multipart upload: field name = 'file'.
    Returns the ImportBatch (with errors if any).
    """
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Validate import file",
        description=(
            "Upload a CSV or XLSX file for the given import type. The file is validated row-by-row "
            "and an `ImportBatch` is created.\n\n"
            "- If all rows are valid → `201 Created`, batch `status` = `VALIDATED`.\n"
            "- If any rows have errors → `200 OK`, batch `status` = `HAS_ERRORS` with per-row details.\n\n"
            "Call `/commit/` with the returned `batch_id` to apply valid rows.\n\n"
            "**import_type**: `PRODUCT` (requires `can_manage_products`), "
            "`EXPENSE` (requires `can_record_expense`), `ORDER` (requires `can_create_sale`).\n\n"
            "Send the file as `multipart/form-data` with field name `file`."
        ),
        parameters=[
            OpenApiParameter("import_type", OpenApiTypes.STR, location=OpenApiParameter.PATH,
                             description="Import type: PRODUCT | EXPENSE | ORDER"),
        ],
        responses={
            201: OpenApiTypes.OBJECT,
            200: OpenApiTypes.OBJECT,
            400: OpenApiTypes.OBJECT,
            403: OpenApiTypes.OBJECT,
        },
    )
    def post(self, request, import_type: str):
        import_type = import_type.upper()
        if import_type not in _TEMPLATES:
            return Response(
                {"detail": f"Unknown import type '{import_type}'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from accounts.permissions import has_permission
        if not has_permission(request.user, _perm_for_type(import_type)):
            return Response(
                {"detail": "You do not have permission to import this data type."},
                status=status.HTTP_403_FORBIDDEN,
            )

        if "file" not in request.FILES:
            return Response(
                {"detail": "No file uploaded. Send the file in the 'file' field."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        uploaded = request.FILES["file"]
        file_name = uploaded.name

        # Optional operator-confirmed mapping from the "Map columns" wizard.
        # Posted as a JSON string in the 'mapping_json' multipart field, e.g.
        #   '{"name": "Product", "sku": "SKU", "selling_price": "Unit Price", ...}'
        # When absent, validate_import runs the auto-mapper itself.
        mapping_override = None
        mapping_json = request.data.get("mapping_json")
        if mapping_json:
            import json as _json
            try:
                mapping_override = _json.loads(mapping_json)
            except _json.JSONDecodeError:
                return Response(
                    {"detail": "mapping_json is not valid JSON."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            batch = validate_import(
                import_type=import_type,
                file=uploaded,
                file_name=file_name,
                created_by_id=request.user.pk,
                mapping_override=mapping_override,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            logger.exception("Unexpected error during import validation: %s", exc)
            return Response(
                {"detail": f"File could not be processed ({exc}). Ensure it is a valid CSV or XLSX."},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        resp_status = (
            status.HTTP_200_OK
            if batch.status == ImportBatch.Status.HAS_ERRORS
            else status.HTTP_201_CREATED
        )
        return Response(_serialize_batch(batch), status=resp_status)


# ──────────────────────────────────────────────────────────────────────────────
# Commit
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportCommitView(APIView):
    """
    POST /api/imports/<batch_id>/commit/

    Commits a VALIDATED batch.  Empty body — all data was stored in the batch.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Commit validated import batch",
        description=(
            "Commits a previously validated `ImportBatch`. All valid rows are written to the database "
            "atomically — if any row fails during commit, the entire batch is rolled back.\n\n"
            "The batch must have `status = VALIDATED` and must not be expired. "
            "The request body should be empty (all data was captured during validation).\n\n"
            "Requires the same permission as the import type: `can_manage_products` / "
            "`can_record_expense` / `can_create_sale`."
        ),
        responses={
            200: OpenApiTypes.OBJECT,
            400: OpenApiTypes.OBJECT,
            404: OpenApiTypes.OBJECT,
        },
    )
    def post(self, request, batch_id):
        db = _current_db()
        try:
            batch = ImportBatch.objects.using(db).get(pk=batch_id)
        except ImportBatch.DoesNotExist:
            return Response(
                {"detail": "Import batch not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        from accounts.permissions import has_permission
        if not has_permission(request.user, _perm_for_type(batch.import_type)):
            return Response(
                {"detail": "You do not have permission to commit this import."},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            result = commit_import(batch_id=batch_id, created_by_id=request.user.pk)
        except (ValueError, RuntimeError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            logger.exception("Commit failed for batch %s: %s", batch_id, exc)
            return Response(
                {"detail": f"Commit failed ({exc}). No data was written."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(result, status=status.HTTP_200_OK)


# ──────────────────────────────────────────────────────────────────────────────
# Batch detail
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportBatchDetailView(APIView):
    """
    GET /api/imports/<batch_id>/

    Retrieve status and errors for an import batch.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="imports_retrieve",
        summary="Get import batch detail",
        description=(
            "Returns status, row counts, and per-row error details for an import batch. "
            "Only the user who created the batch can view it."
        ),
        responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    def get(self, request, batch_id):
        db = _current_db()
        try:
            batch = ImportBatch.objects.using(db).get(pk=batch_id, created_by_id=request.user.pk)
        except ImportBatch.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(_serialize_batch(batch))


# ──────────────────────────────────────────────────────────────────────────────
# Batch list (own batches only)
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema(tags=["Imports"])
class ImportBatchListView(APIView):
    """
    GET /api/imports/

    List the current user's import batches (newest first, limit 50).
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="imports_list",
        summary="List my import batches",
        description="Returns the current user's import batches (newest first, up to 50). Includes status and error counts.",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        db = _current_db()
        batches = ImportBatch.objects.using(db).filter(
            created_by_id=request.user.pk
        ).order_by("-created_at")[:50]
        return Response([_serialize_batch(b) for b in batches])
