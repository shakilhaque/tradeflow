import { client, apiCall } from './client'

async function listWithFallback(primaryPath, fallbackPath, params = {}, mergeFallbackParams = {}) {
  try {
    return await apiCall(() => client.get(primaryPath, { params }))
  } catch (err) {
    const isRouteIssue = err?.status === 404 || err?.status === 405
    if (!isRouteIssue || !fallbackPath) throw err
    return apiCall(() => client.get(fallbackPath, { params: { ...params, ...mergeFallbackParams } }))
  }
}

// ── Sales lifecycle ───────────────────────────────────────────────────────────

/**
 * List sales
 * params:
 * {
 *   page, limit, search,
 *   location_id, customer_id, payment_status,
 *   date_from, date_to, user_id, service_staff,
 *   shipping_status, source, subscription,
 *   sort_by, sort_dir
 * }
 *
 * Returns:
 * {
 *   results: SaleRow[],
 *   count, page, limit, total_pages,
 *   summary: { total_sales_amount, total_paid, total_due }
 * }
 */
export const getSales = (params = {}) =>
  listWithFallback('/api/sales/all-sales/', '/api/sales/sales/', params)

/** Dedicated list API for Drafts page */
export const getDraftSales = (params = {}) =>
  listWithFallback('/api/sales/drafts/', '/api/sales/sales/', params, { status: 'DRAFT' })

/** Dedicated list API for Sales List POS page */
export const getPosSales = (params = {}) =>
  listWithFallback('/api/sales/pos-sales/', '/api/sales/sales/', params, { source: 'POS' })

/** Dedicated list API for Quotations page */
export const getQuotationSales = (params = {}) =>
  listWithFallback('/api/sales/quotations/', '/api/sales/sales/', params, { status: 'QUOTATION' })

/** Dedicated list API for Sell Return page */
export const getSellReturns = (params = {}) =>
  listWithFallback('/api/sales/sell-returns/', '/api/sales/sales/', params, { status: 'VOIDED' })

/** Get full sell-return detail */
export const getSellReturn = (id) =>
  apiCall(() => client.get(`/api/sales/sell-returns/${id}/`))

/**
 * Create a sell return (credit note)
 * body: { parent_sale_id, location_id, items:[{product_id, quantity, unit_price, reason}],
 *          return_date?, refund_method?, refunded_amount?, restocking_fee?, notes? }
 */
export const createSellReturn = (data) =>
  apiCall(() => client.post('/api/sales/sell-returns/create/', data))

/** Delete a credit note (hard delete; stock stays restocked). */
export const deleteSellReturn = (id) =>
  apiCall(() => client.delete(`/api/sales/sell-returns/${id}/`))

/** Update a credit note's per-line quantities and header discount.
 *  body: { items: [{id, quantity}, ...], discount_type, discount_value } */
export const updateSellReturn = (id, data) =>
  apiCall(() => client.patch(`/api/sales/sell-returns/${id}/`, data))

/** Record an additional refund payment on a credit note.
 *  body: { amount, method?, reference?, payment_account_id?, notes? } */
export const refundSellReturn = (id, data) =>
  apiCall(() => client.post(`/api/sales/sell-returns/${id}/refund/`, data))

/** Dedicated list API for Shipments page */
export const getShipments = (params = {}) =>
  listWithFallback('/api/sales/shipments/', '/api/sales/sales/', params)

/** Discounts */
export const getDiscounts = (params = {}) =>
  apiCall(() => client.get('/api/sales/discounts/', { params }))

export const createDiscount = (data) =>
  apiCall(() => client.post('/api/sales/discounts/', data))

export const deactivateDiscounts = (ids) =>
  apiCall(() => client.post('/api/sales/discounts/deactivate/', { ids }))

/** Get full sale detail */
export const getSale = (id) =>
  apiCall(() => client.get(`/api/sales/sales/${id}/`))

/**
 * Create a new sale (DRAFT or QUOTATION)
 * body: { location_id, items:[{product_id, quantity, unit_price, item_discount}],
 *          status, customer_id, discount, tax_rate, notes, supervisor_password }
 */
// Sale create/finalize suppress the generic "Saved" toast — the POS / Add
// Sale pages fire a sale-specific "Sale recorded · Invoice #… saved." toast
// instead (with the real invoice number).
export const createSale = (data) =>
  apiCall(() => client.post('/api/sales/sales/', data, { _silentToast: true }))

/**
 * Advanced Add Sale endpoint (draft/final + payment + shipping + expenses)
 */
export const createAdvancedSale = (data) =>
  apiCall(() => client.post('/api/sales/create/', data, { _silentToast: true }))

/**
 * Update editable sale (DRAFT / QUOTATION only)
 */
export const updateSale = (id, data) =>
  apiCall(() => client.patch(`/api/sales/sales/${id}/`, data))

/**
 * Update shipping fields on a sale of ANY status (incl. FINAL).
 * Body: { shipping_details, shipping_address, shipping_status,
 *         delivered_to, shipping_charges, shipping_note,
 *         shipping_documents }
 */
export const updateSaleShipping = (id, data) =>
  apiCall(() => client.patch(`/api/sales/sales/${id}/shipping/`, data))

/**
 * Edit journal-safe header fields on a sale of ANY status (incl. FINAL):
 * customer_id, sale_date, notes, sell_note, staff_note.
 * Money/stock fields are NOT editable here — use updateSale (editable
 * statuses) or a Sell Return / Void instead.
 */
export const updateSaleHeader = (id, data) =>
  apiCall(() => client.patch(`/api/sales/sales/${id}/header/`, data))

/** Delete editable sale (DRAFT/QUOTATION) */
export const deleteSale = (id) =>
  apiCall(() => client.delete(`/api/sales/sales/${id}/`))

/**
 * Finalize a DRAFT sale — deducts FIFO stock
 * body: { supervisor_password? }
 */
export const finalizeSale = (id, data = {}) =>
  apiCall(() => client.post(`/api/sales/sales/${id}/finalize/`, data, { _silentToast: true }))

/**
 * Record a payment instalment
 * body: { amount, method, reference?, notes? }
 */
export const addPayment = (id, data) =>
  apiCall(() => client.post(`/api/sales/sales/${id}/payments/`, data))

/**
 * Void a finalized sale (admin/owner only)
 * body: { reason }
 */
export const voidSale = (id, data) =>
  apiCall(() => client.post(`/api/sales/sales/${id}/void/`, data))

/**
 * Create a back-order from a sale
 * body: { items:[{product_id, quantity}], notes? }
 */
export const createBackOrder = (id, data) =>
  apiCall(() => client.post(`/api/sales/sales/${id}/backorder/`, data))

// ── Reports ───────────────────────────────────────────────────────────────────

/**
 * Product Sell Report
 * params: { mode, search, customer_id, location_id, category_id, brand_id,
 *           date_from, date_to, time_from, time_to, page, limit }
 * modes: detailed | detailed_purchase | grouped | by_category | by_brand
 */
export const getProductSellReport = (params = {}) =>
  apiCall(() => client.get('/api/sales/product-sell-report/', { params }))

// ── Customers ─────────────────────────────────────────────────────────────────

/**
 * List customers
 * params: { search, active_only }
 */
export const getCustomers = (params = {}) =>
  apiCall(() => client.get('/api/sales/customers/', { params }))

export const getCustomer = (id) =>
  apiCall(() => client.get(`/api/sales/customers/${id}/`))

/**
 * Live credit snapshot — credit_limit, current_due, available_credit,
 * plus flags `is_credit_eligible` and `would_exceed_limit`.
 * Used by the POS Credit Sale button + the inline due indicator that
 * appears as soon as a registered customer is selected.
 */
export const getCustomerCreditSummary = (id) =>
  apiCall(() => client.get(`/api/sales/customers/${id}/credit-summary/`))

/**
 * Record a payment from a customer (Customers page → Pay). Settles dues
 * oldest-first; overflow is added to the customer's advance balance.
 * payload: { amount, method, payment_account_id?, note? }
 */
export const payCustomer = (id, payload) =>
  apiCall(() => client.post(`/api/sales/customers/${id}/pay/`, payload))

export const createCustomer = (data) =>
  apiCall(() => client.post('/api/sales/customers/', data))

export const updateCustomer = (id, data) =>
  apiCall(() => client.patch(`/api/sales/customers/${id}/`, data))

export const deleteCustomer = (id) =>
  apiCall(() => client.delete(`/api/sales/customers/${id}/`))

// ── Customer Groups ──────────────────────────────────────────────────────────

export const getCustomerGroups = (params = {}) =>
  apiCall(() => client.get('/api/sales/customer-groups/', { params }))

export const createCustomerGroup = (data) =>
  apiCall(() => client.post('/api/sales/customer-groups/', data))

export const updateCustomerGroup = (id, data) =>
  apiCall(() => client.patch(`/api/sales/customer-groups/${id}/`, data))

export const deleteCustomerGroup = (id) =>
  apiCall(() => client.delete(`/api/sales/customer-groups/${id}/`))

// ── Contacts import (CSV bulk upload of Customers / Suppliers) ───────────────

/** POST a multipart CSV. Resolves to {created, skipped, errors, summary}. */
export const importContacts = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return apiCall(() => client.post('/api/sales/contacts/import/', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }))
}

/** URL for the GET template download — used as a plain href. */
export const contactsImportTemplateUrl = '/api/sales/contacts/import-template/'
