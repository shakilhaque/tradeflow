"""
Shared upload-safety helpers.

Two concerns, both about files that get served back from our own origin:

  • Active-content files (SVG, HTML, XML, JS) can carry <script> and run in a
    visitor's session when the browser renders them inline — i.e. stored XSS.
    `reject_active_content()` blocks them by extension AND by sniffing the first
    bytes (so a `logo.png` that is really an `<svg onload=…>` is still caught).

  • Raster logos should additionally be a real image of an allowed type, which
    `validate_image()` enforces by magic-byte sniffing rather than trusting the
    filename or the client-supplied Content-Type.

These raise `UploadValidationError` (a ValueError) with a user-friendly message;
callers turn that into a 400.
"""
from __future__ import annotations


class UploadValidationError(ValueError):
    """Raised when an uploaded file fails a safety check."""


# Extensions that can execute script / markup when served inline.
DANGEROUS_EXT = frozenset({
    "svg", "svgz", "html", "htm", "xhtml", "shtml", "xml", "js", "mjs",
    "php", "phtml", "php3", "php4", "php5", "phar", "htaccess", "swf",
})

# Magic-byte signatures for the raster formats we accept as images.
_IMAGE_SIGNATURES = {
    "png":  [b"\x89PNG\r\n\x1a\n"],
    "jpg":  [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "gif":  [b"GIF87a", b"GIF89a"],
    "webp": [b"RIFF"],   # plus 'WEBP' at offset 8 — checked below
}


def file_ext(name: str) -> str:
    return (name.rsplit(".", 1)[-1] if name and "." in name else "").lower()


def _head(f, n: int = 16) -> bytes:
    """Read the first `n` bytes without consuming the upload stream."""
    try:
        pos = f.tell()
    except (OSError, AttributeError):
        pos = None
    f.seek(0)
    head = f.read(n) or b""
    f.seek(pos if pos is not None else 0)
    return head


def reject_active_content(f) -> None:
    """Block files that could execute markup/script when served inline."""
    ext = file_ext(getattr(f, "name", "") or "")
    if ext in DANGEROUS_EXT:
        raise UploadValidationError(
            f"Files of type '.{ext}' are not allowed for security reasons."
        )
    head = _head(f, 256).lstrip()
    low = head.lower()
    if low.startswith(b"<?xml") or low.startswith(b"<svg") or b"<svg" in low[:200] \
            or low.startswith(b"<!doctype html") or low.startswith(b"<html"):
        raise UploadValidationError(
            "This file looks like markup (SVG/HTML) and is not allowed."
        )


def validate_image(f, *, allow=("png", "jpg", "jpeg", "webp"), max_bytes=5 * 1024 * 1024) -> str:
    """Validate an uploaded raster image. Returns the normalised extension.

    Checks size, then verifies the *actual* bytes match an allowed image type
    (not just the filename / Content-Type). Raises UploadValidationError.
    """
    size = getattr(f, "size", 0) or 0
    if size > max_bytes:
        raise UploadValidationError(
            f"File too large ({size // 1024} KB). Max is {max_bytes // 1024} KB."
        )
    reject_active_content(f)

    head = _head(f, 16)
    matched = None
    for ext in allow:
        for sig in _IMAGE_SIGNATURES.get(ext, []):
            if head.startswith(sig):
                if ext == "webp" and head[8:12] != b"WEBP":
                    continue
                matched = "jpg" if ext == "jpeg" else ext
                break
        if matched:
            break
    if not matched:
        raise UploadValidationError(
            f"Unsupported or corrupt image. Allowed: {', '.join(sorted(set(allow)))}."
        )
    return matched
