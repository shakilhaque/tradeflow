"""
Support ticket system — service layer (master DB).

SLA targets, serialization, ticket-number generation, event/audit logging and
lightweight notifications (in-app unread flags + best-effort email). Shared by
the tenant and admin support views.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db.models import Count
from django.utils import timezone

from .models import SupportTicket, SupportTicketEvent

logger = logging.getLogger(__name__)

# SLA targets in HOURS per priority: (first_response, resolution).
SLA_HOURS = {
    "urgent": (1, 8),
    "high":   (4, 24),
    "medium": (8, 48),
    "low":    (24, 96),
}
OPEN_STATUSES = ("open", "pending", "in_progress")


# ── ticket number ───────────────────────────────────────────────────────────

def next_ticket_number() -> str:
    n = SupportTicket.objects.count() + 1
    # Make it collision-resistant under light concurrency.
    while SupportTicket.objects.filter(ticket_number=f"TKT-{n:06d}").exists():
        n += 1
    return f"TKT-{n:06d}"


# ── events / audit ──────────────────────────────────────────────────────────

def log_event(ticket, action, *, actor=None, role="", from_value="", to_value="", note=""):
    try:
        SupportTicketEvent.objects.create(
            ticket=ticket, action=action,
            from_value=str(from_value or ""), to_value=str(to_value or ""), note=note or "",
            actor=getattr(actor, "id", None), actor_email=getattr(actor, "email", "") or "",
            actor_role=role or "",
        )
    except Exception:
        logger.exception("Failed to log support event (%s)", action)


# ── notifications (in-app unread + best-effort email) ───────────────────────

def notify(ticket, kind, *, by_role):
    """Flag the *other* side as having unread activity. `by_role` is who acted."""
    if by_role == "tenant":
        ticket.admin_unread = True
    else:
        ticket.tenant_unread = True
    # Email is best-effort and must never break the request.
    try:
        _email_notification(ticket, kind, by_role)
    except Exception:
        logger.debug("support email notification skipped for %s", ticket.ticket_number)


def _email_notification(ticket, kind, by_role):
    from django.conf import settings
    from django.core.mail import send_mail

    app = getattr(settings, "APP_NAME", "Support")
    support_email = getattr(settings, "SUPPORT_EMAIL", settings.DEFAULT_FROM_EMAIL)
    subj_map = {
        "new_ticket": f"[{app}] New ticket {ticket.ticket_number}: {ticket.subject}",
        "new_reply":  f"[{app}] New reply on {ticket.ticket_number}",
        "status":     f"[{app}] Ticket {ticket.ticket_number} status updated",
        "assigned":   f"[{app}] Ticket {ticket.ticket_number} assigned",
        "resolved":   f"[{app}] Ticket {ticket.ticket_number} resolved",
    }
    subject = subj_map.get(kind, f"[{app}] Ticket {ticket.ticket_number} update")
    if by_role == "tenant":
        to = [support_email]                       # tenant acted → notify support
    else:
        to = [ticket.user.email] if ticket.user and ticket.user.email else []
    if not to:
        return
    send_mail(subject, f"Ticket {ticket.ticket_number}: {ticket.subject}\nStatus: {ticket.get_status_display()}",
              settings.DEFAULT_FROM_EMAIL, to, fail_silently=True)


# ── SLA ─────────────────────────────────────────────────────────────────────

def compute_sla(t) -> dict:
    fr_h, res_h = SLA_HOURS.get(t.priority, SLA_HOURS["medium"])
    response_due = t.created_at + timedelta(hours=fr_h)
    resolution_due = t.created_at + timedelta(hours=res_h)
    now = timezone.now()

    if t.first_response_at:
        fr_breached = t.first_response_at > response_due
    else:
        fr_breached = t.status in OPEN_STATUSES and now > response_due

    resolved_when = t.resolved_at or t.closed_at
    if resolved_when:
        res_breached = resolved_when > resolution_due
    else:
        res_breached = t.status in OPEN_STATUSES and now > resolution_due

    return {
        "response_due":      response_due.isoformat(),
        "resolution_due":    resolution_due.isoformat(),
        "first_response_breached": fr_breached,
        "resolution_breached":     res_breached,
        "overdue":           res_breached,
    }


def _company(user):
    return (getattr(user, "business_name", "") or getattr(user, "name", "") or getattr(user, "email", "")) if user else "—"


# ── serialization ───────────────────────────────────────────────────────────

def serialize_row(t) -> dict:
    sla = compute_sla(t)
    return {
        "id":             str(t.id),
        "ticket_number":  t.ticket_number,
        "subject":        t.subject,
        "tenant_name":    getattr(t.user, "name", "") or getattr(t.user, "email", ""),
        "company_name":   _company(t.user),
        "category":       t.category,
        "category_label": t.get_category_display(),
        "priority":       t.priority,
        "status":         t.status,
        "status_label":   t.get_status_display(),
        "assigned_to":    (t.assigned_to.name or t.assigned_to.email) if t.assigned_to else None,
        "assigned_to_id": str(t.assigned_to_id) if t.assigned_to_id else None,
        "overdue":        sla["overdue"],
        "admin_unread":   t.admin_unread,
        "tenant_unread":  t.tenant_unread,
        "created_at":     t.created_at.isoformat(),
        "updated_at":     t.last_activity_at.isoformat(),
    }


def _attachments(qs, request=None):
    # Hand back a short-lived SIGNED link, not the raw /media URL — support
    # attachments can be sensitive and must not be guessable/public. The link
    # is only minted here, while serialising a ticket the caller is already
    # authorised to view. See SupportAttachmentDownloadView.
    from django.core import signing
    from django.urls import reverse

    out = []
    for a in qs:
        url = ""
        if a.file:
            sig = signing.dumps(str(a.id), salt="support-attachment")
            url = f"{reverse('accounts:support-attachment', kwargs={'pk': a.id})}?sig={sig}"
            if request is not None:
                url = request.build_absolute_uri(url)
        out.append({"id": str(a.id), "name": a.name or (a.file.name.split("/")[-1] if a.file else ""),
                    "url": url, "created_at": a.created_at.isoformat()})
    return out


def serialize_detail(t, *, include_internal=False, request=None) -> dict:
    row = serialize_row(t)
    msgs = t.messages.select_related("author").prefetch_related("attachments").all()
    if not include_internal:
        msgs = [m for m in msgs if not m.is_internal]
    messages = [{
        "id": str(m.id),
        "author_name": (m.author.name or m.author.email) if m.author else "System",
        "author_role": m.author_role,
        "body": m.body,
        "is_internal": m.is_internal,
        "attachments": _attachments(m.attachments.all(), request),
        "created_at": m.created_at.isoformat(),
    } for m in msgs]

    events = [{
        "id": str(e.id), "action": e.action, "from": e.from_value, "to": e.to_value,
        "note": e.note, "by": e.actor_email or "system", "role": e.actor_role,
        "at": e.created_at.isoformat(),
    } for e in t.events.all()]

    row.update({
        "messages":     messages,
        "events":       events,
        "attachments":  _attachments(t.attachments.filter(message__isnull=True), request),
        "sla":          compute_sla(t),
        "satisfaction": t.satisfaction,
        "merged_into":  t.merged_into.ticket_number if t.merged_into_id else None,
        "tenant": {
            "name":  getattr(t.user, "name", ""),
            "email": getattr(t.user, "email", ""),
            "phone": getattr(t.user, "phone", ""),
            "company": _company(t.user),
        },
    })
    return row


# ── KPIs / analytics ────────────────────────────────────────────────────────

def kpis(qs=None) -> dict:
    qs = qs if qs is not None else SupportTicket.objects.all()
    by_status = dict(qs.values_list("status").annotate(c=Count("id")))
    return {
        "total":       qs.count(),
        "open":        by_status.get("open", 0),
        "pending":     by_status.get("pending", 0),
        "in_progress": by_status.get("in_progress", 0),
        "resolved":    by_status.get("resolved", 0),
        "closed":      by_status.get("closed", 0),
        "high_priority": qs.filter(priority__in=["high", "urgent"]).count(),
    }
