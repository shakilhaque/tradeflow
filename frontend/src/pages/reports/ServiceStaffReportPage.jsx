/**
 * Service Staff Report
 *
 * Two views ("Orders" / "Line Orders") of finalised sales, scoped to staff
 * members that signed them off. Filters: business location, service staff,
 * date range. CSV + Print export. Modern emerald styling that matches the
 * other reports.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { getServiceStaffReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString().slice(0, 10)
}
const monthEnd = () => {
  // Day 0 of next month = last day of current month. The "12" hour avoids
  // any UTC-vs-local-timezone date rollover when toISOString() runs.
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).toISOString().slice(0, 10)
}

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtDT  = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const MODES = [
  { id: 'orders', label: 'Orders' },
  { id: 'lines',  label: 'Line Orders' },
]

export default function ServiceStaffReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState('')
  const [staffId,    setStaffId]    = useState('')
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(monthEnd())
  const [search,     setSearch]     = useState('')

  // ── Mode + paging ──────────────────────────────────────────────────────────
  const [mode,  setMode]  = useState('orders')
  const [page,  setPage]  = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const params = { mode, page, limit }
      if (locationId) params.location_id = locationId
      if (staffId)    params.staff_id    = staffId
      if (dateFrom)   params.date_from   = dateFrom
      if (dateTo)     params.date_to     = dateTo
      if (search.trim()) params.search   = search.trim()

      const res = await getServiceStaffReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [mode, page, limit, locationId, staffId, dateFrom, dateTo, search])

  // Auto-apply — every filter change re-fires the request (the old
  // page required a manual "Apply filters" click, which read as
  // broken filters). 350 ms debounce so each keystroke in the text
  // search doesn't fire its own request.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll while the tab is visible plus
  // an immediate refetch on tab/window focus, so freshly finalised
  // sales appear under their staff without a manual reload.
  useEffect(() => {
    let id = null
    const start = () => { if (id) return; id = setInterval(() => { if (!document.hidden) fetchReport(true) }, 30000) }
    const stop  = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { fetchReport(true); start() } }
    const onFocus = () => { if (!document.hidden) fetchReport(true) }
    start()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchReport])

  // Reset to first page when changing mode
  useEffect(() => { setPage(1) }, [mode])

  const onApply = () => {
    if (page === 1) fetchReport()
    else setPage(1)
  }

  const onReset = () => {
    setLocationId(''); setStaffId(''); setSearch('')
    setDateFrom(monthStart()); setDateTo(monthEnd())
    setPage(1)
  }

  const rows           = data?.rows ?? []
  const summary        = data?.summary ?? {}
  const footer         = data?.footer ?? {}
  const totalPages     = data?.total_pages ?? 1
  const count          = data?.count ?? 0
  const staffOptions   = data?.staff_options ?? []
  const locationOptions = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const csvHref = useMemo(() => buildCsvBlobHref(rows, mode), [rows, mode])

  // ── Modern A4 print — self-contained popup: company header +
  // filter chips + KPI strip + the active view's table (Orders or
  // Line Orders) with a TOTALS footer.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const locName   = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const staffName = staffId ? (staffOptions.find((s) => s.id === staffId)?.name || '') : 'All Staff'
    const isOrders  = mode === 'orders'

    const head = isOrders
      ? '<th>#</th><th>Date</th><th>Invoice No</th><th>Service Staff</th><th>Location</th><th>Customer</th><th class="num">Subtotal</th><th class="num">Discount</th><th class="num">Tax</th><th class="num">Total</th>'
      : '<th>#</th><th>Date</th><th>Invoice No</th><th>Service Staff</th><th>Location</th><th>Product</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Discount</th><th class="num">Line Total</th>'

    const body = rows.map((r, i) => isOrders ? `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td class="nowrap">${esc(fmtDT(r.finalized_at))}</td>
      <td class="mono">${esc(r.invoice_number || '—')}</td>
      <td>${esc(r.staff_name || '—')}</td>
      <td>${esc(r.location_name || '—')}</td>
      <td>${esc(r.customer_name || '—')}</td>
      <td class="num">${fmtBDT(r.subtotal)}</td>
      <td class="num">${fmtBDT(r.discount)}</td>
      <td class="num">${fmtBDT(r.tax)}</td>
      <td class="num bold">${fmtBDT(r.total)}</td>
    </tr>` : `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td class="nowrap">${esc(fmtDT(r.finalized_at))}</td>
      <td class="mono">${esc(r.invoice_number || '—')}</td>
      <td>${esc(r.staff_name || '—')}</td>
      <td>${esc(r.location_name || '—')}</td>
      <td>${esc(r.product_name || '—')}</td>
      <td class="num">${Number(r.quantity || 0).toLocaleString()}</td>
      <td class="num">${fmtBDT(r.unit_price)}</td>
      <td class="num">${fmtBDT(r.discount)}</td>
      <td class="num bold">${fmtBDT(r.total)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">No rows for these filters.</td></tr>'

    const pageTotal = rows.reduce((s, r) => s + Number(r.total || 0), 0)

    const w = window.open('', '_blank', 'width=1250,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Service Staff Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:9.5px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:9px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-family:ui-monospace,monospace}
  .bold{font-weight:700}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Service Staff Report — ${isOrders ? 'Orders' : 'Line Orders'}</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Period</div>
    <div><b>${esc(dateFrom)} → ${esc(dateTo)}</b></div>
    <div class="sub" style="margin-top:4px">Generated: ${esc(new Date().toLocaleString())}</div>
  </div>
</div>

<div class="filters">
  <div><div class="k">Service Staff</div>${esc(staffName)}</div>
  <div><div class="k">Location</div>${esc(locName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : '<div></div>'}
  <div><div class="k">Rows</div>Page ${page} — ${rows.length} of ${count}</div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Orders</div><div class="v">${fmtInt(summary.total_orders)}</div></div>
  <div class="kpi"><div class="l">Total Revenue</div><div class="v" style="color:#059669">${fmtBDT(summary.total_revenue)}</div></div>
  <div class="kpi"><div class="l">Total Discount</div><div class="v">${fmtBDT(summary.total_discount)}</div></div>
  <div class="kpi"><div class="l">Unique Staff</div><div class="v">${fmtInt(summary.unique_staff)}</div></div>
</div>

<table>
  <thead><tr>${head}</tr></thead>
  <tbody>${body}</tbody>
  ${rows.length ? `<tfoot><tr>
    <td colspan="9">PAGE TOTAL (${rows.length} rows)</td>
    <td class="num">${fmtBDT(pageTotal)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>Finalised sales scoped to the staff who served them.</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Service Staff Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Performance of every staff member who finalised a sale, including
              order count, revenue, and discounts. Switch tabs for per-line detail.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Staff
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total orders"     value={fmtInt(summary.total_orders)} accent="emerald" />
        <Kpi label="Total revenue"    value={fmtBDT(summary.total_revenue)} accent="emerald" />
        <Kpi label="Total discount"   value={fmtBDT(summary.total_discount)} accent="green" />
        <Kpi label="Unique staff"     value={fmtInt(summary.unique_staff)} accent="emerald" />
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FieldSelect
            label="Business location"
            value={locationId}
            onChange={setLocationId}
            options={[
              { value: '', label: 'All locations' },
              ...locationOptions.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <FieldSelect
            label="Service staff"
            value={staffId}
            onChange={setStaffId}
            options={[
              { value: '', label: 'All staff' },
              ...staffOptions.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 justify-between">
          <div className="flex-1 min-w-[200px] max-w-md">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              Search
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onApply()}
              placeholder="Invoice no, customer name or phone…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={onReset}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
            >
              Reset
            </button>
            <button
              onClick={onApply}
              disabled={loading}
              title="Refresh now (auto-refresh every 30s; filters apply instantly)"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              ⟳ Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── Tabs + actions ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <nav className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={[
                  'rounded-lg px-4 py-2 text-sm font-medium transition',
                  mode === m.id
                    ? 'bg-emerald-50 text-emerald-700 shadow-sm ring-1 ring-emerald-200'
                    : 'text-gray-600 hover:bg-gray-50',
                ].join(' ')}
              >
                {m.label}
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`service-staff-${mode}-${dateFrom}_${dateTo}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <DownloadIcon /> CSV / Excel
            </a>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <PrintIcon /> Print / PDF
            </button>
            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            >
              {[10, 25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Table ──────────────────────────────────────────────────────── */}
        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : error ? (
            <div className="px-6 py-10 text-center text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No sales found for the selected filters.
            </div>
          ) : mode === 'orders' ? (
            <OrdersTable rows={rows} footer={footer} />
          ) : (
            <LinesTable rows={rows} footer={footer} />
          )}
        </div>

        {/* ── Pagination ─────────────────────────────────────────────────── */}
        {!loading && !error && rows.length > 0 && (
          <Pager
            page={page}
            totalPages={totalPages}
            count={count}
            limit={limit}
            onChange={setPage}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────

function OrdersTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Invoice no.</th>
          <th className="px-5 py-3">Service staff</th>
          <th className="px-5 py-3">Location</th>
          <th className="px-5 py-3 text-right">Subtotal</th>
          <th className="px-5 py-3 text-right">Discount</th>
          <th className="px-5 py-3 text-right">Tax</th>
          <th className="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDT(r.finalized_at)}</td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.invoice_number}</td>
            <td className="px-5 py-3 text-gray-800">{r.staff_name}</td>
            <td className="px-5 py-3 text-gray-700">{r.location_name}</td>
            <td className="px-5 py-3 text-right text-gray-900">{fmtBDT(r.subtotal)}</td>
            <td className="px-5 py-3 text-right text-emerald-700">{fmtBDT(r.discount)}</td>
            <td className="px-5 py-3 text-right text-gray-700">{fmtBDT(r.tax)}</td>
            <td className="px-5 py-3 text-right font-semibold text-gray-900">{fmtBDT(r.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={4}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered rows)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.subtotal)}</td>
          <td className="px-5 py-3 text-right text-emerald-800 tabular-nums">{fmtBDT(footer.discount)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.tax)}</td>
          <td className="px-5 py-3 text-right text-base font-bold tabular-nums">{fmtBDT(footer.total)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

function LinesTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Invoice no.</th>
          <th className="px-5 py-3">Service staff</th>
          <th className="px-5 py-3">Product</th>
          <th className="px-5 py-3 text-right">Qty</th>
          <th className="px-5 py-3 text-right">Unit price</th>
          <th className="px-5 py-3 text-right">Discount</th>
          <th className="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDT(r.finalized_at)}</td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.invoice_number}</td>
            <td className="px-5 py-3 text-gray-800">{r.staff_name}</td>
            <td className="px-5 py-3 text-gray-700">{r.product_name}</td>
            <td className="px-5 py-3 text-right text-gray-900">{Number(r.quantity || 0).toLocaleString()}</td>
            <td className="px-5 py-3 text-right text-gray-700">{fmtBDT(r.unit_price)}</td>
            <td className="px-5 py-3 text-right text-emerald-700">{fmtBDT(r.discount)}</td>
            <td className="px-5 py-3 text-right font-semibold text-gray-900">{fmtBDT(r.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={4}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered rows)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">
            {Number(footer.quantity || 0).toLocaleString()}
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.subtotal)}</td>
          <td className="px-5 py-3 text-right text-emerald-800 tabular-nums">{fmtBDT(footer.discount)}</td>
          <td className="px-5 py-3 text-right text-base font-bold tabular-nums">{fmtBDT(footer.total)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function buildCsvBlobHref(rows, mode) {
  if (!rows?.length) return '#'
  const header = mode === 'orders'
    ? ['Date', 'Invoice No', 'Service staff', 'Location', 'Customer', 'Subtotal', 'Discount', 'Tax', 'Total']
    : ['Date', 'Invoice No', 'Service staff', 'Location', 'Product', 'Qty', 'Unit price', 'Discount', 'Line total']

  const escape = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lines = rows.map((r) => {
    if (mode === 'orders') {
      return [
        r.finalized_at || '', r.invoice_number, r.staff_name, r.location_name,
        r.customer_name, r.subtotal, r.discount, r.tax, r.total,
      ].map(escape).join(',')
    }
    return [
      r.finalized_at || '', r.invoice_number, r.staff_name, r.location_name,
      r.product_name, r.quantity, r.unit_price, r.discount, r.total,
    ].map(escape).join(',')
  })

  // TOTAL row across the exported rows.
  const totalSum = rows.reduce((s, r) => s + Number(r.total || 0), 0)
  lines.push(['TOTAL', '', '', '', '', '', '', '', totalSum.toFixed(2)].join(','))

  const csv = [header.join(','), ...lines].join('\n')
  // UTF-8 BOM so Bangla text + ৳ open correctly in Excel.
  return URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent = 'emerald' }) {
  const COLORS = {
    emerald: 'from-indigo-50 to-cyan-100 ring-emerald-200 text-emerald-700',
    green:   'from-indigo-50 to-cyan-100 ring-green-200 text-green-700',
    teal:    'from-teal-50 to-teal-100 ring-teal-200 text-teal-700',
    lime:    'from-lime-50 to-lime-100 ring-lime-200 text-lime-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.emerald} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}

function FieldSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function FieldDate({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      />
    </div>
  )
}

function Pager({ page, totalPages, count, limit, onChange }) {
  const start = (page - 1) * limit + 1
  const end   = Math.min(page * limit, count)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3 text-sm">
      <p className="text-xs text-gray-500">
        Showing <span className="font-semibold text-gray-700">{start.toLocaleString()}</span>
        {' – '}
        <span className="font-semibold text-gray-700">{end.toLocaleString()}</span>
        {' of '}
        <span className="font-semibold text-gray-700">{count.toLocaleString()}</span>
      </p>
      <div className="inline-flex items-center gap-1">
        <PagerButton onClick={() => onChange(1)} disabled={page === 1}>«</PagerButton>
        <PagerButton onClick={() => onChange(page - 1)} disabled={page === 1}>‹</PagerButton>
        <span className="px-3 py-1.5 text-xs font-semibold text-gray-700">
          Page {page} of {totalPages}
        </span>
        <PagerButton onClick={() => onChange(page + 1)} disabled={page >= totalPages}>›</PagerButton>
        <PagerButton onClick={() => onChange(totalPages)} disabled={page >= totalPages}>»</PagerButton>
      </div>
    </div>
  )
}

function PagerButton({ children, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:border-emerald-500 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

function FilterIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM4 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H4.75A.75.75 0 014 10zm3 5.25a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75z" clipRule="evenodd" />
    </svg>
  )
}
function DownloadIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
      <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
    </svg>
  )
}
function PrintIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5 2.75A2.75 2.75 0 017.75 0h4.5A2.75 2.75 0 0115 2.75v1.5h.25A2.75 2.75 0 0118 7v3.25A2.75 2.75 0 0115.25 13H15v3.25A1.75 1.75 0 0113.25 18h-6.5A1.75 1.75 0 015 16.25V13h-.25A2.75 2.75 0 012 10.25V7a2.75 2.75 0 012.75-2.75H5v-1.5zm1.5 0v1.5h7v-1.5a1.25 1.25 0 00-1.25-1.25h-4.5A1.25 1.25 0 006.5 2.75zM5 11.5h10v-1.25a1.25 1.25 0 00-1.25-1.25h-7.5A1.25 1.25 0 005 10.25v1.25zm1.5 1.5v3.25c0 .138.112.25.25.25h6.5a.25.25 0 00.25-.25V13h-7z" clipRule="evenodd" />
    </svg>
  )
}
