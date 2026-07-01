"""
Website CMS — API views.

Public read endpoint (AllowAny) for the marketing site, and admin endpoints
(is_staff / is_superuser) to manage blocks, collection items, media and SEO.
Everything is master-DB; the public site falls back to its built-in defaults
for any block/collection the admin hasn't customised yet.
"""
import logging

from django.utils.text import slugify
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from .models import CmsBlock, CmsItem, CmsMedia, CmsAuditLog

logger = logging.getLogger(__name__)

# Editable singleton sections + their SEO pages. The admin UI renders these
# even before they're saved; the public site uses defaults for missing keys.
BLOCK_KEYS = [
    "header", "hero", "contact", "pricing_intro",
    "seo.home", "seo.services", "seo.products", "seo.pricing", "seo.contact",
]
COLLECTIONS = [c[0] for c in CmsItem.Collection.choices]


def _is_admin(u) -> bool:
    return bool(u and (u.is_staff or u.is_superuser))


def _audit(action, *, target="", actor=None, note="", metadata=None):
    try:
        CmsAuditLog.objects.create(
            action=action, target=target or "", note=note or "", metadata=metadata or {},
            actor=getattr(actor, "id", None), actor_email=getattr(actor, "email", "") or "",
        )
    except Exception:
        logger.exception("Failed to write CMS audit log (%s)", action)


def _media_url(m, request=None):
    url = m.file.url if m.file else ""
    return request.build_absolute_uri(url) if (request and url) else url


def serialize_block(b):
    return {"key": b.key, "content": b.content or {}, "is_published": b.is_published,
            "sort_order": b.sort_order, "updated_at": b.updated_at.isoformat()}


def serialize_item(i):
    return {"id": str(i.id), "collection": i.collection, "slug": i.slug, "data": i.data or {},
            "sort_order": i.sort_order, "is_published": i.is_published,
            "created_at": i.created_at.isoformat(), "updated_at": i.updated_at.isoformat()}


def serialize_media(m, request=None):
    return {"id": str(m.id), "name": m.name, "folder": m.folder, "url": _media_url(m, request),
            "content_type": m.content_type, "size": m.size, "created_at": m.created_at.isoformat()}


# ──────────────────────────────────────────────────────────────────────────────
# Public
# ──────────────────────────────────────────────────────────────────────────────

class CmsPublicView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        blocks = {b.key: b.content or {} for b in CmsBlock.objects.filter(is_published=True)}
        items = {c: [] for c in COLLECTIONS}
        for i in CmsItem.objects.filter(is_published=True).order_by("collection", "sort_order"):
            items.setdefault(i.collection, []).append({
                "id": str(i.id), "slug": i.slug, **(i.data or {}),
            })
        return Response({"blocks": blocks, "collections": items})


class CmsPublicItemView(APIView):
    permission_classes = [AllowAny]

    def get(self, request, collection, slug):
        try:
            i = CmsItem.objects.get(collection=collection, slug=slug, is_published=True)
        except CmsItem.DoesNotExist:
            return Response({"detail": "Not found."}, status=http.HTTP_404_NOT_FOUND)
        return Response({"id": str(i.id), "slug": i.slug, **(i.data or {})})


# ──────────────────────────────────────────────────────────────────────────────
# Admin base
# ──────────────────────────────────────────────────────────────────────────────

class _AdminBase(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None


# ── Blocks (singleton sections + SEO) ───────────────────────────────────────

class AdminCmsBlocksView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        saved = {b.key: b for b in CmsBlock.objects.all()}
        out = []
        for key in BLOCK_KEYS:
            b = saved.get(key)
            out.append(serialize_block(b) if b else
                       {"key": key, "content": {}, "is_published": True, "sort_order": 0, "updated_at": None})
        # Include any extra saved blocks not in the known list.
        for key, b in saved.items():
            if key not in BLOCK_KEYS:
                out.append(serialize_block(b))
        return Response({"results": out})

    def put(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        key = (data.get("key") or "").strip()
        if not key:
            return Response({"detail": "Block key is required."}, status=http.HTTP_400_BAD_REQUEST)
        block, _ = CmsBlock.objects.get_or_create(key=key)
        if "content" in data and isinstance(data["content"], dict):
            block.content = data["content"]
        if "is_published" in data:
            block.is_published = bool(data["is_published"])
        block.updated_by = getattr(request.user, "email", "") or ""
        block.save()
        _audit("publish" if "is_published" in data else "update", target=f"block:{key}", actor=request.user)
        return Response(serialize_block(block))


# ── Collection items ─────────────────────────────────────────────────────────

class AdminCmsItemsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = CmsItem.objects.all()
        if col := (request.query_params.get("collection") or "").strip():
            qs = qs.filter(collection=col)
        return Response({"results": [serialize_item(i) for i in qs]})

    def post(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        col = (data.get("collection") or "").strip()
        if col not in COLLECTIONS:
            return Response({"detail": "Invalid collection."}, status=http.HTTP_400_BAD_REQUEST)
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        slug = (data.get("slug") or payload.get("slug") or "").strip()
        if col in ("services", "products"):
            slug = slugify(slug or payload.get("name") or "")[:120] or str(CmsItem.objects.count() + 1)
            # Ensure uniqueness within the collection.
            base, n = slug, 2
            while CmsItem.objects.filter(collection=col, slug=slug).exists():
                slug = f"{base}-{n}"; n += 1
        last = CmsItem.objects.filter(collection=col).order_by("-sort_order").first()
        item = CmsItem.objects.create(
            collection=col, slug=slug, data=payload,
            sort_order=(last.sort_order + 1 if last else 0),
            is_published=bool(data.get("is_published", True)),
        )
        _audit("create", target=f"item:{col}:{item.id}", actor=request.user, note=payload.get("name") or payload.get("title") or "")
        return Response(serialize_item(item), status=http.HTTP_201_CREATED)


class AdminCmsItemDetailView(_AdminBase):
    def _get(self, pk):
        return CmsItem.objects.get(id=pk)

    def patch(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            item = self._get(pk)
        except CmsItem.DoesNotExist:
            return Response({"detail": "Not found."}, status=http.HTTP_404_NOT_FOUND)
        data = request.data or {}
        if isinstance(data.get("data"), dict):
            item.data = data["data"]
        if "slug" in data and item.collection in ("services", "products"):
            new_slug = slugify(data.get("slug") or "")[:120]
            if new_slug and not CmsItem.objects.filter(collection=item.collection, slug=new_slug).exclude(id=item.id).exists():
                item.slug = new_slug
        if "is_published" in data:
            item.is_published = bool(data["is_published"])
            _audit("publish" if item.is_published else "unpublish", target=f"item:{item.collection}:{item.id}", actor=request.user)
        item.save()
        _audit("update", target=f"item:{item.collection}:{item.id}", actor=request.user)
        return Response(serialize_item(item))

    def delete(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            item = self._get(pk)
        except CmsItem.DoesNotExist:
            return Response({"detail": "Not found."}, status=http.HTTP_404_NOT_FOUND)
        target = f"item:{item.collection}:{item.id}"
        item.delete()
        _audit("delete", target=target, actor=request.user)
        return Response({"detail": "Deleted."})


class AdminCmsReorderView(_AdminBase):
    """POST { collection, order: [id, id, …] } — persist drag-and-drop order."""
    def post(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        order = data.get("order") or []
        for idx, pk in enumerate(order):
            CmsItem.objects.filter(id=pk).update(sort_order=idx)
        _audit("reorder", target=f"collection:{data.get('collection', '')}", actor=request.user)
        return Response({"detail": "Order saved."})


# ── Media library ────────────────────────────────────────────────────────────

class AdminCmsMediaView(_AdminBase):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = CmsMedia.objects.all()
        if folder := (request.query_params.get("folder") or "").strip():
            qs = qs.filter(folder=folder)
        folders = list(CmsMedia.objects.exclude(folder="").values_list("folder", flat=True).distinct())
        return Response({
            "results": [serialize_media(m, request) for m in qs[:500]],
            "folders": sorted(folders),
        })

    def post(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        f = request.FILES.get("file")
        if not f:
            return Response({"detail": "No file provided."}, status=http.HTTP_400_BAD_REQUEST)

        # Reject active-content files (SVG/HTML/JS) that could run script when
        # served inline from our media origin, and cap the size.
        from core.uploads import reject_active_content, UploadValidationError
        _MAX_MEDIA_BYTES = 25 * 1024 * 1024
        if (getattr(f, "size", 0) or 0) > _MAX_MEDIA_BYTES:
            return Response({"detail": "File too large. Max is 25 MB."}, status=http.HTTP_400_BAD_REQUEST)
        try:
            reject_active_content(f)
        except UploadValidationError as exc:
            return Response({"detail": str(exc)}, status=http.HTTP_400_BAD_REQUEST)

        m = CmsMedia.objects.create(
            file=f, name=(request.data.get("name") or getattr(f, "name", ""))[:255],
            folder=(request.data.get("folder") or "").strip()[:120],
            content_type=getattr(f, "content_type", "") or "",
            size=getattr(f, "size", 0) or 0,
            uploaded_by=getattr(request.user, "email", "") or "",
        )
        _audit("upload", target=f"media:{m.id}", actor=request.user, note=m.name)
        return Response(serialize_media(m, request), status=http.HTTP_201_CREATED)


class AdminCmsMediaDetailView(_AdminBase):
    def delete(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            m = CmsMedia.objects.get(id=pk)
        except CmsMedia.DoesNotExist:
            return Response({"detail": "Not found."}, status=http.HTTP_404_NOT_FOUND)
        try:
            m.file.delete(save=False)
        except Exception:
            pass
        m.delete()
        _audit("delete", target=f"media:{pk}", actor=request.user)
        return Response({"detail": "Deleted."})


# ── Audit feed ───────────────────────────────────────────────────────────────

class AdminCmsAuditView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = CmsAuditLog.objects.all()[:80]
        return Response({"results": [{
            "id": str(a.id), "action": a.action, "target": a.target, "note": a.note,
            "by": a.actor_email or "system", "at": a.created_at.isoformat(),
        } for a in qs]})
