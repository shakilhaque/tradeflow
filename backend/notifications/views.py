"""
Notification views — in-app notifications for the authenticated user.

Endpoints
─────────
  GET  /api/notifications/           — list own in-app notifications
  GET  /api/notifications/unread-count/ — unread count (for badge)
  POST /api/notifications/<id>/read/ — mark one notification as READ
  POST /api/notifications/read-all/  — mark all unread notifications as READ
"""

import logging

from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiTypes
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.tenant_db import get_current_db_alias
from .services import get_user_notifications, mark_notification_read, get_unread_count


def _current_db() -> str:
    return get_current_db_alias() or "default"

logger = logging.getLogger(__name__)


def _serialize_notification(n) -> dict:
    return {
        "id":           str(n.pk),
        "event_type":   n.event_type,
        "subject":      n.subject,
        "body":         n.body,
        "status":       n.status,
        "created_at":   n.created_at.isoformat(),
        "read_at":      n.read_at.isoformat() if n.read_at else None,
        "related_type": n.related_type,
        "related_id":   str(n.related_id) if n.related_id else None,
    }


@extend_schema(tags=["Notifications"])
class NotificationListView(APIView):
    """
    GET /api/notifications/?unread_only=1&limit=50

    Returns the authenticated user's in-app notifications.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List notifications",
        description=(
            "Returns the authenticated user's in-app notifications, newest first. "
            "Pass `unread_only=true` to show only unread items. Results are capped at 200."
        ),
        parameters=[
            OpenApiParameter("unread_only", OpenApiTypes.BOOL, required=False, description='Pass "true" or "1" to return only unread notifications'),
            OpenApiParameter("limit",       OpenApiTypes.INT,  required=False, description="Max results (default 50, max 200)"),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        unread_only = request.query_params.get("unread_only") in ("1", "true", "True")
        try:
            limit = min(int(request.query_params.get("limit", 50)), 200)
        except (ValueError, TypeError):
            limit = 50

        notifications = get_user_notifications(
            user_id=request.user.pk,
            limit=limit,
            unread_only=unread_only,
        )
        return Response([_serialize_notification(n) for n in notifications])


@extend_schema(tags=["Notifications"])
class NotificationUnreadCountView(APIView):
    """
    GET /api/notifications/unread-count/

    Returns {"count": N} — used by frontend badge.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Unread notification count",
        description="Returns the number of unread in-app notifications for the authenticated user. Useful for driving a notification badge in the UI.",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        count = get_unread_count(request.user.pk)
        return Response({"count": count})


@extend_schema(tags=["Notifications"])
class NotificationMarkReadView(APIView):
    """
    POST /api/notifications/<notification_id>/read/

    Mark a single in-app notification as READ.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Mark notification as read",
        description="Mark a single in-app notification as READ. The notification must belong to the authenticated user.",
        responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    def post(self, request, notification_id):
        success = mark_notification_read(
            notification_id=notification_id,
            user_id=request.user.pk,
        )
        if not success:
            return Response({"detail": "Notification not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"detail": "Marked as read."})


@extend_schema(tags=["Notifications"])
class NotificationMarkAllReadView(APIView):
    """
    POST /api/notifications/read-all/

    Mark ALL unread in-app notifications for the user as READ.
    """
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Mark all notifications as read",
        description="Mark ALL unread in-app notifications for the authenticated user as READ in one call. Returns the count of notifications updated.",
        responses={200: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        from .models import Notification
        from django.utils import timezone
        db = _current_db()

        updated = Notification.objects.using(db).filter(
            recipient_id=request.user.pk,
            channel="IN_APP",
            status=Notification.Status.SENT,
        ).update(
            status=Notification.Status.READ,
            read_at=timezone.now(),
        )
        return Response({"marked_read": updated})
