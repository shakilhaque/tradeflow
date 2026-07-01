import { client, apiCall } from './client'

// ── Stock operations ──────────────────────────────────────────────────────────

/** Record stock received (creates FIFO layer) */
export const stockIn = (data) =>
  apiCall(() => client.post('/api/inventory/stock-in/', data))

/** Transfer stock between locations (single line — legacy) */
export const stockTransfer = (data) =>
  apiCall(() => client.post('/api/inventory/stock-transfer/', data))

// ── Stock transfer history (header + items) ──────────────────────────────────

export const getStockTransfers = (params = {}) =>
  apiCall(() => client.get('/api/inventory/stock-transfers/', { params }))

export const getStockTransfer = (id) =>
  apiCall(() => client.get(`/api/inventory/stock-transfers/${id}/`))

export const createStockTransfer = (data) =>
  apiCall(() => client.post('/api/inventory/stock-transfers/', data))

export const deleteStockTransfer = (id) =>
  apiCall(() => client.delete(`/api/inventory/stock-transfers/${id}/`))

// ── Reports ───────────────────────────────────────────────────────────────────

/**
 * Get stock-on-hand report
 * params: { product_id, location_id, include_zero }
 */
export const getStockReport = (params = {}) =>
  apiCall(() => client.get('/api/inventory/stock-report/', { params }))

/**
 * Get stock movement history
 * params: { product_id, location_id, movement_type, limit }
 */
export const getMovements = (params = {}) =>
  apiCall(() => client.get('/api/inventory/movements/', { params }))

/** Get FIFO layers for a product (optional: location_id) */
export const getFifoLayers = (params = {}) =>
  apiCall(() => client.get('/api/inventory/fifo-layers/', { params }))

// ── Business locations (branches) ────────────────────────────────────────────

export const getLocations = (params = {}) =>
  apiCall(() => client.get('/api/inventory/locations/', { params }))

export const createLocation = (data) =>
  apiCall(() => client.post('/api/inventory/locations/', data))

export const updateLocation = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/locations/${id}/`, data))

export const deleteLocation = (id) =>
  apiCall(() => client.delete(`/api/inventory/locations/${id}/`))

/** Subscription-driven branch limits: { limit, current, remaining, can_add, multi_branch_enabled, plan_name } */
export const getLocationLimits = () =>
  apiCall(() => client.get('/api/inventory/locations/limits/'))
