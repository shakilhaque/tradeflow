/**
 * Stock Report
 *
 * Filter strip (Business location · Category · Sub-category · Brand · Unit)
 * drives a 4-card valuation summary and an items table with per-row
 * quantities, purchase-price valuation, sale-price valuation and lifetime
 * sold/transferred/adjusted counts. Sticky tfoot totals span the whole
 * filtered set. Pure green theme to match the rest of the Reports group.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getStockReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtQty = (n) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtPct = (n) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'

export default function StockReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [locationId,    setLocationId]    = useState('')
  const [categoryId,    setCategoryId]    = useState('')
  const [subcategoryId, setSubcategoryId] = useState('')
  const [brandId,       setBrandId]       = useState('')
  const [unitId,        setUnitId]        = useState('')
  const [lowOnly,       setLowOnly]       = useState(false)
  const [search,        setSearch]        = useState('')

  // ── Data ───────────────────────────────────────────────────────────────────
  const [report,  setReport]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  // ── Paging (client-side — the API returns the whole set) ──────────────────
  const [page,  setPage]  = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true) }
    setError('')
    try {
      const params = {}
      if (locationId)    params.location_id    = locationId
      if (categoryId)    params.category_id    = categoryId
      if (subcategoryId) params.subcategory_id = subcategoryId
      if (brandId)       params.brand_id       = brandId
      if (unitId)        params.unit_id        = unitId
      if (lowOnly)       params.low_stock_only = 'true'
      const res = await getStockReport(params)
      setReport(res)
      if (!silent) setPage(1)
    } catch (err) {
      setError(err?.message || 'Failed to load report')
      if (!silent) setReport(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [locationId, categoryId, subcategoryId, brandId, unitId, lowOnly])

  // Auto-apply — every filter change re-fires the request (the old
  // page required a manual "Apply filters" click, which read as
  // "filters don't work"). Small debounce coalesces rapid changes.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll while visible, plus an
  // immediate refetch when the operator returns to the tab/window
  // (e.g. after recording a purchase or sale elsewhere).
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

  // When the parent category changes, reset sub-category — and only show
  // sub-categories whose parent matches.
  useEffect(() => { setSubcategoryId('') }, [categoryId])

  const summary             = report?.summary ?? {}
  const allItems            = report?.items ?? []
  const categoryOptions     = report?.category_options ?? []
  const subcategoryOptions  = report?.subcategory_options ?? []
  const brandOptions        = report?.brand_options ?? []
  const unitOptions         = report?.unit_options ?? []
  const locationOptions     = report?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [report]) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleSubcategories = useMemo(() => {
    if (!categoryId) return subcategoryOptions
    return subcategoryOptions.filter((s) => s.parent_id === categoryId)
  }, [subcategoryOptions, categoryId])

  // Local search filter (applies to the API-returned set).
  const filtered = useMemo(() => {
    if (!search.trim()) return allItems
    const q = search.trim().toLowerCase()
    return allItems.filter((it) =>
      (it.name     || '').toLowerCase().includes(q) ||
      (it.sku      || '').toLowerCase().includes(q) ||
      (it.brand    || '').toLowerCase().includes(q) ||
      (it.category || '').toLowerCase().includes(q) ||
      (it.subcategory || '').toLowerCase().includes(q) ||
      (it.location || '').toLowerCase().includes(q)
    )
  }, [allItems, search])

  // Footer totals on the SEARCH-FILTERED set.
  const filteredTotals = useMemo(() => {
    let qty = 0, vP = 0, vS = 0, prof = 0, sold = 0, trans = 0, adj = 0
    for (const it of filtered) {
      qty   += Number(it.qty)                  || 0
      vP    += Number(it.stock_value_purchase) || 0
      vS    += Number(it.stock_value_sale)     || 0
      prof  += Number(it.potential_profit)     || 0
      sold  += Number(it.total_unit_sold)      || 0
      trans += Number(it.total_unit_transferred) || 0
      adj   += Number(it.total_unit_adjusted)  || 0
    }
    return { qty, vP, vS, prof, sold, trans, adj }
  }, [filtered])

  const count       = filtered.length
  const totalPages  = Math.max(Math.ceil(count / limit), 1)
  const pageRows    = filtered.slice((page - 1) * limit, page * limit)
  const csvHref     = useMemo(() => buildCsv(filtered), [filtered])

  const onApply = () => fetchReport()
  const onReset = () => {
    setLocationId(''); setCategoryId(''); setSubcategoryId('')
    setBrandId(''); setUnitId(''); setLowOnly(false); setSearch('')
  }

  // ── Modern A4 print — self-contained popup (company header +
  // filter chips + KPI strip + full filtered table + totals) instead
  // of dumping the live page DOM.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const qf = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const locName  = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const catName  = categoryId ? (categoryOptions.find((c) => c.id === categoryId)?.name || '') : 'All Categories'
    const brName   = brandId ? (brandOptions.find((b) => b.id === brandId)?.name || '') : 'All Brands'
    const unName   = unitId ? (unitOptions.find((u) => u.id === unitId)?.name || '') : 'All Units'

    const body = filtered.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td class="mono">${esc(r.sku || '—')}</td>
      <td>${esc(r.name)}<div class="muted">${esc([r.brand, r.category, r.subcategory].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(r.location)}</td>
      <td class="num">${money(r.unit_price)}</td>
      <td class="num">${qf(r.qty)} ${esc(r.unit || '')}</td>
      <td class="num">${money(r.stock_value_purchase)}</td>
      <td class="num">${money(r.stock_value_sale)}</td>
      <td class="num bold">${money(r.potential_profit)}</td>
      <td class="num">${qf(r.total_unit_sold)}</td>
      <td class="num">${qf(r.total_unit_transferred)}</td>
      <td class="num">${qf(r.total_unit_adjusted)}</td>
    </tr>`).join('') || '<tr><td colspan="12" class="empty">No products match these filters.</td></tr>'

    const w = window.open('', '_blank', 'width=1250,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Stock Report — ${esc(company?.business_name || '')}</title>
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
  .muted{color:#9ca3af;font-size:8px}
  .bold{font-weight:700}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Stock Report</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">Rows: <b>${filtered.length}</b></div>
  </div>
</div>

<div class="filters">
  <div><div class="k">Location</div>${esc(locName)}</div>
  <div><div class="k">Category</div>${esc(catName)}</div>
  <div><div class="k">Brand</div>${esc(brName)}</div>
  <div><div class="k">Unit</div>${esc(unName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : ''}
  ${lowOnly ? '<div><div class="k">Filter</div>Below reorder level only</div>' : ''}
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Closing stock (purchase)</div><div class="v">${money(summary.closing_stock_purchase_value)}</div></div>
  <div class="kpi"><div class="l">Closing stock (sale)</div><div class="v">${money(summary.closing_stock_sale_value)}</div></div>
  <div class="kpi"><div class="l">Potential profit</div><div class="v" style="color:#059669">${money(summary.potential_profit)}</div></div>
  <div class="kpi"><div class="l">Profit margin</div><div class="v">${qf(summary.profit_margin_pct)}%</div></div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>SKU</th><th>Product</th><th>Location</th>
    <th class="num">Unit Price</th><th class="num">Current Stock</th>
    <th class="num">Stock Value (Purchase)</th><th class="num">Stock Value (Sale)</th>
    <th class="num">Potential Profit</th>
    <th class="num">Total Sold</th><th class="num">Transferred</th><th class="num">Adjusted</th>
  </tr></thead>
  <tbody>${body}</tbody>
  ${filtered.length ? `<tfoot><tr>
    <td colspan="5">TOTALS (${filtered.length} rows)</td>
    <td class="num">${qf(filteredTotals.qty)}</td>
    <td class="num">${money(filteredTotals.vP)}</td>
    <td class="num">${money(filteredTotals.vS)}</td>
    <td class="num">${money(filteredTotals.prof)}</td>
    <td class="num">${qf(filteredTotals.sold)}</td>
    <td class="num">${qf(filteredTotals.trans)}</td>
    <td class="num">${qf(filteredTotals.adj)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>FIFO purchase-price valuation · sale-price valuation · potential profit</div>
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
            <h1 className="text-xl font-bold text-white tracking-tight">Stock Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Current inventory with FIFO purchase-price valuation, sale-price
              valuation, potential profit and per-product movement counts.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Stock
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Closing stock (purchase price)" value={fmtBDT(summary.closing_stock_purchase_value)} accent="emerald" />
        <Kpi label="Closing stock (sale price)"     value={fmtBDT(summary.closing_stock_sale_value)}     accent="green" />
        <Kpi label="Potential profit"               value={fmtBDT(summary.potential_profit)}             accent="teal" />
        <Kpi label="Profit margin"                  value={fmtPct(summary.profit_margin_pct)}            accent="lime" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
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
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: '', label: 'All categories' },
              ...categoryOptions.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <FieldSelect
            label="Sub category"
            value={subcategoryId}
            onChange={setSubcategoryId}
            options={[
              { value: '', label: categoryId ? 'All sub-categories' : 'Select category first' },
              ...visibleSubcategories.map((s) => ({ value: s.id, label: s.name })),
            ]}
            disabled={!categoryId && visibleSubcategories.length === 0}
          />
          <FieldSelect
            label="Brand"
            value={brandId}
            onChange={setBrandId}
            options={[
              { value: '', label: 'All brands' },
              ...brandOptions.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <FieldSelect
            label="Unit"
            value={unitId}
            onChange={setUnitId}
            options={[
              { value: '', label: 'All units' },
              ...unitOptions.map((u) => ({ value: u.id, label: `${u.name}${u.abbr ? ` (${u.abbr})` : ''}` })),
            ]}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 justify-between">
          <label className="inline-flex items-center gap-2 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-200"
            />
            Show only items below reorder level
          </label>
          <div className="flex gap-2">
            <button
              onClick={onReset}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
            >
              Reset
            </button>
            <button
              onClick={onApply}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              Apply filters
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search SKU, product, brand…"
            className="flex-1 sm:flex-initial sm:w-72 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`stock-report-${new Date().toISOString().slice(0, 10)}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <DownloadIcon /> CSV
            </a>
            <button
              onClick={() => fetchReport()}
              disabled={loading}
              title="Refresh now (auto-refresh every 30s)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-50"
            >
              ⟳ Refresh
            </button>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <PrintIcon /> Print
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
          ) : pageRows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No products match these filters.
            </div>
          ) : (
            <StockTable rows={pageRows} totals={filteredTotals} />
          )}
        </div>

        {!loading && pageRows.length > 0 && (
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

function StockTable({ rows, totals }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">SKU</th>
          <th className="px-5 py-3">Product</th>
          <th className="px-5 py-3">Location</th>
          <th className="px-5 py-3 text-right">Unit price</th>
          <th className="px-5 py-3 text-right">Current stock</th>
          <th className="px-5 py-3 text-right">Stock value (purchase)</th>
          <th className="px-5 py-3 text-right">Stock value (sale)</th>
          <th className="px-5 py-3 text-right">Potential profit</th>
          <th className="px-5 py-3 text-right">Total sold</th>
          <th className="px-5 py-3 text-right">Transferred</th>
          <th className="px-5 py-3 text-right">Adjusted</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r, i) => (
          <tr key={`${r.product_id}-${r.location_id}-${i}`} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.sku || '—'}</td>
            <td className="px-5 py-3">
              <div className="font-medium text-gray-900 flex items-center gap-1.5">
                {r.is_combo ? (
                  <span title="Quantity is derived from component stock — min(component_qty / per_bundle)">
                    {r.name}
                  </span>
                ) : r.name}
                {r.is_combo && (
                  <span className="inline-flex items-center rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-700">
                    Combo
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400">
                {[r.brand, r.category, r.subcategory].filter(Boolean).join(' · ') || '—'}
              </div>
            </td>
            <td className="px-5 py-3 text-gray-700">{r.location}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.unit_price)}</td>
            <td className="px-5 py-3 text-right tabular-nums">
              <span className={Number(r.qty) <= Number(r.reorder_level) ? 'text-red-600 font-semibold' : 'text-gray-900'}>
                {fmtQty(r.qty)}
                <span className="ml-1 text-[10px] text-gray-400">{r.unit || 'Pc(s)'}</span>
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">{fmtBDT(r.stock_value_purchase)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">{fmtBDT(r.stock_value_sale)}</td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-emerald-700">{fmtBDT(r.potential_profit)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtQty(r.total_unit_sold)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-500">{fmtQty(r.total_unit_transferred)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-500">{fmtQty(r.total_unit_adjusted)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={4}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered rows)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtQty(totals.qty)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(totals.vP)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(totals.vS)}</td>
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(totals.prof)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtQty(totals.sold)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtQty(totals.trans)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtQty(totals.adj)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    'SKU', 'Product', 'Category', 'Sub-category', 'Brand', 'Unit', 'Location',
    'Unit price', 'Current stock', 'Stock value (purchase)', 'Stock value (sale)',
    'Potential profit', 'Total sold', 'Transferred', 'Adjusted',
  ]
  const lines = rows.map((r) => [
    r.sku, r.name, r.category, r.subcategory, r.brand, r.unit, r.location,
    r.unit_price, r.qty, r.stock_value_purchase, r.stock_value_sale,
    r.potential_profit, r.total_unit_sold, r.total_unit_transferred, r.total_unit_adjusted,
  ].map(esc).join(','))
  return URL.createObjectURL(
    new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
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
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
    </div>
  )
}

function FieldSelect({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-gray-50 disabled:text-gray-400"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
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
