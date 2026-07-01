import { client, apiCall } from './client'

/**
 * Sales report
 * params: { date_from, date_to, location_id, user_id, product_id, group_by }
 * group_by: 'day' | 'week' | 'month' | 'product' | 'user'
 */
export const getSalesReport = (params) =>
  apiCall(() => client.get('/api/reports/sales/', { params }))

/**
 * Stock report
 * params: { location_id, category_id, low_stock_only }
 */
export const getStockReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/stock/', { params }))

/**
 * Branch comparison (consolidated, owner-only).
 * params: { date_from, date_to }. Per-branch sales/purchases/expenses/profit
 * plus a consolidated total.
 */
export const getBranchComparison = (params = {}) =>
  apiCall(() => client.get('/api/reports/branch-comparison/', { params }))

/**
 * All-branches dashboard (owner + branch managers). Per-branch KPI snapshot
 * for every branch the caller administers, plus a consolidated total.
 * params: { date_from, date_to } — defaults to the current month server-side.
 */
export const getBranchDashboard = (params = {}) =>
  apiCall(() => client.get('/api/reports/branch-dashboard/', { params }))

/**
 * Expense report
 * params: { date_from, date_to, category, user_id, location_id }
 */
export const getExpenseReport = (params) =>
  apiCall(() => client.get('/api/reports/expenses/', { params }))

/**
 * Tax report — returns Input / Output / Expense tax rows in one round-trip.
 * params: { date_from, date_to, location_id }
 */
export const getTaxReport = (params) =>
  apiCall(() => client.get('/api/reports/tax/', { params }))

/**
 * Product performance report
 * params: { date_from, date_to, location_id, category_id, limit }
 */
export const getProductReport = (params) =>
  apiCall(() => client.get('/api/reports/products/', { params }))

/**
 * Service-staff report
 * params: { mode: 'orders' | 'lines', date_from, date_to,
 *           location_id, staff_id, search, page, limit }
 */
export const getServiceStaffReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/service-staff/', { params }))

/**
 * Sales representative report
 * params: { mode: 'added' | 'commission' | 'expenses', user_id, location_id,
 *           date_from, date_to, commission_percent, search, page, limit }
 */
export const getSalesRepresentativeReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/sales-representative/', { params }))

/**
 * Register report — cashier × day × location sessions with per-method totals.
 * params: { user_id, location_id, status, date_from, date_to, page, limit }
 */
export const getRegisterReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/register/', { params }))

/**
 * Register Details — modal-style synthesised session for
 * (request.user × location_id × date). Powers the "Register Details"
 * button on the POS top bar.
 * params: { location_id?, date? (YYYY-MM-DD, defaults to today), user_id? }
 */
export const getRegisterDetails = (params = {}) =>
  apiCall(() => client.get('/api/reports/register/details/', { params }))

/**
 * Close the current register. Server snapshots expected totals from
 * SalePayment since the last closure for this cashier × location,
 * stores the counted totals + closing note, and writes a
 * RegisterClosure row. Subsequent Register Details calls reset to
 * zero until new payments come in.
 */
export const closeRegister = (payload) =>
  apiCall(() => client.post('/api/reports/register/close/', payload))

/**
 * Sell payment report — one row per SalePayment instalment.
 * params: { customer_id, location_id, method, date_from, date_to,
 *           search, page, limit }
 */
export const getSellPaymentReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/sell-payment/', { params }))

/**
 * Purchase payment report — one row per PurchasePayment instalment.
 * params: { supplier_id, location_id, method, date_from, date_to,
 *           search, page, limit }
 */
export const getPurchasePaymentReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/purchase-payment/', { params }))

/**
 * Product purchase report — one row per PurchaseItem.
 * params: { search, supplier_id, location_id, date_from, date_to, page, limit }
 */
export const getProductPurchaseReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/product-purchases/', { params }))

/**
 * Purchase & Sale combined summary.
 * params: { location_id, date_from, date_to }
 */
export const getPurchaseSaleReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/purchase-sale/', { params }))

/**
 * Customers & Suppliers ledger report.
 * params: { type: 'all' | 'customer' | 'supplier', search, page, limit }
 */
export const getContactsReport = (params = {}) =>
  apiCall(() => client.get('/api/reports/contacts/', { params }))

/**
 * Activity log / audit trail.
 * params: { action, module, user_id, date_from, date_to, limit, offset }
 */
export const getActivityLog = (params = {}) =>
  apiCall(() => client.get('/api/audit-logs/', { params }))
