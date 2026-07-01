"""
Image upload endpoint.

Behaviour
─────────
* If AWS_S3_ENABLED is True (i.e. valid AWS credentials + bucket are set in
  the environment) the file is uploaded to S3 and the public URL returned.
* Otherwise the file is saved to MEDIA_ROOT/products/ and a /media/ URL is
  returned. This makes local dev work without any AWS setup.

Endpoint: POST /api/inventory/uploads/image/
Body:     multipart/form-data with field "file"
Returns:  { "url": "https://...", "key": "products/<uuid>.jpg" }
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.storage import default_storage
from rest_framework import status
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_BYTES   = 5 * 1024 * 1024  # 5 MB


class ImageUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes     = [MultiPartParser]

    def post(self, request):
        f = request.FILES.get("file")
        if not f:
            return Response({"detail": "No file uploaded (field name: file)."},
                            status=status.HTTP_400_BAD_REQUEST)

        ext = Path(f.name).suffix.lower()
        if ext not in ALLOWED_EXT:
            return Response({"detail": f"Unsupported file type {ext}."},
                            status=status.HTTP_400_BAD_REQUEST)
        if f.size > MAX_BYTES:
            return Response({"detail": "File exceeds 5MB limit."},
                            status=status.HTTP_400_BAD_REQUEST)

        from core.uploads import reject_active_content, UploadValidationError
        try:
            reject_active_content(f)
        except UploadValidationError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        key = f"products/{uuid.uuid4().hex}{ext}"

        if getattr(settings, "AWS_S3_ENABLED", False):
            url = self._upload_to_s3(f, key)
        else:
            url = self._save_locally(f, key)

        return Response({"url": url, "key": key}, status=status.HTTP_201_CREATED)

    # ── Storage strategies ───────────────────────────────────────────────────
    def _upload_to_s3(self, fileobj, key: str) -> str:
        import boto3
        s3 = boto3.client(
            "s3",
            aws_access_key_id     = settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key = settings.AWS_SECRET_ACCESS_KEY,
            region_name           = settings.AWS_S3_REGION_NAME,
        )
        s3.upload_fileobj(
            fileobj,
            settings.AWS_STORAGE_BUCKET_NAME,
            key,
            ExtraArgs={"ContentType": fileobj.content_type or "application/octet-stream"},
        )
        if settings.AWS_S3_CUSTOM_DOMAIN:
            return f"https://{settings.AWS_S3_CUSTOM_DOMAIN}/{key}"
        return (f"https://{settings.AWS_STORAGE_BUCKET_NAME}.s3."
                f"{settings.AWS_S3_REGION_NAME}.amazonaws.com/{key}")

    def _save_locally(self, fileobj, key: str) -> str:
        # Ensure media root exists.
        media_root = Path(settings.MEDIA_ROOT)
        (media_root / "products").mkdir(parents=True, exist_ok=True)
        saved_path = default_storage.save(key, fileobj)
        # Build absolute URL using BACKEND_BASE_URL if configured.
        base = getattr(settings, "BACKEND_BASE_URL", "").rstrip("/")
        return f"{base}{settings.MEDIA_URL}{saved_path}"
