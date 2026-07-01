"""
GET /api/me/referrals/
    Returns the current user's referral programme status — number of people
    they've referred, how many have been awarded, pending DiscountCredits,
    and the discount percent that will be auto-applied to their next renewal.

The frontend dashboard uses the `summary.pending_credits` count to decide
whether to show the "you'll get N% off next month" banner, and the full
`referrals` / `credits` arrays drive the dedicated referrals page (if/when
we add one).

Admin endpoints (staff only):
    GET    /api/admin/referrals/                 list referrals + credits (+search)
    PATCH  /api/admin/referrals/<id>/            award / un-award a referral
    DELETE /api/admin/referrals/<id>/            delete a referral
    PATCH  /api/admin/referral-credits/<id>/     edit a credit (percent/notes/status)
    DELETE /api/admin/referral-credits/<id>/     delete a credit
"""
from rest_framework import status as drf_status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from django.utils import timezone as _tz

from . import referrals as referrals_service


class MyReferralsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(referrals_service.list_referral_status(request.user))


# ──────────────────────────────────────────────────────────────────────────────
# Platform-admin referral management
# ──────────────────────────────────────────────────────────────────────────────


def _is_admin(request):
    return bool(request.user.is_staff or request.user.is_superuser)


def _referral_row(r):
    return {
        "id":              str(r.id),
        "referrer_id":     str(r.referrer_id),
        "referrer_name":   r.referrer.name or r.referrer.email,
        "referrer_email":  r.referrer.email,
        "referrer_phone":  r.referrer.phone,
        "referred_name":   r.referred.name or r.referred.email,
        "referred_email":  r.referred.email,
        "plan_at_signup":  r.plan_at_signup.name if r.plan_at_signup else None,
        "awarded":         r.awarded_at is not None,
        "awarded_at":      r.awarded_at,
        "created_at":      r.created_at,
    }


def _credit_row(c):
    return {
        "id":            str(c.id),
        "user_id":       str(c.user_id),
        "user_name":     c.user.name or c.user.email,
        "user_email":    c.user.email,
        "percent":       str(c.percent),
        "is_free_month": c.percent >= 100,
        "earned_at":     c.earned_at,
        "applied_at":    c.applied_at,
        "is_pending":    c.applied_at is None,
        "notes":         c.notes,
    }


class AdminReferralsView(APIView):
    """List every referral + discount credit across the platform."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _is_admin(request):
            return Response({"detail": "Admin only."}, status=drf_status.HTTP_403_FORBIDDEN)
        from django.db.models import Q
        from .models import DiscountCredit, Referral

        search = (request.query_params.get("search") or "").strip()

        ref_qs = Referral.objects.select_related(
            "referrer", "referred", "plan_at_signup",
        ).order_by("-created_at")
        cr_qs = DiscountCredit.objects.select_related("user").order_by("-earned_at")
        if search:
            ref_qs = ref_qs.filter(
                Q(referrer__name__icontains=search)
                | Q(referrer__email__icontains=search)
                | Q(referrer__phone__icontains=search)
                | Q(referred__name__icontains=search)
                | Q(referred__email__icontains=search)
            )
            cr_qs = cr_qs.filter(
                Q(user__name__icontains=search)
                | Q(user__email__icontains=search)
                | Q(notes__icontains=search)
            )

        return Response({
            "referrals": [_referral_row(r) for r in ref_qs[:500]],
            "credits":   [_credit_row(c) for c in cr_qs[:500]],
            "summary": {
                "total_referrals":     Referral.objects.count(),
                "awarded_referrals":   Referral.objects.filter(awarded_at__isnull=False).count(),
                "pending_referrals":   Referral.objects.filter(awarded_at__isnull=True).count(),
                "pending_credits":     DiscountCredit.objects.filter(applied_at__isnull=True, percent__lt=100).count(),
                "free_months_pending": DiscountCredit.objects.filter(applied_at__isnull=True, percent__gte=100).count(),
                "free_months_used":    DiscountCredit.objects.filter(applied_at__isnull=False, percent__gte=100).count(),
            },
        })


class AdminReferralDetailView(APIView):
    """PATCH (award / un-award) or DELETE one referral."""

    permission_classes = [IsAuthenticated]

    def patch(self, request, pk):
        if not _is_admin(request):
            return Response({"detail": "Admin only."}, status=drf_status.HTTP_403_FORBIDDEN)
        from .models import DiscountCredit, Referral
        try:
            r = Referral.objects.select_related("referrer", "referred", "plan_at_signup").get(pk=pk)
        except Referral.DoesNotExist:
            return Response({"detail": "Referral not found."}, status=drf_status.HTTP_404_NOT_FOUND)

        if "awarded" in request.data:
            if request.data["awarded"] and not r.awarded_at:
                r.awarded_at = _tz.now()
                r.save(update_fields=["awarded_at"])
                # Issue the referrer's 20% credit + run the milestone
                # check, exactly like an organic award.
                DiscountCredit.objects.create(
                    user=r.referrer, referral=r,
                    percent=DiscountCredit.DEFAULT_PERCENT,
                    notes=f"Manually awarded by admin ({request.user.email}).",
                )
                referrals_service.check_referral_milestones(r.referrer)
            elif not request.data["awarded"] and r.awarded_at:
                r.awarded_at = None
                r.triggering_payment = None
                r.save(update_fields=["awarded_at", "triggering_payment"])
        return Response(_referral_row(r))

    def delete(self, request, pk):
        if not _is_admin(request):
            return Response({"detail": "Admin only."}, status=drf_status.HTTP_403_FORBIDDEN)
        from .models import Referral
        deleted, _ = Referral.objects.filter(pk=pk).delete()
        if not deleted:
            return Response({"detail": "Referral not found."}, status=drf_status.HTTP_404_NOT_FOUND)
        return Response(status=drf_status.HTTP_204_NO_CONTENT)


class AdminReferralCreditDetailView(APIView):
    """PATCH (percent / notes / pending-applied) or DELETE one credit."""

    permission_classes = [IsAuthenticated]

    def patch(self, request, pk):
        if not _is_admin(request):
            return Response({"detail": "Admin only."}, status=drf_status.HTTP_403_FORBIDDEN)
        from decimal import Decimal, InvalidOperation
        from .models import DiscountCredit
        try:
            c = DiscountCredit.objects.select_related("user").get(pk=pk)
        except DiscountCredit.DoesNotExist:
            return Response({"detail": "Credit not found."}, status=drf_status.HTTP_404_NOT_FOUND)

        fields = []
        if "percent" in request.data:
            try:
                c.percent = Decimal(str(request.data["percent"]))
                fields.append("percent")
            except (InvalidOperation, TypeError):
                return Response({"detail": "Invalid percent."}, status=drf_status.HTTP_400_BAD_REQUEST)
        if "notes" in request.data:
            c.notes = str(request.data["notes"] or "")
            fields.append("notes")
        if "is_pending" in request.data:
            if request.data["is_pending"] and c.applied_at:
                c.applied_at = None
                c.applied_payment = None
                fields += ["applied_at", "applied_payment"]
            elif not request.data["is_pending"] and not c.applied_at:
                c.applied_at = _tz.now()
                fields.append("applied_at")
        if fields:
            c.save(update_fields=list(set(fields)))
        return Response(_credit_row(c))

    def delete(self, request, pk):
        if not _is_admin(request):
            return Response({"detail": "Admin only."}, status=drf_status.HTTP_403_FORBIDDEN)
        from .models import DiscountCredit
        deleted, _ = DiscountCredit.objects.filter(pk=pk).delete()
        if not deleted:
            return Response({"detail": "Credit not found."}, status=drf_status.HTTP_404_NOT_FOUND)
        return Response(status=drf_status.HTTP_204_NO_CONTENT)
