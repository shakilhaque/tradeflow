"""
Support ticket system — API views (master DB).

Tenant endpoints (any authenticated tenant user) under /api/support/tickets/.
Admin endpoints (is_staff / is_superuser) under /api/admin/support/.
"""
import logging

from django.db.models import Q, Count, Avg, F, DurationField, ExpressionWrapper
from django.db.models.functions import TruncMonth
from django.utils import timezone
from django.core import signing
from django.http import FileResponse
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from .models import SupportTicket, SupportTicketMessage, SupportTicketAttachment, User
from . import support_service as svc

logger = logging.getLogger(__name__)

# Salt for the time-limited signed download links minted in support_service._attachments.
ATTACHMENT_SALT = "support-attachment"


def _is_admin(u) -> bool:
    return bool(u and (u.is_staff or u.is_superuser))


class SupportAttachmentDownloadView(APIView):
    """Serve a ticket attachment via a short-lived signed link.

    Support attachments can contain sensitive data, so the raw /media URL must
    not be public. Instead, `support_service._attachments` mints a signed,
    1-hour link (only when serialising a ticket the caller is authorised to
    see); this view verifies that signature and streams the file as an
    attachment. No bearer header is needed, so plain <a>/<img> tags work.
    """
    permission_classes = [AllowAny]   # gated by the HMAC signature, not a token

    def get(self, request, pk):
        sig = request.query_params.get("sig", "")
        try:
            signed_id = signing.loads(sig, salt=ATTACHMENT_SALT, max_age=3600)
        except signing.BadSignature:
            return Response({"detail": "This link is invalid or has expired."},
                            status=http.HTTP_403_FORBIDDEN)
        if str(signed_id) != str(pk):
            return Response({"detail": "This link is invalid."}, status=http.HTTP_403_FORBIDDEN)

        try:
            att = SupportTicketAttachment.objects.get(id=pk)
        except SupportTicketAttachment.DoesNotExist:
            return Response({"detail": "Not found."}, status=http.HTTP_404_NOT_FOUND)
        if not att.file:
            return Response({"detail": "No file."}, status=http.HTTP_404_NOT_FOUND)

        filename = att.name or att.file.name.split("/")[-1]
        resp = FileResponse(att.file.open("rb"), as_attachment=True, filename=filename)
        resp["X-Content-Type-Options"] = "nosniff"
        return resp


def _save_attachments(ticket, message, files, uploader):
    for f in files:
        SupportTicketAttachment.objects.create(
            ticket=ticket, message=message, file=f, name=getattr(f, "name", "")[:255], uploaded_by=uploader,
        )


def _add_message(ticket, *, author, role, body, files, is_internal=False):
    msg = SupportTicketMessage.objects.create(
        ticket=ticket, author=author, author_role=role, body=body or "", is_internal=is_internal,
    )
    if files:
        _save_attachments(ticket, msg, files, author)
    return msg


# ──────────────────────────────────────────────────────────────────────────────
# Tenant endpoints
# ──────────────────────────────────────────────────────────────────────────────

class TenantTicketsView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get(self, request):
        qs = SupportTicket.objects.filter(user=request.user).select_related("assigned_to", "user")
        if st := (request.query_params.get("status") or "").strip():
            qs = qs.filter(status=st)
        return Response({"results": [svc.serialize_row(t) for t in qs], "kpis": svc.kpis(qs)})

    def post(self, request):
        data = request.data
        subject = (data.get("subject") or "").strip()
        body    = (data.get("description") or data.get("body") or "").strip()
        category = (data.get("category") or "general").strip()
        priority = (data.get("priority") or "medium").strip()
        if not subject:
            return Response({"detail": "Subject is required."}, status=http.HTTP_400_BAD_REQUEST)
        if category not in dict(SupportTicket.Category.choices):
            category = "general"
        if priority not in dict(SupportTicket.Priority.choices):
            priority = "medium"

        ticket = SupportTicket.objects.create(
            ticket_number=svc.next_ticket_number(), user=request.user, subject=subject,
            category=category, priority=priority, status=SupportTicket.Status.OPEN,
            admin_unread=True, last_activity_at=timezone.now(),
        )
        _add_message(ticket, author=request.user, role="tenant", body=body,
                     files=request.FILES.getlist("attachments"))
        svc.log_event(ticket, "created", actor=request.user, role="tenant", note=subject)
        svc.notify(ticket, "new_ticket", by_role="tenant")
        ticket.save(update_fields=["admin_unread", "tenant_unread"])
        return Response(svc.serialize_detail(ticket, request=request), status=http.HTTP_201_CREATED)


class TenantTicketDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            t = SupportTicket.objects.select_related("user", "assigned_to").get(id=pk, user=request.user)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)
        if t.tenant_unread:
            t.tenant_unread = False
            t.save(update_fields=["tenant_unread"])
        return Response(svc.serialize_detail(t, include_internal=False, request=request))


class TenantTicketReplyView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request, pk):
        try:
            t = SupportTicket.objects.get(id=pk, user=request.user)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)
        if t.status == SupportTicket.Status.CLOSED:
            return Response({"detail": "This ticket is closed. Reopen it from support to reply."}, status=http.HTTP_400_BAD_REQUEST)
        body = (request.data.get("body") or "").strip()
        files = request.FILES.getlist("attachments")
        if not body and not files:
            return Response({"detail": "Write a message or attach a file."}, status=http.HTTP_400_BAD_REQUEST)
        _add_message(t, author=request.user, role="tenant", body=body, files=files)
        # Tenant reply re-opens a resolved ticket.
        if t.status == SupportTicket.Status.RESOLVED:
            t.status = SupportTicket.Status.IN_PROGRESS
        t.last_activity_at = timezone.now()
        svc.log_event(t, "reply", actor=request.user, role="tenant")
        svc.notify(t, "new_reply", by_role="tenant")
        t.save()
        return Response(svc.serialize_detail(t, request=request))


class TenantTicketCloseView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        try:
            t = SupportTicket.objects.get(id=pk, user=request.user)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)
        rating = request.data.get("satisfaction")
        if rating not in (None, ""):
            try:
                r = int(rating)
                if 1 <= r <= 5:
                    t.satisfaction = r
            except (TypeError, ValueError):
                pass
        t.status = SupportTicket.Status.CLOSED
        t.closed_at = timezone.now()
        t.last_activity_at = timezone.now()
        svc.log_event(t, "closed", actor=request.user, role="tenant", note="Closed by tenant")
        t.save()
        return Response(svc.serialize_detail(t, request=request))


# ──────────────────────────────────────────────────────────────────────────────
# Admin endpoints
# ──────────────────────────────────────────────────────────────────────────────

def _is_support_member(u) -> bool:
    """Support team = superusers OR sub-admins granted the 'support'
    section. These are the only users who may work the admin ticket
    queue and the only ones tickets can be assigned to."""
    from .admin_perms import admin_has_perm
    return bool(u and admin_has_perm(u, "support"))


class _AdminBase(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        # Platform-admin AND a member of the support team (super admin or a
        # sub-admin with the 'support' permission). This is the role-based
        # gate for the support module.
        if not _is_admin(request.user) or not _is_support_member(request.user):
            return Response({"detail": "Support-team access required."}, status=http.HTTP_403_FORBIDDEN)
        return None


_SORT = {
    "created_at": "created_at", "updated_at": "last_activity_at", "priority": "priority",
    "status": "status", "subject": "subject",
}


class AdminTicketsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        p = request.query_params
        qs = SupportTicket.objects.select_related("user", "assigned_to")

        if search := (p.get("search") or "").strip():
            qs = qs.filter(
                Q(ticket_number__icontains=search) | Q(subject__icontains=search)
                | Q(user__name__icontains=search) | Q(user__email__icontains=search)
                | Q(user__business_name__icontains=search)
            )
        flt = (p.get("filter") or "all").lower()
        if flt in dict(SupportTicket.Status.choices):
            qs = qs.filter(status=flt)
        elif flt in dict(SupportTicket.Priority.choices):
            qs = qs.filter(priority=flt)
        elif flt == "overdue":
            pass  # filtered in python below
        if cat := (p.get("category") or "").strip():
            qs = qs.filter(category=cat)
        if assignee := (p.get("assigned_to") or "").strip():
            qs = qs.filter(assigned_to_id=assignee)

        kpis = svc.kpis(SupportTicket.objects.all())

        sort_by = (p.get("sort_by") or "updated_at").lower()
        sort_dir = (p.get("sort_dir") or "desc").lower()
        field = _SORT.get(sort_by, "last_activity_at")
        qs = qs.order_by(f"-{field}" if sort_dir == "desc" else field)

        rows = [svc.serialize_row(t) for t in qs]
        if flt == "overdue":
            rows = [r for r in rows if r["overdue"]]

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
        offset = (page - 1) * limit
        return Response({
            "results": rows[offset:offset + limit], "count": total, "page": page,
            "limit": limit, "total_pages": total_pages, "kpis": kpis,
        })


class AdminTicketDetailView(_AdminBase):
    def get(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            t = SupportTicket.objects.select_related("user", "assigned_to").get(id=pk)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)
        if t.admin_unread:
            t.admin_unread = False
            t.save(update_fields=["admin_unread"])
        return Response(svc.serialize_detail(t, include_internal=True, request=request))


class AdminTicketReplyView(_AdminBase):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            t = SupportTicket.objects.get(id=pk)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)
        body = (request.data.get("body") or "").strip()
        is_internal = str(request.data.get("is_internal") or "").lower() in ("1", "true", "yes", "on")
        files = request.FILES.getlist("attachments")
        if not body and not files:
            return Response({"detail": "Write a message or attach a file."}, status=http.HTTP_400_BAD_REQUEST)
        _add_message(t, author=request.user, role="admin", body=body, files=files, is_internal=is_internal)
        if not is_internal:
            if not t.first_response_at:
                t.first_response_at = timezone.now()
            if t.status == SupportTicket.Status.OPEN:
                t.status = SupportTicket.Status.IN_PROGRESS
            svc.notify(t, "new_reply", by_role="admin")
        t.last_activity_at = timezone.now()
        svc.log_event(t, "note" if is_internal else "reply", actor=request.user, role="admin")
        t.save()
        return Response(svc.serialize_detail(t, include_internal=True, request=request))


class AdminTicketActionView(_AdminBase):
    def post(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            t = SupportTicket.objects.select_related("user", "assigned_to").get(id=pk)
        except SupportTicket.DoesNotExist:
            return Response({"detail": "Ticket not found."}, status=http.HTTP_404_NOT_FOUND)

        data = request.data or {}
        action = (data.get("action") or "").strip().lower()
        actor = request.user

        if action == "assign":
            aid = data.get("assigned_to")
            if not aid:
                t.assigned_to = None
            else:
                try:
                    agent = User.objects.get(id=aid)
                except User.DoesNotExist:
                    return Response({"detail": "Agent not found."}, status=http.HTTP_400_BAD_REQUEST)
                if not _is_support_member(agent):
                    return Response({"detail": "Tickets can only be assigned to the support team."},
                                    status=http.HTTP_400_BAD_REQUEST)
                t.assigned_to = agent
            if t.status == SupportTicket.Status.OPEN:
                t.status = SupportTicket.Status.IN_PROGRESS
            svc.log_event(t, "assigned", actor=actor, role="admin",
                          to_value=(t.assigned_to.email if t.assigned_to else "unassigned"))
            svc.notify(t, "assigned", by_role="admin")

        elif action == "change_status":
            new = (data.get("status") or "").strip()
            if new not in dict(SupportTicket.Status.choices):
                return Response({"detail": "Invalid status."}, status=http.HTTP_400_BAD_REQUEST)
            old = t.status
            t.status = new
            if new == SupportTicket.Status.RESOLVED and not t.resolved_at:
                t.resolved_at = timezone.now()
                svc.notify(t, "resolved", by_role="admin")
            if new == SupportTicket.Status.CLOSED and not t.closed_at:
                t.closed_at = timezone.now()
            svc.log_event(t, "status", actor=actor, role="admin", from_value=old, to_value=new)

        elif action == "change_priority":
            new = (data.get("priority") or "").strip()
            if new not in dict(SupportTicket.Priority.choices):
                return Response({"detail": "Invalid priority."}, status=http.HTTP_400_BAD_REQUEST)
            old = t.priority
            t.priority = new
            svc.log_event(t, "priority", actor=actor, role="admin", from_value=old, to_value=new)

        elif action == "close":
            t.status = SupportTicket.Status.CLOSED
            t.closed_at = t.closed_at or timezone.now()
            svc.log_event(t, "closed", actor=actor, role="admin")

        elif action == "reopen":
            t.status = SupportTicket.Status.OPEN
            t.resolved_at = None
            t.closed_at = None
            svc.log_event(t, "reopened", actor=actor, role="admin")
            svc.notify(t, "status", by_role="admin")

        elif action == "merge":
            target = (data.get("target_ticket") or "").strip()
            try:
                other = SupportTicket.objects.get(Q(id=target) | Q(ticket_number=target))
            except (SupportTicket.DoesNotExist, ValueError):
                return Response({"detail": "Target ticket not found."}, status=http.HTTP_400_BAD_REQUEST)
            if other.id == t.id:
                return Response({"detail": "Cannot merge a ticket into itself."}, status=http.HTTP_400_BAD_REQUEST)
            t.merged_into = other
            t.status = SupportTicket.Status.CLOSED
            t.closed_at = timezone.now()
            svc.log_event(t, "merged", actor=actor, role="admin", to_value=other.ticket_number)

        else:
            return Response({"detail": f"Unknown action '{action}'."}, status=http.HTTP_400_BAD_REQUEST)

        t.last_activity_at = timezone.now()
        t.save()
        return Response(svc.serialize_detail(t, include_internal=True, request=request))


class AdminSupportAgentsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        # Only the support team is assignable — superusers + sub-admins
        # granted the 'support' section.
        agents = [
            a for a in User.objects.filter(Q(is_staff=True) | Q(is_superuser=True)).order_by("name")
            if _is_support_member(a)
        ]
        return Response({"results": [
            {"id": str(a.id), "name": a.name or a.email, "email": a.email} for a in agents
        ]})


class AdminSupportAnalyticsView(_AdminBase):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = SupportTicket.objects.all()

        by_category = [
            {"label": dict(SupportTicket.Category.choices).get(r["category"], r["category"]), "value": r["c"]}
            for r in qs.values("category").annotate(c=Count("id")).order_by("-c")
        ]
        by_status = [
            {"label": dict(SupportTicket.Status.choices).get(r["status"], r["status"]), "value": r["c"]}
            for r in qs.values("status").annotate(c=Count("id")).order_by("-c")
        ]

        # Avg resolution time (hours) for resolved/closed tickets.
        resolved = qs.filter(resolved_at__isnull=False).annotate(
            dur=ExpressionWrapper(F("resolved_at") - F("created_at"), output_field=DurationField())
        )
        avg_dur = resolved.aggregate(a=Avg("dur"))["a"]
        avg_resolution_hours = round(avg_dur.total_seconds() / 3600, 1) if avg_dur else 0.0

        # Agent performance — resolved count per assignee.
        agent_rows = (
            qs.filter(assigned_to__isnull=False)
            .values("assigned_to__name", "assigned_to__email")
            .annotate(total=Count("id"), resolved=Count("id", filter=Q(status__in=["resolved", "closed"])))
            .order_by("-total")[:10]
        )
        agent_performance = [
            {"label": r["assigned_to__name"] or r["assigned_to__email"], "total": r["total"], "resolved": r["resolved"]}
            for r in agent_rows
        ]

        # CSAT.
        csat_vals = list(qs.filter(satisfaction__isnull=False).values_list("satisfaction", flat=True))
        csat_avg = round(sum(csat_vals) / len(csat_vals), 2) if csat_vals else None

        # Monthly trend (created per month, last 12).
        from datetime import date
        today = timezone.localdate()
        month_start = date(today.year - 1, today.month, 1)
        mon_rows = (
            qs.filter(created_at__date__gte=month_start)
            .annotate(m=TruncMonth("created_at")).values("m")
            .annotate(c=Count("id")).order_by("m")
        )
        monthly_trend = [{"label": r["m"].strftime("%b %Y"), "value": r["c"]} for r in mon_rows if r["m"]]

        return Response({
            "by_category": by_category,
            "by_status": by_status,
            "avg_resolution_hours": avg_resolution_hours,
            "agent_performance": agent_performance,
            "csat_average": csat_avg,
            "csat_responses": len(csat_vals),
            "monthly_trend": monthly_trend,
        })
