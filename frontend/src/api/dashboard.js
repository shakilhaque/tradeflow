import { client, apiCall } from './client'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Today's sales summary from the reports endpoint.
 * Returns the `summary` sub-object:
 *   { total_revenue, net_revenue, order_count, avg_order_value, total_items_sold, total_discount, total_tax }
 *
 * Requires can_view_reports (or can_create_sale — service falls back gracefully).
 * Rejects with an Error if the user lacks permission (403).
 */
export async function getTodaySalesSummary() {
  const d = today()
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', { params: { date_from: d, date_to: d } })
  )
  return data?.summary ?? data
}

/**
 * 7-day revenue breakdown for the mini chart.
 * Returns array of { label, revenue, order_count }.
 */
export async function getWeeklySalesBreakdown() {
  const d = today()
  const sevenDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: sevenDaysAgo, date_to: d, group_by: 'day' },
    })
  )
  return data?.breakdown ?? []
}

/**
 * Per-day "items sold" breakdown (+ revenue + orders), using the SAME query
 * as the All Sales list (created_at date, all non-draft sales). This is the
 * single source for the "Items Sold Today" KPI AND the per-day breakdown
 * card, so both always agree with the All Sales footer total for a day.
 * Returns array of { date, items, revenue, orders }, oldest → newest.
 *
 * Visible to can_view_reports OR can_create_sale.
 */
export async function getDailyItemsSold(days = 14) {
  const data = await apiCall(() =>
    client.get('/api/sales/daily-items/', { params: { days } })
  )
  return data?.breakdown ?? []
}

/**
 * Low-stock product count — tracked products at/below their alert quantity
 * (or out of stock). Iterates products, so brand-new 0-stock products count.
 */
export async function getLowStockCount() {
  const data = await apiCall(() =>
    client.get('/api/inventory/low-stock/', { params: { limit: 1 } })
  )
  return Number(data?.count ?? 0)
}

/**
 * Rows for the dashboard "Product Stock Alert" card. Tracked products
 * (manage_stock on) that are low/out of stock show their current stock;
 * services (manage_stock off) are returned with qty=null so the card shows
 * N/A. Every item carries `manage_stock` for that N/A rendering.
 */
export async function getLowStockAlerts(limit = 8) {
  const data = await apiCall(() =>
    client.get('/api/inventory/low-stock/', { params: { limit } })
  )
  return data?.results ?? []
}

/**
 * Recent finalized sales — last N (default 5).
 * Uses the sales list endpoint so any role with can_create_sale can call this.
 */
export async function getRecentSales(limit = 5) {
  const data = await apiCall(() =>
    client.get('/api/sales/sales/', { params: { status: 'FINAL', limit } })
  )
  return Array.isArray(data) ? data : data?.results ?? []
}

/**
 * Pending sales count (back-orders + pending).
 */
export async function getPendingSalesCount() {
  const data = await apiCall(() =>
    client.get('/api/sales/sales/', { params: { status: 'PENDING', limit: 1 } })
  )
  // We only need the count; if paginated the backend returns an array
  return Array.isArray(data) ? data.length : (data?.count ?? 0)
}

/**
 * Daily revenue breakdown for the last N days.
 * Returns array of { label, value, order_count }.
 */
export async function getDailyRevenue(days = 30) {
  const to   = today()
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: from, date_to: to, group_by: 'day' },
    })
  )
  const rows = data?.breakdown ?? []
  // Normalize to { label, value }
  return rows.map((r) => ({
    label: (r.label || '').slice(5),   // MM-DD
    value: Number(r.revenue ?? r.net ?? 0),
    order_count: r.order_count ?? 0,
  }))
}

/**
 * Daily Sales / Cost / Profit comparison for the dashboard's grouped
 * bar chart. Returns array of { label, sales, cost, profit } — one
 * entry per day that had at least one finalised sale.
 */
export async function getDailySalesCostProfit(days = 30) {
  const to   = today()
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: from, date_to: to, group_by: 'day' },
    })
  )
  const rows = data?.breakdown ?? []
  return rows.map((r) => ({
    label:  (r.label || '').slice(5),   // MM-DD
    sales:  Number(r.revenue ?? 0),
    cost:   Number(r.cogs ?? 0),
    profit: Number(r.gross_profit ?? (Number(r.revenue ?? 0) - Number(r.cogs ?? 0))),
  }))
}

/**
 * Top N selling products by revenue, over the last `days` days.
 * Returns array of { label, value } where value = revenue.
 */
export async function getTopProducts(days = 30, limit = 6) {
  const to   = today()
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: from, date_to: to, group_by: 'product' },
    })
  )
  const rows = data?.breakdown ?? []
  return rows
    .slice(0, limit)
    .map((r) => ({ label: r.label || '—', value: Number(r.revenue || 0) }))
}

/**
 * Top-selling products for the dashboard "Top Selling Products" card.
 * `period` is one of 'today' | 'week' | 'month' and maps to a rolling
 * date range. Returns rich rows { id, name, qty, revenue } pulled live
 * from the sales report grouped by product — so it works for every tenant.
 */
export async function getTopSellingProducts(period = 'today', limit = 5) {
  const to = today()
  const spanDays = period === 'month' ? 30 : period === 'week' ? 7 : 1
  const from = new Date(Date.now() - (spanDays - 1) * 86_400_000).toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: from, date_to: to, group_by: 'product' },
      _silentToast: true,
    })
  )
  const rows = data?.breakdown ?? []
  return rows.slice(0, limit).map((r) => ({
    id:      r.key ?? r.label,
    name:    r.label || '—',
    qty:     Number(r.qty_sold || 0),
    revenue: Number(r.revenue || 0),
  }))
}

/**
 * Top customers by lifetime sales for the dashboard "Top Customers" card.
 * Pulls from the customers ledger report (already sorted by activity desc)
 * and returns { id, name, orders, total }. Works for every tenant — only
 * customers with real sales activity appear.
 */
export async function getTopCustomers(limit = 5) {
  const data = await apiCall(() =>
    client.get('/api/reports/contacts/', {
      params: { type: 'customer', page: 1, limit },
      _silentToast: true,
    })
  )
  const rows = Array.isArray(data?.rows) ? data.rows : []
  return rows.slice(0, limit).map((r) => ({
    id:     r.contact_id,
    name:   r.name || '—',
    orders: Number(r.order_count || 0),
    total:  Number(r.total_sale || 0),
  }))
}

/**
 * Sales staff leaderboard (top earners over last `days` days).
 * Returns array of { label, value }.
 */
export async function getStaffLeaderboard(days = 30, limit = 5, userId = null) {
  const to   = today()
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  // Group by SERVICE STAFF (the staff chosen at sale time), not the
  // account that added the sale — so Top Sellers credits the real seller.
  const params = { date_from: from, date_to: to, group_by: 'service_staff' }
  // When a userId is passed (sub-users), the server scopes the result to
  // that single seller — so the Top Sellers card shows only their own row.
  if (userId) params.user_id = userId
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', { params })
  )
  const rows = data?.breakdown ?? []
  return rows
    .slice(0, limit)
    .map((r) => ({ label: r.label || 'System', value: Number(r.revenue || 0) }))
}

/**
 * 12-month revenue trend.
 */
export async function getMonthlyRevenue() {
  const to = today()
  const d  = new Date()
  d.setMonth(d.getMonth() - 11)
  d.setDate(1)
  const from = d.toISOString().slice(0, 10)
  const data = await apiCall(() =>
    client.get('/api/reports/sales/', {
      params: { date_from: from, date_to: to, group_by: 'month' },
    })
  )
  const rows = data?.breakdown ?? []
  return rows.map((r) => ({
    label: (r.label || '').split(' ')[0]?.slice(0, 3) ?? r.label,
    value: Number(r.revenue ?? 0),
    order_count: r.order_count ?? 0,
  }))
}
