"""
URL routes — accounts & subscription system.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter
from .profile_views import MeView, MeAvatarView
from .branch_views import MyBranchesView, BranchAssignmentsView, AssignBranchesView
from .analytics_views import AdminAnalyticsView
from .revenue_analytics_views import AdminRevenueAnalyticsView
from .payment_admin_views import (
    AdminPaymentsView,
    AdminPaymentDetailView,
    AdminPaymentActionView,
    AdminPaymentAnalyticsView,
    AdminPaymentAuditView,
    AdminPaymentGatewaysView,
    AdminPaymentGatewayTestView,
)
from .support_views import (
    TenantTicketsView, TenantTicketDetailView, TenantTicketReplyView, TenantTicketCloseView,
    AdminTicketsView, AdminTicketDetailView, AdminTicketReplyView, AdminTicketActionView,
    AdminSupportAgentsView, AdminSupportAnalyticsView, SupportAttachmentDownloadView,
)
from .coupon_admin_views import (
    AdminCouponsView, AdminCouponDetailView, AdminCouponActionView,
    AdminCouponAnalyticsView, AdminCouponAuditView,
    AdminCampaignsView, AdminCampaignDetailView, CouponValidateView,
)
from .cms_views import (
    CmsPublicView, CmsPublicItemView,
    AdminCmsBlocksView, AdminCmsItemsView, AdminCmsItemDetailView, AdminCmsReorderView,
    AdminCmsMediaView, AdminCmsMediaDetailView, AdminCmsAuditView,
)
from .subscription_admin_views import (
    AdminSubscriptionsView,
    AdminSubscriptionPlansView,
    AdminSubscriptionDetailView,
    AdminSubscriptionActionView,
)
from .tenant_admin_views import (
    AdminTenantsView,
    AdminTenantPlansView,
    AdminTenantDetailView,
    AdminTenantActionView,
)
from .otp_views import OtpLoginView, OtpResendView, ForgotPasswordView
from .sms_admin_views import (
    AdminSmsGatewayView, AdminSmsGatewayTestView, AdminSmsGatewayBalanceView,
)
from .referral_views import (
    MyReferralsView, AdminReferralsView,
    AdminReferralDetailView, AdminReferralCreditDetailView,
)
from .user_management_views import TenantRoleViewSet, TenantUserViewSet
from .tenant_users_admin import (
    TenantUsersListView, TenantUsersAnalyticsView,
    TenantUserDetailView, TenantUserActionView,
)
from .views import (
    # Public
    PlanListView,
    UsernameAvailabilityView,
    SubscribeView,
    TrialSignupView,
    PaymentWebhookView,
    PaymentStatusView,
    PaymentReturnView,
    SetPasswordView,
    ResendSetupLinkView,
    # Auth
    LoginView,
    AdminLoginView,
    LogoutView,
    TokenRefreshView,
    # Authenticated (billing — accessible even when suspended)
    PayNowView,
    BillingStatusView,
    PaymentHistoryView,
    AdminOverviewView,
    AdminClientsInfoView,
    AdminUsersView,
    AdminUserDetailView,
    AdminPermissionCatalogView,
    PlatformNoticeViewSet,
    TenantActiveNoticesView,
    MarqueeNoticeView,
    AdminBulkSmsExportView,
    AdminBulkSmsSendView,
    SupportInfoView,
    PublicSupportInfoView,
    AdminSupportInfoView,
    AdminCancelPaymentView,
    AdminProvisionTenantView,
    AdminDeleteClientView,
    BillingSummaryView,
)

app_name = "accounts"

# DRF router for tenant-side user CRUD
_user_router = DefaultRouter(trailing_slash=True)
_user_router.register("users", TenantUserViewSet, basename="tenant-user")
_user_router.register("roles", TenantRoleViewSet, basename="tenant-role")

# Platform-admin notice CRUD (master DB; admin-only via view's check_permissions).
_notice_router = DefaultRouter(trailing_slash=True)
_notice_router.register("admin/notices", PlatformNoticeViewSet, basename="platform-notice")

# Platform-admin subscription-plan CRUD + clone / toggle / subscribers / usage.
from .plan_admin_views import AdminPlanViewSet  # noqa: E402
_plan_router = DefaultRouter(trailing_slash=True)
_plan_router.register("admin/plans", AdminPlanViewSet, basename="admin-plan")

urlpatterns = [
    # Tenant user management
    path("", include(_user_router.urls)),
    path("", include(_plan_router.urls)),

    # Platform-admin notice board CRUD
    path("", include(_notice_router.urls)),

    # Tenant-facing reads
    # ── Multi-branch (data isolation) ───────────────────────────────────────
    path("branches/my/",          MyBranchesView.as_view(),         name="branches-my"),
    path("branches/assignments/", BranchAssignmentsView.as_view(),  name="branch-assignments"),
    path("branches/assign/",      AssignBranchesView.as_view(),     name="branch-assign"),

    path("notices/active/",  TenantActiveNoticesView.as_view(), name="notices-active"),
    path("notices/marquee/", MarqueeNoticeView.as_view(),       name="notices-marquee"),
    path("support/",         SupportInfoView.as_view(),         name="support-info"),
    path("public/support/",  PublicSupportInfoView.as_view(),   name="public-support-info"),

    # ── Support tickets — tenant portal ─────────────────────────────────────
    path("support/tickets/",                  TenantTicketsView.as_view(),      name="support-tickets"),
    path("support/tickets/<uuid:pk>/",        TenantTicketDetailView.as_view(), name="support-ticket-detail"),
    path("support/tickets/<uuid:pk>/reply/",  TenantTicketReplyView.as_view(),  name="support-ticket-reply"),
    path("support/tickets/<uuid:pk>/close/",  TenantTicketCloseView.as_view(),  name="support-ticket-close"),
    path("support/attachments/<uuid:pk>/",    SupportAttachmentDownloadView.as_view(), name="support-attachment"),

    # ── Support tickets — super-admin ───────────────────────────────────────
    path("admin/support/tickets/",                 AdminTicketsView.as_view(),         name="admin-support-tickets"),
    path("admin/support/agents/",                  AdminSupportAgentsView.as_view(),   name="admin-support-agents"),
    path("admin/support/analytics/",               AdminSupportAnalyticsView.as_view(), name="admin-support-analytics"),
    path("admin/support/tickets/<uuid:pk>/",       AdminTicketDetailView.as_view(),    name="admin-support-ticket-detail"),
    path("admin/support/tickets/<uuid:pk>/reply/", AdminTicketReplyView.as_view(),     name="admin-support-ticket-reply"),
    path("admin/support/tickets/<uuid:pk>/actions/", AdminTicketActionView.as_view(),  name="admin-support-ticket-action"),

    # ── Coupons & promotions — super-admin ──────────────────────────────────
    path("coupons/validate/",                  CouponValidateView.as_view(),       name="coupon-validate"),
    path("admin/coupons/",                     AdminCouponsView.as_view(),         name="admin-coupons"),
    path("admin/coupons/analytics/",           AdminCouponAnalyticsView.as_view(), name="admin-coupon-analytics"),
    path("admin/coupons/audit/",               AdminCouponAuditView.as_view(),     name="admin-coupon-audit"),
    path("admin/coupons/<uuid:pk>/",           AdminCouponDetailView.as_view(),    name="admin-coupon-detail"),
    path("admin/coupons/<uuid:pk>/actions/",   AdminCouponActionView.as_view(),    name="admin-coupon-action"),
    path("admin/campaigns/",                   AdminCampaignsView.as_view(),       name="admin-campaigns"),
    path("admin/campaigns/<uuid:pk>/",         AdminCampaignDetailView.as_view(),  name="admin-campaign-detail"),

    # ── Website CMS ─────────────────────────────────────────────────────────
    path("cms/public/",                        CmsPublicView.as_view(),            name="cms-public"),
    path("cms/public/<str:collection>/<str:slug>/", CmsPublicItemView.as_view(),   name="cms-public-item"),
    path("admin/cms/blocks/",                  AdminCmsBlocksView.as_view(),       name="admin-cms-blocks"),
    path("admin/cms/items/",                   AdminCmsItemsView.as_view(),        name="admin-cms-items"),
    path("admin/cms/items/reorder/",           AdminCmsReorderView.as_view(),      name="admin-cms-reorder"),
    path("admin/cms/items/<uuid:pk>/",         AdminCmsItemDetailView.as_view(),   name="admin-cms-item-detail"),
    path("admin/cms/media/",                   AdminCmsMediaView.as_view(),        name="admin-cms-media"),
    path("admin/cms/media/<uuid:pk>/",         AdminCmsMediaDetailView.as_view(),  name="admin-cms-media-detail"),
    path("admin/cms/audit/",                   AdminCmsAuditView.as_view(),        name="admin-cms-audit"),
    path("admin/support-info/", AdminSupportInfoView.as_view(), name="admin-support-info"),

    # Platform-admin bulk SMS — export tenant phones + broadcast SMS
    path("admin/bulk-sms/export/", AdminBulkSmsExportView.as_view(), name="bulk-sms-export"),
    path("admin/bulk-sms/send/",   AdminBulkSmsSendView.as_view(),   name="bulk-sms-send"),

    # Platform-admin SMS Gateway settings (SSL Wireless)
    path("admin/sms-gateway/",         AdminSmsGatewayView.as_view(),        name="admin-sms-gateway"),
    path("admin/sms-gateway/test/",    AdminSmsGatewayTestView.as_view(),    name="admin-sms-gateway-test"),
    path("admin/sms-gateway/balance/", AdminSmsGatewayBalanceView.as_view(), name="admin-sms-gateway-balance"),

    # Platform-admin Tenant Users module — cross-tenant user directory
    path("admin/tenant-users/",           TenantUsersListView.as_view(),      name="admin-tenant-users"),
    path("admin/tenant-users/analytics/", TenantUsersAnalyticsView.as_view(), name="admin-tenant-users-analytics"),
    path("admin/tenant-users/<uuid:pk>/",          TenantUserDetailView.as_view(), name="admin-tenant-user-detail"),
    path("admin/tenant-users/<uuid:pk>/actions/",  TenantUserActionView.as_view(), name="admin-tenant-user-action"),

    # ── Public plan catalogue ──────────────────────────────────────────────
    path("plans/",                  PlanListView.as_view(),        name="plan-list"),

    # ── Subscription purchase ──────────────────────────────────────────────
    path("subscribe/",              SubscribeView.as_view(),        name="subscribe"),
    path("signup-trial/",           TrialSignupView.as_view(),      name="signup-trial"),
    path("payment/webhook/",        PaymentWebhookView.as_view(),   name="payment-webhook"),
    path("payment/return/",         PaymentReturnView.as_view(),    name="payment-return"),
    path(
        "payment/status/<str:transaction_id>/",
        PaymentStatusView.as_view(),
        name="payment-status",
    ),

    # ── Password setup ─────────────────────────────────────────────────────
    path("set-password/",           SetPasswordView.as_view(),      name="set-password"),
    path("resend-setup-link/",      ResendSetupLinkView.as_view(),  name="resend-setup-link"),

    # ── JWT auth ───────────────────────────────────────────────────────────
    path("auth/me/",                MeView.as_view(),               name="auth-me"),
    path("auth/me/avatar/",         MeAvatarView.as_view(),         name="auth-me-avatar"),
    path("me/referrals/",           MyReferralsView.as_view(),      name="me-referrals"),
    path("admin/referrals/",        AdminReferralsView.as_view(),   name="admin-referrals"),
    path("admin/referrals/<uuid:pk>/", AdminReferralDetailView.as_view(), name="admin-referral-detail"),
    path("admin/referral-credits/<uuid:pk>/", AdminReferralCreditDetailView.as_view(), name="admin-referral-credit"),
    path("auth/check-username/",    UsernameAvailabilityView.as_view(), name="auth-check-username"),
    path("auth/login-otp/",         OtpLoginView.as_view(),         name="auth-otp-login"),
    path("auth/resend-otp/",        OtpResendView.as_view(),        name="auth-otp-resend"),
    path("auth/forgot-password/",   ForgotPasswordView.as_view(),   name="auth-forgot-password"),
    path("auth/login/",             LoginView.as_view(),            name="login"),
    path("auth/admin/login/",       AdminLoginView.as_view(),       name="admin-login"),
    path("auth/token/refresh/",     TokenRefreshView.as_view(),     name="token-refresh"),
    path("auth/logout/",            LogoutView.as_view(),           name="logout"),

    # ── Billing (accessible while suspended) ──────────────────────────────
    path("pay-now/",                PayNowView.as_view(),           name="pay-now"),
    path("billing/status/",         BillingStatusView.as_view(),    name="billing-status"),
    path("billing/summary/",        BillingSummaryView.as_view(),   name="billing-summary"),
    path("billing/history/",        PaymentHistoryView.as_view(),   name="billing-history"),
    path("admin/overview/",         AdminOverviewView.as_view(),    name="admin-overview"),
    path("admin/clients-info/",     AdminClientsInfoView.as_view(), name="admin-clients-info"),
    path("admin/analytics/",        AdminAnalyticsView.as_view(),   name="admin-analytics"),
    path("admin/revenue-analytics/", AdminRevenueAnalyticsView.as_view(), name="admin-revenue-analytics"),

    # ── Payment Management (super-admin) ────────────────────────────────────
    path("admin/payments/",                    AdminPaymentsView.as_view(),      name="admin-payments"),
    path("admin/payments/analytics/",          AdminPaymentAnalyticsView.as_view(), name="admin-payment-analytics"),
    path("admin/payments/audit/",              AdminPaymentAuditView.as_view(),  name="admin-payment-audit"),
    path("admin/payment-gateways/",            AdminPaymentGatewaysView.as_view(), name="admin-payment-gateways"),
    path("admin/payment-gateways/<str:code>/test/", AdminPaymentGatewayTestView.as_view(), name="admin-payment-gateway-test"),
    path("admin/payments/<uuid:pk>/",          AdminPaymentDetailView.as_view(), name="admin-payment-detail"),
    path("admin/payments/<uuid:pk>/actions/",  AdminPaymentActionView.as_view(), name="admin-payment-action"),
    path("admin/users/",            AdminUsersView.as_view(),       name="admin-users"),
    path("admin/users/<uuid:pk>/",  AdminUserDetailView.as_view(),  name="admin-user-detail"),
    path("admin/permissions/",      AdminPermissionCatalogView.as_view(), name="admin-permission-catalog"),
    path(
        "admin/payments/<uuid:pk>/cancel/",
        AdminCancelPaymentView.as_view(),
        name="admin-cancel-payment",
    ),
    path(
        "admin/tenants/<uuid:user_id>/provision/",
        AdminProvisionTenantView.as_view(),
        name="admin-provision-tenant",
    ),
    path(
        "admin/clients/<uuid:user_id>/",
        AdminDeleteClientView.as_view(),
        name="admin-delete-client",
    ),

    # ── Subscription Management (Super-Admin) ──────────────────────────
    path("admin/subscriptions/",              AdminSubscriptionsView.as_view(),      name="admin-subscriptions"),
    path("admin/subscriptions/plans/",        AdminSubscriptionPlansView.as_view(),  name="admin-subscription-plans"),
    path("admin/subscriptions/<uuid:pk>/",    AdminSubscriptionDetailView.as_view(), name="admin-subscription-detail"),
    path("admin/subscriptions/<uuid:pk>/actions/", AdminSubscriptionActionView.as_view(), name="admin-subscription-action"),

    # ── Tenant Management (super-admin) ─────────────────────────────────────
    path("admin/tenants/",                       AdminTenantsView.as_view(),      name="admin-tenants"),
    path("admin/tenants/plans/",                 AdminTenantPlansView.as_view(),  name="admin-tenant-plans"),
    path("admin/tenants/<uuid:user_id>/",        AdminTenantDetailView.as_view(), name="admin-tenant-detail"),
    path("admin/tenants/<uuid:user_id>/actions/", AdminTenantActionView.as_view(), name="admin-tenant-action"),
]
