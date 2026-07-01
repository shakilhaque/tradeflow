"""
Coupon & Promotion management — API views.

Admin endpoints (is_staff / is_superuser) under /api/admin/coupons/ and
/api/admin/campaigns/. One public validation endpoint at /api/coupons/validate/.
"""
import logging
from datetime import date
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from .models import Coupon, PromotionCampaign, Plan
from . import coupon_admin as svc

logger = logging.getLogger(__name__)


def _is_admin(u) -> bool:
    return bool(u and (u.is_staff or u.is_superuser))


def _parse_date(v):
    try:
        return date.fromisoformat((v or "").strip()) if v else None
    except (ValueError, TypeError):
        return None


class _Base(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Coupons
# ──────────────────────────────────────────────────────────────────────────────

_SORT = {"code": "code", "name": "name", "created_at": "created_at",
         "start_date": "start_date", "end_date": "end_date", "discount_value": "discount_value"}


def _apply_coupon_fields(c, data):
    """Write the editable fields from a payload onto a coupon instance."""
    for f in ("code", "name", "description"):
        if f in data:
            setattr(c, f, (data.get(f) or "").strip())
    if "discount_type" in data and data["discount_type"] in dict(Coupon.Type.choices):
        c.discount_type = data["discount_type"]
    for f in ("discount_value", "min_purchase_amount"):
        if f in data and data[f] not in (None, ""):
            try:
                setattr(c, f, Decimal(str(data[f])))
            except Exception:
                pass
    if "free_trial_days" in data and data["free_trial_days"] not in (None, ""):
        try:
            c.free_trial_days = int(data["free_trial_days"])
        except (TypeError, ValueError):
            pass
    for f in ("max_usage_limit", "per_tenant_limit"):
        if f in data:
            v = data.get(f)
            setattr(c, f, int(v) if v not in (None, "") else None)
    if "start_date" in data:
        c.start_date = _parse_date(data.get("start_date"))
    if "end_date" in data:
        c.end_date = _parse_date(data.get("end_date"))
    if "is_active" in data:
        c.is_active = bool(data.get("is_active"))


class AdminCouponsView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        p = request.query_params
        qs = Coupon.objects.prefetch_related("applicable_plans", "redemptions")

        if search := (p.get("search") or "").strip():
            qs = qs.filter(Q(code__icontains=search) | Q(name__icontains=search))
        flt = (p.get("filter") or "all").lower()
        if flt in ("percentage", "fixed", "free_trial", "first_time", "renewal", "promotional"):
            qs = qs.filter(discount_type=flt)

        sort_by = (p.get("sort_by") or "created_at").lower()
        sort_dir = (p.get("sort_dir") or "desc").lower()
        field = _SORT.get(sort_by, "created_at")
        qs = qs.order_by(f"-{field}" if sort_dir == "desc" else field)

        rows = [svc.serialize_row(c) for c in qs]
        # Status filters are derived → filter in python.
        if flt in ("active", "expired", "scheduled", "disabled"):
            rows = [r for r in rows if r["status"] == flt]

        try:
            limit = min(max(int(p.get("limit", 25)), 1), 200)
        except (TypeError, ValueError):
            limit = 25
        try:
            page = max(int(p.get("page", 1)), 1)
        except (TypeError, ValueError):
            page = 1
        total = len(rows)
        total_pages = max((total + limit - 1) // limit, 1)
        page = min(page, total_pages)
        off = (page - 1) * limit
        return Response({
            "results": rows[off:off + limit], "count": total, "page": page,
            "limit": limit, "total_pages": total_pages, "kpis": svc.kpis(),
        })

    def post(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        code = (data.get("code") or "").strip()
        if not code:
            return Response({"detail": "Coupon code is required."}, status=http.HTTP_400_BAD_REQUEST)
        if Coupon.objects.filter(code__iexact=code).exists():
            return Response({"detail": "A coupon with this code already exists."}, status=http.HTTP_400_BAD_REQUEST)
        c = Coupon(created_by=getattr(request.user, "id", None))
        _apply_coupon_fields(c, data)
        if not c.name:
            c.name = c.code
        c.save()
        _set_plans(c, data.get("applicable_plan_ids"))
        svc.audit("created", coupon=c, actor=request.user, note=f"Created coupon {c.code}")
        return Response(svc.serialize_row(c), status=http.HTTP_201_CREATED)


def _set_plans(c, ids):
    if ids is None:
        return
    plans = Plan.objects.filter(id__in=ids) if ids else Plan.objects.none()
    c.applicable_plans.set(plans)


class AdminCouponDetailView(_Base):
    def get(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            c = Coupon.objects.prefetch_related("applicable_plans", "redemptions").get(id=pk)
        except Coupon.DoesNotExist:
            return Response({"detail": "Coupon not found."}, status=http.HTTP_404_NOT_FOUND)
        return Response(svc.serialize_row(c))

    def patch(self, request, pk):
        return self._update(request, pk)

    def put(self, request, pk):
        return self._update(request, pk)

    def _update(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            c = Coupon.objects.get(id=pk)
        except Coupon.DoesNotExist:
            return Response({"detail": "Coupon not found."}, status=http.HTTP_404_NOT_FOUND)
        data = request.data or {}
        new_code = (data.get("code") or "").strip()
        if new_code and Coupon.objects.filter(code__iexact=new_code).exclude(id=c.id).exists():
            return Response({"detail": "Another coupon already uses this code."}, status=http.HTTP_400_BAD_REQUEST)
        _apply_coupon_fields(c, data)
        c.save()
        _set_plans(c, data.get("applicable_plan_ids"))
        svc.audit("updated", coupon=c, actor=request.user, note=f"Updated coupon {c.code}")
        return Response(svc.serialize_row(c))

    def delete(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            c = Coupon.objects.get(id=pk)
        except Coupon.DoesNotExist:
            return Response({"detail": "Coupon not found."}, status=http.HTTP_404_NOT_FOUND)
        code = c.code
        svc.audit("deleted", actor=request.user, note=f"Deleted coupon {code}", metadata={"code": code})
        c.delete()
        return Response({"detail": f"Coupon {code} deleted."})


class AdminCouponActionView(_Base):
    def post(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            c = Coupon.objects.prefetch_related("applicable_plans").get(id=pk)
        except Coupon.DoesNotExist:
            return Response({"detail": "Coupon not found."}, status=http.HTTP_404_NOT_FOUND)
        action = (request.data.get("action") or "").strip().lower()

        if action in ("activate", "deactivate"):
            c.is_active = (action == "activate")
            c.save(update_fields=["is_active"])
            svc.audit(action + "d", coupon=c, actor=request.user)
            return Response(svc.serialize_row(c))

        if action == "duplicate":
            base = c.code
            i, new_code = 1, f"{base}-COPY"
            while Coupon.objects.filter(code__iexact=new_code).exists():
                i += 1
                new_code = f"{base}-COPY{i}"
            dup = Coupon.objects.create(
                code=new_code, name=f"{c.name} (Copy)", description=c.description,
                discount_type=c.discount_type, discount_value=c.discount_value,
                free_trial_days=c.free_trial_days, max_usage_limit=c.max_usage_limit,
                per_tenant_limit=c.per_tenant_limit, min_purchase_amount=c.min_purchase_amount,
                start_date=c.start_date, end_date=c.end_date, is_active=False,
                created_by=getattr(request.user, "id", None),
            )
            dup.applicable_plans.set(c.applicable_plans.all())
            svc.audit("created", coupon=dup, actor=request.user, note=f"Duplicated from {c.code}")
            return Response(svc.serialize_row(dup), status=http.HTTP_201_CREATED)

        return Response({"detail": f"Unknown action '{action}'."}, status=http.HTTP_400_BAD_REQUEST)


class AdminCouponAnalyticsView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        return Response(svc.analytics())


class AdminCouponAuditView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        from .models import CouponAuditLog
        qs = CouponAuditLog.objects.select_related("coupon", "campaign")
        if cid := (request.query_params.get("coupon") or "").strip():
            qs = qs.filter(coupon_id=cid)
        try:
            limit = min(max(int(request.query_params.get("limit", 50)), 1), 200)
        except (TypeError, ValueError):
            limit = 50
        rows = [{
            "id": str(a.id), "action": a.action, "note": a.note,
            "coupon": a.coupon.code if a.coupon else None,
            "campaign": a.campaign.name if a.campaign else None,
            "by": a.actor_email or "system", "at": a.created_at.isoformat(),
        } for a in qs[:limit]]
        return Response({"results": rows, "count": qs.count()})


# ──────────────────────────────────────────────────────────────────────────────
# Promotion campaigns
# ──────────────────────────────────────────────────────────────────────────────

def _serialize_campaign(c) -> dict:
    today = timezone.localdate()
    st = "disabled" if not c.is_active else (
        "scheduled" if c.start_date and c.start_date > today else
        "ended" if c.end_date and c.end_date < today else "active")
    return {
        "id": str(c.id), "name": c.name, "description": c.description,
        "target": c.target, "target_label": c.get_target_display(),
        "coupon_codes": list(c.coupons.values_list("code", flat=True)),
        "coupon_ids": [str(x) for x in c.coupons.values_list("id", flat=True)],
        "target_plan_ids": [str(x) for x in c.target_plans.values_list("id", flat=True)],
        "start_date": c.start_date.isoformat() if c.start_date else None,
        "end_date": c.end_date.isoformat() if c.end_date else None,
        "is_active": c.is_active, "status": st,
        "created_at": c.created_at.isoformat(),
    }


class AdminCampaignsView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = PromotionCampaign.objects.prefetch_related("coupons", "target_plans")
        return Response({"results": [_serialize_campaign(c) for c in qs]})

    def post(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        name = (data.get("name") or "").strip()
        if not name:
            return Response({"detail": "Campaign name is required."}, status=http.HTTP_400_BAD_REQUEST)
        camp = PromotionCampaign.objects.create(
            name=name, description=(data.get("description") or "").strip(),
            target=data.get("target") if data.get("target") in dict(PromotionCampaign.Target.choices) else "all",
            start_date=_parse_date(data.get("start_date")), end_date=_parse_date(data.get("end_date")),
            is_active=bool(data.get("is_active", True)), created_by=getattr(request.user, "id", None),
        )
        camp.coupons.set(Coupon.objects.filter(id__in=data.get("coupon_ids") or []))
        camp.target_plans.set(Plan.objects.filter(id__in=data.get("target_plan_ids") or []))
        svc.audit("campaign", campaign=camp, actor=request.user, note=f"Created campaign {name}")
        return Response(_serialize_campaign(camp), status=http.HTTP_201_CREATED)


class AdminCampaignDetailView(_Base):
    def _get(self, pk):
        return PromotionCampaign.objects.prefetch_related("coupons", "target_plans").get(id=pk)

    def patch(self, request, pk):
        return self.put(request, pk)

    def put(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            camp = self._get(pk)
        except PromotionCampaign.DoesNotExist:
            return Response({"detail": "Campaign not found."}, status=http.HTTP_404_NOT_FOUND)
        data = request.data or {}
        for f in ("name", "description"):
            if f in data:
                setattr(camp, f, (data.get(f) or "").strip())
        if data.get("target") in dict(PromotionCampaign.Target.choices):
            camp.target = data["target"]
        if "start_date" in data:
            camp.start_date = _parse_date(data.get("start_date"))
        if "end_date" in data:
            camp.end_date = _parse_date(data.get("end_date"))
        if "is_active" in data:
            camp.is_active = bool(data.get("is_active"))
        camp.save()
        if "coupon_ids" in data:
            camp.coupons.set(Coupon.objects.filter(id__in=data.get("coupon_ids") or []))
        if "target_plan_ids" in data:
            camp.target_plans.set(Plan.objects.filter(id__in=data.get("target_plan_ids") or []))
        svc.audit("campaign", campaign=camp, actor=request.user, note=f"Updated campaign {camp.name}")
        return Response(_serialize_campaign(camp))

    def delete(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            camp = self._get(pk)
        except PromotionCampaign.DoesNotExist:
            return Response({"detail": "Campaign not found."}, status=http.HTTP_404_NOT_FOUND)
        name = camp.name
        svc.audit("campaign", actor=request.user, note=f"Deleted campaign {name}")
        camp.delete()
        return Response({"detail": f"Campaign {name} deleted."})


# ──────────────────────────────────────────────────────────────────────────────
# Public coupon validation (used by the subscribe / checkout flow)
# ──────────────────────────────────────────────────────────────────────────────

class CouponValidateView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        data = request.data or {}
        code = (data.get("code") or "").strip()
        if not code:
            return Response({"valid": False, "detail": "Enter a coupon code."}, status=http.HTTP_400_BAD_REQUEST)
        try:
            amount = Decimal(str(data.get("amount") or 0))
        except Exception:
            amount = Decimal("0")
        user = request.user if getattr(request.user, "is_authenticated", False) else None
        try:
            coupon, discount, msg = svc.validate(
                code, amount=amount, plan_id=data.get("plan_id"),
                user=user, email=(data.get("email") or ""),
                is_renewal=bool(data.get("is_renewal")),
            )
        except svc.CouponError as exc:
            return Response({"valid": False, "detail": str(exc)})
        return Response({
            "valid": True, "detail": msg,
            "code": coupon.code, "discount_type": coupon.discount_type,
            "discount": str(discount), "free_trial_days": coupon.free_trial_days,
            "final_amount": str((amount - discount).quantize(Decimal("0.01"))),
        })
