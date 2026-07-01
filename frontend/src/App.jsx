import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider }  from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { LanguageProvider } from './context/LanguageContext'
import { BranchProvider } from './context/BranchContext'
import ProtectedRoute    from './components/ProtectedRoute'
import AppLayout         from './components/layout/AppLayout'

// Auth
import LoginPage         from './pages/LoginPage'

import { ToastHost } from './lib/toast.jsx'
import { GlobalLoadingBar } from './lib/loading.jsx'

// Protected pages — Core
import DashboardPage     from './pages/DashboardPage'
import ProductsPage      from './pages/products/ProductsPage'
import ProductsListPage  from './pages/products/ProductsListPage'
import ProductStockHistoryPage from './pages/products/ProductStockHistoryPage'
import AddProductPage    from './pages/products/AddProductPage'
import EditProductPage   from './pages/products/EditProductPage'
import PrintLabelsPage   from './pages/products/PrintLabelsPage'
import ImportProductsPage from './pages/products/ImportProductsPage'
import ImportStockPage   from './pages/products/ImportStockPage'
import ImportOpeningStockPage from './pages/products/ImportOpeningStockPage'
import UnitsPage         from './pages/products/UnitsPage'
import CategoriesPage    from './pages/products/CategoriesPage'
import BrandsPage        from './pages/products/BrandsPage'
import WarrantiesPage    from './pages/products/WarrantiesPage'
import StockPage         from './pages/inventory/StockPage'
import StockTransfersListPage from './pages/inventory/StockTransfersListPage'
import AddStockTransferPage   from './pages/inventory/AddStockTransferPage'
import SalesPage         from './pages/sales/SalesPage'
import AllSalesPage      from './pages/sales/AllSalesPage'
import SaleDetailPage    from './pages/sales/SaleDetailPage'
import AddSalePage       from './pages/sales/AddSalePage'
import POSPage           from './pages/sales/POSPage'
import POSSalesListPage  from './pages/sales/POSSalesListPage'
import DraftSalesPage    from './pages/sales/DraftSalesPage'
import QuotationSalesPage from './pages/sales/QuotationSalesPage'
import SellReturnsPage   from './pages/sales/SellReturnsPage'
import NewSaleReturnPage from './pages/sales/NewSaleReturnPage'
import SaleReturnDetailPage from './pages/sales/SaleReturnDetailPage'
import ImportSalesPage   from './pages/sales/ImportSalesPage'
import ShipmentsPage     from './pages/sales/ShipmentsPage'
import DiscountsPage     from './pages/sales/DiscountsPage'
import PurchasesPage     from './pages/purchases/PurchasesPage'
import PurchasesListPage from './pages/purchases/PurchasesListPage'
import AddPurchasePage   from './pages/purchases/AddPurchasePage'
import PurchaseReturnsPage from './pages/purchases/PurchaseReturnsPage'
import AddPurchaseReturnPage from './pages/purchases/AddPurchaseReturnPage'

// Protected pages — Accounting
import ExpensesPage      from './pages/accounting/ExpensesPage'
import ExpensesListPage  from './pages/accounting/ExpensesListPage'
import AddExpensePage    from './pages/accounting/AddExpensePage'
import ExpenseCategoriesPage from './pages/accounting/ExpenseCategoriesPage'
import PaymentAccountsPage   from './pages/accounting/PaymentAccountsPage'
import BalanceSheetPage      from './pages/accounting/BalanceSheetPage'
import TrialBalancePage      from './pages/accounting/TrialBalancePage'
import CashFlowPage          from './pages/accounting/CashFlowPage'
import PaymentAccountReportPage from './pages/accounting/PaymentAccountReportPage'
import JournalPage       from './pages/accounting/JournalPage'
import AccountsPage      from './pages/accounting/AccountsPage'

// Protected pages — Reports
import SalesReportPage   from './pages/reports/SalesReportPage'
import BranchComparisonReportPage from './pages/reports/BranchComparisonReportPage'
import BranchDashboardPage from './pages/reports/BranchDashboardPage'
import ProfitLossReportPage from './pages/reports/ProfitLossReportPage'
import StockReportPage   from './pages/reports/StockReportPage'
import ExpenseReportPage from './pages/reports/ExpenseReportPage'
import TaxReportPage     from './pages/reports/TaxReportPage'
import ProductReportPage from './pages/reports/ProductReportPage'
import ServiceStaffReportPage from './pages/reports/ServiceStaffReportPage'
import SalesRepresentativeReportPage from './pages/reports/SalesRepresentativeReportPage'
import RegisterReportPage from './pages/reports/RegisterReportPage'
import SellPaymentReportPage from './pages/reports/SellPaymentReportPage'
import PurchasePaymentReportPage from './pages/reports/PurchasePaymentReportPage'
import PurchaseSaleReportPage from './pages/reports/PurchaseSaleReportPage'
import ContactsReportPage from './pages/reports/ContactsReportPage'
import ActivityLogPage from './pages/reports/ActivityLogPage'

// Protected pages — Contacts & Users
import CustomersPage from './pages/contacts/CustomersPage'
import CustomerLedgerPage from './pages/contacts/CustomerLedgerPage'
import CustomerGroupsPage from './pages/contacts/CustomerGroupsPage'
import ImportContactsPage from './pages/contacts/ImportContactsPage'
import SuppliersPage from './pages/contacts/SuppliersPage'
import ImportSuppliersPage from './pages/contacts/ImportSuppliersPage'
import UsersPage from './pages/users/UsersPage'
import RolesPage from './pages/users/RolesPage'
import AddRolePage from './pages/users/AddRolePage'

// Protected pages — Settings
import SettingsPage      from './pages/settings/SettingsPage'
import BusinessSettingsPage from './pages/settings/BusinessSettingsPage'
import BusinessLocationsPage from './pages/settings/BusinessLocationsPage'
import CompanyProfilePage  from './pages/settings/CompanyProfilePage'

/**
 * Convenience wrapper — every protected page gets the shared AppLayout.
 */
function Protected({ children, requiredRoles }) {
  return (
    <ProtectedRoute requiredRoles={requiredRoles}>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <BranchProvider>
        <SettingsProvider>
        <LanguageProvider>
        <GlobalLoadingBar />
        <ToastHost />
        <Routes>
          {/* ── Auth ─────────────────────────────────────────────────────── */}
          <Route path="/login" element={<LoginPage />} />

          {/* ── Dashboard ────────────────────────────────────────────────── */}
          <Route path="/dashboard" element={<Protected><DashboardPage /></Protected>} />

          {/* ── Sales & POS ───────────────────────────────────────────────── */}
          <Route path="/sells"        element={<Protected><AllSalesPage /></Protected>} />
          <Route path="/sales"        element={<Protected><SalesPage /></Protected>} />
          <Route path="/sales/drafts" element={<Protected><DraftSalesPage /></Protected>} />
          <Route path="/sales/quotations" element={<Protected><QuotationSalesPage /></Protected>} />
          <Route path="/sales/returns"      element={<Protected><SellReturnsPage /></Protected>} />
          <Route path="/sales/returns/new"  element={<Protected><NewSaleReturnPage /></Protected>} />
          <Route path="/sales/returns/:id"  element={<Protected><SaleReturnDetailPage /></Protected>} />
          <Route path="/sales/import"       element={<Protected><ImportSalesPage /></Protected>} />
          <Route path="/sales/shipments" element={<Protected><ShipmentsPage /></Protected>} />
          <Route path="/sales/discounts" element={<Protected><DiscountsPage /></Protected>} />
          <Route path="/sales/pos"      element={<Protected><POSPage /></Protected>} />
          <Route path="/sales/pos-list" element={<Protected><POSSalesListPage /></Protected>} />
          <Route path="/sales/add"    element={<Protected><AddSalePage /></Protected>} />
          <Route path="/sales/add-draft" element={<Protected><AddSalePage /></Protected>} />
          <Route path="/sales/add-quotation" element={<Protected><AddSalePage /></Protected>} />
          <Route path="/sales/:id"    element={<Protected><SaleDetailPage /></Protected>} />

          {/* ── Contacts & Users ─────────────────────────────────────────── */}
          <Route path="/contacts/customers" element={<Protected><CustomersPage /></Protected>} />
          <Route path="/contacts/customers/:id/ledger" element={<Protected><CustomerLedgerPage /></Protected>} />
          <Route path="/contacts/customer-groups" element={<Protected><CustomerGroupsPage /></Protected>} />
          <Route path="/contacts/import"          element={<Protected><ImportContactsPage /></Protected>} />
          <Route path="/users"                    element={<Protected><UsersPage /></Protected>} />
          <Route path="/roles"                    element={<Protected><RolesPage /></Protected>} />
          <Route path="/roles/new"                element={<Protected><AddRolePage /></Protected>} />
          <Route path="/roles/:id/edit"           element={<Protected><AddRolePage /></Protected>} />
          <Route path="/contacts/suppliers"        element={<Protected><SuppliersPage /></Protected>} />
          <Route path="/contacts/suppliers/import" element={<Protected><ImportSuppliersPage /></Protected>} />
          <Route path="/customers"          element={<Protected><CustomersPage /></Protected>} />
          <Route path="/customers/*"        element={<Navigate to="/contacts/customers" replace />} />
          <Route path="/suppliers"          element={<Navigate to="/contacts/suppliers" replace />} />

          {/* ── Products ─────────────────────────────────────────────────── */}
          <Route path="/products"               element={<Protected><ProductsListPage /></Protected>} />
          <Route path="/products/new"           element={<Protected><AddProductPage /></Protected>} />
          <Route path="/products/print-labels"  element={<Protected><PrintLabelsPage /></Protected>} />
          <Route path="/products/:id/stock-history" element={<Protected><ProductStockHistoryPage /></Protected>} />
          <Route path="/products/import"        element={<Protected><ImportProductsPage /></Protected>} />
          <Route path="/products/import-stock"          element={<Protected><ImportStockPage /></Protected>} />
          <Route path="/products/import-opening-stock"  element={<Protected><ImportOpeningStockPage /></Protected>} />
          <Route path="/products/units"         element={<Protected><UnitsPage /></Protected>} />
          <Route path="/products/categories"    element={<Protected><CategoriesPage /></Protected>} />
          <Route path="/products/brands"        element={<Protected><BrandsPage /></Protected>} />
          <Route path="/products/warranties"    element={<Protected><WarrantiesPage /></Protected>} />
          <Route path="/products/:id/edit"      element={<Protected><EditProductPage /></Protected>} />
          <Route path="/products/:id"           element={<Protected><EditProductPage /></Protected>} />

          {/* ── Inventory ────────────────────────────────────────────────── */}
          <Route path="/inventory/products"  element={<Protected><ProductsPage /></Protected>} />
          <Route path="/inventory/stock"             element={<Protected><StockPage /></Protected>} />
          <Route path="/inventory/stock-transfers"     element={<Protected><StockTransfersListPage /></Protected>} />
          <Route path="/inventory/stock-transfers/add" element={<Protected><AddStockTransferPage /></Protected>} />
          <Route path="/inventory/*"         element={<Protected><StockPage /></Protected>} />

          {/* ── Purchases ────────────────────────────────────────────────── */}
          <Route path="/purchases"         element={<Protected><PurchasesListPage /></Protected>} />
          <Route path="/purchases/list"    element={<Protected><PurchasesListPage /></Protected>} />
          <Route path="/purchases/add"     element={<Protected><AddPurchasePage /></Protected>} />
          <Route path="/purchases/returns"     element={<Protected><PurchaseReturnsPage /></Protected>} />
          <Route path="/purchases/returns/add" element={<Protected><AddPurchaseReturnPage /></Protected>} />
          <Route path="/purchases/legacy"  element={<Protected><PurchasesPage /></Protected>} />
          <Route path="/purchases/*"  element={<Protected><PurchasesPage /></Protected>} />

          {/* ── Accounting ────────────────────────────────────────────────── */}
          <Route path="/accounting"           element={<Navigate to="/accounting/expenses" replace />} />
          <Route path="/accounting/expenses"      element={<Protected><ExpensesListPage /></Protected>} />
          <Route path="/accounting/expenses/add"        element={<Protected><AddExpensePage /></Protected>} />
          <Route path="/accounting/expenses/categories" element={<Protected><ExpenseCategoriesPage /></Protected>} />
          <Route path="/accounting/payment-accounts"    element={<Protected><PaymentAccountsPage /></Protected>} />
          <Route path="/accounting/balance-sheet"       element={<Protected><BalanceSheetPage /></Protected>} />
          <Route path="/accounting/trial-balance"       element={<Protected><TrialBalancePage /></Protected>} />
          <Route path="/accounting/cash-flow"            element={<Protected><CashFlowPage /></Protected>} />
          <Route path="/accounting/payment-account-report" element={<Protected><PaymentAccountReportPage /></Protected>} />
          <Route path="/accounting/journal"   element={<Protected><JournalPage /></Protected>} />
          <Route path="/accounting/accounts"  element={<Protected><AccountsPage /></Protected>} />
          <Route path="/accounting/*"         element={<Navigate to="/accounting/expenses" replace />} />

          {/* ── Reports ───────────────────────────────────────────────────── */}
          <Route path="/reports"              element={<Navigate to="/reports/sales" replace />} />
          <Route path="/reports/sales"        element={<Protected><SalesReportPage /></Protected>} />
          <Route path="/reports/branch-comparison" element={<Protected><BranchComparisonReportPage /></Protected>} />
          <Route path="/reports/branch-dashboard" element={<Protected><BranchDashboardPage /></Protected>} />
          <Route path="/reports/profit-loss"  element={<Protected><ProfitLossReportPage /></Protected>} />
          <Route path="/reports/stock"        element={<Protected><StockReportPage /></Protected>} />
          <Route path="/reports/expenses"     element={<Protected><ExpenseReportPage /></Protected>} />
          <Route path="/reports/tax"          element={<Protected><TaxReportPage /></Protected>} />
          <Route path="/reports/products"     element={<Protected><ProductReportPage /></Protected>} />
          <Route path="/reports/service-staff" element={<Protected><ServiceStaffReportPage /></Protected>} />
          <Route path="/reports/sales-representative" element={<Protected><SalesRepresentativeReportPage /></Protected>} />
          <Route path="/reports/register"     element={<Protected><RegisterReportPage /></Protected>} />
          <Route path="/reports/sell-payment" element={<Protected><SellPaymentReportPage /></Protected>} />
          <Route path="/reports/purchase-payment" element={<Protected><PurchasePaymentReportPage /></Protected>} />
          <Route path="/reports/purchase-sale" element={<Protected><PurchaseSaleReportPage /></Protected>} />
          <Route path="/reports/contacts"      element={<Protected><ContactsReportPage /></Protected>} />
          <Route path="/reports/activity-log"  element={<Protected><ActivityLogPage /></Protected>} />
          <Route path="/reports/*"            element={<Navigate to="/reports/sales" replace />} />

          {/* ── Settings ──────────────────────────────────────────────────── */}
          <Route path="/settings"                  element={<Protected><SettingsPage /></Protected>} />
          <Route path="/settings/business"         element={<Protected><BusinessSettingsPage /></Protected>} />
          <Route path="/settings/locations"        element={<Protected><BusinessLocationsPage /></Protected>} />
          <Route path="/settings/company-profile"  element={<Protected><CompanyProfilePage /></Protected>} />
          <Route path="/settings/*"                element={<Navigate to="/settings" replace />} />

          {/* Defaults */}
          <Route path="/"  element={<Navigate to="/dashboard" replace />} />
          <Route path="*"  element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </LanguageProvider>
        </SettingsProvider>
        </BranchProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
