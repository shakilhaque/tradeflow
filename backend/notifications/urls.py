from django.urls import path
from . import views

app_name = "notifications"

urlpatterns = [
    path("", views.NotificationListView.as_view(), name="list"),
    path("unread-count/", views.NotificationUnreadCountView.as_view(), name="unread-count"),
    path("read-all/", views.NotificationMarkAllReadView.as_view(), name="read-all"),
    path("<uuid:notification_id>/read/", views.NotificationMarkReadView.as_view(), name="mark-read"),
]
