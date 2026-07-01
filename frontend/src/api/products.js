import { client, apiCall } from './client'

// ── Products ─────────────────────────────────────────────────────────────────

/** List products with optional filters */
export const getProducts = (params = {}) =>
  apiCall(() => client.get('/api/inventory/products/', { params }))

/** Low-stock alert — products whose on-hand ≤ reorder_level (alert qty). */
export const getLowStock = (params = {}) =>
  apiCall(() => client.get('/api/inventory/low-stock/', { params }))

/** Get single product detail */
export const getProduct = (id) =>
  apiCall(() => client.get(`/api/inventory/products/${id}/`))

/** Product Stock History — aggregates + ledger for the history page.
 *  params: { location_id?, limit? } */
export const getProductStockHistory = (id, params = {}) =>
  apiCall(() => client.get(`/api/inventory/products/${id}/stock-history/`, { params }))

/**
 * Opening Stock — GET returns one row per active business location with
 * the current opening-stock FIFO layer's qty / unit_cost / date / layer_id
 * (zeros if the layer doesn't exist yet). POST upserts: rows with
 * quantity > 0 update the existing untouched opening layer (or create
 * a new one via the shared add_stock_fifo service).
 */
export const getProductOpeningStock = (id) =>
  apiCall(() => client.get(`/api/inventory/products/${id}/opening-stock/`))

export const saveProductOpeningStock = (id, rows) =>
  apiCall(() => client.post(`/api/inventory/products/${id}/opening-stock/`, { rows }))

/**
 * Exact-match lookup for a barcode / SKU. Used by the POS scan path —
 * the cashier scans (or types) a code and presses Enter; the matching
 * product is returned instantly so the cart can add it without going
 * through the debounced search dropdown. Throws on 404 if no product
 * matches.
 */
export const scanProductByCode = (code) =>
  apiCall(() => client.get('/api/inventory/products/scan/', { params: { code } }))

/** Create a new product */
export const createProduct = (data) =>
  apiCall(() => client.post('/api/inventory/products/', data))

/** Partial-update a product */
export const updateProduct = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/products/${id}/`, data))

/** Soft-delete a product (sets is_active=False). */
export const deleteProduct = (id) =>
  apiCall(() => client.delete(`/api/inventory/products/${id}/`))

/** Receive stock — creates one FIFO layer. */
export const stockIn = (data) =>
  apiCall(() => client.post('/api/inventory/stock-in/', data))

// ── Master data ───────────────────────────────────────────────────────────────

export const getCategories = () =>
  apiCall(() => client.get('/api/inventory/categories/'))

export const getBrands = () =>
  apiCall(() => client.get('/api/inventory/brands/'))

export const getUnits = () =>
  apiCall(() => client.get('/api/inventory/units/'))

export const getLocations = (activeOnly = true) =>
  apiCall(() => client.get('/api/inventory/locations/', { params: { active_only: activeOnly } }))

// ── Category / Brand / Unit CRUD (for settings) ───────────────────────────────

export const createCategory = (data) =>
  apiCall(() => client.post('/api/inventory/categories/', data))

export const createBrand = (data) =>
  apiCall(() => client.post('/api/inventory/brands/', data))

export const updateBrand = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/brands/${id}/`, data))

export const deleteBrand = (id) =>
  apiCall(() => client.delete(`/api/inventory/brands/${id}/`))

export const createUnit = (data) =>
  apiCall(() => client.post('/api/inventory/units/', data))

export const updateUnit = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/units/${id}/`, data))
export const deleteUnit = (id) =>
  apiCall(() => client.delete(`/api/inventory/units/${id}/`))

export const updateCategory = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/categories/${id}/`, data))
export const deleteCategory = (id) =>
  apiCall(() => client.delete(`/api/inventory/categories/${id}/`))

// ── Warranties ───────────────────────────────────────────────────────────────
export const getWarranties = () =>
  apiCall(() => client.get('/api/inventory/warranties/'))
export const createWarranty = (data) =>
  apiCall(() => client.post('/api/inventory/warranties/', data))
export const updateWarranty = (id, data) =>
  apiCall(() => client.patch(`/api/inventory/warranties/${id}/`, data))
export const deleteWarranty = (id) =>
  apiCall(() => client.delete(`/api/inventory/warranties/${id}/`))

// ── Image upload (S3 if configured, /media fallback) ─────────────────────────

/** Upload a product image. Returns { url, key }. */
export const uploadProductImage = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return apiCall(() =>
    client.post('/api/inventory/uploads/image/', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  )
}
