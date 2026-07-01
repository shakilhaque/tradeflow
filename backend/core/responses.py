"""
core/responses.py
─────────────────
Standard API response envelope for the entire project.

Every successful JSON response:
    {
        "status":  "success",
        "data":    <payload>,
        "message": "<optional text>"
    }

Every error JSON response:
    {
        "status":  "error",
        "data":    null,
        "message": "<human-readable reason>",
        "errors":  <field-error dict | null>
    }

Implementation
──────────────
• StandardJSONRenderer         — DRF renderer; wraps every 2xx Response automatically.
• api_custom_exception_handler — DRF exception hook; wraps every 4xx/5xx Response.
• api_success / api_error      — convenience constructors for explicit use in views.

Usage (settings.py)
───────────────────
    REST_FRAMEWORK = {
        "DEFAULT_RENDERER_CLASSES": ["core.responses.StandardJSONRenderer"],
        "EXCEPTION_HANDLER":        "core.responses.api_custom_exception_handler",
        ...
    }
"""

from rest_framework.renderers import JSONRenderer
from rest_framework.views import exception_handler as _drf_exception_handler


# ──────────────────────────────────────────────────────────────────────────────
# Convenience constructors (use in views when you want explicit wrapping)
# ──────────────────────────────────────────────────────────────────────────────

def api_success(data=None, message: str = "", http_status: int = 200):
    """
    Return a standard success Response.

    Example::
        return api_success(data=serializer.data, message="Product created.", http_status=201)
    """
    from rest_framework.response import Response
    return Response(
        {"status": "success", "data": data, "message": message},
        status=http_status,
    )


def api_error(message: str = "", errors=None, http_status: int = 400):
    """
    Return a standard error Response.

    Example::
        return api_error("Insufficient stock.", http_status=409)
    """
    from rest_framework.response import Response
    return Response(
        {"status": "error", "data": None, "message": message, "errors": errors},
        status=http_status,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Custom DRF exception handler
# ──────────────────────────────────────────────────────────────────────────────

def api_custom_exception_handler(exc, context):
    """
    Wrap every DRF exception in the standard error envelope.

    Handles:
    • Authentication errors:  {"detail": "..."}  → message
    • Permission errors:      {"detail": "..."}  → message
    • Validation errors:      {"field": ["..."]} → errors
    • Throttling errors:      {"detail": "..."}  → message
    • 404 Not found:          {"detail": "..."}  → message

    Registered via settings.REST_FRAMEWORK["EXCEPTION_HANDLER"].
    """
    response = _drf_exception_handler(exc, context)
    if response is None:
        # Non-DRF exception — let Django's 500 handler deal with it.
        return None

    data = response.data

    if isinstance(data, dict) and "detail" in data:
        # Single-message error (auth, permission, 404, throttle …)
        message = str(data["detail"])
        errors  = None
    elif isinstance(data, dict):
        # Validation errors with per-field messages
        message = "Validation failed."
        errors  = data
    elif isinstance(data, list) and data:
        message = str(data[0])
        errors  = data
    else:
        message = str(data) if data else "An error occurred."
        errors  = None

    response.data = {
        "status":  "error",
        "data":    None,
        "message": message,
        "errors":  errors,
    }
    return response


# ──────────────────────────────────────────────────────────────────────────────
# Custom JSON renderer — auto-wraps every 2xx response
# ──────────────────────────────────────────────────────────────────────────────

class StandardJSONRenderer(JSONRenderer):
    """
    Intercepts every DRF Response before it is serialised to bytes.

    Rules
    ─────
    • data is None       → return empty bytes (preserves HTTP 204 No Content).
    • Already wrapped    → pass through (avoids double-wrapping).
    • status_code >= 400 → wrap as error (safety net for errors that bypassed
                           the exception handler, e.g. explicit Response(status=403)).
    • status_code < 400  → wrap as success; hoist "message" / "detail" key if present.
    """

    def render(self, data, accepted_media_type=None, renderer_context=None):
        renderer_context = renderer_context or {}
        response         = renderer_context.get("response")

        # Fallback: no response context (shouldn't happen in normal DRF flow).
        if response is None:
            return super().render(data, accepted_media_type, renderer_context)

        # Preserve 204 No Content — returning any body would break the spec.
        if data is None:
            return super().render(data, accepted_media_type, renderer_context)

        status_code = response.status_code

        # ── Already in standard envelope? ────────────────────────────────────
        # Detect by checking both "status" and "data" keys together
        # (a legitimate payload may have "status" alone, e.g. payment_status).
        if isinstance(data, dict) and "status" in data and "data" in data:
            return super().render(data, accepted_media_type, renderer_context)

        # ── Error path (safety net) ──────────────────────────────────────────
        if status_code >= 400:
            wrapped = {
                "status":  "error",
                "data":    None,
                "message": _extract_detail(data),
                "errors":  data if isinstance(data, dict) and "detail" not in data else None,
            }
            return super().render(wrapped, accepted_media_type, renderer_context)

        # ── Success path ─────────────────────────────────────────────────────
        message = ""
        payload = data

        if isinstance(data, dict):
            if "message" in data:
                # Hoist the "message" key to the top level.
                message = str(data["message"])
                payload = {k: v for k, v in data.items() if k != "message"}
            elif "detail" in data:
                # Some views use "detail" for success messages
                # (e.g. "Password set successfully.").
                message = str(data["detail"])
                payload = {k: v for k, v in data.items() if k != "detail"}

        wrapped = {
            "status":  "success",
            "data":    payload,
            "message": message,
        }
        return super().render(wrapped, accepted_media_type, renderer_context)


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _extract_detail(data) -> str:
    """Pull the most useful human-readable string from an error payload."""
    if isinstance(data, dict):
        return str(data.get("detail", data.get("message", "An error occurred.")))
    if isinstance(data, list) and data:
        return str(data[0])
    return "An error occurred."
