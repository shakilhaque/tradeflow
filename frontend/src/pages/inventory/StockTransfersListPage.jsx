import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import FilterToggle from '../../components/ui/FilterToggle'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import { getStockTransfers, deleteStockTransfer, getLocations, getStockTransfer } from '../../api/inventory'
import { getCompanyProfile } from '../../api/companyProfile'
import Modal, { ModalFooter } from '../../components/ui/Modal'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate  = (d) => (d ? new Date(d).toLocaleDateString() : '—')

const STATUS_VARIANT = {
  pending:    'gray',
  in_transit: 'yellow',
  completed:  'green',
  cancelled:  'red',
}
const STATUS_LABEL = {
  pending:    'Pending',
  in_transit: 'In Transit',
  completed:  'Completed',
  cancelled:  'Cancelled',
}

export default function StockTransfersListPage() {
  const navigate = useNavigate()

  const [filtersOpen, setFiltersOpen] = useState(true)
  const [filters, setFilters] = useState({
    from_id: '', to_id: '', status: '',
    date_from: `${currentYear}-01-01`, date_to: `${currentYear}-12-31`,
  })
  const [search, setSearch] = useState('')
  const [page,   setPage]   = useState(1)
  const [limit,  setLimit]  = useState(25)

  const [locations, setLocations] = useState([])
  const [data, setData] = useState({ results: [], count: 0, total_pages: 1, summary: {} })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [deletingId, setDeletingId] = useState(null)
  // Row-level View Transfer modal — opens via the action menu's
  // 👁 View item. Held at the page level so the table's
  // overflow-x-auto wrapper doesn't clip the modal.
  const [viewRow, setViewRow] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const locs = await getLocations({ active_only: 'true' })
        { const _l = Array.isArray(locs) ? locs : (locs?.results ?? []); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
      } catch { /* ignore */ }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {
        page, limit, search,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      }
      const res = await getStockTransfers(params)
      setData(res || { results: [], count: 0, total_pages: 1, summary: {} })
    } catch (err) {
      setError(err?.message || 'Failed to load stock transfers.')
      setData({ results: [], count: 0, total_pages: 1, summary: {} })
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters])

  useEffect(() => { load() }, [load])

  const handleFilterChange = (k, v) => {
    setFilters((p) => ({ ...p, [k]: v }))
    setPage(1)
  }

  const handleDelete = async (row) => {
    if (!confirm(`Delete stock transfer ${row.reference_no}? This cannot be undone.`)) return
    setDeletingId(row.id)
    try {
      await deleteStockTransfer(row.id)
      await load()
    } catch (err) {
      alert(err?.message || 'Failed to delete stock transfer.')
    } finally {
      setDeletingId(null)
    }
  }

  // Page-local totals (visible rows). Backend already sums across the FILTERED set.
  const pageTotals = useMemo(() => {
    const rows = data.results || []
    const grand    = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0)
    const shipping = rows.reduce((s, r) => s + Number(r.shipping_charges || 0), 0)
    return { grand, shipping }
  }, [data.results])

  const handleExportCsv = () => {
    const rows = data.results || []
    if (!rows.length) return
    const headers = ['Date', 'Reference No', 'From', 'To', 'Status', 'Shipping', 'Total', 'Notes']
    const lines = [headers.join(',')].concat(
      rows.map((r) => [
        fmtDate(r.transfer_date),
        r.reference_no,
        (r.from_location_name || '').replace(/,/g, ' '),
        (r.to_location_name || '').replace(/,/g, ' '),
        STATUS_LABEL[r.status] || r.status,
        Number(r.shipping_charges || 0).toFixed(2),
        Number(r.total_amount || 0).toFixed(2),
        (r.notes || '').replace(/[\r\n,]/g, ' '),
      ].join(','))
    )
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `stock-transfers-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Stock Transfers</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Move inventory between business locations and track every transfer.
        </p>
      </div>

      <Card>
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} accent="brand" />
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
          <Select label="Location (From)" value={filters.from_id} onChange={(e) => handleFilterChange('from_id', e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Location (To)" value={filters.to_id} onChange={(e) => handleFilterChange('to_id', e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Status" value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="in_transit">In Transit</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <div />
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

      {/* Banner */}
      <div className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-500 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <h3 className="text-base font-semibold">All Stock Transfers</h3>
        <span className="text-sm">
          Total Transferred: {fmtMoney(data?.summary?.total_amount ?? pageTotals.grand)}
          <span className="mx-2 text-white/50">·</span>
          Shipping: {fmtMoney(data?.summary?.total_shipping ?? pageTotals.shipping)}
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-200"
            value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span>entries</span>
          <Button variant="secondary" size="sm" onClick={handleExportCsv} disabled={!data.results?.length}>
            Export CSV
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <SearchInput
            placeholder="Search reference, location, notes..."
            value={search}
            onChange={(v) => { setSearch(v); setPage(1) }}
          />
          <Button onClick={() => navigate('/inventory/stock-transfers/add')}>
            <span className="mr-1">+</span> Add Transfer
          </Button>
        </div>
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState
              title="No stock transfers"
              message="Transfers between business locations will appear here."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Reference No</th>
                  <th className="px-4 py-3">Location (From)</th>
                  <th className="px-4 py-3">Location (To)</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Shipping Charges</th>
                  <th className="px-4 py-3 text-right">Total Amount</th>
                  <th className="px-4 py-3">Additional Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <ActionMenu
                        row={r}
                        onView={() => setViewRow(r)}
                        onDelete={() => handleDelete(r)}
                        deleting={deletingId === r.id}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-700">{fmtDate(r.transfer_date)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.reference_no}</td>
                    <td className="px-4 py-3 font-medium text-gray-700">{r.from_location_name || '—'}</td>
                    <td className="px-4 py-3 font-medium text-gray-700">{r.to_location_name || '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'gray'}>
                        {STATUS_LABEL[r.status] || r.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">{fmtMoney(r.shipping_charges)}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmtMoney(r.total_amount)}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs max-w-xs truncate" title={r.notes}>
                      {r.notes || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-100 text-sm font-semibold text-gray-800 border-t border-gray-200">
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" colSpan={5}>Total (page):</td>
                  <td className="px-4 py-3 text-right">{fmtMoney(pageTotals.shipping)}</td>
                  <td className="px-4 py-3 text-right">{fmtMoney(pageTotals.grand)}</td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {!loading && data.count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–<strong>{Math.min(page * limit, data.count)}</strong> of <strong>{data.count}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3">{page} / {data.total_pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= data.total_pages} onClick={() => setPage((p) => Math.min(p + 1, data.total_pages))}>Next</Button>
          </div>
        </div>
      )}

      {viewRow && (
        <ViewStockTransferModal
          row={viewRow}
          onClose={() => setViewRow(null)}
        />
      )}
    </div>
  )
}

function ActionMenu({ row, onView, onDelete, deleting }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition disabled:opacity-50"
        disabled={deleting}
      >
        Actions
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M5 7l5 6 5-6z" /></svg>
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute left-0 z-20 mt-1 w-44 rounded-lg bg-white shadow-lg ring-1 ring-black/5 overflow-hidden">
            <button
              onClick={() => { setOpen(false); onView() }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <svg className="w-4 h-4 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 4a6 6 0 100 12 6 6 0 000-12zm0 2a4 4 0 100 8 4 4 0 000-8z" clipRule="evenodd" /><circle cx="10" cy="10" r="2" /></svg>
              View
            </button>
            {row.status !== 'completed' && (
              <button
                onClick={() => { setOpen(false); onDelete() }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 011 1v7a1 1 0 102 0V9a1 1 0 112 0v7a1 1 0 102 0V9a1 1 0 112 0v7a3 3 0 01-3 3H8a3 3 0 01-3-3V9a1 1 0 011-1z" clipRule="evenodd" /></svg>
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewStockTransferModal — opens from the row action menu's View item.
// Fetches /api/inventory/stock-transfers/<id>/ + company profile for
// the Business header. All data live from the per-tenant DB — items,
// locations, totals, status, notes — nothing hardcoded.
// ─────────────────────────────────────────────────────────────────────────
function ViewStockTransferModal({ row, onClose }) {
  const [data, setData] = useState(null)
  const [company, setCompany] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getStockTransfer(row.id).catch((e) => { setErr(e?.message || 'Failed to load.'); return null }),
      getCompanyProfile().catch(() => null),
    ]).then(([d, c]) => {
      if (cancelled) return
      setData(d); setCompany(c)
    })
    return () => { cancelled = true }
  }, [row.id])

  const moneyN = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const money = (n) => `৳ ${moneyN(n)}`
  const fmtDt = (s) => s ? new Date(s).toLocaleString() : '—'

  const lines = Array.isArray(data?.items) ? data.items : []
  const itemsSubtotal = lines.reduce((s, it) => s + Number(it.line_total || (Number(it.quantity || 0) * Number(it.unit_cost || 0))), 0)
  const shipping = Number(data?.shipping_charges || 0)
  const total    = Number(data?.total_amount || (itemsSubtotal + shipping))

  const printTransfer = () => {
    if (!data) return
    const w = window.open('', '_blank', 'width=1000,height=900')
    if (!w) { window.alert('Allow popups to print.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rowsHtml = lines.map((it, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(it.product_name || '')}${it.sku ? `<br><span class="sub">${esc(it.sku)}</span>` : ''}</td>
      <td class="num">${Number(it.quantity || 0).toFixed(2)}</td>
      <td class="num">${money(it.unit_cost)}</td>
      <td class="num"><b>${money(it.line_total || (Number(it.quantity || 0) * Number(it.unit_cost || 0)))}</b></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No line items.</td></tr>'
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Stock Transfer ${esc(data.reference_no)}</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:14mm 10mm;font-size:12px}
  .head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:14px}
  .block{font-size:11px;line-height:1.5}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}
  th{background:#10b981;color:#fff;padding:7px 8px;text-align:left;border:1px solid #0f9971}
  td{padding:7px 8px;border:1px solid #e5e7eb}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .sub{color:#6b7280;font-size:10px}
  .empty{text-align:center;color:#9ca3af;padding:18px}
  .totals{margin-left:auto;width:300px;margin-top:14px;border-collapse:collapse}
  .totals td{border:none;padding:5px 8px}
  .totals .grand td{border-top:2px solid #111827;font-weight:700;padding-top:8px}
  .badge{display:inline-block;background:#10b981;color:#fff;border-radius:3px;padding:2px 8px;font-size:10px;text-transform:capitalize}
  @page{size:A4;margin:8mm}
</style></head><body>
<div class="head">
  <div>
    <div class="block"><b>${esc(company?.business_name || '')}</b><br>
    ${esc(company?.address || '')}<br>
    ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}</div>
  </div>
  <div style="text-align:right">
    <div class="title">STOCK TRANSFER</div>
    <div>#${esc(data.reference_no)}</div>
    <div>Date: <b>${esc(new Date(data.transfer_date || data.created_at).toLocaleDateString())}</b></div>
    <div style="margin-top:6px"><span class="badge">${esc(data.status || '')}</span></div>
  </div>
</div>

<div style="display:flex;gap:24px;margin-bottom:8px">
  <div class="block" style="flex:1"><b style="color:#10b981">FROM</b><br>${esc(data.from_location_name || '')}</div>
  <div class="block" style="flex:1"><b style="color:#10b981">TO</b><br>${esc(data.to_location_name || '')}</div>
</div>

<table>
  <thead><tr>
    <th style="width:30px">#</th>
    <th>Product</th>
    <th class="num">Quantity</th>
    <th class="num">Unit Cost</th>
    <th class="num">Line Total</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

<table class="totals">
  <tbody>
    <tr><td>Items Subtotal:</td><td class="num">${money(itemsSubtotal)}</td></tr>
    <tr><td>Shipping Charges:</td><td class="num">+ ${money(shipping)}</td></tr>
    <tr class="grand"><td>Total:</td><td class="num">${money(total)}</td></tr>
  </tbody>
</table>

${data.notes ? `<div style="margin-top:18px"><b style="color:#10b981">NOTES</b><div class="block" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:8px;white-space:pre-line;margin-top:4px">${esc(data.notes)}</div></div>` : ''}

<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#6b7280">
  <div>Generated: ${esc(new Date().toLocaleString())}</div>
  <div>Powered by Iffaa</div>
</div>
<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <Modal open onClose={onClose} title={`Stock Transfer Details — ${row.reference_no}`} size="4xl">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}
      {!data ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* Header — Business · Reference · From / To */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pb-3 border-b border-gray-200">
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">Business:</div>
              <div className="text-gray-700 font-medium">{company?.business_name || '—'}</div>
              {company?.address && <div className="text-gray-600 text-xs whitespace-pre-line">{company.address}</div>}
              {company?.phone && <div className="text-gray-600 text-xs">Mobile: {company.phone}</div>}
            </div>
            <div>
              <div className="font-semibold text-gray-800 mb-0.5">From Location:</div>
              <div className="text-gray-700 font-medium">{data.from_location_name || '—'}</div>
              <div className="font-semibold text-gray-800 mt-2 mb-0.5">To Location:</div>
              <div className="text-gray-700 font-medium">{data.to_location_name || '—'}</div>
            </div>
            <div className="lg:text-right">
              <div className="text-sm font-semibold text-gray-800">Reference No: #{data.reference_no}</div>
              <div className="text-xs text-gray-600">Date: {fmtDt(data.transfer_date || data.created_at)}</div>
              <div className="text-xs text-gray-600">Status: <Badge variant={STATUS_VARIANT[data.status] || 'gray'}>{STATUS_LABEL[data.status] || data.status}</Badge></div>
              <div className="text-xs text-gray-600 mt-1">Added by: {data.added_by_name || '—'}</div>
            </div>
          </div>

          {/* Items table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-gray-200">
              <thead className="bg-emerald-500 text-white">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold w-10">#</th>
                  <th className="px-3 py-2 text-left font-semibold">Product</th>
                  <th className="px-3 py-2 text-left font-semibold">SKU</th>
                  <th className="px-3 py-2 text-right font-semibold">Quantity</th>
                  <th className="px-3 py-2 text-right font-semibold">Unit Cost</th>
                  <th className="px-3 py-2 text-right font-semibold">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No line items.</td></tr>
                ) : lines.map((it, i) => (
                  <tr key={it.id || i}>
                    <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                    <td className="px-3 py-2 font-medium text-gray-800">{it.product_name || '—'}</td>
                    <td className="px-3 py-2 font-mono text-gray-700">{it.sku || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(it.quantity || 0).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(it.unit_cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{money(it.line_total || (Number(it.quantity || 0) * Number(it.unit_cost || 0)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end">
            <table className="w-72">
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="py-1.5 text-gray-600">Items Subtotal:</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-800">{money(itemsSubtotal)}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-600">Shipping Charges:</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-800">+ {money(shipping)}</td>
                </tr>
                <tr className="bg-emerald-50">
                  <td className="py-2 font-semibold text-gray-800">Total:</td>
                  <td className="py-2 text-right tabular-nums font-bold text-gray-900">{money(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Notes */}
          {data.notes && (
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Notes:</div>
              <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700 whitespace-pre-line">{data.notes}</div>
            </div>
          )}
        </div>
      )}
      <ModalFooter>
        <Button onClick={printTransfer}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}
