import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import Card from '../../components/ui/Card'
import { getProductSellReport, getCustomers } from '../../api/sales'
import { getBrands, getCategories, getLocations } from '../../api/products'
import { getCompanyProfile } from '../../api/companyProfile'

const today      = () => new Date().toISOString().slice(0, 10)
const yearStart  = () => `${new Date().getFullYear()}-01-01`
const yearEnd    = () => `${new Date().getFullYear()}-12-31`

const fmtBDT = (n) =>
  // Non-breaking space between the ৳ symbol and the amount so narrow
  // columns (e.g. Tax) never wrap the symbol onto its own line.
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtNum = (n, dp = 2) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })

const MODES = [
  { id: 'detailed',          label: 'Detailed',                icon: ListIcon },
  { id: 'detailed_purchase', label: 'Detailed (With purchase)', icon: ListIcon },
  { id: 'grouped',           label: 'Grouped',                 icon: GroupIcon },
  { id: 'by_category',       label: 'By Category',             icon: GroupIcon },
  { id: 'by_brand',          label: 'By Brand',                icon: GroupIcon },
]

export default function SalesReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [search,     setSearch]     = useState('')
  const [customerId, setCustomerId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [brandId,    setBrandId]    = useState('')
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(yearEnd())
  const [timeFrom,   setTimeFrom]   = useState('00:00')
  const [timeTo,     setTimeTo]     = useState('23:59')

  // ── Master data ───────────────────────────────────────────────────────────
  const [brands,     setBrands]     = useState([])
  const [categories, setCategories] = useState([])
  const [locations,  setLocations]  = useState([])
  const [customers,  setCustomers]  = useState([])

  // ── Report data ───────────────────────────────────────────────────────────
  const [mode,    setMode]    = useState('detailed')
  const [page,    setPage]    = useState(1)
  const [limit,   setLimit]   = useState(25)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [tableSearch, setTableSearch] = useState('')

  useEffect(() => {
    getBrands().then((d) => setBrands(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
    getCategories().then((d) => setCategories(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
    getLocations(true).then((d) => { const _l = Array.isArray(d) ? d : (d?.results ?? []); setLocations(_l); if (_l.length === 1) setLocationId((v) => v || String(_l[0].id)) }).catch(() => {})
    getCustomers({ active_only: true }).then((d) =>
      setCustomers(Array.isArray(d) ? d : (d?.results ?? []))
    ).catch(() => {})
  }, [])

  const fetchReport = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = { mode, page, limit }
      if (search.trim())  params.search       = search.trim()
      if (customerId)     params.customer_id  = customerId
      if (locationId)     params.location_id  = locationId
      if (categoryId)     params.category_id  = categoryId
      if (brandId)        params.brand_id     = brandId
      if (dateFrom)       params.date_from    = dateFrom
      if (dateTo)         params.date_to      = dateTo
      if (timeFrom)       params.time_from    = timeFrom
      if (timeTo)         params.time_to      = timeTo

      const res = await getProductSellReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [mode, page, limit, search, customerId, locationId, categoryId,
      brandId, dateFrom, dateTo, timeFrom, timeTo])

  // ── Auto-apply filters. The old page required a manual
  // "Apply" click for every dropdown change; the user reported
  // search/filter as "not working" because typing did nothing
  // visible. Every filter change now re-fires the request, with
  // a 350 ms debounce so each keystroke in the text search
  // doesn't fire its own request.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchReport()
    }, 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Reset page on mode switch
  useEffect(() => { setPage(1) }, [mode])

  // ── Real-time refresh. While the tab is visible, re-pull the
  // report every 30 s so newly-recorded sales show up without a
  // manual reload. Pauses on tab hide, re-fires on focus.
  useEffect(() => {
    let id = null
    const start = () => { if (id) return; id = setInterval(() => { if (!document.hidden) fetchReport() }, 30000) }
    const stop  = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { fetchReport(); start() } }
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [fetchReport])

  const onApplyFilters = () => {
    if (page === 1) fetchReport()
    else setPage(1)
  }

  const resetFilters = () => {
    setSearch(''); setCustomerId(''); setLocationId(''); setCategoryId(''); setBrandId('')
    setDateFrom(yearStart()); setDateTo(yearEnd())
    setTimeFrom('00:00'); setTimeTo('23:59')
    setPage(1)
  }

  // ── Client-side filter for table-level search ──────────────────────────────
  const rows = useMemo(() => {
    const r = data?.results || []
    if (!tableSearch.trim()) return r
    const t = tableSearch.toLowerCase()
    return r.filter((x) =>
      Object.values(x).some((v) => String(v ?? '').toLowerCase().includes(t))
    )
  }, [data, tableSearch])

  // ── CSV export (current page) ──────────────────────────────────────────────
  const exportCSV = () => {
    if (!rows.length) return
    const headers = Object.keys(rows[0])
    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `product-sell-report-${mode}-${today()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Modern A4 print — opens a popup with a self-contained
  // report instead of dumping the live page DOM (which printed
  // the filter card, tabs, search box, etc.). Header is pulled
  // live from company profile and the active filter labels.
  const printReport = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc  = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const num   = (n, dp = 2) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })

    const customerName = customerId ? (customers.find((c) => c.id === customerId)?.name || '') : 'All Customers'
    const locationName = locationId ? (locations.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const categoryName = categoryId ? (categories.find((c) => c.id === categoryId)?.name || '') : 'All Categories'
    const brandName    = brandId    ? (brands.find((b) => b.id === brandId)?.name || '')       : 'All Brands'
    const modeLabel    = MODES.find((m) => m.id === mode)?.label || mode

    const dtStr = (iso) => { try { return iso ? new Date(iso).toLocaleString() : '—' } catch { return '—' } }

    // Build the body table based on the active mode
    let head = '', body = '', cols = 0
    if (mode === 'detailed' || mode === 'detailed_purchase') {
      const extra = mode === 'detailed_purchase'
      head = `<tr>
        <th>#</th><th>Product</th><th>SKU</th><th>Customer</th>
        <th>Invoice</th><th>Date</th>
        <th class="num">Qty</th><th class="num">Unit Price</th>
        <th class="num">Discount</th><th class="num">Tax</th>
        <th class="num">Inc. Tax</th><th class="num">Total</th>
        ${extra ? '<th class="num">Purchase</th><th class="num">Profit</th>' : ''}
      </tr>`
      cols = extra ? 14 : 12
      body = rows.map((r, i) => `<tr>
        <td>${i + 1 + (page - 1) * limit}</td>
        <td>${esc(r.product)}</td>
        <td class="muted">${esc(r.sku)}</td>
        <td>${esc(r.customer_name)}</td>
        <td class="bold">${esc(r.invoice_no)}</td>
        <td class="muted nowrap">${esc(dtStr(r.date))}</td>
        <td class="num">${num(r.quantity)} ${esc(r.unit_label || '')}</td>
        <td class="num">${money(r.unit_price)}</td>
        <td class="num red">${money(r.discount)}</td>
        <td class="num">${money(r.tax)}</td>
        <td class="num">${money(r.price_inc_tax)}</td>
        <td class="num bold">${money(r.total)}</td>
        ${extra ? `<td class="num">${money(r.purchase_price)}</td><td class="num ${Number(r.profit) >= 0 ? 'green' : 'red'} bold">${money(r.profit)}</td>` : ''}
      </tr>`).join('')
    } else {
      const labelHeader = mode === 'grouped' ? 'Product' : mode === 'by_category' ? 'Category' : 'Brand'
      head = `<tr>
        <th>#</th><th>${labelHeader}</th>
        ${mode === 'grouped' ? '<th>SKU</th>' : ''}
        <th class="num">Total Quantity</th>
        <th class="num">Total Sale</th>
      </tr>`
      cols = mode === 'grouped' ? 5 : 4
      body = rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(r.name)}</td>
        ${mode === 'grouped' ? `<td class="muted">${esc(r.sku)}</td>` : ''}
        <td class="num">${num(r.quantity)}</td>
        <td class="num bold">${money(r.total)}</td>
      </tr>`).join('')
    }

    if (!body) {
      body = `<tr><td colspan="${cols}" class="empty">No data for the selected filters.</td></tr>`
    }

    const totQty   = data?.summary?.total_quantity ?? rows.reduce((s, r) => s + Number(r.quantity || 0), 0)
    const totSale  = data?.summary?.total_sale     ?? rows.reduce((s, r) => s + Number(r.total || 0), 0)
    const totCount = data?.count ?? rows.length

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Product Sell Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:10mm 8mm;font-size:10.5px}
  .hdr{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:12px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0;letter-spacing:.4px}
  .sub{color:#6b7280;font-size:9.5px}
  .meta{font-size:10px;line-height:1.55}
  .filters{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:10px}
  .filters .k{color:#065f46;font-weight:600;letter-spacing:.3px;text-transform:uppercase;font-size:9px;margin-bottom:1px}
  .filters .v{color:#111827}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;background:#fff}
  .kpi .l{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:14px;font-weight:700;color:#111827;margin-top:2px}
  .kpi.green .v{color:#059669}
  table{width:100%;border-collapse:collapse;font-size:9.5px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:#6b7280}
  .bold{font-weight:700}
  .red{color:#dc2626}
  .green{color:#059669}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#f9fafb;font-weight:800;border-top:2px solid #111827;font-size:10px}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:9px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Product Sell Report</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">View</div>
    <div><b>${esc(modeLabel)}</b></div>
    <div class="sub" style="margin-top:4px">Period</div>
    <div><b>${esc(dateFrom)} → ${esc(dateTo)}</b> &nbsp; <span class="muted">(${esc(timeFrom)}–${esc(timeTo)})</span></div>
    <div class="sub" style="margin-top:4px">Generated: ${esc(new Date().toLocaleString())}</div>
  </div>
</div>

<div class="filters">
  <div><div class="k">Customer</div><div class="v">${esc(customerName)}</div></div>
  <div><div class="k">Location</div><div class="v">${esc(locationName)}</div></div>
  <div><div class="k">Category</div><div class="v">${esc(categoryName)}</div></div>
  <div><div class="k">Brand</div><div class="v">${esc(brandName)}</div></div>
  ${search ? `<div><div class="k">Search</div><div class="v">${esc(search)}</div></div>` : ''}
  ${tableSearch ? `<div><div class="k">Table Search</div><div class="v">${esc(tableSearch)}</div></div>` : ''}
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Quantity</div><div class="v">${num(totQty)}</div></div>
  <div class="kpi green"><div class="l">Total Sale</div><div class="v">${money(totSale)}</div></div>
  <div class="kpi"><div class="l">Total Rows</div><div class="v">${num(totCount, 0)}</div></div>
</div>

<table>
  <thead>${head}</thead>
  <tbody>${body}</tbody>
  ${(mode === 'detailed' || mode === 'detailed_purchase') && rows.length ? `
  <tfoot><tr>
    <td colspan="6">PAGE TOTAL</td>
    <td class="num">${num(rows.reduce((s, r) => s + Number(r.quantity || 0), 0))}</td>
    <td></td>
    <td class="num red">${money(rows.reduce((s, r) => s + Number(r.discount || 0), 0))}</td>
    <td class="num">${money(rows.reduce((s, r) => s + Number(r.tax || 0), 0))}</td>
    <td></td>
    <td class="num">${money(rows.reduce((s, r) => s + Number(r.total || 0), 0))}</td>
    ${mode === 'detailed_purchase' ? `
      <td class="num">${money(rows.reduce((s, r) => s + Number(r.purchase_price || 0) * Number(r.quantity || 0), 0))}</td>
      <td class="num bold">${money(rows.reduce((s, r) => s + Number(r.profit || 0), 0))}</td>
    ` : ''}
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>Rows on this page: <b>${rows.length}</b> &nbsp;|&nbsp; Total rows in scope: <b>${totCount}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-2 h-7 rounded-full bg-gradient-to-b from-indigo-600 to-cyan-500" />
            Product Sell Report
          </h1>
          <p className="mt-1 text-sm text-gray-500">Detailed and grouped views of sold items</p>
        </div>
      </div>

      {/* Filters Card */}
      <Card padding="p-0" className="overflow-hidden border-emerald-100 ring-1 ring-emerald-50">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-emerald-100 bg-gradient-to-r from-indigo-50 to-cyan-50">
          <FilterIcon className="w-5 h-5 text-emerald-600" />
          <h2 className="font-semibold text-emerald-800">Filters</h2>
        </div>

        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Search Product */}
          <Field label="Search Product">
            <div className="relative">
              <SearchIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onApplyFilters()}
                placeholder="Product name / SKU / Barcode"
                className="w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 py-2 text-sm
                           outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
          </Field>

          {/* Customer */}
          <Field label="Customer">
            <Select value={customerId} onChange={setCustomerId} placeholder="All Customers">
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>

          {/* Business Location */}
          <Field label="Business Location">
            <Select value={locationId} onChange={setLocationId} placeholder="All Locations">
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </Field>

          {/* Category */}
          <Field label="Category">
            <Select value={categoryId} onChange={setCategoryId} placeholder="All Categories">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>

          {/* Brand */}
          <Field label="Brand">
            <Select value={brandId} onChange={setBrandId} placeholder="All Brands">
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </Field>

          {/* Date Range */}
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />

          {/* Time range */}
          <Field label="Time Range">
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm
                           outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <span className="text-gray-400 text-xs">to</span>
              <input
                type="time"
                value={timeTo}
                onChange={(e) => setTimeTo(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm
                           outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
          </Field>

          {/* Action buttons */}
          <div className="flex items-end gap-2">
            <button
              onClick={onApplyFilters}
              disabled={loading}
              className="flex-1 rounded-lg bg-gradient-to-r from-indigo-600 to-cyan-500 px-4 py-2 text-sm
                         font-semibold text-white shadow-sm hover:from-indigo-600 hover:to-cyan-700
                         disabled:opacity-60"
            >
              {loading ? 'Loading…' : 'Apply'}
            </button>
            <button
              onClick={resetFilters}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium
                         text-gray-700 hover:bg-gray-50"
            >
              Reset
            </button>
          </div>
        </div>
      </Card>

      {/* Summary KPIs (only for detailed modes) */}
      {data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Kpi label="Total Quantity" value={fmtNum(data.summary.total_quantity, 0)} icon={<CubeIcon />} />
          <Kpi label="Total Sale"     value={fmtBDT(data.summary.total_sale)}        icon={<MoneyIcon />} highlight />
          <Kpi label="Rows in Page"   value={fmtNum(rows.length, 0)}                  icon={<RowsIcon />} />
          <Kpi label="Total Rows"     value={fmtNum(data.count, 0)}                   icon={<DbIcon />} />
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Mode tabs + actions */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 bg-gray-50/70 px-3 pt-3">
          {MODES.map((m) => {
            const Icon = m.icon
            const active = mode === m.id
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={[
                  'flex items-center gap-2 px-4 py-2 rounded-t-lg text-sm font-medium transition-all border-b-2',
                  active
                    ? 'bg-white text-emerald-700 border-emerald-500 shadow-sm'
                    : 'bg-transparent text-gray-600 border-transparent hover:text-emerald-600 hover:bg-white/60',
                ].join(' ')}
              >
                <Icon className="w-4 h-4" />
                {m.label}
              </button>
            )
          })}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>Show</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm
                         outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {[10, 25, 50, 100, 250].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>entries</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={fetchReport}
              disabled={loading}
              className="btn-action bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60"
              title="Refresh now (auto-refresh every 30s)"
            >
              ⟳ Refresh
            </button>
            <button onClick={exportCSV} className="btn-action bg-emerald-600 hover:bg-emerald-700">
              <DownloadIcon className="w-3.5 h-3.5" /> Export CSV
            </button>
            <button onClick={printReport} className="btn-action bg-emerald-600 hover:bg-emerald-700">
              <PrintIcon className="w-3.5 h-3.5" /> Print
            </button>
            <div className="relative">
              <SearchIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Search…"
                className="rounded-lg border border-gray-300 bg-white pl-9 pr-3 py-1.5 text-sm
                           outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 w-44"
              />
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          {loading ? (
            <div className="py-12 text-center text-gray-500">Loading…</div>
          ) : !rows.length ? (
            <div className="py-12 text-center text-gray-400">No data found for the selected filters.</div>
          ) : (
            <ReportTable mode={mode} rows={rows} />
          )}
        </div>

        {/* Pagination — only for detailed modes */}
        {data && (mode === 'detailed' || mode === 'detailed_purchase') && data.total_pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 text-sm">
            <span className="text-gray-500">
              Page {data.page} of {data.total_pages} — {data.count} total
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.total_pages, p + 1))}
                disabled={page >= data.total_pages}
                className="px-3 py-1 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>

      <style>{`
        .btn-action {
          display: inline-flex; align-items: center; gap: 0.35rem;
          padding: 0.4rem 0.75rem; border-radius: 0.5rem;
          font-size: 0.75rem; font-weight: 600; color: white;
          transition: background-color .15s;
        }
      `}</style>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function Select({ value, onChange, placeholder, children }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                 outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500
                 cursor-pointer"
    >
      <option value="">{placeholder}</option>
      {children}
    </select>
  )
}

function Kpi({ label, value, icon, highlight }) {
  return (
    <div className={[
      'rounded-xl border p-4 flex items-center gap-3 shadow-sm',
      highlight
        ? 'bg-gradient-to-br from-indigo-600 to-cyan-500 border-emerald-600 text-white'
        : 'bg-white border-gray-100 text-gray-700',
    ].join(' ')}>
      <div className={[
        'w-10 h-10 rounded-lg flex items-center justify-center',
        highlight ? 'bg-white/20' : 'bg-emerald-50 text-emerald-600',
      ].join(' ')}>
        {icon}
      </div>
      <div>
        <div className={['text-xs font-medium', highlight ? 'text-white/80' : 'text-gray-500'].join(' ')}>{label}</div>
        <div className={['text-lg font-bold', highlight ? 'text-white' : 'text-gray-900'].join(' ')}>{value}</div>
      </div>
    </div>
  )
}

function ReportTable({ mode, rows }) {
  if (mode === 'detailed' || mode === 'detailed_purchase') {
    return (
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-emerald-50/60 text-left text-xs font-semibold text-emerald-900 uppercase tracking-wide">
            <Th>Product</Th>
            <Th>SKU</Th>
            <Th>Customer</Th>
            <Th>Contact ID</Th>
            <Th>Invoice No.</Th>
            <Th>Date</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Unit Price</Th>
            <Th align="right">Discount</Th>
            <Th align="right">Tax</Th>
            <Th align="right">Inc. Tax</Th>
            <Th align="right">Total</Th>
            {mode === 'detailed_purchase' && <Th align="right">Purchase</Th>}
            {mode === 'detailed_purchase' && <Th align="right">Profit</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-emerald-50/30">
              <Td className="font-medium text-gray-900">{r.product}</Td>
              <Td className="text-gray-500">{r.sku}</Td>
              <Td>{r.customer_name}</Td>
              <Td className="text-gray-500">{r.contact_id}</Td>
              <Td className="text-emerald-700 font-medium">{r.invoice_no}</Td>
              <Td className="text-gray-500 whitespace-nowrap">{formatDate(r.date)}</Td>
              <Td align="right">{fmtNum(r.quantity, 2)} {r.unit_label || ''}</Td>
              <Td align="right">{fmtBDT(r.unit_price)}</Td>
              <Td align="right" className="text-red-500">{fmtBDT(r.discount)}</Td>
              <Td align="right">{fmtBDT(r.tax)}</Td>
              <Td align="right">{fmtBDT(r.price_inc_tax)}</Td>
              <Td align="right" className="font-semibold text-gray-900">{fmtBDT(r.total)}</Td>
              {mode === 'detailed_purchase' && <Td align="right">{fmtBDT(r.purchase_price)}</Td>}
              {mode === 'detailed_purchase' && (
                <Td align="right" className={Number(r.profit) >= 0 ? 'text-emerald-600 font-semibold' : 'text-red-500 font-semibold'}>
                  {fmtBDT(r.profit)}
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Grouped / By Category / By Brand
  const labelHeader =
    mode === 'grouped'     ? 'Product' :
    mode === 'by_category' ? 'Category' :
                             'Brand'
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-emerald-50/60 text-left text-xs font-semibold text-emerald-900 uppercase tracking-wide">
          <Th>{labelHeader}</Th>
          {mode === 'grouped' && <Th>SKU</Th>}
          <Th align="right">Total Quantity</Th>
          <Th align="right">Total Sale</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r, i) => (
          <tr key={r.id ?? i} className="hover:bg-emerald-50/30">
            <Td className="font-medium text-gray-900">{r.name}</Td>
            {mode === 'grouped' && <Td className="text-gray-500">{r.sku}</Td>}
            <Td align="right">{fmtNum(r.quantity, 2)}</Td>
            <Td align="right" className="font-semibold text-gray-900">{fmtBDT(r.total)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Th({ children, align = 'left' }) {
  return <th className={`px-4 py-3 text-${align}`}>{children}</th>
}
function Td({ children, align = 'left', className = '' }) {
  return <td className={`px-4 py-3 text-${align} ${className}`}>{children}</td>
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const date = d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `${date} ${time}`
  } catch { return iso }
}

// ── Icons ─────────────────────────────────────────────────────────────────────
function FilterIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 9v6l-4 2v-8L3 4z" />
  </svg>
)}
function SearchIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" />
  </svg>
)}
function ListIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
)}
function GroupIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M7 12h10M10 18h4" />
  </svg>
)}
function CubeIcon() { return (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5-9 5m18 0l-9 5m9-5v9l-9 5m0-14l-9 5m9 5v9m0-9L3 7.5m0 0v9l9 5" />
  </svg>
)}
function MoneyIcon() { return (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.66 0-3 .9-3 2s1.34 2 3 2 3 .9 3 2-1.34 2-3 2m0-8V6m0 12v-2" />
    <circle cx="12" cy="12" r="10" />
  </svg>
)}
function RowsIcon() { return (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="5" rx="1" /><rect x="3" y="11" width="18" height="5" rx="1" /><rect x="3" y="18" width="18" height="3" rx="1" />
  </svg>
)}
function DbIcon() { return (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
  </svg>
)}
function DownloadIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v3h16v-3M12 3v12m0 0l-4-4m4 4l4-4" />
  </svg>
)}
function PrintIcon(p) { return (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v7H6z" />
  </svg>
)}
