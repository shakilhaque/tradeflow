"""
URL routes — accounts (single-client build): auth, profile, branches,
and tenant user/role management. No SaaS billing / subscription / OTP /
platform-admin endpoints.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .profile_views import MeView, MeAvatarView
from .branch_views import MyBranchesView, BranchAssignmentsView, AssignBranchesView
from .user_management_views import TenantRoleViewSet, TenantUserViewSet
from .views import (
    UsernameAvailabilityView,
    LoginView,
    LogoutView,
    TokenRefreshView,
)

app_name = "accounts"

# DRF router for user + role CRUD (staff management within the business).
_user_router = DefaultRouter(trailing_slash=True)
_user_router.register("users", TenantUserViewSet, basename="tenant-user")
_user_router.register("roles", TenantRoleViewSet, basename="tenant-role")

urlpatterns = [
    # User + role management
    path("", include(_user_router.urls)),

    # ── Multi-branch (data isolation) ───────────────────────────────────────
    path("branches/my/",          MyBranchesView.as_view(),         name="branches-my"),
    path("branches/assignments/", BranchAssignmentsView.as_view(),  name="branch-assignments"),
    path("branches/assign/",      AssignBranchesView.as_view(),     name="branch-assign"),

    # ── Auth ────────────────────────────────────────────────────────────────
    path("auth/me/",             MeView.as_view(),                name="auth-me"),
    path("auth/me/avatar/",      MeAvatarView.as_view(),          name="auth-me-avatar"),
    path("auth/check-username/", UsernameAvailabilityView.as_view(), name="auth-check-username"),
    path("auth/login/",          LoginView.as_view(),             name="login"),
    path("auth/logout/",         LogoutView.as_view(),            name="logout"),
    path("auth/token/refresh/",  TokenRefreshView.as_view(),      name="token-refresh"),
]
