"""
core/schema.py
──────────────
drf-spectacular helpers and the standard-envelope postprocessing hook.

The hook rewrites every generated response schema to reflect the actual
wire format produced by StandardJSONRenderer:

  Success (2xx):
    { "status": "success", "data": <original_schema>, "message": "" }

  Error (4xx / 5xx):
    { "status": "error", "data": null, "message": "...", "errors": <original_schema | null> }

Usage in settings.py
────────────────────
    SPECTACULAR_SETTINGS = {
        ...
        "POSTPROCESSING_HOOKS": [
            "drf_spectacular.hooks.postprocess_schema_enums",
            "core.schema.wrap_envelope_hook",          # ← this file
        ],
    }

View-level helpers
──────────────────
    from core.schema import api_response, api_error_response, query_param

    @extend_schema(
        summary="List products",
        responses=api_response(ProductSerializer(many=True)),
    )
    def get(self, request): ...
"""

from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, OpenApiTypes


# ──────────────────────────────────────────────────────────────────────────────
# Reusable query parameter builders
# ──────────────────────────────────────────────────────────────────────────────

def query_param(name: str, description: str, *, required=False,
                type=OpenApiTypes.STR, enum=None) -> OpenApiParameter:
    """Shorthand for a GET query parameter."""
    kwargs = dict(
        name        = name,
        location    = OpenApiParameter.QUERY,
        required    = required,
        type        = type,
        description = description,
    )
    if enum is not None:
        kwargs["enum"] = enum
    return OpenApiParameter(**kwargs)


# Common reusable params
DATE_FROM = query_param("date_from", "Start date (YYYY-MM-DD)", required=True, type=OpenApiTypes.DATE)
DATE_TO   = query_param("date_to",   "End date (YYYY-MM-DD)",   required=True, type=OpenApiTypes.DATE)
LIMIT     = query_param("limit",     "Maximum number of results (default 50, max 500)", type=OpenApiTypes.INT)
SEARCH    = query_param("search",    "Case-insensitive search string")


# ──────────────────────────────────────────────────────────────────────────────
# Inline schema builders (used in @extend_schema responses=...)
# ──────────────────────────────────────────────────────────────────────────────

def api_response(serializer_or_schema, description="OK", status_code=200) -> dict:
    """
    Wrap a serializer (or inline schema dict) in a standard success envelope
    for use with @extend_schema(responses=...).

    Example::
        @extend_schema(responses=api_response(ProductSerializer(many=True)))
    """
    return {status_code: OpenApiResponse(response=serializer_or_schema, description=description)}


def api_created(serializer_or_schema, description="Created") -> dict:
    return api_response(serializer_or_schema, description=description, status_code=201)


def api_error_responses(*codes) -> dict:
    """
    Return a dict of standard error responses for the given HTTP status codes.

    Example::
        @extend_schema(responses={**api_response(MySerializer), **api_error_responses(400, 403, 404)})
    """
    from drf_spectacular.utils import inline_serializer
    from rest_framework import serializers

    descriptions = {
        400: "Bad request / validation error",
        401: "Authentication required",
        403: "Permission denied",
        404: "Not found",
        409: "Conflict (e.g. insufficient stock)",
        422: "Unprocessable entity",
        500: "Internal server error",
    }
    result = {}
    for code in codes:
        result[code] = OpenApiResponse(description=descriptions.get(code, str(code)))
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Postprocessing hook — wraps all response schemas in the envelope
# ──────────────────────────────────────────────────────────────────────────────

def wrap_envelope_hook(result, generator, request, public):
    """
    drf-spectacular postprocessing hook.

    Rewrites every response schema in the generated OpenAPI document to
    reflect the standard envelope produced by StandardJSONRenderer.

    Registered in SPECTACULAR_SETTINGS["POSTPROCESSING_HOOKS"].
    """
    for _path, path_item in result.get("paths", {}).items():
        for _method, operation in path_item.items():
            if not isinstance(operation, dict):
                continue

            new_responses = {}
            for status_code, response in operation.get("responses", {}).items():
                try:
                    code_int = int(status_code)
                except (ValueError, TypeError):
                    new_responses[status_code] = response
                    continue

                content = response.get("content", {})
                new_content = {}

                for media_type, media_obj in content.items():
                    original_schema = media_obj.get("schema", {})
                    if code_int >= 400:
                        wrapped = _error_envelope(original_schema)
                    else:
                        wrapped = _success_envelope(original_schema)
                    new_content[media_type] = {**media_obj, "schema": wrapped}

                new_responses[status_code] = {**response, "content": new_content} if new_content else response

            if new_responses:
                operation["responses"] = new_responses

    return result


def _success_envelope(data_schema: dict) -> dict:
    """Build an OpenAPI schema for the standard success envelope."""
    return {
        "type": "object",
        "required": ["status", "data", "message"],
        "properties": {
            "status":  {"type": "string", "enum": ["success"], "example": "success"},
            "data":    data_schema if data_schema else {"type": "object", "nullable": True},
            "message": {"type": "string", "example": ""},
        },
        "example": {
            "status": "success",
            "data": {},
            "message": "",
        },
    }


def _error_envelope(original_schema: dict) -> dict:
    """Build an OpenAPI schema for the standard error envelope."""
    errors_schema = original_schema if original_schema else {"type": "object", "nullable": True}
    return {
        "type": "object",
        "required": ["status", "data", "message"],
        "properties": {
            "status":  {"type": "string", "enum": ["error"], "example": "error"},
            "data":    {"type": "object", "nullable": True, "example": None},
            "message": {"type": "string", "example": "An error occurred."},
            "errors":  {"oneOf": [errors_schema, {"type": "null"}]},
        },
        "example": {
            "status": "error",
            "data": None,
            "message": "An error occurred.",
            "errors": None,
        },
    }
