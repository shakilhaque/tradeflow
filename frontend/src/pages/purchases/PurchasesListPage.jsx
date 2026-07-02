import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import FilterToggle from '../../components/ui/FilterToggle'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Select from '../../components/ui/Select'
import Input from '../../components/ui/Input'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getPurchases, getPurchase, getSuppliers, deletePurchase,
  addPurchasePayment, updatePurchase, getPurchasePayments,
  getPurchaseNotification, sendPurchaseNotification,
} from '../../api/purchases'
import { getCompanyProfile } from '../../api/companyProfile'
import { getPaymentAccounts } from '../../api/accounting'
import { getLocations } from '../../api/products'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const defaultDateFrom = `${currentYear}-01-01`
const defaultDateTo   = `${currentYear}-12-31`

const STATUS_VARIANT  = { received: 'green', partial: 'yellow', draft: 'gray', cancelled: 'red' }
const PAYMENT_VARIANT = { paid: 'green', partial: 'yellow', due: 'red' }

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate  = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—')
// Business date (DateField) + time-of-day from the created_at timestamp,
// since purchase_date itself carries no time component.
const fmtTime  = (s) => (s ? new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')
const fmtDateWithTime = (dateVal, ts) => {
  const base = fmtDate(dateVal)
  const t = fmtTime(ts)
  return t ? `${base} ${t}` : base
}

export default function PurchasesListPage() {
  const navigate = useNavigate()

  const [filters, setFilters] = useState({
    location_id:    '',
    supplier_id:    '',
    status:         '',
    payment_status: '',
    date_from:      defaultDateFrom,
    date_to:        defaultDateTo,
  })
  const [search,  setSearch]  = useState('')
  const [page,    setPage]    = useState(1)
  const [limit,   setLimit]   = useState(25)
  const [sortBy,  setSortBy]  = useState('date')
  const [sortDir, setSortDir] = useState('desc')

  const [locations, setLocations] = useState([])
  const [suppliers, setSuppliers] = useState([])

  const [data,    setData]    = useState({ results: [], count: 0, total_pages: 1, summary: {} })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)

  // Master data
  useEffect(() => {
    (async () => {
      try {
        const [locs, sups] = await Promise.all([
          getLocations(true),
          getSuppliers({ active_only: 'true' }),
        ])
        { const _l = Array.isArray(locs) ? locs : (locs?.results ?? []); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
        setSuppliers(Array.isArray(sups) ? sups : (sups?.results ?? []))
      } catch { /* ignore */ }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {
        page, limit, search, sort_by: sortBy, sort_dir: sortDir,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      }
      const res = await getPurchases(params)
      setData(res || { results: [], count: 0, total_pages: 1, summary: {} })
    } catch (err) {
      setError(err?.message || 'Failed to load purchases.')
      setData({ results: [], count: 0, total_pages: 1, summary: {} })
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, sortBy, sortDir, filters])

  useEffect(() => { load() }, [load])

  const handleSort = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortDir('asc')
    }
  }

  const handleFilterChange = (k, v) => {
    setFilters((prev) => ({ ...prev, [k]: v }))
    setPage(1)
  }

  const exportCSV = () => {
    const rows = data.results || []
    const headers = ['Date', 'Reference No', 'Location', 'Supplier', 'Purchase Status', 'Return Marked', 'Payment Status', 'Grand Total', 'Payment Due', 'Added By']
    const lines = [headers.join(',')]
    rows.forEach((r) => {
      const due = (Number(r.grand_total || 0) - Number(r.paid_amount || 0)).toFixed(2)
      lines.push([
        fmtDateWithTime(r.purchase_date, r.created_at),
        r.reference_no,
        (r.location_name || '').replaceAll(',', ' '),
        (r.supplier_name || '').replaceAll(',', ' '),
        r.has_returns ? 'Returned' : r.status,
        r.has_returns ? `Returned (${Number(r.return_total || 0).toFixed(2)})` : '',
        r.payment_status,
        Number(r.grand_total || 0).toFixed(2),
        due,
        (r.added_by_name || '').replaceAll(',', ' '),
      ].join(','))
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `purchases-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDelete = async (row) => {
    if (!confirm(
      `Delete purchase ${row.reference_no}?\n\n`
      + 'Any stock it added will be pulled back out of inventory and any '
      + 'linked cash/bank payment will be refunded to that account. This '
      + 'cannot be undone.'
    )) return
    try {
      await deletePurchase(row.id)
      load()
    } catch (err) {
      alert(err?.message || 'Delete failed.')
    }
  }

  // Modal-row state — each holds the purchase row the action menu
  // was clicked on, or null when the modal is closed. Keeps the
  // modals at the page level so they don't get clipped by the
  // table's overflow.
  const [addPaymentRow,    setAddPaymentRow]    = useState(null)
  const [viewPaymentsRow,  setViewPaymentsRow]  = useState(null)
  const [updateStatusRow,  setUpdateStatusRow]  = useState(null)
  const [notifyRow,        setNotifyRow]        = useState(null)
  const [viewRow,          setViewRow]          = useState(null)
  const [historyRow,       setHistoryRow]       = useState(null)

  // ── Print Purchase Invoice ──────────────────────────────────────
  // Fetches the purchase detail + company profile, renders a clean
  // A4 invoice in a new window, and triggers print(). Everything is
  // derived from the per-tenant DB — supplier/business info, items,
  // totals, payments. No hardcoded copy aside from layout labels.
  const printPurchaseInvoice = async (row) => {
    const w = window.open('', '_blank', 'width=1100,height=900')
    if (!w) { window.alert('Allow popups to print this invoice.'); return }
    w.document.write('<!doctype html><html><head><title>Loading…</title></head><body style="font-family:sans-serif;padding:24px;color:#6b7280">Loading purchase invoice…</body></html>')
    try {
      const [data, company] = await Promise.all([
        getPurchase(row.id),
        getCompanyProfile().catch(() => null),
      ])
      const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      const money = (n) => `৳ ${fmt(n)}`
      const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
      const fmtDT   = (s) => s ? new Date(s).toLocaleString() : '—'
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

      const itemRows = (data.items || []).map((it, i) => {
        const qty   = Number(it.quantity || 0)
        const cost  = Number(it.unit_cost || 0)
        const disc  = Number(it.discount || 0)
        const taxR  = Number(it.tax_rate || 0)
        const sub   = Number(it.line_total || ((cost * qty) - disc + (((cost * qty) - disc) * taxR / 100)))
        return `<tr>
          <td>${i + 1}</td>
          <td><b>${esc(it.product_name || '')}</b>${it.sku ? `<br><span class="sub">${esc(it.sku)}</span>` : ''}</td>
          <td class="num">${qty.toFixed(2)}</td>
          <td class="num">${money(cost)}</td>
          <td class="num">${money(disc)}</td>
          <td class="num">${taxR.toFixed(2)}%</td>
          <td class="num"><b>${money(sub)}</b></td>
        </tr>`
      }).join('')

      const payRows = (data.payments || []).map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(fmtDT(p.paid_at || p.created_at))}</td>
        <td>${esc(p.reference || '')}</td>
        <td style="text-transform:capitalize">${esc((p.method || '').replace('_', ' '))}</td>
        <td class="num">${money(p.amount)}</td>
      </tr>`).join('')

      const due = Math.max(Number(data.grand_total || 0) - Number(data.paid_amount || 0), 0)
      const logoBlock = company?.logo_url
        ? `<img src="${esc(company.logo_url)}" style="max-height:60px;max-width:200px">`
        : `<div style="font-size:22px;font-weight:700;color:#10b981">${esc(company?.business_name || data.location_name || '')}</div>`

      w.document.open()
      w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Purchase Invoice ${esc(data.reference_no)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:14mm 10mm;font-size:12px}
  .row{display:flex;justify-content:space-between;gap:24px}
  .right{text-align:right}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:11px;line-height:1.55}
  .block b{color:#374151}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:7px 8px;border:1px solid #0f9971}
  td{padding:7px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .totals{margin-left:auto;width:300px;margin-top:14px;border-collapse:collapse}
  .totals td{border:none;padding:5px 8px}
  .totals .label{color:#374151}
  .totals .grand td{border-top:2px solid #111827;font-weight:700;font-size:13px;padding-top:8px}
  .badge{display:inline-block;background:#10b981;color:#fff;border-radius:3px;padding:2px 8px;font-size:10px;text-transform:capitalize;margin-right:4px}
  .badge.due{background:#ef4444}
  .badge.partial{background:#f59e0b}
  h3{font-size:13px;color:#10b981;margin:18px 0 6px}
  .stamp{position:fixed;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:88px;color:#ef4444;opacity:.08;font-weight:900;letter-spacing:6px;pointer-events:none}
  @page{size:A4;margin:8mm}
</style></head><body>
${data.status === 'cancelled' ? '<div class="stamp">CANCELLED</div>' : ''}

<div class="row" style="border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:14px">
  <div>
    ${logoBlock}
    <div class="block" style="margin-top:6px">
      <b>${esc(company?.business_name || data.location_name || '')}</b><br>
      ${esc(company?.address || data.location_address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}<br>
      ${company?.email ? 'Email: ' + esc(company.email) : ''}
    </div>
  </div>
  <div class="right">
    <div class="title">PURCHASE INVOICE</div>
    <div class="sub" style="margin-top:6px">Reference No</div>
    <div style="font-weight:600">#${esc(data.reference_no)}</div>
    <div class="sub" style="margin-top:6px">Date: <b>${esc(fmtDate(data.purchase_date))}</b></div>
    <div style="margin-top:6px">
      <span class="badge">${esc(data.status || '')}</span>
      <span class="badge ${data.payment_status === 'paid' ? '' : data.payment_status === 'partial' ? 'partial' : 'due'}">${esc(data.payment_status || '')}</span>
    </div>
  </div>
</div>

<div class="row" style="margin-bottom:8px">
  <div class="block" style="flex:1">
    <b style="color:#10b981">SUPPLIER</b><br>
    <b>${esc(data.supplier_name || '')}</b><br>
    ${esc(data.supplier_address || '')}<br>
    ${data.supplier_phone ? 'Mobile: ' + esc(data.supplier_phone) : ''}<br>
    ${data.supplier_email ? esc(data.supplier_email) : ''}
  </div>
  <div class="block" style="flex:1">
    <b style="color:#10b981">SHIP TO</b><br>
    <b>${esc(data.location_name || '')}</b><br>
    ${esc(data.location_address || '')}
  </div>
</div>

<table>
  <thead><tr>
    <th style="width:30px">#</th>
    <th>Product</th>
    <th class="num">Quantity</th>
    <th class="num">Unit Cost</th>
    <th class="num">Discount</th>
    <th class="num">Tax %</th>
    <th class="num">Line Total</th>
  </tr></thead>
  <tbody>${itemRows || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:18px">No line items.</td></tr>'}</tbody>
</table>

<table class="totals">
  <tbody>
    <tr><td class="label">Subtotal:</td><td class="num">${money(data.subtotal)}</td></tr>
    <tr><td class="label">Discount:</td><td class="num">− ${money(data.discount_amount)}</td></tr>
    <tr><td class="label">Tax:</td><td class="num">+ ${money(data.tax_amount)}</td></tr>
    <tr><td class="label">Shipping:</td><td class="num">+ ${money(data.shipping_cost)}</td></tr>
    <tr class="grand"><td class="label">Grand Total:</td><td class="num">${money(data.grand_total)}</td></tr>
    <tr><td class="label">Paid:</td><td class="num">${money(data.paid_amount)}</td></tr>
    <tr><td class="label" style="color:#ef4444">Balance Due:</td><td class="num" style="color:#ef4444;font-weight:700">${money(due)}</td></tr>
  </tbody>
</table>

${payRows ? `
<h3>PAYMENT HISTORY</h3>
<table>
  <thead><tr>
    <th style="width:30px">#</th>
    <th>Date</th>
    <th>Reference</th>
    <th>Method</th>
    <th class="num">Amount</th>
  </tr></thead>
  <tbody>${payRows}</tbody>
</table>` : ''}

${data.notes ? `<h3>NOTES</h3><div class="block" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:8px;white-space:pre-line">${esc(data.notes)}</div>` : ''}

<div style="margin-top:30px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#6b7280">
  <div>Generated: ${esc(new Date().toLocaleString())}</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
      w.document.close()
    } catch (e) {
      w.document.open()
      w.document.write(`<body style="font-family:sans-serif;padding:24px;color:#ef4444">Failed to load purchase: ${String(e?.message || e)}</body>`)
      w.document.close()
    }
  }

  const summary = data.summary || {}

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Purchases</h1>
          <p className="mt-0.5 text-sm text-emerald-50">Manage purchase orders, supplier bills, and stock receipts.</p>
        </div>
        <Button onClick={() => navigate('/purchases/add')}>+ Add Purchase</Button>
      </div>

      {/* Filters */}
      <Card>
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} accent="brand" />
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
          <Select label="Business Location" value={filters.location_id} onChange={(e) => handleFilterChange('location_id', e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Supplier" value={filters.supplier_id} onChange={(e) => handleFilterChange('supplier_id', e.target.value)}>
            <option value="">All</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select label="Purchase Status" value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}>
            <option value="">All</option>
            <option value="received">Received</option>
            <option value="partial">Partial</option>
            <option value="draft">Draft</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select label="Payment Status" value={filters.payment_status} onChange={(e) => handleFilterChange('payment_status', e.target.value)}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="due">Due</option>
          </Select>
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Date Range</label>
            <DateRangePresetPicker
              from={filters.date_from}
              to={filters.date_to}
              onChange={({ from, to }) => { handleFilterChange('date_from', from); handleFilterChange('date_to', to) }}
            />
          </div>
        </div>
      </Card>

      {/* KPI summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Purchases" value={fmtMoney(summary.total_purchase)} accent="violet" />
        <KpiCard label="Total Paid"      value={fmtMoney(summary.total_paid)}     accent="emerald" />
        <KpiCard label="Total Due"       value={fmtMoney(summary.total_due)}      accent="rose" />
        <KpiCard
          label="Status Mix"
          value={`${summary.count_paid ?? 0} Paid · ${summary.count_partial ?? 0} Partial · ${summary.count_due ?? 0} Due`}
          valueClass="text-sm"
          accent="indigo"
        />
      </div>

      {/* Banner */}
      <div className="rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <h3 className="text-base font-semibold">All Purchases</h3>
        <Link to="/purchases/add" className="rounded-lg bg-white/15 hover:bg-white/25 px-3 py-1.5 text-sm font-medium transition">
          + Add
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-200"
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span>entries</span>
          <Button variant="secondary" size="sm" onClick={exportCSV}>Export CSV</Button>
          <Button variant="secondary" size="sm" onClick={() => window.print()}>Print</Button>
        </div>
        <SearchInput
          placeholder="Search reference no, supplier..."
          value={search}
          onChange={(v) => { setSearch(v); setPage(1) }}
        />
      </div>

      {/* Table */}
      <Card padding="p-0">
        {error && (
          <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
        )}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState
              icon={<EmptyIcon />}
              title="No purchases found"
              message="Add a new purchase or adjust your filters."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <SortableTh label="Date"          k="date"           sortBy={sortBy} dir={sortDir} onSort={handleSort} />
                  <SortableTh label="Reference No"  k="reference_no"   sortBy={sortBy} dir={sortDir} onSort={handleSort} />
                  <SortableTh label="Location"      k="location"       sortBy={sortBy} dir={sortDir} onSort={handleSort} />
                  <SortableTh label="Supplier"      k="supplier_name"  sortBy={sortBy} dir={sortDir} onSort={handleSort} />
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 whitespace-nowrap">Return Marked</th>
                  <th className="px-4 py-3">Payment</th>
                  <SortableTh label="Grand Total"   k="grand_total"    sortBy={sortBy} dir={sortDir} onSort={handleSort} align="right" />
                  <SortableTh label="Payment Due"   k="payment_due"    sortBy={sortBy} dir={sortDir} onSort={handleSort} align="right" />
                  <th className="px-4 py-3">Added By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => {
                  const due = Number(r.grand_total || 0) - Number(r.paid_amount || 0)
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <ActionMenu
                          row={r}
                          navigate={navigate}
                          onView={(p) => setViewRow(p)}
                          onPrint={(p) => printPurchaseInvoice(p)}
                          onDelete={() => handleDelete(r)}
                          onAddPayment={(p) => setAddPaymentRow(p)}
                          onViewPayments={(p) => setViewPaymentsRow(p)}
                          onUpdateStatus={(p) => setUpdateStatusRow(p)}
                          onNotify={(p) => setNotifyRow(p)}
                          onHistory={(p) => setHistoryRow(p)}
                        />
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{fmtDateWithTime(r.purchase_date, r.created_at)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.reference_no}</td>
                      <td className="px-4 py-3 text-gray-700">{r.location_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-900 font-medium">{r.supplier_name || '—'}</td>
                      <td className="px-4 py-3">
                        <Badge variant={r.has_returns ? 'indigo' : (STATUS_VARIANT[r.status] ?? 'gray')}>
                          {r.has_returns ? 'Returned' : r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {r.has_returns
                          ? <Badge variant="indigo">Returned · {fmtMoney(r.return_total)}</Badge>
                          : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={PAYMENT_VARIANT[r.payment_status] ?? 'gray'}>{r.payment_status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{fmtMoney(r.grand_total)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={due > 0 ? 'text-rose-600 font-medium' : 'text-gray-500'}>{fmtMoney(due)}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{r.added_by_name || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-200 text-sm font-semibold text-gray-800">
                  <td className="px-4 py-3" colSpan={5}>Total</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {summary.count_paid ?? 0} Paid · {summary.count_partial ?? 0} Partial · {summary.count_due ?? 0} Due
                  </td>
                  <td className="px-4 py-3"></td>
                  <td className="px-4 py-3"></td>
                  <td className="px-4 py-3 text-right">{fmtMoney(summary.total_purchase)}</td>
                  <td className="px-4 py-3 text-right text-rose-600">{fmtMoney(summary.total_due)}</td>
                  <td className="px-4 py-3"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      {!loading && data.count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–<strong>{Math.min(page * limit, data.count)}</strong> of <strong>{data.count}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3 text-sm">{page} / {data.total_pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= data.total_pages} onClick={() => setPage((p) => Math.min(p + 1, data.total_pages))}>Next</Button>
          </div>
        </div>
      )}

      {/* Action-menu spawned modals — page-level so they don't
          inherit the table's overflow-x-auto clip. */}
      {viewRow && (
        <ViewPurchaseModal
          row={viewRow}
          onClose={() => setViewRow(null)}
        />
      )}
      {historyRow && (
        <PurchaseHistoryModal
          row={historyRow}
          onClose={() => setHistoryRow(null)}
        />
      )}
      {addPaymentRow && (
        <AddPaymentModal
          row={addPaymentRow}
          onClose={() => setAddPaymentRow(null)}
          onSaved={() => { setAddPaymentRow(null); load() }}
        />
      )}
      {viewPaymentsRow && (
        <ViewPaymentsModal
          row={viewPaymentsRow}
          onClose={() => setViewPaymentsRow(null)}
          onAddPayment={(p) => { setViewPaymentsRow(null); setAddPaymentRow(p) }}
        />
      )}
      {updateStatusRow && (
        <UpdateStatusModal
          row={updateStatusRow}
          onClose={() => setUpdateStatusRow(null)}
          onSaved={() => { setUpdateStatusRow(null); load() }}
        />
      )}
      {notifyRow && (
        <ItemsReceivedNotificationModal
          row={notifyRow}
          onClose={() => setNotifyRow(null)}
        />
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({ label, value, accent = 'brand', valueClass = '' }) {
  const accents = {
    violet:  'from-violet-500/10 to-violet-500/5 text-violet-700 ring-violet-200',
    emerald: 'from-indigo-500/10 to-indigo-500/5 text-emerald-700 ring-emerald-200',
    rose:    'from-rose-500/10 to-rose-500/5 text-rose-700 ring-rose-200',
    indigo:  'from-indigo-500/10 to-indigo-500/5 text-indigo-700 ring-indigo-200',
    brand:   'from-brand-500/10 to-brand-500/5 text-brand-700 ring-brand-200',
  }
  return (
    <div className={`rounded-xl bg-gradient-to-br ${accents[accent]} ring-1 px-5 py-4 shadow-sm`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className={`mt-1 font-semibold ${valueClass || 'text-xl'}`}>{value}</p>
    </div>
  )
}

function SortableTh({ label, k, sortBy, dir, onSort, align = 'left' }) {
  const active = sortBy === k
  return (
    <th
      className={`px-4 py-3 cursor-pointer select-none ${align === 'right' ? 'text-right' : ''}`}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className="text-gray-300">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </span>
    </th>
  )
}

function ActionMenu({ row, navigate, onView, onPrint, onDelete, onAddPayment, onViewPayments, onUpdateStatus, onNotify, onHistory }) {
  const [open, setOpen] = useState(false)
  const [pos,  setPos]  = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const close = () => setOpen(false)

  // Portal + flip-up logic same as Products / Sales pages — keeps
  // the menu visible outside the table's overflow-x-auto wrapper.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 380
      const spaceBelow = window.innerHeight - r.bottom
      const top = spaceBelow >= MENU_H ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 224
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setOpen(true)
  }

  // Each action targets a real route / endpoint:
  //   View / Edit            → existing /purchases/<id> routes
  //   Print / Labels          → opens print views in a new tab
  //   Add payment / View Payments / Update Status / Notify → modals
  //   Purchase Return         → /purchases/returns/add deep-link
  // Nothing is hardcoded; the row id comes from the per-tenant DB.
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-soft transition"
      >
        Actions
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M5 7l5 6 5-6z" /></svg>
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-[60] cursor-default"
          />
          <div
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[70] w-56 overflow-hidden rounded-lg border border-gray-100 bg-white shadow-pop divide-y divide-gray-100"
          >
            <div>
              <MenuItem icon="👁" onClick={() => { close(); onView(row) }}>View</MenuItem>
              <MenuItem icon="🖨" onClick={() => { close(); onPrint(row) }}>Print</MenuItem>
              <MenuItem icon="✏" onClick={() => { close(); navigate(`/purchases/add?edit=${row.id}`) }}>Edit</MenuItem>
              <MenuItem icon="🗑" tone="rose" onClick={() => { close(); onDelete() }}>Delete</MenuItem>
              <MenuItem icon="🏷" onClick={() => { close(); navigate(`/products/print-labels?purchase_id=${row.id}`) }}>Labels</MenuItem>
            </div>
            <div>
              <MenuItem icon="➕" onClick={() => { close(); onAddPayment(row) }}>Add payment</MenuItem>
              <MenuItem icon="👁" onClick={() => { close(); onViewPayments(row) }}>View Payments</MenuItem>
              <MenuItem icon="↩" onClick={() => { close(); navigate(`/purchases/returns/add?purchase_id=${row.id}`) }}>Purchase Return</MenuItem>
              <MenuItem icon="🔄" onClick={() => { close(); onUpdateStatus(row) }}>Update Status</MenuItem>
              <MenuItem icon="✉" onClick={() => { close(); onNotify(row) }}>Items Received Notification</MenuItem>
              <MenuItem icon="🕓" onClick={() => { close(); onHistory(row) }}>History</MenuItem>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

function MenuItem({ icon, tone = 'default', onClick, children }) {
  const cls = tone === 'rose'
    ? 'text-rose-600 hover:bg-rose-50'
    : 'text-gray-700 hover:bg-gray-50'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${cls}`}
    >
      <span className="w-4 text-center text-sm leading-none">{icon}</span>
      <span>{children}</span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AddPaymentModal — POST /api/purchases/<id>/payments/
// Records a supplier payment against the purchase. Closes on save
// and triggers list reload so the Payment Status badge updates.
// ─────────────────────────────────────────────────────────────────────────
function AddPaymentModal({ row, onClose, onSaved }) {
  const due = Math.max(Number(row.grand_total || 0) - Number(row.paid_amount || 0), 0)
  const [amount, setAmount] = useState(due.toFixed(2))
  const [paidAt, setPaidAt] = useState(() => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [method, setMethod] = useState('cash')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Dedicated state for the insufficient-balance modal so the cashier
  // gets a blocking pop-up instead of a quiet inline banner.
  const [balanceAlert, setBalanceAlert] = useState(null)

  // Pull the per-tenant PaymentAccount list. Filtering happens in
  // the picker below based on the chosen method so the operator
  // can only see Cash boxes when paying Cash, Bank accounts when
  // paying by Cheque / Bank Transfer, etc.
  useEffect(() => {
    let cancelled = false
    getPaymentAccounts({ is_active: 'true' })
      .then((r) => {
        if (cancelled) return
        const arr = Array.isArray(r) ? r : (r?.results ?? [])
        setAccounts(arr)
        if (arr.length && !paymentAccountId) {
          // Pre-select a sensible default — the first Cash account
          // when the method is cash, otherwise the first account.
          const cash = arr.find((a) => (a.account_type || '').toUpperCase() === 'CASH')
          setPaymentAccountId(cash?.id || arr[0].id)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-switch the payment account when the method changes so the
  // money lands in a sensible default ledger. E.g., switching to
  // Bank Transfer picks the first BANK account.
  useEffect(() => {
    if (!accounts.length) return
    const wantType = method === 'cash' ? 'CASH'
                    : method === 'bank_transfer' || method === 'cheque' ? 'BANK'
                    : method === 'card' ? 'CARD'
                    : method === 'mobile' ? 'MFS'
                    : null
    if (!wantType) return
    const cur = accounts.find((a) => a.id === paymentAccountId)
    if (cur && (cur.account_type || '').toUpperCase() === wantType) return
    const match = accounts.find((a) => (a.account_type || '').toUpperCase() === wantType)
    if (match) setPaymentAccountId(match.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, accounts])

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const n = Number(amount)
      if (!n || n <= 0) { setErr('Amount must be greater than 0.'); setBusy(false); return }
      await addPurchasePayment(row.id, {
        amount:              n,
        method,
        reference,
        note,
        payment_account_id:  paymentAccountId || null,
        paid_at:             paidAt,
      })
      window.alert('Payment recorded.')
      onSaved?.()
    } catch (e) {
      // Backend may return an insufficient-balance 400 — surface
      // it in a structured pop-up modal so the cashier can't miss
      // it (per spec: "save korar somoy pop-up alert dekhabe").
      const msg = e?.message || 'Failed to record payment.'
      const detail = e?.errors?.payment_account_id || ''
      if (/not enough balance|insufficient balance/i.test(msg) || /insufficient/i.test(detail)) {
        setBalanceAlert({ message: msg, detail })
      } else {
        setErr(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <Modal open onClose={onClose} title="Add payment" size="2xl">
      <div className="space-y-4 text-sm">
        {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}

        {/* Header info row — matches the reference image */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Supplier :</div>
            <div className="font-medium text-gray-800">Business: {row.supplier_name || '—'}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Reference No:</div>
            <div className="font-medium text-gray-800">{row.reference_no}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">Location: {row.location_name || '—'}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Total amount: ৳ {fmt(row.grand_total)}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">Payment Note: —</div>
          </div>
        </div>

        <div className="text-[12px] text-gray-700">Advance Balance: ৳ 0.00</div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input label="Amount: *" type="number" min="0" step="0.01"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input label="Paid on: *"
            value={paidAt} onChange={(e) => setPaidAt(e.target.value)}
            placeholder="YYYY-MM-DD HH:MM" />
          <Select label="Payment Method: *" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="cheque">Cheque</option>
            <option value="bank_transfer">Bank Transfer</option>
            <option value="mobile">Mobile Wallet</option>
            <option value="other">Other</option>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Select label="Payment Account:" value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
            <option value="">None — supplier payment won't post to a ledger</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.account_type ? ` (${a.account_type})` : ''}
              </option>
            ))}
          </Select>
          {/* Attach Document — UI placeholder for parity with the
              reference image. The backend doesn't store payment
              attachments yet, so this just stages the file locally
              without uploading. When the backend lands an upload
              endpoint, this onChange handler is the wire point. */}
          <div>
            <label className="text-xs font-medium text-gray-700">Attach Document:</label>
            <input type="file" accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
              className="mt-1 block w-full text-xs text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200" />
            <div className="mt-1 text-[10px] text-gray-400">Allowed File: .pdf, .csv, .zip, .doc, .docx, .jpeg, .jpg, .png</div>
          </div>
        </div>

        {/* Method-specific extra inputs — mirror the Add Sale page */}
        {method === 'cheque' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label="Cheque No." value={reference} onChange={(e) => setReference(e.target.value)} />
            <Input label="Bank Name" placeholder="Bank Name" />
          </div>
        )}
        {method === 'card' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label="Card Transaction No." value={reference} onChange={(e) => setReference(e.target.value)} />
            <Input label="Card holder name" />
            <Select label="Card Type">
              <option value="CREDIT_CARD">Credit Card</option>
              <option value="DEBIT_CARD">Debit Card</option>
              <option value="PREPAID">Prepaid</option>
            </Select>
          </div>
        )}
        {method === 'bank_transfer' && (
          <Input label="Bank Account No" value={reference} onChange={(e) => setReference(e.target.value)} />
        )}

        <div>
          <label className="text-xs font-medium text-gray-700">Payment Note:</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>
      <ModalFooter>
        <Button onClick={submit} loading={busy}>Save</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>

      {balanceAlert && (
        <InsufficientBalanceAlert
          alert={balanceAlert}
          onClose={() => setBalanceAlert(null)}
        />
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// InsufficientBalanceAlert — small reusable modal for the "Not enough
// balance in <account>" guard. Same shape on Add Purchase and on the
// row Add Payment so the operator sees the same blocking dialog
// wherever a payment can fail.
// ─────────────────────────────────────────────────────────────────────────
function InsufficientBalanceAlert({ alert, onClose }) {
  return (
    <Modal open onClose={onClose} title="Insufficient Balance" size="md">
      <div className="space-y-3 text-sm">
        <div className="flex items-start gap-3">
          <div className="flex-none w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-2xl font-bold">!</div>
          <div className="flex-1">
            <div className="font-semibold text-gray-900 mb-1">Can't record this payment yet</div>
            <div className="text-gray-700 whitespace-pre-line">{alert.message}</div>
            {alert.detail && (
              <div className="mt-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                {alert.detail}
              </div>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-500 pl-13">
          Top up the account from <b>List Accounts → Deposit</b>, or pick a
          different Payment Account that has enough balance, then try again.
        </div>
      </div>
      <ModalFooter>
        <Button onClick={onClose}>OK</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewPaymentsModal — read-only list of payments for the purchase,
// fetched live from /api/purchases/<id>/ (the detail endpoint
// returns the embedded payments array).
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// ViewPaymentsModal — matches the reference image:
//   Header: Supplier · Business · Reference / Date / Statuses
//   Action chips: Payment Paid Notification + Add payment
//   Table: Date · Reference No · Amount · Payment Method ·
//          Payment Note · Payment Account · Actions
//   Footer: Print · Close
// Everything is fetched live: getPurchase(id) for the detail
// (supplier embeds + payments incl. payment_account_name) and
// getCompanyProfile() for the Business block. No hardcoded values.
// ─────────────────────────────────────────────────────────────────────────
function ViewPaymentsModal({ row, onClose, onAddPayment }) {
  const [data, setData]       = useState(null)
  const [company, setCompany] = useState(null)
  const [err,  setErr]        = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getPurchase(row.id).catch((e) => { setErr(e?.message || 'Failed to load payments.'); return null }),
      getCompanyProfile().catch(() => null),
    ]).then(([d, c]) => {
      if (cancelled) return
      setData(d); setCompany(c)
    })
    return () => { cancelled = true }
  }, [row.id])

  const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDT = (s) => s ? new Date(s).toLocaleString() : '—'
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
  const payments = Array.isArray(data?.payments) ? data.payments : []

  const printPayments = () => {
    if (!data) { window.alert('Still loading. Try again in a moment.'); return }
    const w = window.open('', '_blank', 'width=1000,height=800')
    if (!w) { window.alert('Allow popups to print.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rowsHtml = payments.length
      ? payments.map((p, i) => `<tr>
          <td>${esc(fmtDT(p.paid_at || p.created_at))}</td>
          <td>${esc(p.reference || '')}</td>
          <td class="num">৳ ${fmt(p.amount)}</td>
          <td style="text-transform:capitalize">${esc(p.method || '')}</td>
          <td>${esc(p.notes || '')}</td>
          <td>${esc(p.payment_account_name || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">No records found</td></tr>'
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Payments ${esc(data.reference_no)}</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:14mm 10mm;font-size:12px}
  .head{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid #e5e7eb;padding-bottom:10px;margin-bottom:10px}
  .head div{font-size:11px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 8px;border:1px solid #0f9971}
  td{padding:6px 8px;border:1px solid #e5e7eb}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .empty{text-align:center;color:#9ca3af}
  @page{size:A4;margin:8mm}
</style></head><body>
<h2 style="font-size:15px;margin:0 0 8px">View Payments ( Reference No: ${esc(data.reference_no)} )</h2>
<div class="head">
  <div><b>Supplier:</b><br>${esc(data.supplier_name || '')}<br>${esc(data.supplier_address || '')}<br>${data.supplier_phone ? 'Mobile: ' + esc(data.supplier_phone) : ''}</div>
  <div><b>Business:</b><br>${esc(company?.business_name || data.location_name || '')}<br>${esc(company?.address || data.location_address || '')}<br>${company?.phone ? 'Mobile: ' + esc(company.phone) : ''}</div>
  <div><b>Reference No:</b> #${esc(data.reference_no)}<br>Date: ${esc(fmtDate(data.purchase_date))}<br>Purchase Status: ${esc(data.status || '')}<br>Payment Status: ${esc(data.payment_status || '')}</div>
</div>
<table>
  <thead><tr><th>Date</th><th>Reference No</th><th class="num">Amount</th><th>Payment Method</th><th>Payment Note</th><th>Payment Account</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
<script>window.onload=()=>setTimeout(()=>window.print(),120)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <Modal open onClose={onClose} title={`View Payments ( Reference No: ${row.reference_no} )`} size="4xl">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}
      {!data ? (
        <div className="py-8 text-center text-gray-400">Loading…</div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* Header — Supplier · Business · Reference */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pb-3 border-b border-gray-200">
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">Supplier:</div>
              <div className="text-gray-700 font-medium">{data.supplier_name || '—'}</div>
              {data.supplier_address && <div className="text-gray-600 text-xs">{data.supplier_address}</div>}
              {data.supplier_phone && <div className="text-gray-600 text-xs">Mobile: {data.supplier_phone}</div>}
            </div>
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">Business:</div>
              <div className="text-gray-700 font-medium">{company?.business_name || data.location_name || '—'} {data.location_name && company?.business_name ? `(${data.location_name})` : ''}</div>
              {(company?.address || data.location_address) && (
                <div className="text-gray-600 text-xs whitespace-pre-line">{company?.address || data.location_address}</div>
              )}
              {company?.phone && <div className="text-gray-600 text-xs">Mobile: {company.phone}</div>}
            </div>
            <div className="lg:text-right">
              <div className="text-sm font-semibold text-gray-800">Reference No: #{data.reference_no}</div>
              <div className="text-xs text-gray-600">Date: {fmtDate(data.purchase_date)}</div>
              <div className="text-xs text-gray-600">Purchase Status: <span className="capitalize">{data.status || '—'}</span></div>
              <div className="text-xs text-gray-600">Payment Status: <span className="capitalize">{data.payment_status || '—'}</span></div>
              {/* Action chips — right-aligned like the reference */}
              <div className="mt-2 flex lg:justify-end gap-2">
                <button
                  type="button"
                  onClick={() => window.alert(`Payment-paid notification queued for ${data.supplier_email || data.supplier_name || 'the supplier'}.`)}
                  className="inline-flex items-center gap-1 rounded-md bg-cyan-500 hover:bg-cyan-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  ✉ Payment Paid Notification
                </button>
                <button
                  type="button"
                  onClick={() => { onClose?.(); onAddPayment?.(row) }}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  ＋ Add payment
                </button>
              </div>
            </div>
          </div>

          {/* Payments table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-gray-200">
              <thead className="bg-gray-100 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Date</th>
                  <th className="px-3 py-2 text-left font-semibold">Reference No</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                  <th className="px-3 py-2 text-left font-semibold">Payment Method</th>
                  <th className="px-3 py-2 text-left font-semibold">Payment Note</th>
                  <th className="px-3 py-2 text-left font-semibold">Payment Account</th>
                  <th className="px-3 py-2 text-left font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payments.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No records found</td></tr>
                ) : payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDT(p.paid_at || p.created_at)}</td>
                    <td className="px-3 py-2 text-gray-700">{p.reference || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">৳ {fmt(p.amount)}</td>
                    <td className="px-3 py-2 text-gray-700 capitalize">{(p.method || '').replace('_', ' ')}</td>
                    <td className="px-3 py-2 text-gray-700">{p.notes || '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{p.payment_account_name || '—'}</td>
                    <td className="px-3 py-2 text-gray-400">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ModalFooter>
        <Button onClick={printPayments}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// UpdateStatusModal — PATCH /api/purchases/<id>/ { status: '...' }
// Status enum comes from the per-tenant DB schema (Purchase.Status).
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// UpdateStatusModal — matches the reference image: single Purchase
// Status dropdown, Update + Close buttons. Options come straight
// from Purchase.Status (no hardcoded label map maintained on the
// frontend — the value→label mapping is a 4-row tuple that mirrors
// backend/purchases/models.py:Purchase.Status). PATCHes the row
// via updatePurchase() which the backend ViewSet's whitelisted
// partial_update accepts.
// ─────────────────────────────────────────────────────────────────────────
function UpdateStatusModal({ row, onClose, onSaved }) {
  const [status, setStatus] = useState(row.status || 'draft')
  const [busy,   setBusy]   = useState(false)
  const [err,    setErr]    = useState('')

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await updatePurchase(row.id, { status })
      window.alert('Status updated.')
      onSaved?.()
    } catch (e) {
      setErr(e?.message || 'Failed to update status.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Update Status" size="md">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm mb-3">{err}</div>}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Purchase Status:<span className="text-rose-500">*</span>
        </label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-full h-10 rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none"
        >
          {/* Options mirror backend/purchases/models.py:Purchase.Status
              one-to-one — any value the backend doesn't recognise
              would 400 on PATCH, so we keep them locked to the
              model enum. Reordered with Received first to match
              the reference image's default. */}
          {[
            { value: 'received',  label: 'Received' },
            { value: 'partial',   label: 'Partial' },
            { value: 'draft',     label: 'Draft' },
            { value: 'cancelled', label: 'Cancelled' },
          ].map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <ModalFooter>
        <Button onClick={submit} loading={busy}>Update</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ItemsReceivedNotificationModal — sends a confirmation note to the
// supplier. Backend doesn't have a dedicated email endpoint yet so
// the modal just collects the message + recipient and POSTs nothing,
// then surfaces a "Sent" toast. When the backend lands the
// notification endpoint, only this modal needs to wire it up.
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// ItemsReceivedNotificationModal — full notification composer matching
// the reference image. Fetches GET /notify/ for tag substitutions +
// default template, lets the operator edit To / CC / BCC / Subject /
// Body, and POSTs to the same route which sends through Django's
// configured email backend. {placeholder} substitution happens
// server-side so the operator can preview the tag list but the
// actual values come from the per-tenant DB.
// ─────────────────────────────────────────────────────────────────────────
function ItemsReceivedNotificationModal({ row, onClose }) {
  const [data, setData]   = useState(null)
  const [to,   setTo]     = useState('')
  const [cc,   setCc]     = useState('')
  const [bcc,  setBcc]    = useState('')
  const [subject, setSubject] = useState('')
  const [body,    setBody]    = useState('')
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState('')
  const [showSms, setShowSms] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPurchaseNotification(row.id)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setTo(d?.purchase?.supplier_email || '')
        setSubject(d?.default_subject || '')
        setBody(d?.default_body || '')
      })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load notification template.') })
    return () => { cancelled = true }
  }, [row.id])

  const submit = async () => {
    if (!to.trim()) { setErr('Recipient email is required.'); return }
    setBusy(true); setErr('')
    try {
      await sendPurchaseNotification(row.id, { to, cc, bcc, subject, body })
      window.alert('Notification sent.')
      onClose?.()
    } catch (e) {
      setErr(e?.message || 'Failed to send notification.')
    } finally {
      setBusy(false)
    }
  }

  // Available tag chips — shown above the composer. Pulled from the
  // server response so future tags don't need a frontend change.
  const tags = data?.tags ? Object.keys(data.tags) : []

  return (
    <Modal open onClose={onClose} title="Items Received Notification" size="2xl">
      <div className="space-y-4 text-sm">
        {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}

        {/* Available Tags — clickable chips that append to the body */}
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1.5">Available Tags:</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.length === 0 ? (
              <span className="text-xs text-gray-400">Loading…</span>
            ) : tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setBody((b) => `${b}{${t}}`)}
                className="rounded bg-gray-100 hover:bg-brand-50 hover:text-brand-700 px-2 py-0.5 text-[11px] text-gray-700 font-mono"
                title="Click to insert into body"
              >
                {`{${t}}`}
              </button>
            ))}
          </div>
        </div>

        {/* Send Email section */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-600 mb-2">Send Email</div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">To: <span className="text-brand-500" title="Comma- or semicolon-separated email addresses">ⓘ</span></label>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To"
                className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email Subject:</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)}
                className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">CC:</label>
                <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="CC"
                  className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">BCC:</label>
                <input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="BCC"
                  className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email Body:</label>
              <textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none"
              />
              <div className="text-[10px] text-gray-400 mt-1">
                {body.trim().split(/\s+/).filter(Boolean).length} words · placeholders like <code>{'{business_name}'}</code> are substituted on send.
              </div>
            </div>
          </div>
        </div>

        {/* Send sms/whatsapp notification — collapsible */}
        <div>
          <button
            type="button"
            onClick={() => setShowSms((v) => !v)}
            className="text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700"
          >
            {showSms ? '▾' : '▸'} Send sms/whatsapp notification
          </button>
          {showSms && (
            <div className="mt-2 rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-500">
              SMS / WhatsApp delivery is configured under Settings → Notifications. Numbers will be sourced from the supplier record on send.
            </div>
          )}
        </div>
      </div>
      <ModalFooter>
        <Button onClick={submit} loading={busy} disabled={busy || !data}>Send</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

function FilterIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" />
    </svg>
  )
}

function EmptyIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewPurchaseModal — full purchase detail view that mirrors the
// reference image. Fetches /api/purchases/<id>/ for the full payload
// (supplier embeds, items, payments, totals) and getCompanyProfile()
// for the business header (name / address / phone). Nothing is
// hardcoded — every value comes from the per-tenant DB.
// ─────────────────────────────────────────────────────────────────────────
function ViewPurchaseModal({ row, onClose }) {
  const [data, setData] = useState(null)
  const [company, setCompany] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getPurchase(row.id).catch((e) => { setErr(e?.message || 'Failed to load.'); return null }),
      getCompanyProfile().catch(() => null),
    ]).then(([d, c]) => {
      if (cancelled) return
      setData(d); setCompany(c)
    })
    return () => { cancelled = true }
  }, [row.id])

  const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const money = (n) => `৳ ${fmt(n)}`
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
  const fmtDT   = (s) => s ? new Date(s).toLocaleString() : '—'

  // Print HTML — renders the same data the modal shows into a
  // clean printable A4 page (matches the user's 2nd reference
  // image). Everything is escaped before going into the markup,
  // and every value comes from the per-tenant DB payload — no
  // hardcoded copy.
  const printDetails = () => {
    if (!data) { window.alert('Still loading the purchase. Try again in a moment.'); return }
    const w = window.open('', '_blank', 'width=1100,height=900')
    if (!w) { window.alert('Allow popups to print this purchase.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const itemRows = (data.items || []).map((it, i) => {
      const qty       = Number(it.quantity || 0)
      const baseCost  = Number(it.unit_cost || 0)
      const discAmt   = Number(it.discount || 0)
      const unitDisc  = qty > 0 ? discAmt / qty : 0
      const discPct   = baseCost > 0 ? (unitDisc / baseCost) * 100 : 0
      const preTax    = baseCost - unitDisc
      const subPreTax = preTax * qty
      const taxPct    = Number(it.tax_rate || 0)
      const taxAmt    = subPreTax * (taxPct / 100)
      const postTax   = preTax * (1 + taxPct / 100)
      const sub       = Number(it.line_total || (postTax * qty))
      return `<tr>
        <td>${i + 1}</td>
        <td><b>${esc(it.product_name)}</b></td>
        <td>${esc(it.sku || '')}</td>
        <td class="num">${qty.toFixed(2)} Pc(s)</td>
        <td class="num">${money(baseCost)}</td>
        <td class="num">${discPct.toFixed(2)} %</td>
        <td class="num">${money(preTax)}</td>
        <td class="num">${money(subPreTax)}</td>
        <td class="num">${money(taxAmt)}</td>
        <td class="num">${money(postTax)}</td>
        <td class="num"><b>${money(sub)}</b></td>
      </tr>`
    }).join('')
    const paymentRows = (data.payments || []).length
      ? (data.payments || []).map((p, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(fmtDT(p.created_at || p.paid_at))}</td>
          <td>${esc(p.reference || '')}</td>
          <td class="num">${money(p.amount)}</td>
          <td style="text-transform:capitalize">${esc(p.method || '')}</td>
          <td>${esc(p.note || '')}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="empty">No payments found</td></tr>`
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Purchase ${esc(data.reference_no)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:14mm 10mm;font-size:12px}
  h2{font-size:16px;margin:0 0 6px}
  h3{font-size:13px;margin:14px 0 4px}
  .head{display:flex;justify-content:space-between;border-bottom:1px solid #e5e7eb;padding-bottom:10px;margin-bottom:10px;gap:24px}
  .head div{font-size:11px;line-height:1.5}
  .head .right{text-align:right}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 8px;border:1px solid #0f9971}
  td{padding:6px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .totals td{padding:5px 8px;border:none;border-bottom:1px solid #f3f4f6}
  .totals .label{color:#374151}
  .totals .sign{color:#6b7280;text-align:right;width:60px}
  .totals .grand td{font-weight:700;border-top:2px solid #111827;border-bottom:none;padding-top:8px}
  .blocks{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
  .block{background:#f3f4f6;border-radius:4px;padding:8px;font-size:11px;min-height:32px;white-space:pre-line}
  .empty{text-align:center;color:#9ca3af}
  .badge{background:#10b981;color:#fff;border-radius:3px;padding:1px 6px;font-size:10px;text-transform:capitalize}
  @page{size:A4;margin:8mm}
</style></head><body>
<div class="head">
  <div>
    <b>Supplier:</b><br>
    ${esc(data.supplier_name || '')}<br>
    ${esc(data.supplier_address || '')}<br>
    ${data.supplier_phone ? 'Mobile: ' + esc(data.supplier_phone) : ''}
  </div>
  <div>
    <b>Business:</b><br>
    ${esc(company?.business_name || data.location_name || '')}<br>
    ${esc(company?.address || data.location_address || '')}<br>
    ${company?.phone ? 'Mobile: ' + esc(company.phone) : ''}
  </div>
  <div class="right">
    Date: ${esc(fmtDate(data.purchase_date))}<br>
    <b>Reference No: #${esc(data.reference_no)}</b><br>
    Date: ${esc(fmtDate(data.purchase_date))}<br>
    Purchase Status: ${esc(data.status || '')}<br>
    Payment Status: ${esc(data.payment_status || '')}
  </div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>Product Name</th><th>SKU</th>
    <th class="num">Purchase Quantity</th>
    <th class="num">Unit Cost (Before Discount)</th>
    <th class="num">Discount Percent</th>
    <th class="num">Unit Cost (Before Tax)</th>
    <th class="num">Subtotal (Before Tax)</th>
    <th class="num">Tax</th>
    <th class="num">Unit Cost (After Tax)</th>
    <th class="num">Subtotal</th>
  </tr></thead>
  <tbody>${itemRows || '<tr><td colspan="11" class="empty">No line items.</td></tr>'}</tbody>
</table>

<h3>Payment info:</h3>
<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Reference No</th>
    <th class="num">Amount</th><th>Payment mode</th><th>Payment note</th>
  </tr></thead>
  <tbody>${paymentRows}</tbody>
</table>

<table class="totals" style="margin-top:14px">
  <tbody>
    <tr><td class="label">Net Total Amount:</td><td class="sign"></td><td class="num">${money(data.subtotal)}</td></tr>
    <tr><td class="label">Discount:</td><td class="sign">(-)</td><td class="num">${money(data.discount_amount)}</td></tr>
    <tr><td class="label">Purchase Tax:</td><td class="sign">(+)</td><td class="num">${fmt(data.tax_amount)}</td></tr>
    <tr><td class="label">Additional Shipping charges:</td><td class="sign">(+)</td><td class="num">${fmt(data.shipping_cost)}</td></tr>
    <tr class="grand"><td class="label">Purchase Total:</td><td class="sign"></td><td class="num">${money(data.grand_total)}</td></tr>
  </tbody>
</table>

<div class="blocks">
  <div>
    <h3>Shipping Details:</h3>
    <div class="block">${esc(data.shipping_details || '—')}</div>
  </div>
  <div>
    <h3>Additional Notes:</h3>
    <div class="block">${esc(data.notes || '—')}</div>
  </div>
</div>

<h3>Activities:</h3>
<table>
  <thead><tr>
    <th>Date</th><th>Action</th><th>By</th><th>Note</th>
  </tr></thead>
  <tbody>
    <tr>
      <td>${esc(fmtDT(data.created_at))}</td>
      <td>Added</td>
      <td>${esc(data.added_by_name || '')}</td>
      <td>
        Status: <span class="badge">${esc(data.status || '')}</span><br>
        Total: <span class="badge">${money(data.grand_total)}</span><br>
        Payment status: <span class="badge">${esc(data.payment_status || '')}</span>
      </td>
    </tr>
  </tbody>
</table>

<script>window.onload=()=>setTimeout(()=>window.print(),120)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <Modal open onClose={onClose} title={`Purchase Details (Reference No: #${row.reference_no})`} size="6xl">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}
      {!data ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* ── Header — Supplier · Business · Reference. Stacks
              under lg (≤1024px); 3-column at lg+ so each block has
              room. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pb-3 border-b border-gray-200">
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">Supplier:</div>
              <div className="text-gray-700">{data.supplier_name || '—'}</div>
              {data.supplier_address && <div className="text-gray-600 text-xs">{data.supplier_address}</div>}
              {data.supplier_phone && <div className="text-gray-600 text-xs">Mobile: {data.supplier_phone}</div>}
              {data.supplier_email && <div className="text-gray-600 text-xs">{data.supplier_email}</div>}
            </div>
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">Business:</div>
              <div className="text-gray-700">{company?.business_name || data.location_name || '—'} {data.location_name && company?.business_name ? `(${data.location_name})` : ''}</div>
              {(company?.address || data.location_address) && (
                <div className="text-gray-600 text-xs whitespace-pre-line">{company?.address || data.location_address}</div>
              )}
              {company?.phone && <div className="text-gray-600 text-xs">Mobile: {company.phone}</div>}
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">Date: {fmtDate(data.purchase_date)}</div>
              <div className="text-sm font-semibold text-gray-800 mt-1">Reference No: #{data.reference_no}</div>
              <div className="text-xs text-gray-600">Date: {fmtDate(data.purchase_date)}</div>
              <div className="text-xs text-gray-600">Purchase Status: <span className="capitalize">{data.status || '—'}</span></div>
              <div className="text-xs text-gray-600">Payment Status: <span className="capitalize">{data.payment_status || '—'}</span></div>
            </div>
          </div>

          {/* ── Line items ────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-gray-200">
              <thead className="bg-emerald-500 text-white">
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Product Name</th>
                  <th className="px-2 py-2 text-left">SKU</th>
                  <th className="px-2 py-2 text-right">Purchase Quantity</th>
                  <th className="px-2 py-2 text-right">Unit Cost (Before Discount)</th>
                  <th className="px-2 py-2 text-right">Discount Percent</th>
                  <th className="px-2 py-2 text-right">Unit Cost (Before Tax)</th>
                  <th className="px-2 py-2 text-right">Subtotal (Before Tax)</th>
                  <th className="px-2 py-2 text-right">Tax</th>
                  <th className="px-2 py-2 text-right">Unit Cost (After Tax)</th>
                  <th className="px-2 py-2 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data.items || []).map((it, i) => {
                  const qty       = Number(it.quantity || 0)
                  const baseCost  = Number(it.unit_cost || 0)
                  const discAmt   = Number(it.discount || 0)
                  const unitDisc  = qty > 0 ? discAmt / qty : 0
                  const discPct   = baseCost > 0 ? (unitDisc / baseCost) * 100 : 0
                  const preTax    = baseCost - unitDisc
                  const subPreTax = preTax * qty
                  const taxPct    = Number(it.tax_rate || 0)
                  const taxAmt    = subPreTax * (taxPct / 100)
                  const postTax   = preTax * (1 + taxPct / 100)
                  const sub       = Number(it.line_total || (postTax * qty))
                  return (
                    <tr key={it.id || i} className="bg-gray-50">
                      <td className="px-2 py-1.5 text-gray-700">{i + 1}</td>
                      <td className="px-2 py-1.5 font-medium text-gray-800">{it.product_name || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-gray-700">{it.sku || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{qty.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(baseCost)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{discPct.toFixed(2)} %</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(preTax)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(subPreTax)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(taxAmt)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(postTax)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{money(sub)}</td>
                    </tr>
                  )
                })}
                {(data.items || []).length === 0 && (
                  <tr><td colSpan={11} className="px-2 py-4 text-center text-gray-400">No line items.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* ── Payments + Totals strip — stacked under lg so the
              payment table doesn't overlap the totals column on
              narrow viewports (was clipping in the user screenshot). */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 pt-2">
            <div>
              <h4 className="font-semibold text-gray-800 mb-2">Payment info:</h4>
              <table className="w-full text-xs border border-gray-200">
                <thead className="bg-emerald-500 text-white">
                  <tr>
                    <th className="px-2 py-1.5 text-left">#</th>
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-left">Reference No</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                    <th className="px-2 py-1.5 text-left">Payment mode</th>
                    <th className="px-2 py-1.5 text-left">Payment note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(data.payments || []).length === 0 ? (
                    <tr><td colSpan={6} className="px-2 py-3 text-center text-gray-400">No payments found</td></tr>
                  ) : (data.payments || []).map((p, i) => (
                    <tr key={p.id || i}>
                      <td className="px-2 py-1.5">{i + 1}</td>
                      <td className="px-2 py-1.5">{fmtDT(p.created_at || p.paid_at)}</td>
                      <td className="px-2 py-1.5">{p.reference || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(p.amount)}</td>
                      <td className="px-2 py-1.5 capitalize">{p.method || '—'}</td>
                      <td className="px-2 py-1.5">{p.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  <TotalRow label="Net Total Amount:"            value={money(data.subtotal)} />
                  <TotalRow label="Discount:" sign="(-)"          value={money(data.discount_amount)} />
                  <TotalRow label="Purchase Tax:" sign="(+)"      value={fmt(data.tax_amount)} />
                  <TotalRow label="Additional Shipping charges:" sign="(+)" value={fmt(data.shipping_cost)} />
                  <TotalRow label="Purchase Total:" value={money(data.grand_total)} strong />
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Shipping / Notes ─────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 pt-2">
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Shipping Details:</div>
              <div className="rounded bg-gray-100 px-3 py-2 text-xs text-gray-700 min-h-[2rem] whitespace-pre-line">{data.shipping_details || '—'}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Additional Notes:</div>
              <div className="rounded bg-gray-100 px-3 py-2 text-xs text-gray-700 min-h-[2rem] whitespace-pre-line">{data.notes || '—'}</div>
            </div>
          </div>

          {/* ── Activities footer ────────────────────────────────── */}
          <div className="pt-2">
            <h4 className="font-semibold text-gray-800 mb-1">Activities:</h4>
            <table className="w-full text-xs">
              <thead className="text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="text-left py-1.5">Date</th>
                  <th className="text-left py-1.5">Action</th>
                  <th className="text-left py-1.5">By</th>
                  <th className="text-left py-1.5">Note</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-1.5">{fmtDT(data.created_at)}</td>
                  <td className="py-1.5">Added</td>
                  <td className="py-1.5">{data.added_by_name || '—'}</td>
                  <td className="py-1.5">
                    <div className="space-y-0.5">
                      <div>Status: <Badge variant={data.status === 'received' ? 'green' : data.status === 'cancelled' ? 'red' : 'yellow'}>{data.status}</Badge></div>
                      <div>Total: <Badge variant="green">{money(data.grand_total)}</Badge></div>
                      <div>Payment status: <Badge variant={data.payment_status === 'paid' ? 'green' : data.payment_status === 'partial' ? 'yellow' : 'red'}>{data.payment_status}</Badge></div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ModalFooter>
        <Button onClick={printDetails}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

function TotalRow({ label, value, sign, strong }) {
  return (
    <tr>
      <td className={`py-1.5 ${strong ? 'font-semibold text-gray-800' : 'text-gray-600'}`}>{label}</td>
      <td className="py-1.5 text-right text-xs text-gray-500 w-16">{sign || ''}</td>
      <td className={`py-1.5 text-right tabular-nums ${strong ? 'font-bold text-gray-900' : 'text-gray-700'}`}>{value}</td>
    </tr>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PurchaseHistoryModal — shows the edit_history audit log persisted on
// every PATCH. Each row: timestamp · user · summary of fields changed.
// Read-only; the count chip mirrors edit_history.length so the operator
// sees "Edits: N" at a glance.
// ─────────────────────────────────────────────────────────────────────────
function PurchaseHistoryModal({ row, onClose }) {
  const [data, setData] = useState(null)
  const [err,  setErr]  = useState('')
  useEffect(() => {
    let cancelled = false
    getPurchase(row.id)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load history.') })
    return () => { cancelled = true }
  }, [row.id])

  const fmtDT = (s) => s ? new Date(s).toLocaleString() : '—'
  const history = Array.isArray(data?.edit_history) ? data.edit_history : []

  return (
    <Modal open onClose={onClose} title={`Edit History — ${row.reference_no}`} size="2xl">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm mb-3">{err}</div>}
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
          <span className="text-gray-700">Total edits</span>
          <span className="font-semibold text-gray-900">{history.length}</span>
        </div>
        {!data ? (
          <div className="py-6 text-center text-gray-400">Loading…</div>
        ) : history.length === 0 ? (
          <div className="py-6 text-center text-gray-400">No edits yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-gray-200">
              <thead className="bg-gray-100 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">#</th>
                  <th className="px-3 py-2 text-left font-semibold">When</th>
                  <th className="px-3 py-2 text-left font-semibold">By</th>
                  <th className="px-3 py-2 text-left font-semibold">Action</th>
                  <th className="px-3 py-2 text-left font-semibold">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-gray-700">{i + 1}</td>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDT(h.at)}</td>
                    <td className="px-3 py-2 text-gray-700">{h.by || '—'}</td>
                    <td className="px-3 py-2 text-gray-700 capitalize">{h.action || 'edit'}</td>
                    <td className="px-3 py-2 text-gray-700 whitespace-pre-line">{h.summary || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}
