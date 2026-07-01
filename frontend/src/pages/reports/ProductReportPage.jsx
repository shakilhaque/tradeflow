/**
 * Product Report (Purchase-detail view)
 *
 * One row per PurchaseItem — answers "what did we buy of this product, when,
 * from whom and at what price?". Matches the layout of the inspiration
 * screenshot but with a teal/emerald accent so it sits beside the Sell
 * Payment (cyan) and Purchase Payment (pink) reports without colour clashes.
 *
 * Filters: Search Product · Supplier · Business location · Date range.
 * Sticky tfoot totals computed across the FULL filtered set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { Link } from 'react-router-dom'
import { getProductPurchaseReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtQty = (n) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const yearStart = () => `${new Date().getFullYear()}-01-01`
const yearEnd   = () => `${new Date().getFullYear()}-12-31`

export default function ProductReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [search,     setSearch]     = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(yearEnd())

  // ── Paging ─────────────────────────────────────────────────────────────────
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
      const params = { page, limit }
      if (search.trim()) params.search   = search.trim()
      if (supplierId)    params.supplier_id = supplierId
      if (locationId)    params.location_id = locationId
      if (dateFrom)      params.date_from   = dateFrom
      if (dateTo)        params.date_to     = dateTo
      const res = await getProductPurchaseReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, limit, search, supplierId, locationId, dateFrom, dateTo])

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
  // an immediate refetch on tab/window focus, so newly recorded
  // purchases land on this page without a manual reload.
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

  const onApply = () => {
    if (page === 1) fetchReport()
    else setPage(1)
  }

  const onReset = () => {
    setSearch(''); setSupplierId(''); setLocationId('')
    setDateFrom(yearStart()); setDateTo(yearEnd())
    setPage(1)
  }

  const rows             = data?.rows ?? []
  const footer           = data?.footer ?? {}
  const totalPages       = data?.total_pages ?? 1
  const count            = data?.count ?? 0
  const supplierOptions  = data?.supplier_options ?? []
  const locationOptions  = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const csvHref = useMemo(() => buildCsv(rows, footer), [rows, footer])

  // ── Modern A4 print — self-contained popup: company header +
  // filter chips + KPI strip + the full purchase-lines table with a
  // bold TOTALS footer.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const supName = supplierId ? (supplierOptions.find((s) => s.id === supplierId)?.name || '') : 'All Suppliers'
    const locName = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'

    const body = rows.map((r, i) => `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td>${esc(r.product_name)}</td>
      <td class="mono">${esc(r.sku || '—')}</td>
      <td>${esc(r.supplier_name || '—')}</td>
      <td class="mono">${esc(r.reference_no || '—')}</td>
      <td class="nowrap">${esc(fmtDate(r.purchase_date))}</td>
      <td class="num">${fmtQty(r.quantity)}</td>
      <td class="num">${fmtQty(r.total_unit_adjusted)}</td>
      <td class="num">${fmtBDT(r.unit_price)}</td>
      <td class="num bold">${fmtBDT(r.subtotal)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">No purchase lines for these filters.</td></tr>'

    const w = window.open('', '_blank', 'width=1250,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Product Report — ${esc(company?.business_name || '')}</title>
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
    <h1 class="title">Product Report — Purchase Lines</h1>
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
  <div><div class="k">Supplier</div>${esc(supName)}</div>
  <div><div class="k">Location</div>${esc(locName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : '<div></div>'}
  <div><div class="k">Rows</div>Page ${page} — ${rows.length} of ${count}</div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Purchase Lines</div><div class="v">${fmtInt(footer.row_count)}</div></div>
  <div class="kpi"><div class="l">Total Quantity</div><div class="v">${fmtQty(footer.total_quantity)}</div></div>
  <div class="kpi"><div class="l">Adjustments</div><div class="v">${fmtQty(footer.total_adjustment)}</div></div>
  <div class="kpi"><div class="l">Total Purchase Value</div><div class="v" style="color:#059669">${fmtBDT(footer.total_subtotal)}</div></div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>Product</th><th>SKU</th><th>Supplier</th><th>Reference</th><th>Date</th>
    <th class="num">Quantity</th><th class="num">Adjusted</th><th class="num">Unit Price</th><th class="num">Subtotal</th>
  </tr></thead>
  <tbody>${body}</tbody>
  ${rows.length ? `<tfoot><tr>
    <td colspan="6">TOTALS (all filtered lines)</td>
    <td class="num">${fmtQty(footer.total_quantity)}</td>
    <td class="num">${fmtQty(footer.total_adjustment)}</td>
    <td></td>
    <td class="num">${fmtBDT(footer.total_subtotal)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>One row per purchased product line — quantity, supplier, price and reference.</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Product Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Detail-level view of every purchased product line — quantity,
              unit price, supplier and reference. Filter by product, supplier,
              location and date range.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Product Purchases
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Purchase lines"  value={fmtInt(footer.row_count)} accent="teal" />
        <Kpi label="Total quantity"  value={`${fmtQty(footer.total_quantity)} unit(s)`} accent="emerald" />
        <Kpi label="Adjustments"     value={`${fmtQty(footer.total_adjustment)} unit(s)`} accent="green" />
        <Kpi label="Total purchase value" value={fmtBDT(footer.total_subtotal)} accent="teal" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-2">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              Search product
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                <SearchIcon />
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onApply()}
                placeholder="Enter product name, SKU or scan barcode…"
                className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </div>
          <FieldSelect
            label="Supplier"
            value={supplierId}
            onChange={setSupplierId}
            options={[
              { value: '', label: 'All suppliers' },
              ...supplierOptions.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <FieldSelect
            label="Business location"
            value={locationId}
            onChange={setLocationId}
            options={[
              { value: '', label: 'All locations' },
              ...locationOptions.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
          <div className="lg:col-span-2 flex items-end justify-end gap-2">
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

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Table card ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <p className="text-sm font-semibold text-gray-800">Purchase lines</p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`product-purchases-${dateFrom}_${dateTo}.csv`}
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

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No purchase lines for these filters.
            </div>
          ) : (
            <LinesTable rows={rows} footer={footer} />
          )}
        </div>

        {!loading && rows.length > 0 && (
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
// Table
// ─────────────────────────────────────────────────────────────────────────────

function LinesTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Product</th>
          <th className="px-5 py-3">SKU</th>
          <th className="px-5 py-3">Supplier</th>
          <th className="px-5 py-3">Reference</th>
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3 text-right">Quantity</th>
          <th className="px-5 py-3 text-right">Adjusted</th>
          <th className="px-5 py-3 text-right">Unit price</th>
          <th className="px-5 py-3 text-right">Subtotal</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-gray-900 font-medium">{r.product_name}</td>
            <td className="px-5 py-3 font-mono text-xs text-gray-600">{r.sku || '—'}</td>
            <td className="px-5 py-3 text-gray-700">{r.supplier_name}</td>
            <td className="px-5 py-3">
              {r.purchase_id ? (
                <Link
                  to={`/purchases/${r.purchase_id}`}
                  className="font-mono text-xs font-semibold text-emerald-700 hover:underline"
                >
                  {r.reference_no}
                </Link>
              ) : (
                <span className="font-mono text-xs text-gray-500">{r.reference_no}</span>
              )}
            </td>
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDate(r.purchase_date)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">
              {fmtQty(r.quantity)}
              <span className="ml-1 text-[10px] text-gray-400">Pc(s)</span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums">
              <span className={Number(r.total_unit_adjusted) > 0 ? 'text-emerald-700' : 'text-gray-500'}>
                {fmtQty(r.total_unit_adjusted)}
                <span className="ml-1 text-[10px] text-gray-400">Pc(s)</span>
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.unit_price)}</td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-gray-900">{fmtBDT(r.subtotal)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={5}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered lines)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtQty(footer.total_quantity)}</td>
          <td className="px-5 py-3 text-right tabular-nums text-emerald-800">{fmtQty(footer.total_adjustment)}</td>
          <td className="px-5 py-3 text-right text-xs uppercase tracking-wider">—</td>
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(footer.total_subtotal)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows, footer = {}) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    'Product', 'SKU', 'Supplier', 'Reference', 'Date',
    'Quantity', 'Adjusted', 'Unit price', 'Subtotal',
  ]
  const lines = rows.map((r) => [
    r.product_name, r.sku, r.supplier_name, r.reference_no, r.purchase_date,
    r.quantity, r.total_unit_adjusted, r.unit_price, r.subtotal,
  ].map(esc).join(','))
  lines.push(['TOTAL', '', '', '', '',
    footer.total_quantity ?? '', footer.total_adjustment ?? '', '',
    footer.total_subtotal ?? ''].map(esc).join(','))
  // UTF-8 BOM so Bangla text + ৳ open correctly in Excel.
  return URL.createObjectURL(
    new Blob(['﻿' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent = 'teal' }) {
  const COLORS = {
    emerald: 'from-emerald-50 to-emerald-100 ring-emerald-200 text-emerald-700',
    green:   'from-green-50 to-green-100 ring-green-200 text-green-700',
    teal:    'from-teal-50 to-teal-100 ring-teal-200 text-teal-700',
    lime:    'from-lime-50 to-lime-100 ring-lime-200 text-lime-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.emerald} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
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
        <span className="px-3 py-1.5 text-xs font-semibold text-gray-700">Page {page} of {totalPages}</span>
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
function SearchIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3zM4.5 9a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
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
