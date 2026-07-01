import { client, apiCall } from './client'

// ── Purchases ────────────────────────────────────────────────────────────────

export const getPurchases = (params = {}) =>
  apiCall(() => client.get('/api/purchases/', { params }))

export const getPurchase = (id) =>
  apiCall(() => client.get(`/api/purchases/${id}/`))

export const createPurchase = (data) =>
  apiCall(() => client.post('/api/purchases/', data))

export const deletePurchase = (id) =>
  apiCall(() => client.delete(`/api/purchases/${id}/`))

export const addPurchasePayment = (id, data) =>
  apiCall(() => client.post(`/api/purchases/${id}/payments/`, data))

export const updatePurchase = (id, data) =>
  apiCall(() => client.patch(`/api/purchases/${id}/`, data))

// Payments are embedded in the purchase detail response, so we
// reuse getPurchase and just project .payments — saves a route
// and keeps things consistent.
export const getPurchasePayments = async (id) => {
  const detail = await apiCall(() => client.get(`/api/purchases/${id}/`))
  return Array.isArray(detail?.payments) ? detail.payments : []
}

// Items Received Notification — GET returns tag substitutions +
// default subject/body, POST sends the email through Django's email
// backend (substitutes {placeholders} server-side).
export const getPurchaseNotification = (id) =>
  apiCall(() => client.get(`/api/purchases/${id}/notify/`))

export const sendPurchaseNotification = (id, payload) =>
  apiCall(() => client.post(`/api/purchases/${id}/notify/`, payload))

// ── Purchase Returns ─────────────────────────────────────────────────────────

export const getPurchaseReturns = (params = {}) =>
  apiCall(() => client.get('/api/purchases/returns/', { params }))

export const getPurchaseReturn = (id) =>
  apiCall(() => client.get(`/api/purchases/returns/${id}/`))

export const createPurchaseReturn = (data) =>
  apiCall(() => client.post('/api/purchases/returns/', data))

export const deletePurchaseReturn = (id) =>
  apiCall(() => client.delete(`/api/purchases/returns/${id}/`))

export const addPurchaseReturnPayment = (id, data) =>
  apiCall(() => client.post(`/api/purchases/returns/${id}/payments/`, data))

export const getPurchaseReturnPayments = (id) =>
  apiCall(() => client.get(`/api/purchases/returns/${id}/payments/`))

export const updatePurchaseReturnPayment = (paymentId, data) =>
  apiCall(() => client.patch(`/api/purchases/returns/payments/${paymentId}/`, data))

export const deletePurchaseReturnPayment = (paymentId) =>
  apiCall(() => client.delete(`/api/purchases/returns/payments/${paymentId}/`))

// ── Suppliers ────────────────────────────────────────────────────────────────

export const getSuppliers = (params = {}) =>
  apiCall(() => client.get('/api/purchases/suppliers/', { params }))

export const getSupplier = (id) =>
  apiCall(() => client.get(`/api/purchases/suppliers/${id}/`))

export const createSupplier = (data) =>
  apiCall(() => client.post('/api/purchases/suppliers/', data))

export const updateSupplier = (id, data) =>
  apiCall(() => client.patch(`/api/purchases/suppliers/${id}/`, data))

export const deleteSupplier = (id) =>
  apiCall(() => client.delete(`/api/purchases/suppliers/${id}/`))
