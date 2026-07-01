"""
Profile views — current user can read their own info and manage their
profile picture.

Endpoints
─────────
    GET   /api/auth/me/                 → { id, email, name, role, profile_picture, ... }
    PATCH /api/auth/me/                 → update name / phone / business_name
    POST  /api/auth/me/avatar/          → multipart upload, sets profile_picture URL
    DELETE /api/auth/me/avatar/         → clears profile_picture

Storage mirrors inventory.uploads:
    • If AWS_S3_ENABLED → uploaded to S3 under avatars/<uuid>.ext
    • Otherwise         → saved locally to MEDIA_ROOT/avatars/ and served via /media/
"""
from __future__ import annotations

import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.storage import default_storage
from rest_framework import serializers, status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_BYTES   = 5 * 1024 * 1024  # 5 MB


# ──────────────────────────────────────────────────────────────────────────────
# Serializer
# ──────────────────────────────────────────────────────────────────────────────

class MeSerializer(serializers.ModelSerializer):
    """Read/update the current user's basic profile."""
    class Meta:
        from .models import User
        model = User
        fields = [
            "id", "email", "name", "username", "phone",
            "business_name", "role", "status", "profile_picture",
        ]
        read_only_fields = ["id", "email", "username", "role", "status"]


# ──────────────────────────────────────────────────────────────────────────────
# GET / PATCH /api/auth/me/
# ──────────────────────────────────────────────────────────────────────────────

class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(MeSerializer(request.user).data)

    def patch(self, request):
        ser = MeSerializer(request.user, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


# ──────────────────────────────────────────────────────────────────────────────
# POST / DELETE /api/auth/me/avatar/
# ──────────────────────────────────────────────────────────────────────────────

class MeAvatarView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes     = [MultiPartParser, FormParser]

    def post(self, request):
        f = request.FILES.get("file")
        if not f:
            return Response(
                {"detail": "No file uploaded (field name: file)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ext = Path(f.name).suffix.lower()
        if ext not in ALLOWED_EXT:
            return Response(
                {"detail": f"Unsupported file type {ext}. Allowed: {sorted(ALLOWED_EXT)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if f.size > MAX_BYTES:
            return Response(
                {"detail": "File exceeds 5 MB limit."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from core.uploads import reject_active_content, UploadValidationError
        try:
            reject_active_content(f)
        except UploadValidationError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        key = f"avatars/{uuid.uuid4().hex}{ext}"

        if getattr(settings, "AWS_S3_ENABLED", False):
            url = self._upload_to_s3(f, key)
        else:
            url = self._save_locally(f, key)

        user = request.user
        user.profile_picture = url
        user.save(update_fields=["profile_picture"])

        return Response(
            {"url": url, "profile_picture": url},
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request):
        user = request.user
        user.profile_picture = ""
        user.save(update_fields=["profile_picture"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Storage helpers (mirrors inventory.uploads) ───────────────────────────
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
        return (
            f"https://{settings.AWS_STORAGE_BUCKET_NAME}.s3."
            f"{settings.AWS_S3_REGION_NAME}.amazonaws.com/{key}"
        )

    def _save_locally(self, fileobj, key: str) -> str:
        (Path(settings.MEDIA_ROOT) / "avatars").mkdir(parents=True, exist_ok=True)
        saved_path = default_storage.save(key, fileobj)
        base = getattr(settings, "BACKEND_BASE_URL", "").rstrip("/")
        return f"{base}{settings.MEDIA_URL}{saved_path}"
