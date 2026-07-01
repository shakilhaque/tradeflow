"""
Accounting URL routes — mounted at /api/accounting/ in config/urls.py.
"""
from django.urls import path

from .views import (
    AccountDetailView,
    AccountListCreateView,
    BalanceSheetView,
    BalanceSummaryView,
    CashFlowLedgerView,
    CashFlowView,
    ExpenseCategoryDetailView,
    ExpenseCategoryListCreateView,
    ExpenseListCreateView,
    ExpenseDetailView,
    ExpensePaymentListView,
    ExpensePaymentDetailView,
    JournalEntryListCreateView,
    LedgerView,
    PaymentAccountDepositView,
    PaymentAccountDetailView,
    PaymentAccountListCreateView,
    PaymentAccountReportView,
    PaymentAccountTransactionsView,
    PaymentAccountTransferView,
    PaymentLinkView,
    ProfitLossBreakdownView,
    ProfitLossSummaryView,
    ProfitLossView,
    TrialBalanceView,
    # Branch-aware reports (added with the multi-branch CoA refactor).
    BranchPnLView,
    BranchContributionView,
    CashReconciliationView,
    GlobalAccountBalanceView,
)

app_name = "accounting"

urlpatterns = [
    # Chart of accounts
    path("accounts/",          AccountListCreateView.as_view(), name="account-list"),
    path("accounts/<uuid:pk>/", AccountDetailView.as_view(),   name="account-detail"),

    # Journal entries
    path("journal-entries/",   JournalEntryListCreateView.as_view(), name="je-list"),

    # Expenses
    path("expenses/",                ExpenseListCreateView.as_view(), name="expense-list"),
    path("expenses/<uuid:pk>/",      ExpenseDetailView.as_view(),     name="expense-detail"),
    path("expenses/payments/<uuid:pk>/", ExpensePaymentDetailView.as_view(), name="expense-payment-detail"),
    path("expenses/<uuid:pk>/payments/", ExpensePaymentListView.as_view(),   name="expense-payments"),

    # Expense categories (master data)
    path("expense-categories/",          ExpenseCategoryListCreateView.as_view(), name="expense-category-list"),
    path("expense-categories/<uuid:pk>/", ExpenseCategoryDetailView.as_view(),    name="expense-category-detail"),

    # Payment accounts (Cash / Bank / MFS)
    path("payment-accounts/",                       PaymentAccountListCreateView.as_view(),    name="payment-account-list"),
    path("payment-accounts/<uuid:pk>/",             PaymentAccountDetailView.as_view(),        name="payment-account-detail"),
    path("payment-accounts/<uuid:pk>/transactions/", PaymentAccountTransactionsView.as_view(), name="payment-account-transactions"),
    path("payment-accounts/<uuid:pk>/deposit/",      PaymentAccountDepositView.as_view(),      name="payment-account-deposit"),
    path("payment-account-transfers/",               PaymentAccountTransferView.as_view(),     name="payment-account-transfer"),

    # Merchant balance summary (Payment Accounts → Balance Sheet)
    path("balance-summary/",           BalanceSummaryView.as_view(),           name="balance-summary"),

    # Cash flow ledger (Payment Accounts → Cash Flow)
    path("cash-flow-ledger/",          CashFlowLedgerView.as_view(),           name="cash-flow-ledger"),

    # Payment account report + link
    path("payment-account-report/",      PaymentAccountReportView.as_view(), name="payment-account-report"),
    path("payment-account-report/link/", PaymentLinkView.as_view(),          name="payment-account-link"),

    # Merchant Profit / Loss Report
    path("profit-loss-summary/",         ProfitLossSummaryView.as_view(),    name="profit-loss-summary"),
    path("profit-loss-breakdown/",       ProfitLossBreakdownView.as_view(),  name="profit-loss-breakdown"),

    # Reports
    path("ledger/",            LedgerView.as_view(),       name="ledger"),
    path("trial-balance/",     TrialBalanceView.as_view(), name="trial-balance"),
    path("profit-loss/",       ProfitLossView.as_view(),   name="profit-loss"),
    path("balance-sheet/",     BalanceSheetView.as_view(), name="balance-sheet"),
    path("cash-flow/",         CashFlowView.as_view(),     name="cash-flow"),

    # ── Branch-aware reports ─────────────────────────────────────────────
    path("reports/branch/pnl/",                  BranchPnLView.as_view(),            name="branch-pnl"),
    path("reports/branch/contribution/",         BranchContributionView.as_view(),   name="branch-contribution"),
    path("reports/branch/cash-reconciliation/",  CashReconciliationView.as_view(),   name="branch-cash-recon"),
    path("reports/global-account-balance/",      GlobalAccountBalanceView.as_view(), name="global-account-balance"),
]
