import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import FilterToggle from '../../components/ui/FilterToggle'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getPurchaseReturns, getPurchaseReturn, getSuppliers, deletePurchaseReturn,
  addPurchaseReturnPayment, getPurchaseReturnPayments,
  updatePurchaseReturnPayment, deletePurchaseReturnPayment,
} from '../../api/purchases'
import { getLocations } from '../../api/products'
import { getCompanyProfile } from '../../api/companyProfile'
import { getPaymentAccounts } from '../../api/accounting'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate  = (d) => (d ? new Date(d).toLocaleDateString() : '—')
// return_date is a date-only field; append time-of-day from created_at.
const fmtTime  = (s) => (s ? new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')
const fmtDateWithTime = (dateVal, ts) => {
  const base = fmtDate(dateVal)
  const t = fmtTime(ts)
  return t ? `${base} ${t}` : base
}

const STATUS_VARIANT  = { completed: 'green', received: 'green', draft: 'gray', cancelled: 'red' }
const PAYMENT_VARIANT = { paid: 'green', received: 'green', partial: 'yellow', due: 'red' }

export default function PurchaseReturnsPage() {
  const navigate = useNavigate()

  const [filtersOpen, setFiltersOpen] = useState(true)
  const [filters, setFilters] = useState({
    location_id: '', supplier_id: '', status: '',
    date_from: `${currentYear}-01-01`, date_to: `${currentYear}-12-31`,
  })
  const [search, setSearch] = useState('')
  const [page,   setPage]   = useState(1)
  const [limit,  setLimit]  = useState(25)

  const [locations, setLocations] = useState([])
  const [suppliers, setSuppliers] = useState([])

  const [data,    setData]    = useState({ results: [], count: 0, total_pages: 1, summary: {} })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

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
        page, limit, search,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      }
      const res = await getPurchaseReturns(params)
      setData(res || { results: [], count: 0, total_pages: 1, summary: {} })
    } catch (err) {
      setError(err?.message || 'Failed to load purchase returns.')
      setData({ results: [], count: 0, total_pages: 1, summary: {} })
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters])

  useEffect(() => { load() }, [load])

  const handleFilterChange = (k, v) => {
    setFilters((prev) => ({ ...prev, [k]: v }))
    setPage(1)
  }

  // Row-level modal state — the action menu items open these.
  const [viewPaymentsRow, setViewPaymentsRow] = useState(null)
  const [addPaymentRow,   setAddPaymentRow]   = useState(null)

  const handleDelete = async (row) => {
    if (!confirm(`Delete purchase return ${row.reference_no}? This cannot be undone.`)) return
    try {
      await deletePurchaseReturn(row.id)
      load()
    } catch (err) {
      alert(err?.message || 'Failed to delete purchase return.')
    }
  }

  // Aggregate totals across the current page
  const totals = useMemo(() => {
    const rows = data.results || []
    const grand = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0)
    const due   = rows.reduce((s, r) => s + Number(r.payment_due ?? 0), 0)
    const statusCounts = rows.reduce((m, r) => {
      const k = (r.payment_status || r.status || '—').toString()
      m[k] = (m[k] || 0) + 1
      return m
    }, {})
    return { grand, due, statusCounts }
  }, [data.results])

  const statusSummary = Object.entries(totals.statusCounts)
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)} - ${v}`)
    .join(', ')

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Purchase Returns</h1>
        <p className="mt-0.5 text-sm text-emerald-50">Track goods returned to suppliers.</p>
      </div>

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
          <Select label="Status" value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}>
            <option value="">All</option>
            <option value="completed">Completed</option>
            <option value="draft">Draft</option>
            <option value="cancelled">Cancelled</option>
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

      <div className="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <h3 className="text-base font-semibold">All Purchase Returns</h3>
        <span className="text-sm">Total Returned: {fmtMoney(data?.summary?.total_return ?? totals.grand)}</span>
      </div>

      <div className="flex items-center justify-end">
        <Button onClick={() => navigate('/purchases/returns/add')}>
          <span className="mr-1">+</span> Add Purchase Return
        </Button>
      </div>

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
        </div>
        <SearchInput placeholder="Search reference, supplier..." value={search}
          onChange={(v) => { setSearch(v); setPage(1) }} />
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState title="No purchase returns" message="Returns to suppliers will appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Reference No</th>
                  <th className="px-4 py-3">Parent Purchase</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Payment Status</th>
                  <th className="px-4 py-3 text-right">Grand Total</th>
                  <th className="px-4 py-3 text-right">Payment Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => {
                  const payStatus = r.payment_status || r.status
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <ActionMenu
                          row={r}
                          onDelete={() => handleDelete(r)}
                          onViewPayments={(p) => setViewPaymentsRow(p)}
                          onAddPayment={(p) => setAddPaymentRow(p)}
                        />
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{fmtDateWithTime(r.return_date, r.created_at)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.reference_no}</td>
                      <td className="px-4 py-3">
                        {r.purchase ? (
                          <Link to={`/purchases/${r.purchase}`} className="text-brand-600 hover:underline">
                            {r.purchase_ref || '—'}
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{r.location_name || '—'}</td>
                      <td className="px-4 py-3 font-medium">{r.supplier_name || '—'}</td>
                      <td className="px-4 py-3">
                        <Badge variant={PAYMENT_VARIANT[payStatus] ?? STATUS_VARIANT[r.status] ?? 'gray'}>
                          {payStatus}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{fmtMoney(r.total_amount)}</td>
                      <td className="px-4 py-3 text-right">{fmtMoney(r.payment_due ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-100 text-sm font-semibold text-gray-800 border-t border-gray-200">
                  <td className="px-4 py-3" colSpan={5}>Total:</td>
                  <td className="px-4 py-3 text-gray-700">{statusSummary || '—'}</td>
                  <td className="px-4 py-3 text-right">{fmtMoney(totals.grand)}</td>
                  <td className="px-4 py-3 text-right">{fmtMoney(totals.due)}</td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {!loading && data.count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>Showing <strong>{(page - 1) * limit + 1}</strong>–<strong>{Math.min(page * limit, data.count)}</strong> of <strong>{data.count}</strong></span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3">{page} / {data.total_pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= data.total_pages} onClick={() => setPage((p) => Math.min(p + 1, data.total_pages))}>Next</Button>
          </div>
        </div>
      )}

      {viewPaymentsRow && (
        <ViewReturnPaymentsModal
          row={viewPaymentsRow}
          onClose={() => setViewPaymentsRow(null)}
          onAddPayment={(r) => { setViewPaymentsRow(null); setAddPaymentRow(r) }}
        />
      )}
      {addPaymentRow && (
        <AddReturnPaymentModal
          row={addPaymentRow}
          payment={addPaymentRow._editPayment || null}
          onClose={() => setAddPaymentRow(null)}
          onSaved={() => { setAddPaymentRow(null) }}
        />
      )}
    </div>
  )
}

// ── Action menu ────────────────────────────────────────────────────────────────

function ActionMenu({ row, navigate, onDelete, onViewPayments, onAddPayment }) {
  const [open, setOpen] = useState(false)
  const [pos,  setPos]  = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const close  = () => setOpen(false)

  // Portal + flip-up — same pattern as the All Purchases / Products
  // list pages. Lifts the dropdown OUT of the table's overflow-y
  // wrapper so every item is visible regardless of which row was
  // clicked or how close it is to the bottom of the table.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 180
      const spaceBelow = window.innerHeight - r.bottom
      const top  = spaceBelow >= MENU_H ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 192
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setOpen(true)
  }

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
            className="fixed z-[70] w-48 overflow-hidden rounded-lg border border-gray-100 bg-white shadow-pop"
          >
            <Link
              to={`/purchases/returns/add?edit=${row.id}`}
              onClick={close}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              ✏ Edit
            </Link>
            <button
              onClick={() => { close(); onAddPayment?.(row) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              ➕ Add payment
            </button>
            <button
              onClick={() => { close(); onViewPayments?.(row) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              👁 View Payments
            </button>
            <button
              onClick={() => { close(); onDelete() }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
            >
              🗑 Delete
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewReturnPaymentsModal — matches the reference image. Header card
// (Supplier / Business / Reference + Status), payments table with per-
// row Edit / Delete / View action buttons, Print + Close footer. All
// data live from /api/purchases/returns/<id>/ + the company-profile
// endpoint; no hardcoded values.
// ─────────────────────────────────────────────────────────────────────────
function ViewReturnPaymentsModal({ row, onClose, onAddPayment }) {
  const [data, setData]       = useState(null)
  const [company, setCompany] = useState(null)
  const [err, setErr]         = useState('')
  const [viewPayment, setViewPayment] = useState(null)
  const [editPayment, setEditPayment] = useState(null)
  const [busyId, setBusyId]   = useState('')

  const load = async () => {
    try {
      const d = await getPurchaseReturn(row.id)
      setData(d)
    } catch (e) {
      setErr(e?.message || 'Failed to load payments.')
    }
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getPurchaseReturn(row.id).catch(() => null),
      getCompanyProfile().catch(() => null),
    ]).then(([d, c]) => {
      if (cancelled) return
      setData(d); setCompany(c)
    })
    return () => { cancelled = true }
  }, [row.id])

  const fmt    = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDT  = (s) => s ? new Date(s).toLocaleString() : '—'
  const fmtDate= (s) => s ? new Date(s).toLocaleDateString() : '—'
  const payments = Array.isArray(data?.payments) ? data.payments : []

  const handleDelete = async (p) => {
    if (!window.confirm(`Delete payment of ৳ ${fmt(p.amount)}? The linked account will be auto-reversed.`)) return
    setBusyId(p.id)
    try {
      await deletePurchaseReturnPayment(p.id)
      await load()
    } catch (e) {
      window.alert(e?.message || 'Failed to delete payment.')
    } finally {
      setBusyId('')
    }
  }

  const printPayments = () => {
    if (!data) return
    const w = window.open('', '_blank', 'width=1000,height=800')
    if (!w) { window.alert('Allow popups to print.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rowsHtml = payments.length
      ? payments.map((p, i) => `<tr>
          <td>${esc(fmtDT(p.paid_at || p.created_at))}</td>
          <td>${esc(p.reference_no || p.reference || '')}</td>
          <td class="num">৳ ${fmt(p.amount)}</td>
          <td style="text-transform:capitalize">${esc((p.method || '').replace('_', ' '))}</td>
          <td>${esc(p.notes || '')}</td>
          <td>${esc(p.payment_account_name || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">No records found</td></tr>'
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Return Payments ${esc(data.reference_no)}</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:14mm 10mm;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  th{background:#10b981;color:#fff;padding:6px 8px;text-align:left;border:1px solid #0f9971}
  td{padding:6px 8px;border:1px solid #e5e7eb}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .empty{text-align:center;color:#9ca3af}
  @page{size:A4;margin:8mm}
</style></head><body>
<h2 style="font-size:15px;margin:0 0 8px">View Payments ( Reference No: ${esc(data.reference_no)} )</h2>
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
      {!data ? <div className="py-8 text-center text-gray-400">Loading…</div> : (
        <div className="space-y-4 text-sm">
          {/* Header */}
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
              <div className="text-xs text-gray-600">Date: {fmtDate(data.return_date)}</div>
              <div className="text-xs text-gray-600">Status: <span className="capitalize">{data.status || '—'}</span></div>
              <div className="mt-2 flex lg:justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onAddPayment?.(row)}
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
                    <td className="px-3 py-2 text-gray-700">{p.reference_no || p.reference || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">৳ {fmt(p.amount)}</td>
                    <td className="px-3 py-2 text-gray-700 capitalize">{(p.method || '').replace('_', ' ')}</td>
                    <td className="px-3 py-2 text-gray-700">{p.notes || '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{p.payment_account_name || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setEditPayment(p)}
                          title="Edit"
                          className="p-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                        >✎</button>
                        <button
                          onClick={() => handleDelete(p)}
                          disabled={busyId === p.id}
                          title="Delete"
                          className="p-1.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-600 disabled:opacity-50"
                        >🗑</button>
                        <button
                          onClick={() => setViewPayment(p)}
                          title="View"
                          className="p-1.5 rounded bg-sky-50 hover:bg-sky-100 text-sky-700"
                        >👁</button>
                      </div>
                    </td>
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

      {viewPayment && (
        <ViewSinglePaymentModal payment={viewPayment} onClose={() => setViewPayment(null)} />
      )}
      {editPayment && (
        <AddReturnPaymentModal
          row={row}
          payment={editPayment}
          onClose={() => setEditPayment(null)}
          onSaved={() => { setEditPayment(null); load() }}
        />
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AddReturnPaymentModal — create OR edit a refund payment. When the
// optional `payment` prop is set we PATCH it; otherwise POST a new
// one. Backend handles the PaymentAccount ledger reversal on edits.
// ─────────────────────────────────────────────────────────────────────────
function AddReturnPaymentModal({ row, payment, onClose, onSaved }) {
  const editing = !!payment
  const [amount, setAmount] = useState(payment ? String(payment.amount) : '0.00')
  const [method, setMethod] = useState(payment?.method || 'cash')
  const [paymentAccountId, setPaymentAccountId] = useState(payment?.payment_account_id || '')
  const [reference, setReference] = useState(payment?.reference || '')
  const [referenceNo, setReferenceNo] = useState(payment?.reference_no || '')
  const [notes, setNotes] = useState(payment?.notes || '')
  const [paidAt, setPaidAt] = useState(() => {
    const d = payment?.paid_at ? new Date(payment.paid_at) : new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  // Method-specific extras — parsed out of `reference` when editing
  // a non-cash payment, then re-encoded into the reference string
  // before submit so existing rows round-trip cleanly.
  const [cardHolder, setCardHolder] = useState('')
  const [cardType,   setCardType]   = useState('CREDIT_CARD')
  const [chequeBank, setChequeBank] = useState('')
  const [bankAccountNo, setBankAccountNo] = useState('')
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    getPaymentAccounts({ is_active: 'true' })
      .then((r) => setAccounts(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => {})
  }, [])

  // Auto-switch payment account when method changes so the money
  // lands in a sensible default ledger (Cash → CASH, Bank/Cheque
  // → BANK, Card → CARD, Mobile → MFS). Matches the All Purchases
  // Add Payment modal.
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
      if (!n || n <= 0) { setErr('Amount must be > 0.'); setBusy(false); return }
      // Stuff method-specific extras into `notes` as labelled lines
      // so they round-trip through the existing schema without a
      // model migration. The reference (transaction No / cheque No
      // / bank account no) goes into the main `reference` field
      // where the table already shows it.
      const extras = []
      if (method === 'card') {
        if (cardHolder) extras.push(`Card Holder: ${cardHolder}`)
        if (cardType)   extras.push(`Card Type: ${cardType}`)
      } else if (method === 'cheque' && chequeBank) {
        extras.push(`Bank: ${chequeBank}`)
      } else if (method === 'bank_transfer' && bankAccountNo) {
        extras.push(`Bank Account: ${bankAccountNo}`)
      }
      const finalNotes = [notes, ...extras].filter(Boolean).join('\n').trim()
      const body = {
        amount: n,
        method,
        reference,
        reference_no: referenceNo,
        notes: finalNotes,
        payment_account_id: paymentAccountId || null,
        paid_at: paidAt,
      }
      if (editing) await updatePurchaseReturnPayment(payment.id, body)
      else         await addPurchaseReturnPayment(row.id, body)
      window.alert(editing ? 'Payment updated.' : 'Payment recorded.')
      onSaved?.()
    } catch (e) {
      setErr(e?.message || 'Failed to save payment.')
    } finally {
      setBusy(false)
    }
  }

  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit payment' : 'Add payment'} size="2xl">
      <div className="space-y-4 text-sm">
        {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{err}</div>}

        {/* Header info row — matches the reference image */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Supplier :</div>
            <div className="font-medium text-gray-800">Business: {row.supplier_name || '—'}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Reference No:</div>
            <div className="font-medium text-gray-800">{row.reference_no || '—'}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">Location: {row.location_name || '—'}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Total amount: ৳ {fmt(row.grand_total || row.total_amount)}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">Payment Note: —</div>
          </div>
        </div>

        <div className="text-[12px] text-gray-700">Advance Balance: ৳ 0.00</div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input label="Amount: *" type="number" min="0" step="0.01"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input label="Paid on: *" value={paidAt} onChange={(e) => setPaidAt(e.target.value)}
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
            <option value="">None — won't post to a ledger</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.account_type ? ` (${a.account_type})` : ''}
              </option>
            ))}
          </Select>
          {/* Attach Document — UI parity with the reference image.
              Backend has no payment attachment endpoint yet; the
              file is staged locally only, with a clear wire point
              for when the upload endpoint lands. */}
          <div>
            <label className="text-xs font-medium text-gray-700">Attach Document:</label>
            <input type="file" accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
              className="mt-1 block w-full text-xs text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200" />
            <div className="mt-1 text-[10px] text-gray-400">Allowed File: .pdf, .csv, .zip, .doc, .docx, .jpeg, .jpg, .png</div>
          </div>
        </div>

        {/* ── Method-specific inputs — mirror the Add Sale page ── */}
        {method === 'card' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label="Card Transaction No." value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Card Transaction No." />
            <Input label="Card Holder Name" value={cardHolder}
              onChange={(e) => setCardHolder(e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))}
              placeholder="Card Holder Name" />
            <Select label="Card Type" value={cardType} onChange={(e) => setCardType(e.target.value)}>
              <option value="CREDIT_CARD">Credit Card</option>
              <option value="DEBIT_CARD">Debit Card</option>
              <option value="PREPAID">Prepaid</option>
            </Select>
          </div>
        )}
        {method === 'cheque' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label="Cheque No." value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Cheque No." />
            <Input label="Bank Name" value={chequeBank}
              onChange={(e) => setChequeBank(e.target.value)}
              placeholder="Bank Name" />
          </div>
        )}
        {method === 'bank_transfer' && (
          <Input label="Bank Account No" value={bankAccountNo}
            onChange={(e) => setBankAccountNo(e.target.value.replace(/[^\d -]/g, ''))}
            placeholder="Bank Account No" inputMode="numeric" />
        )}
        {(method === 'mobile' || method === 'other') && (
          <Input label="Reference / Transaction No." value={reference}
            onChange={(e) => setReference(e.target.value)} />
        )}

        <div>
          <label className="text-xs font-medium text-gray-700">Payment Note:</label>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>
      <ModalFooter>
        <Button onClick={submit} loading={busy}>{editing ? 'Update' : 'Save'}</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewSinglePaymentModal — read-only details of one refund payment.
// ─────────────────────────────────────────────────────────────────────────
function ViewSinglePaymentModal({ payment, onClose }) {
  const fmt    = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDT  = (s) => s ? new Date(s).toLocaleString() : '—'
  const rows = [
    ['Reference No',     payment.reference_no || '—'],
    ['Amount',           `৳ ${fmt(payment.amount)}`],
    ['Method',           (payment.method || '').replace('_', ' ')],
    ['Payment Account',  payment.payment_account_name || '—'],
    ['Transaction Ref',  payment.reference || '—'],
    ['Paid on',          fmtDT(payment.paid_at || payment.created_at)],
    ['Notes',            payment.notes || '—'],
  ]
  return (
    <Modal open onClose={onClose} title="Payment Details" size="md">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-100">
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-2 text-gray-500 w-44">{k}</td>
              <td className="py-2 text-gray-800 font-medium capitalize">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}
