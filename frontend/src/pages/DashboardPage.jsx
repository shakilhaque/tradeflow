import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useNavigate }   from 'react-router-dom'

import StatCard from '../components/ui/StatCard'
import Badge    from '../components/ui/Badge'
import Button   from '../components/ui/Button'
import { LineChart, BarChart, DonutChart, ChartLegend } from '../components/charts/Charts'
import LowStockAlertCard    from '../components/dashboard/LowStockAlertCard'
import TopSellingProductsCard from '../components/dashboard/TopSellingProductsCard'
import TopCustomersCard      from '../components/dashboard/TopCustomersCard'
import RecentTransactionsCard from '../components/dashboard/RecentTransactionsCard'
import DateRangePresetPicker from '../components/ui/DateRangePresetPicker'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import {
  getTodaySalesSummary,
  getLowStockCount,
  getPendingSalesCount,
  getDailyRevenue,
  getDailySalesCostProfit,
  getMonthlyRevenue,
  getTopProducts,
  getStaffLeaderboard,
  getDailyItemsSold,
} from '../api/dashboard'
import { getPurchaseSaleReport, getExpenseReport, getStockReport } from '../api/reports'
import { getSales, getShipments } from '../api/sales'
import { getPurchases } from '../api/purchases'

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtInt = (n) => Number(n ?? 0).toLocaleString()

const fmtBDT = (n) =>
  `৳ ${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

function statusVariant(status) {
  return { FINAL: 'green', DRAFT: 'gray', QUOTATION: 'blue', PENDING: 'yellow', VOIDED: 'red' }[status] ?? 'gray'
}

function paymentVariant(ps) {
  return { PAID: 'green', PARTIAL: 'yellow', DUE: 'red' }[ps] ?? 'gray'
}

// ── Recent Sales table ────────────────────────────────────────────────────────

function RecentSalesTable({ sales, loading }) {
  const { t } = useLang()
  // Client-side pagination so a long list of recent sales doesn't stretch
  // the dashboard — the tenant pages through 5 at a time.
  const PAGE_SIZE = 5
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil((sales?.length || 0) / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [totalPages, page])
  const pageRows = (sales || []).slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  if (!sales.length) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        No recent sales found.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
            <th className="text-left pb-3 font-medium">{t('Invoice')}</th>
            <th className="text-left pb-3 font-medium">{t('Customer')}</th>
            <th className="text-right pb-3 font-medium">{t('Total')}</th>
            <th className="text-center pb-3 font-medium">{t('Status')}</th>
            <th className="text-center pb-3 font-medium">{t('Payment')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {pageRows.map((sale) => (
            <tr key={sale.id} className="hover:bg-gray-50/50 transition-colors">
              <td className="py-3 pr-3">
                <span className="font-mono text-xs text-brand-600 font-medium">
                  {sale.invoice_number ?? sale.id?.slice(0, 8)}
                </span>
              </td>
              <td className="py-3 pr-3 text-gray-700">
                {sale.customer_name ?? <span className="text-gray-400 italic">{t('Walk-in')}</span>}
              </td>
              <td className="py-3 pr-3 text-right font-semibold text-gray-900">
                ৳ {fmt(sale.total_amount)}
              </td>
              <td className="py-3 pr-3 text-center">
                <Badge variant={statusVariant(sale.status)} dot>{sale.status}</Badge>
              </td>
              <td className="py-3 text-center">
                <Badge variant={paymentVariant(sale.payment_status)}>{sale.payment_status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 text-xs text-gray-500">
          <span>
            Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sales.length)} of {sales.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="rounded-md border border-gray-200 px-2.5 py-1 font-medium text-gray-600 hover:border-gray-300 disabled:opacity-40 disabled:hover:border-gray-200"
            >
              Previous
            </button>
            <span className="rounded bg-brand-600 px-2.5 py-1 font-semibold text-white">{safePage}</span>
            <span className="text-gray-400">of {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="rounded-md border border-gray-200 px-2.5 py-1 font-medium text-gray-600 hover:border-gray-300 disabled:opacity-40 disabled:hover:border-gray-200"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Quick Actions ─────────────────────────────────────────────────────────────

function QuickActions({ perms }) {
  const { t } = useLang()
  const has = (p) => perms.includes(p)
  const actions = [
    { label: 'New Sale',       path: '/sales/add',              show: has('can_create_sale'),       icon: <PlusIcon />,   color: 'text-brand-600 bg-brand-50' },
    { label: 'Add Product',    path: '/products/new',           show: has('can_manage_products'),   icon: <BoxIcon />,    color: 'text-indigo-600 bg-indigo-50' },
    { label: 'Record Expense', path: '/accounting/expenses/add',show: has('can_record_expense'),    icon: <WalletIcon />, color: 'text-violet-600 bg-violet-50' },
    { label: 'View Reports',   path: '/reports/sales',          show: has('can_view_reports'),      icon: <ChartIcon />,  color: 'text-emerald-600 bg-emerald-50' },
    { label: 'Settings',       path: '/settings',               show: true,                         icon: <CogIcon />,    color: 'text-gray-600 bg-gray-100' },
    { label: 'Audit Log',      path: '/audit',                  show: has('can_view_audit_log'),    icon: <ShieldIcon />, color: 'text-rose-600 bg-rose-50' },
  ].filter((a) => a.show)
  if (!actions.length) return null
  return (
    <div className="grid grid-cols-2 gap-3">
      {actions.map((a) => (
        <Link
          key={a.path}
          to={a.path}
          className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 hover:shadow-md hover:border-gray-200 transition-all group"
        >
          <div className={`rounded-lg p-2 shrink-0 ${a.color} group-hover:scale-110 transition-transform`}>
            {a.icon}
          </div>
          <span className="text-sm font-medium text-gray-700 group-hover:text-gray-900">{t(a.label)}</span>
        </Link>
      ))}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth()
  const { t }    = useLang()
  const navigate = useNavigate()
  const perms    = user?.permissions ?? []
  // loginSource is the source of truth for which portal the
  // user belongs to — see ProtectedRoute for the full rationale.
  // Without this, a portal-swap via shared localStorage caused
  // the old heuristic to flip on refresh and bounce a tenant
  // owner to /platform/dashboard (and vice versa).
  // Single-client build: there is no platform-admin portal.
  const isPlatformAdmin = false
  const has      = (p) => perms.includes(p)

  // Range filter for the line chart (7 | 30 | 90)
  const [range, setRange] = useState(30)

  // Data states
  const [summary,    setSummary]     = useState(null)
  // Per-day items-sold breakdown — single source of truth for the
  // "Items Sold Today" KPI and the breakdown card, matching All Sales.
  const [itemsDaily, setItemsDaily]  = useState([])
  const [daily,      setDaily]       = useState([])
  const [monthly,    setMonthly]     = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [staff,      setStaff]       = useState([])
  const [lowStock,   setLowStock]    = useState(null)
  const [pending,    setPending]     = useState(null)

  const [loadingMap, setLoadingMap] = useState({
    summary: true, daily: true, monthly: true, topProducts: true, staff: true,
    lowStock: true, sales: true, pending: true,
  })

  const setDone = (key) => setLoadingMap((m) => ({ ...m, [key]: false }))

  // ── POS-style business KPIs + operational tables ──────────────────
  // Date-range filter for the KPI strip. Defaults to TODAY so the card
  // shows that single day's figures (not a month-to-date running total),
  // and the preset picker lets the operator switch to Last 7 / 30 days,
  // This Month, etc. Every change refetches from the DB for that exact range.
  const todayIso = () => new Date().toISOString().slice(0, 10)
  const [kpiFrom, setKpiFrom] = useState(todayIso())
  const [kpiTo,   setKpiTo]   = useState(todayIso())

  const [psData,       setPsData]       = useState(null)   // purchase&sale report
  const [expenseTotal, setExpenseTotal] = useState(null)
  const [dueSales,     setDueSales]     = useState([])
  const [duePurchases, setDuePurchases] = useState([])
  const [shipments,    setShipments]    = useState([])
  const [posLoading,   setPosLoading]   = useState(true)

  const fetchPosData = useCallback(async (silent = false) => {
    if (isPlatformAdmin) return
    if (!silent) setPosLoading(true)
    const range = { date_from: kpiFrom, date_to: kpiTo }
    // Each block is best-effort — a permission gap or a slow endpoint
    // must not blank the rest of the dashboard.
    await Promise.all([
      has('can_view_reports')
        ? getPurchaseSaleReport(range).then(setPsData).catch(() => {})
        : Promise.resolve(),
      has('can_view_reports')
        ? getExpenseReport(range).then((d) => setExpenseTotal(d?.total_expenses ?? 0)).catch(() => {})
        : Promise.resolve(),
      has('can_create_sale')
        ? getSales({ payment_status: 'DUE', status: 'FINAL', limit: 5 })
            .then((d) => setDueSales(Array.isArray(d) ? d : (d?.results ?? [])))
            .catch(() => {})
        : Promise.resolve(),
      has('can_manage_purchases') || has('can_view_reports')
        ? getPurchases({ payment_status: 'due,partial', limit: 5 })
            .then((d) => setDuePurchases(Array.isArray(d) ? d : (d?.results ?? [])))
            .catch(() => {})
        : Promise.resolve(),
      has('can_create_sale')
        ? getShipments({ shipping_status: 'PENDING', limit: 5 })
            .then((d) => setShipments(Array.isArray(d) ? d : (d?.results ?? [])))
            .catch(() => {})
        : Promise.resolve(),
    ])
    setPosLoading(false)
  }, [isPlatformAdmin, kpiFrom, kpiTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // Date filter auto-applies (debounced); plus a 30-second real-time
  // poll + refetch on tab focus so the dashboard stays live.
  const posDebounceRef = useRef(null)
  useEffect(() => {
    if (posDebounceRef.current) clearTimeout(posDebounceRef.current)
    posDebounceRef.current = setTimeout(() => fetchPosData(), 300)
    return () => { if (posDebounceRef.current) clearTimeout(posDebounceRef.current) }
  }, [fetchPosData])
  useEffect(() => {
    let id = null
    const start = () => { if (id) return; id = setInterval(() => { if (!document.hidden) fetchPosData(true) }, 30000) }
    const stop  = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { fetchPosData(true); start() } }
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [fetchPosData])

  // Platform admins → bounce to platform dashboard
  useEffect(() => {
    if (isPlatformAdmin) {
      navigate('/platform/dashboard', { replace: true })
    }
  }, [isPlatformAdmin, navigate])

  // Today's KPIs + low stock + recent sales + pending — fetched once
  useEffect(() => {
    if (isPlatformAdmin) return

    if (has('can_view_reports') || has('can_create_sale')) {
      getTodaySalesSummary().then(setSummary).catch(() => setSummary({})).finally(() => setDone('summary'))
      // Per-day items sold (last 14 days) — drives the "Items Sold Today"
      // KPI and the breakdown card from the same All-Sales-consistent query.
      getDailyItemsSold(14).then(setItemsDaily).catch(() => setItemsDaily([]))
    } else { setDone('summary') }

    if (has('can_manage_products')) {
      getLowStockCount().then(setLowStock).catch(() => setLowStock(0)).finally(() => setDone('lowStock'))
    } else { setDone('lowStock') }

    if (has('can_create_sale')) {
      setDone('sales')  // Recent Sales card removed — no list fetch needed.
      getPendingSalesCount().then(setPending).catch(() => setPending(0)).finally(() => setDone('pending'))
    } else { setDone('sales'); setDone('pending') }

    if (has('can_view_reports')) {
      getMonthlyRevenue().then(setMonthly).catch(() => setMonthly([])).finally(() => setDone('monthly'))
      getTopProducts(60, 6).then(setTopProducts).catch(() => setTopProducts([])).finally(() => setDone('topProducts'))
    } else {
      setDone('monthly'); setDone('topProducts')
    }

    // Top Sellers — visible to every user. The OWNER sees the whole team;
    // every sub-user (admin/manager/cashier) sees ONLY their own row,
    // scoped server-side to their user_id (DB-driven, nothing hardcoded).
    if (has('can_view_reports') || has('can_create_sale')) {
      const isOwner = user?.role === 'owner'
      getStaffLeaderboard(30, 5, isOwner ? null : user?.id)
        .then(setStaff).catch(() => setStaff([])).finally(() => setDone('staff'))
    } else {
      setDone('staff')
    }
  }, [isPlatformAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  // Daily revenue — refetched when range changes
  useEffect(() => {
    if (isPlatformAdmin) return
    if (!has('can_view_reports')) { setDone('daily'); return }
    setLoadingMap((m) => ({ ...m, daily: true }))
    getDailySalesCostProfit(range)
      .then(setDaily)
      .catch(() => setDaily([]))
      .finally(() => setDone('daily'))
  }, [range, isPlatformAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalsInRange = useMemo(() => {
    const sales  = daily.reduce((s, d) => s + Number(d.sales  || 0), 0)
    const cost   = daily.reduce((s, d) => s + Number(d.cost   || 0), 0)
    const profit = daily.reduce((s, d) => s + Number(d.profit || 0), 0)
    return { sales, cost, profit }
  }, [daily])

  // Today = the last (newest) row of the items breakdown. Drives the
  // Today's Revenue + Items Sold KPIs so they equal the All Sales footer.
  const todayStats = useMemo(() => {
    if (!itemsDaily.length) return null
    const r = itemsDaily[itemsDaily.length - 1]
    return { items: Number(r.items || 0), revenue: Number(r.revenue || 0), orders: Number(r.orders || 0) }
  }, [itemsDaily])

  const firstName = user?.name?.split(' ')[0] ?? 'there'
  const hour      = new Date().getHours()
  const greeting  = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  if (isPlatformAdmin) {
    return null  // redirected
  }

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t(greeting)}, {firstName}! 👋</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      {/* ── Business overview — POS-style KPI strip with date filter.
          Placed directly under the Subscription card per layout spec. ── */}
      {has('can_view_reports') && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{t('Business Overview')}</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('Purchases, sales, dues, returns and expense for the selected period. Updates automatically every 30 seconds.')}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 font-medium">{t('Filter by date')}</span>
              {/* Same preset picker as All Sales: Today / Yesterday /
                  Last 7 Days / Last 30 Days / This Month / … / Custom. The
                  card refetches from the DB for the exact range chosen. */}
              <div className="w-56">
                <DateRangePresetPicker
                  from={kpiFrom}
                  to={kpiTo}
                  onChange={({ from, to }) => { setKpiFrom(from); setKpiTo(to) }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            <BizKpi label="Total Purchase"
              value={psData?.purchases?.total_purchase_with_tax}
              loading={posLoading} accent="sky" />
            <BizKpi label="Total Sales"
              value={psData?.sales?.total_sale_with_tax}
              loading={posLoading} accent="emerald" />
            <BizKpi label="Purchase Due"
              value={psData?.purchases?.purchase_due}
              loading={posLoading} accent="amber"
              hint="Owed to suppliers" />
            <BizKpi label="Invoice Due"
              value={psData?.sales?.sale_due}
              loading={posLoading} accent="orange"
              hint="Owed by customers" />
            <BizKpi label="Purchase Return"
              value={psData?.purchases?.total_return_with_tax}
              loading={posLoading} accent="teal" />
            <BizKpi label="Sell Return"
              value={psData?.sales?.total_return_with_tax}
              loading={posLoading} accent="rose" />
            <BizKpi label="Expense"
              value={expenseTotal}
              loading={posLoading} accent="red" />
            <BizKpi label="Net (Sale − Purchase)"
              value={psData?.overall?.sale_minus_purchase}
              loading={posLoading} accent="violet"
              signColor />
          </div>
        </div>
      )}

      {/* Low Stock Alert — products at/below their alert quantity. */}
      <div className="grid grid-cols-1 gap-4">
        <LowStockAlertCard />
      </div>

      {/* Recent Transactions — tabbed (Sale / Purchase / Quotation /
          Expenses / Invoices), each pulling live from its own list.
          Full width so there's no empty space beside it. */}
      {(has('can_view_reports') || has('can_create_sale')) && (
        <RecentTransactionsCard />
      )}

      {/* Today's pulse — small strip. Revenue + Items + orders come from
          the per-day breakdown (todayStats) so they match the All Sales
          page filtered to today, to the unit. */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title="Today's Revenue"
          value={todayStats ? `৳ ${fmt(todayStats.revenue)}` : (summary ? `৳ ${fmt(summary.total_revenue ?? summary.net_revenue)}` : null)}
          loading={loadingMap.summary}
          icon={<RevenueIcon />}
          iconColor="bg-brand-100 text-brand-600"
          suffix={todayStats?.orders ? `(${fmtInt(todayStats.orders)} orders)` : (summary?.order_count ? `(${fmtInt(summary.order_count)} orders)` : undefined)}
        />
        <StatCard
          title="Items Sold Today"
          value={todayStats ? fmtInt(todayStats.items) : (summary ? fmtInt(summary.total_items_sold) : null)}
          loading={loadingMap.summary}
          icon={<CartIcon />}
          iconColor="bg-indigo-100 text-indigo-600"
        />
        <StatCard
          title="Low Stock Items"
          value={lowStock !== null ? fmtInt(lowStock) : null}
          loading={loadingMap.lowStock}
          icon={<AlertIcon />}
          iconColor={lowStock > 0 ? 'bg-amber-100 text-amber-600' : 'bg-green-100 text-green-600'}
          suffix="products"
        />
        <StatCard
          title="Pending Orders"
          value={pending !== null ? fmtInt(pending) : null}
          loading={loadingMap.pending}
          icon={<ClockIcon />}
          iconColor={pending > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'}
          suffix="orders"
        />
      </div>

      {/* Sales Last 30 Days — classic POS line chart (compact) */}
      {has('can_view_reports') && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="bg-red-500 px-5 py-2 text-center">
            <h2 className="text-sm font-bold text-white tracking-tight">Sales Last 30 Days</h2>
          </div>
          <div className="p-4">
            {loadingMap.daily ? (
              <div className="h-[180px] bg-gray-50 rounded-lg animate-pulse" />
            ) : (
              <SalesLast30Chart
                data={daily}
                days={range}
                legend={psData?.location_options?.length === 1
                  ? psData.location_options[0].name
                  : 'All locations'}
              />
            )}
          </div>
        </div>
      )}

      {/* Revenue trend (large) */}
      {has('can_view_reports') && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Sales, Cost &amp; Profit Comparison</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Per-day comparison over the selected period — sales revenue,
                cost of goods, and gross profit.
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  onClick={() => setRange(d)}
                  className={[
                    'px-3 py-1.5 rounded-md font-medium transition',
                    range === d ? 'bg-brand-600 text-white shadow' : 'text-gray-600 hover:text-brand-600',
                  ].join(' ')}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          {loadingMap.daily ? (
            <div className="h-[220px] bg-gray-50 rounded-lg animate-pulse" />
          ) : (
            <SalesCostProfitChart data={daily} height={260} />
          )}

          {/* Totals strip — mirrors the bottom table of the reference design */}
          {!loadingMap.daily && daily.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-50">
                  <tr>
                    <td className="py-2 pr-3 w-28">
                      <span className="inline-flex items-center gap-2 rounded-md bg-rose-500 px-3 py-1 text-xs font-bold text-white">{t('Sales')}</span>
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-gray-900">৳ {fmt(totalsInRange.sales)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-2 rounded-md bg-teal-500 px-3 py-1 text-xs font-bold text-white">{t('Cost')}</span>
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-gray-900">৳ {fmt(totalsInRange.cost)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-2 rounded-md bg-rose-300 px-3 py-1 text-xs font-bold text-white">{t('Profit')}</span>
                    </td>
                    <td className={`py-2 text-right font-bold tabular-nums ${totalsInRange.profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>৳ {fmt(totalsInRange.profit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 12-month trend + Top products */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {has('can_view_reports') && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-gray-900">Sales — Current Financial Year</h2>
            <p className="text-xs text-gray-500 mt-0.5 mb-4">Monthly totals, last 12 months</p>
            {loadingMap.monthly ? (
              <div className="h-[200px] bg-gray-50 rounded-lg animate-pulse" />
            ) : (
              <BarChart data={monthly} height={220} accent="emerald" yFormat={fmtBDT} />
            )}
          </div>
        )}

        {has('can_view_reports') && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-gray-900">{t('Top Products')}</h2>
            <p className="text-xs text-gray-500 mt-0.5 mb-4">Revenue · last 60 days</p>
            {loadingMap.topProducts ? (
              <div className="h-[220px] bg-gray-50 rounded-lg animate-pulse" />
            ) : (
              <BarChart data={topProducts} height={240} accent="violet" yFormat={fmtBDT} horizontal />
            )}
          </div>
        )}
      </div>

      {/* ── Payment dues — side-by-side like a classic POS dashboard ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DueTable
          title="Sales Payment Due"
          tone="emerald"
          loading={posLoading}
          rows={dueSales}
          empty="No customer dues. 🎉"
          headers={['Customer', 'Invoice No.', 'Due Amount']}
          mapRow={(r) => [
            r.customer_name || 'Walk-in',
            r.invoice_number || r.invoice_no || '—',
            `৳ ${fmt(Math.max(0, Number(r.total_amount || 0) - Number(r.total_paid ?? r.amount_paid ?? 0)))}`,
          ]}
          linkTo="/sells"
        />
        <DueTable
          title="Purchase Payment Due"
          tone="amber"
          loading={posLoading}
          rows={duePurchases}
          empty="No supplier dues. 🎉"
          headers={['Supplier', 'Reference No.', 'Due Amount']}
          mapRow={(r) => [
            r.supplier_name || '—',
            r.reference_no || '—',
            `৳ ${fmt(Math.max(0, Number(r.grand_total || 0) - Number(r.paid_amount || 0)))}`,
          ]}
          linkTo="/purchases"
        />
      </div>

      {/* ── Pending shipments ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DueTable
          title="Pending Shipments"
          tone="sky"
          loading={posLoading}
          rows={shipments}
          empty="No pending shipments."
          headers={['Invoice No.', 'Customer', 'Status']}
          mapRow={(r) => [
            r.invoice_number || r.invoice_no || '—',
            r.customer_name || 'Walk-in',
            (r.meta?.shipping_status || r.shipping_status || 'PENDING'),
          ]}
          linkTo="/sales/shipments"
        />
      </div>

      {/* Top Customers · Top Products · Top Sellers — side by side
          (each one-third on large screens, stacked on mobile). */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        <TopCustomersCard />
        <TopSellingProductsCard />
        {/* Top Sellers is shown to every user who can sell. The owner sees
            the whole team; sub-users see only their own (data scoped in
            the fetch above). */}
        {(has('can_view_reports') || has('can_create_sale')) && (
          <TopSellersCard staff={staff} loading={loadingMap.staff} />
        )}
      </div>
    </div>
  )
}

// ── Sales Last 30 Days — classic POS line chart ─────────────────────────────
// Every day in the window appears on the X axis (zero-sale days
// included), with rotated date labels and a small location legend —
// modelled on the classic POS dashboard chart.

function SalesLast30Chart({ data = [], days = 30, legend = '' }) {
  // Fill the full day range so gaps show as zeros.
  const byLabel = {}
  for (const d of data) byLabel[d.label] = Number(d.sales ?? d.value ?? 0)
  const series = []
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86_400_000)
    const key = dt.toISOString().slice(5, 10)              // MM-DD
    const lbl = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    series.push({ key: lbl, full: dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), v: byLabel[key] ?? 0 })
  }

  const W = 940, H = 220
  const padL = 46, padB = 52, padT = 8, padR = 12
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const maxV = Math.max(1, ...series.map((s) => s.v))
  const x = (i) => padL + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW)
  const y = (v) => padT + innerH - (v / maxV) * innerH
  const path = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.v).toFixed(1)}`).join(' ')

  // Show at most ~8 date labels so 30 days don't collide. Always render
  // the last point (today); render evenly-spaced ticks otherwise, skipping
  // any that would sit right next to "today" and overlap it.
  const last = series.length - 1
  const labelEvery = Math.max(1, Math.ceil(series.length / 8))
  const showLabel = (i) =>
    i === last ||
    (i % labelEvery === 0 && (last - i) >= Math.ceil(labelEvery / 2))

  const ticks = 4
  const kFmt = (v) => (v >= 1000 ? `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : Math.round(v).toLocaleString())

  return (
    <div className="overflow-x-auto">
      <div className="flex justify-end pr-2 -mb-1">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
          <span className="h-2 w-2 rounded-full bg-sky-500" /> {legend}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 640 }}>
        {[...Array(ticks + 1)].map((_, i) => {
          const v = (maxV / ticks) * i
          const yy = y(v)
          return (
            <g key={i}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#f3f4f6" strokeWidth="1" />
              <text x={padL - 5} y={yy + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{kFmt(v)}</text>
            </g>
          )
        })}
        <text transform={`translate(10 ${padT + innerH / 2}) rotate(-90)`} textAnchor="middle" fontSize="9" fill="#9ca3af">
          Total Sales (BDT)
        </text>
        <path d={path} fill="none" stroke="#60a5fa" strokeWidth="1.8" />
        {series.map((s, i) => (
          <circle key={i} cx={x(i)} cy={y(s.v)} r="2.6" fill="#fff" stroke="#3b82f6" strokeWidth="1.6">
            <title>{`${s.full} — ৳ ${s.v.toLocaleString()}`}</title>
          </circle>
        ))}
        {series.map((s, i) => (
          showLabel(i) ? (
            <text
              key={`l${i}`}
              transform={`translate(${x(i)} ${H - padB + 16}) rotate(-40)`}
              textAnchor="end"
              fontSize="9"
              fill="#64748b"
            >
              {s.key}
            </text>
          ) : null
        ))}
      </svg>
    </div>
  )
}

// ── Sales / Cost / Profit grouped bar chart ─────────────────────────────────
// Lightweight SVG — three bars per day (sales rose, cost teal, profit
// pale rose), modelled on the classic POS comparison chart.

function SalesCostProfitChart({ data = [], height = 260 }) {
  const { t } = useLang()
  if (!data.length) {
    return <div className="py-12 text-center text-sm text-gray-400">{t('No sales in the selected period.')}</div>
  }
  const W = 940
  const H = height
  const padL = 56, padB = 26, padT = 10
  const innerW = W - padL - 8
  const innerH = H - padT - padB
  const maxV = Math.max(1, ...data.flatMap((d) => [d.sales, d.cost, Math.abs(d.profit)]))
  const groupW = innerW / data.length
  const barW = Math.min(14, Math.max(3, (groupW - 6) / 3))
  const y = (v) => padT + innerH - (Math.max(0, v) / maxV) * innerH
  const hOf = (v) => (Math.max(0, v) / maxV) * innerH

  const ticks = 4
  const series = [
    { key: 'sales',  color: '#f43f5e' },
    { key: 'cost',   color: '#14b8a6' },
    { key: 'profit', color: '#fda4af' },
  ]
  // Show at most ~10 x-labels so 30 days don't collide.
  const labelEvery = Math.max(1, Math.ceil(data.length / 10))

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 640 }}>
        {[...Array(ticks + 1)].map((_, i) => {
          const v = (maxV / ticks) * i
          const yy = y(v)
          return (
            <g key={i}>
              <line x1={padL} y1={yy} x2={W - 4} y2={yy} stroke="#f3f4f6" strokeWidth="1" />
              <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize="10" fill="#9ca3af">
                ৳{Math.round(v).toLocaleString()}
              </text>
            </g>
          )
        })}
        {data.map((d, gi) => {
          const gx = padL + gi * groupW + (groupW - barW * 3 - 4) / 2
          return (
            <g key={gi}>
              {series.map((s, si) => (
                <rect
                  key={s.key}
                  x={gx + si * (barW + 2)}
                  y={y(d[s.key])}
                  width={barW}
                  height={hOf(d[s.key])}
                  rx="1.5"
                  fill={s.color}
                >
                  <title>{`${d.label} — ${s.key}: ৳ ${Number(d[s.key] || 0).toLocaleString()}`}</title>
                </rect>
              ))}
              {gi % labelEvery === 0 && (
                <text
                  x={padL + gi * groupW + groupW / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#6b7280"
                >
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="mt-2 flex items-center justify-center gap-5 text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Sales</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-teal-500" /> Cost</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-300" /> Profit</span>
      </div>
    </div>
  )
}

// ── Top Sellers — modern ranked list ────────────────────────────────────────

const SELLER_COLORS = [
  'bg-brand-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-sky-500',
]

function TopSellersCard({ staff = [], loading }) {
  const { t } = useLang()
  const total = staff.reduce((s, d) => s + Number(d.value || 0), 0)
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-gray-900">{t('Top Sellers')}</h2>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 tabular-nums">
          ৳ {fmt(total)}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-5">Revenue by seller · last 30 days</p>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-xl bg-gray-50 animate-pulse" />)}
        </div>
      ) : staff.length === 0 ? (
        <div className="py-8 text-center text-xs text-gray-400">No sales recorded in the last 30 days.</div>
      ) : (
        <div className="space-y-4">
          {staff.map((s, i) => {
            const pct = total > 0 ? (Number(s.value || 0) / total) * 100 : 0
            const initials = (s.label || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
            return (
              <div key={s.label ?? i} className="flex items-center gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${SELLER_COLORS[i % SELLER_COLORS.length]}`}>
                  {initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {i === 0 && <span className="mr-1">🏆</span>}{s.label}
                    </p>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">৳ {fmt(s.value)}</p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className={`h-full rounded-full ${SELLER_COLORS[i % SELLER_COLORS.length]} transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-11 shrink-0 text-right text-[10px] font-semibold text-gray-400 tabular-nums">
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── POS-dashboard building blocks ───────────────────────────────────────────

const BIZ_ACCENT = {
  sky:     'border-t-sky-400 bg-sky-50/40',
  emerald: 'border-t-emerald-400 bg-emerald-50/40',
  amber:   'border-t-amber-400 bg-amber-50/40',
  orange:  'border-t-orange-400 bg-orange-50/40',
  teal:    'border-t-teal-400 bg-teal-50/40',
  rose:    'border-t-rose-400 bg-rose-50/40',
  red:     'border-t-red-400 bg-red-50/40',
  violet:  'border-t-violet-400 bg-violet-50/40',
}

function BizKpi({ label, value, hint, loading, accent = 'emerald', signColor = false }) {
  const n = Number(value || 0)
  const valueCls = signColor
    ? (n >= 0 ? 'text-emerald-600' : 'text-rose-600')
    : 'text-gray-900'
  return (
    <div className={`rounded-xl border border-gray-100 border-t-4 ${BIZ_ACCENT[accent] ?? BIZ_ACCENT.emerald} px-4 py-3 shadow-sm`}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      {loading && value == null ? (
        <div className="mt-2 h-6 w-24 rounded bg-gray-100 animate-pulse" />
      ) : (
        <p className={`mt-1 text-xl font-bold tabular-nums truncate ${valueCls}`}>
          ৳ {fmt(value)}
        </p>
      )}
      {hint && <p className="mt-0.5 text-[10px] text-gray-400">{hint}</p>}
    </div>
  )
}

const DUE_TONE = {
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  sky:     'bg-sky-500',
}

function DueTable({ title, tone = 'emerald', loading, rows, empty, headers, mapRow, linkTo }) {
  // Client-side pagination so a long dues list doesn't stretch the card —
  // 5 rows per page with a Prev/Next footer.
  const PAGE_SIZE = 5
  const [page, setPage] = useState(1)
  const allRows = rows || []
  const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [totalPages, page])
  const pageRows = allRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className={`${DUE_TONE[tone] ?? DUE_TONE.emerald} px-5 py-2.5 flex items-center justify-between`}>
        <h3 className="text-sm font-bold text-white tracking-tight">{title}</h3>
        {linkTo && (
          <Link to={linkTo} className="text-[11px] font-semibold text-white/85 hover:text-white">
            View all →
          </Link>
        )}
      </div>
      {loading && allRows.length === 0 ? (
        <div className="p-5 space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-8 rounded bg-gray-50 animate-pulse" />)}
        </div>
      ) : allRows.length === 0 ? (
        <div className="px-5 py-8 text-center text-xs text-gray-400">{empty}</div>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/70 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {headers.map((h, i) => (
                  <th key={h} className={`px-5 py-2.5 ${i === headers.length - 1 ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageRows.map((r, idx) => {
                const cells = mapRow(r)
                return (
                  <tr key={r.id ?? `${safePage}-${idx}`} className="hover:bg-gray-50/60">
                    {cells.map((c, i) => (
                      <td key={i} className={`px-5 py-2.5 ${i === cells.length - 1 ? 'text-right font-semibold tabular-nums text-gray-900' : i === 0 ? 'text-gray-800' : 'text-gray-600'}`}>
                        {c}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {allRows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-2.5 text-[11px] text-gray-500">
              <span>
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, allRows.length)} of {allRows.length}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Inline icons ─────────────────────────────────────────────────────────────

function RevenueIcon() {
  return <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 10.818v2.614A3.13 3.13 0 0011.888 13c.482-.315.612-.648.612-.875 0-.227-.13-.56-.612-.875a3.13 3.13 0 00-1.138-.432zM8.33 8.62c.053.055.115.11.184.164.208.16.46.284.736.363V6.603a2.45 2.45 0 00-.35.13c-.14.065-.27.143-.386.233-.377.292-.514.627-.514.909 0 .184.058.39.33.615z" /><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25v-.5a.75.75 0 00-1.5 0v.5a2.37 2.37 0 00-.5.172 3.021 3.021 0 00-.72.463c-.606.557-.78 1.28-.78 1.865 0 .604.211 1.298.795 1.884.322.323.737.574 1.205.738v2.741a2.99 2.99 0 01-.721-.348.75.75 0 00-.829 1.247 4.49 4.49 0 001.55.645v.5a.75.75 0 001.5 0v-.517a3.987 3.987 0 001.48-.537 3.25 3.25 0 001.27-2.821c-.028-1.025-.73-1.903-1.696-2.397a4.013 4.013 0 00-1.054-.372V8.24c.217.107.407.252.568.43a.75.75 0 001.124-.991A3.133 3.133 0 0010.75 6.75v-.001z" clipRule="evenodd" /></svg>
}
function CartIcon() {
  return <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M1 1.75A.75.75 0 011.75 1h1.628a1.75 1.75 0 011.734 1.51L5.18 3a65.25 65.25 0 0113.36 1.412.75.75 0 01.58.875 48.645 48.645 0 01-1.618 6.2.75.75 0 01-.712.513H6a2.503 2.503 0 00-2.292 1.5H17.25a.75.75 0 010 1.5H2.76a.75.75 0 01-.748-.807 4.002 4.002 0 012.716-3.486L3.626 2.716a.25.25 0 00-.248-.216H1.75A.75.75 0 011 1.75zM6 17.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM15.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" /></svg>
}
function AlertIcon() {
  return <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
}
function ClockIcon() {
  return <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd" /></svg>
}
function PlusIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" /></svg>
}
function BoxIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M2 4.25A2.25 2.25 0 014.25 2h2.5A2.25 2.25 0 019 4.25v2.5A2.25 2.25 0 016.75 9h-2.5A2.25 2.25 0 012 6.75v-2.5zM2 13.25A2.25 2.25 0 014.25 11h2.5A2.25 2.25 0 019 13.25v2.5A2.25 2.25 0 016.75 18h-2.5A2.25 2.25 0 012 15.75v-2.5zM11 4.25A2.25 2.25 0 0113.25 2h2.5A2.25 2.25 0 0118 4.25v2.5A2.25 2.25 0 0115.75 9h-2.5A2.25 2.25 0 0111 6.75v-2.5zM15.25 11.75a.75.75 0 00-1.5 0v2h-2a.75.75 0 000 1.5h2v2a.75.75 0 001.5 0v-2h2a.75.75 0 000-1.5h-2v-2z" /></svg>
}
function WalletIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 4A1.5 1.5 0 001 5.5V6h18v-.5A1.5 1.5 0 0017.5 4h-15zM19 8.5H1v6A1.5 1.5 0 002.5 16h15a1.5 1.5 0 001.5-1.5v-6zM3 13.25a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zm4.75-.75a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" /></svg>
}
function ChartIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M15.5 2A1.5 1.5 0 0014 3.5v13a1.5 1.5 0 003 0v-13A1.5 1.5 0 0015.5 2zM10.5 6A1.5 1.5 0 009 7.5v9a1.5 1.5 0 003 0v-9A1.5 1.5 0 0010.5 6zM5.5 10A1.5 1.5 0 004 11.5v5a1.5 1.5 0 003 0v-5A1.5 1.5 0 005.5 10z" /></svg>
}
function CogIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.114a7.04 7.04 0 010 2.226l1.267 1.114a1 1 0 01.205 1.25l-1.18 2.045a1 1 0 01-1.186.447l-1.598-.54a6.992 6.992 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447L1.616 13.27a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.226L1.821 7.566a1 1 0 01-.205-1.251l1.18-2.045a1 1 0 011.186-.447l1.598.54a6.993 6.993 0 011.929-1.114l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>
}
function ShieldIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9.661 2.237a.531.531 0 01.678 0 11.947 11.947 0 007.078 2.749.5.5 0 01.479.425c.069.52.104 1.05.104 1.589 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 01-.332 0C5.26 16.564 2 12.163 2 7c0-.538.035-1.069.104-1.589a.5.5 0 01.48-.425 11.947 11.947 0 007.077-2.749z" clipRule="evenodd" /></svg>
}
function GiftIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
    </svg>
  )
}
