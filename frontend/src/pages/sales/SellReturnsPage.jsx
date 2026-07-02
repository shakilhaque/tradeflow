/**
 * Sale Returns — Sales → Sale Return
 *
 * Green-themed list of credit notes issued against finalized sales.
 * Modelled on CustomersPage / SuppliersPage so it matches the rest of
 * the Contacts / Sales pages: gradient header, KPI strip, labeled
 * filter card, action-menu dropdown per row, totals footer, CSV /
 * print toolbar, and an empty state when the tenant has no returns.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'

import { getSellReturns, getCustomers, getSellReturn, deleteSellReturn, refundSellReturn, updateSellReturn } from '../../api/sales'
import { getLocations } from '../../api/products'
import { getUsers } from '../../api/users'
import { getCompanyProfile } from '../../api/companyProfile'
import { getPaymentAccounts } from '../../api/accounting'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import Button from '../../components/ui/Button'
import FilterToggle from '../../components/ui/FilterToggle'
import DateRangeField from '../../components/ui/DateRangeField'
import { useDefaultPageSize } from '../../context/SettingsContext'
import {
  DEMO_RETURNS, DEMO_LOCATIONS, DEMO_CUSTOMERS,
} from '../../data/demoSales'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200]

const fmtMoney = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDateTime = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

const STATUS_TINTS = {
  REFUNDED: 'bg-emerald-100 text-emerald-700',
  PAID:     'bg-emerald-100 text-emerald-700',
  PARTIAL:  'bg-amber-100 text-amber-700',
  DUE:      'bg-rose-100 text-rose-700',
  PENDING:  'bg-gray-100 text-gray-600',
}

export default function SellReturnsPage() {
  const navigate = useNavigate()

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows,      setRows]      = useState([])
  const [usingDemo, setUsingDemo] = useState(false)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [search,    setSearch]    = useState('')
  const [filters,   setFilters]   = useState({
    location_id: '', customer_id: '', status: '', user_id: '',
    // Default to the current year so the range picker shows
    // "01/01/YYYY – 12/31/YYYY" like the report pages.
    date_from:   `${new Date().getFullYear()}-01-01`,
    date_to:     `${new Date().getFullYear()}-12-31`,
  })

  // ── Paging ─────────────────────────────────────────────────────────────────
  const defaultPageSize = useDefaultPageSize(25)
  const [page,  setPage]  = useState(1)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Master data ────────────────────────────────────────────────────────────
  const [locations, setLocations] = useState([])
  const [customers, setCustomers] = useState([])

  // ── Per-row modals (View Payments / Add Payment) + company header
  //     for the printed slip. All loaded lazily so the page render is
  //     fast and read-only callers don't pay the cost.
  const [companyProfile, setCompanyProfile] = useState(null)
  const [paymentsRet, setPaymentsRet] = useState(null)
  const [addPaymentRet, setAddPaymentRet] = useState(null)
  const [editRet, setEditRet] = useState(null)
  useEffect(() => {
    getCompanyProfile().then((p) => setCompanyProfile(p || {})).catch(() => setCompanyProfile({}))
  }, [])
  const [usersById, setUsersById] = useState({})

  const loadMaster = useCallback(async () => {
    try {
      const [locs, custs] = await Promise.all([
        getLocations(true).catch(() => null),
        getCustomers({ active_only: 'true' }).catch(() => null),
      ])
      { const _l = Array.isArray(locs)  ? locs  : (locs?.results  ?? DEMO_LOCATIONS); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
      setCustomers(Array.isArray(custs) ? custs : (custs?.results ?? DEMO_CUSTOMERS))
    } catch {
      setLocations(DEMO_LOCATIONS); setCustomers(DEMO_CUSTOMERS)
    }
    // Best-effort: resolve UUIDs to readable names for the User filter.
    try {
      const res = await getUsers()
      const arr = Array.isArray(res) ? res : (res?.results ?? [])
      const map = {}
      for (const u of arr) map[String(u.id)] = u.name || u.username || u.email || String(u.id)
      setUsersById(map)
    } catch { /* ignore */ }
  }, [])

  const loadReturns = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await getSellReturns({
        page, limit,
        search:      search || undefined,
        location_id: filters.location_id || undefined,
        customer_id: filters.customer_id || undefined,
        user_id:     filters.user_id     || undefined,
        date_from:   filters.date_from   || undefined,
        date_to:     filters.date_to     || undefined,
      })
      const list = Array.isArray(data) ? data : (data?.results ?? [])
      setRows(list)
      setUsingDemo(false)
    } catch (err) {
      // Network error / 5xx — fall back to demo so the page still renders.
      setRows(DEMO_RETURNS)
      setUsingDemo(true)
      setError(err?.message || '')
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters])

  useEffect(() => { loadMaster() },  [loadMaster])
  useEffect(() => { loadReturns() }, [loadReturns])

  // Client-side narrowing for demo data + the status dropdown (the
  // backend list doesn't take a payment_status filter today).
  const visibleRows = useMemo(() => {
    let out = rows
    if (filters.status) out = out.filter((r) => (r.payment_status || '') === filters.status)
    if (!usingDemo) return out
    const q = search.trim().toLowerCase()
    if (q) {
      out = out.filter((r) =>
        [r.invoice_no, r.parent_invoice_no, r.customer_name].some((v) => (v || '').toLowerCase().includes(q))
      )
    }
    if (filters.location_id) out = out.filter((r) => r.location_id === filters.location_id)
    if (filters.customer_id) out = out.filter((r) => r.customer_id === filters.customer_id)
    return out
  }, [rows, usingDemo, search, filters])

  const totals = useMemo(() => {
    const byStatus = {}
    let amount = 0, refunded = 0, due = 0
    for (const r of visibleRows) {
      amount   += Number(r.total_amount    || 0)
      refunded += Number(r.refunded_amount || 0)
      due      += Number(r.balance_due     || 0)
      const s = (r.payment_status || 'PENDING').toUpperCase()
      byStatus[s] = (byStatus[s] || 0) + 1
    }
    return { count: visibleRows.length, amount, refunded, due, byStatus }
  }, [visibleRows])

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / limit))
  const pageRows  = visibleRows.slice((page - 1) * limit, page * limit)
  const csvHref   = useMemo(() => buildCsv(visibleRows), [visibleRows])

  // ── Print the list as a clean table document (not the whole page) ───────────
  const handlePrintList = () => {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const c = companyProfile || {}
    const rowsHtml = visibleRows.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(fmtDateTime(r.date || r.return_date || r.created_at))}</td>
      <td><b>${esc(r.invoice_no || '—')}</b></td>
      <td>${esc(r.parent_invoice_no || (r.parent_sale_id ? String(r.parent_sale_id).slice(0, 8) : '—'))}</td>
      <td>${esc(r.customer_name || 'Walk-in')}</td>
      <td>${esc(r.location_name || '—')}</td>
      <td>${esc(r.payment_status || 'PENDING')}</td>
      <td class="num">${money(r.total_amount)}</td>
      <td class="num">${money(r.refunded_amount)}</td>
      <td class="num">${money(r.balance_due)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">No sale returns.</td></tr>'

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Sale Returns — ${esc(c.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:10mm 8mm;font-size:11px}
  .row{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:700;color:#10b981;letter-spacing:.5px;margin:0}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:10px;line-height:1.45}
  table{width:100%;border-collapse:collapse;font-size:10px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 7px;border:1px solid #0f9971;white-space:nowrap}
  td{padding:6px 7px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tfoot td{background:#f9fafb;font-weight:600}
  .empty{text-align:center;color:#9ca3af;padding:18px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:9px;color:#6b7280}
  @page{size:A4 landscape;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">Sale Returns</h1>
    <div class="block" style="margin-top:4px">
      <b>${esc(c.business_name || '')}</b><br>
      ${esc(c.address || '')}<br>
      ${c.phone ? 'Phone: ' + esc(c.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">${visibleRows.length} record${visibleRows.length === 1 ? '' : 's'}</div>
  </div>
</div>

<table>
  <thead><tr>
    <th>#</th>
    <th>Date</th>
    <th>Credit Note #</th>
    <th>Parent Sale</th>
    <th>Customer</th>
    <th>Location</th>
    <th>Status</th>
    <th class="num">Total</th>
    <th class="num">Refunded</th>
    <th class="num">Due</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="7" style="text-align:right">Totals:</td>
    <td class="num">${money(totals.amount)}</td>
    <td class="num">${money(totals.refunded)}</td>
    <td class="num">${money(totals.due)}</td>
  </tr></tfoot>
</table>

<div class="footer">
  <div>Total Returned: <b>${money(totals.amount)}</b> · Refunded: <b>${money(totals.refunded)}</b> · Outstanding: <b>${money(totals.due)}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  const onReset = () => {
    setSearch('')
    setFilters({
      location_id: '', customer_id: '', status: '', user_id: '',
      date_from: `${new Date().getFullYear()}-01-01`,
      date_to:   `${new Date().getFullYear()}-12-31`,
    })
    setPage(1)
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Sale Returns</h1>
          <p className="text-xs text-emerald-50 mt-0.5">
            Credit notes issued against finalized sales.
            {usingDemo && (
              <span className="ml-2 inline-block rounded bg-amber-200/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-50 ring-1 ring-amber-100/40">
                demo data — backend unreachable
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => navigate('/sales/returns/new')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm hover:bg-emerald-50"
        >
          <PlusIcon /> New Sale Return
        </button>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Returns"        value={totals.count}                accent="emerald" />
        <Kpi label="Total returned" value={fmtMoney(totals.amount)}     accent="green" />
        <Kpi label="Refunded"       value={fmtMoney(totals.refunded)}   accent="teal" />
        <Kpi label="Outstanding"    value={fmtMoney(totals.due)}        accent="rose" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} />
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
          <FieldSelect label="Business Location" value={filters.location_id}
                       onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, location_id: v })) }}
                       options={[{ value: '', label: 'All' }, ...locations.map((l) => ({ value: l.id, label: l.name }))]} />
          <FieldSelect label="Customer" value={filters.customer_id}
                       onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, customer_id: v })) }}
                       options={[{ value: '', label: 'All' }, ...customers.map((c) => ({ value: c.id, label: c.name }))]} />
          <FieldSelect label="Status" value={filters.status}
                       onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, status: v })) }}
                       options={[
                         { value: '',         label: 'Any status' },
                         { value: 'REFUNDED', label: 'Refunded' },
                         { value: 'PARTIAL',  label: 'Partial'  },
                         { value: 'DUE',      label: 'Due'      },
                         { value: 'PENDING',  label: 'Pending'  },
                       ]} />
          <FieldSelect label="User" value={filters.user_id}
                       onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, user_id: v })) }}
                       options={[
                         { value: '', label: 'All' },
                         ...Object.entries(usersById).map(([id, name]) => ({ value: id, label: name })),
                       ]} />
          <DateRangeField
            from={filters.date_from}
            to={filters.date_to}
            onChange={(r) => { setPage(1); setFilters((f) => ({ ...f, date_from: r.from, date_to: r.to })) }}
          />
          <div className="sm:col-span-2 lg:col-span-2 self-end flex justify-end gap-2">
            <button
              onClick={onReset}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
            >
              Reset
            </button>
            <button
              onClick={loadReturns}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              Apply filters
            </button>
          </div>
        </div>
      </div>

      {error && !usingDemo && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Table card ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadReturns()}
            placeholder="Search by invoice / customer…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`sale-returns-${new Date().toISOString().slice(0, 10)}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <DownloadIcon /> CSV
            </a>
            <button
              onClick={handlePrintList}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <PrintIcon /> Print
            </button>
            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
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
            <EmptyState onAdd={() => navigate('/sales/returns/new')} />
          ) : (
            <ReturnsTable
              rows={pageRows}
              totals={totals}
              navigate={navigate}
              onDelete={async (r) => {
                if (!window.confirm(`Delete credit note ${r.invoice_no || ''}? This cannot be undone.`)) return
                try {
                  await deleteSellReturn(r.id)
                  setRows((prev) => prev.filter((x) => x.id !== r.id))
                  window.alert('Credit note deleted.')
                } catch (e) {
                  window.alert(e?.message || 'Failed to delete credit note.')
                }
              }}
              onAddPayment={async (r) => {
                try { setAddPaymentRet(await getSellReturn(r.id)) }
                catch (e) { window.alert(e?.message || 'Could not load credit note for payment.') }
              }}
              onViewPayments={async (r) => {
                try { setPaymentsRet(await getSellReturn(r.id)) }
                catch (e) { window.alert(e?.message || 'Could not load credit note.') }
              }}
              onEdit={async (r) => {
                try { setEditRet(await getSellReturn(r.id)) }
                catch (e) { window.alert(e?.message || 'Could not load credit note for edit.') }
              }}
            />
          )}
        </div>

        {!loading && pageRows.length > 0 && (
          <Pager page={page} totalPages={pageCount} count={visibleRows.length} limit={limit} onChange={setPage} />
        )}
      </div>

      {/* View Payments modal — matches the user's reference image. */}
      {paymentsRet && (
        <ViewReturnPaymentsModal
          ret={paymentsRet}
          company={companyProfile}
          onClose={() => setPaymentsRet(null)}
          onAddPayment={() => { setAddPaymentRet(paymentsRet); setPaymentsRet(null) }}
        />
      )}

      {/* Add Payment modal — only opens when balance_due > 0. */}
      {addPaymentRet && (
        <AddReturnPaymentModal
          ret={addPaymentRet}
          onClose={() => setAddPaymentRet(null)}
          onSaved={(updated) => {
            setAddPaymentRet(null)
            // Refresh the row in the list so the new payment_status
            // / refunded_amount / balance_due land immediately.
            setRows((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x))
          }}
        />
      )}

      {/* Edit credit-note modal — change return quantity per line
          and/or the header discount. Posts an updated total to the
          backend via refundSellReturn-like helper (server recomputes). */}
      {editRet && (
        <EditReturnModal
          ret={editRet}
          onClose={() => setEditRet(null)}
          onSaved={(updated) => {
            setEditRet(null)
            setRows((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x))
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

function ReturnsTable({ rows, totals, navigate, onDelete, onAddPayment, onViewPayments, onEdit }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3 w-24">Action</th>
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Credit Note #</th>
          <th className="px-5 py-3">Parent Sale</th>
          <th className="px-5 py-3">Customer</th>
          <th className="px-5 py-3">Location</th>
          <th className="px-5 py-3 text-center">Status</th>
          <th className="px-5 py-3 text-right">Total</th>
          <th className="px-5 py-3 text-right">Refunded</th>
          <th className="px-5 py-3 text-right">Due</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3">
              <RowMenu
                row={r}
                onView={() => navigate(`/sales/returns/${r.id}`)}
                onEdit={() => onEdit?.(r)}
                // Print in the SAME tab per spec (was opening a new
                // window which felt disruptive on touch screens).
                onPrint={() => navigate(`/sales/returns/${r.id}?print=1`)}
                onDelete={() => onDelete?.(r)}
                onAddPayment={() => onAddPayment?.(r)}
                onViewPayments={() => onViewPayments?.(r)}
              />
            </td>
            <td className="px-5 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(r.date || r.return_date || r.created_at)}</td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.invoice_no || '—'}</td>
            <td className="px-5 py-3 font-mono text-xs">
              {r.parent_sale_id ? (
                <Link to={`/sales/${r.parent_sale_id}`} className="text-sky-700 hover:underline">
                  {r.parent_invoice_no || String(r.parent_sale_id).slice(0, 8)}
                </Link>
              ) : <span className="text-gray-400">—</span>}
            </td>
            <td className="px-5 py-3 text-gray-700">{r.customer_name || <span className="text-gray-400 italic">Walk-in</span>}</td>
            <td className="px-5 py-3 text-gray-500">{r.location_name || '—'}</td>
            <td className="px-5 py-3 text-center">
              <span className={[
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                STATUS_TINTS[(r.payment_status || 'PENDING').toUpperCase()] || STATUS_TINTS.PENDING,
              ].join(' ')}>
                {r.payment_status || 'PENDING'}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-gray-900">{fmtMoney(r.total_amount)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-emerald-700">{fmtMoney(r.refunded_amount)}</td>
            <td className="px-5 py-3 text-right tabular-nums">
              <span className={Number(r.balance_due) > 0 ? 'text-rose-700 font-semibold' : 'text-gray-400'}>
                {fmtMoney(r.balance_due)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm">
          <td className="px-5 py-3" />
          <td className="px-5 py-3 font-semibold text-emerald-900" colSpan={5}>
            Total ·{' '}
            {Object.entries(totals.byStatus).map(([s, n], i, arr) => (
              <span key={s} className="mr-2 inline-flex items-center gap-1 text-[11px]">
                <span className={`inline-block rounded px-1.5 py-0.5 ${STATUS_TINTS[s] || STATUS_TINTS.PENDING}`}>
                  {s}: {n}
                </span>
                {i < arr.length - 1 ? '' : ''}
              </span>
            ))}
          </td>
          <td className="px-5 py-3" />
          <td className="px-5 py-3 text-right tabular-nums font-bold text-emerald-900">{fmtMoney(totals.amount)}</td>
          <td className="px-5 py-3 text-right tabular-nums font-bold text-emerald-700">{fmtMoney(totals.refunded)}</td>
          <td className="px-5 py-3 text-right tabular-nums font-bold text-rose-700">{fmtMoney(totals.due)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

function RowMenu({ row, onView, onEdit, onPrint, onDelete, onAddPayment, onViewPayments }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const canAddPayment =
    row?.payment_status && String(row.payment_status).toUpperCase() !== 'PAID'

  // Position the dropdown right under the Actions button using
  // viewport coordinates so it doesn't get clipped by the
  // overflow-x-auto wrapper around the table.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      setPos({
        top:  r.bottom + window.scrollY + 4,
        left: r.right  + window.scrollX - 160,   // 160 = menu width
      })
    }
    setOpen(true)
  }
  const closeMenu = () => setOpen(false)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!e.target.closest('[data-rowmenu-popup]') && !e.target.closest('[data-rowmenu-trigger]')) {
        closeMenu()
      }
    }
    const onEsc = (e) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        data-rowmenu-trigger
        onClick={() => (open ? closeMenu() : openMenu())}
        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
      >
        Actions <ChevronDownIcon />
      </button>
      {/* Portal the menu to <body> with fixed positioning so the
          table's overflow-x-auto wrapper can't clip it. */}
      {open && createPortal(
        <div
          data-rowmenu-popup
          style={{ position: 'absolute', top: pos.top, left: pos.left, width: 160 }}
          className="z-[1000] rounded-lg border border-gray-100 bg-white shadow-pop py-1"
        >
          <button onClick={() => { closeMenu(); onView() }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700">
            👁 View
          </button>
          <button onClick={() => { closeMenu(); onEdit() }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700">
            ✎ Edit
          </button>
          {onDelete && (
            <button onClick={() => { closeMenu(); onDelete() }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50">
              🗑 Delete
            </button>
          )}
          <button onClick={() => { closeMenu(); onPrint() }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700">
            🖨 Print
          </button>
          {canAddPayment && onAddPayment && (
            <button onClick={() => { closeMenu(); onAddPayment() }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700">
              💵 Add payment
            </button>
          )}
          {onViewPayments && (
            <button onClick={() => { closeMenu(); onViewPayments() }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700">
              📜 View Payments
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <ReturnIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No sale returns yet.</p>
      <p className="mt-1 text-xs text-gray-500">Create a credit note from a finalized sale to start tracking refunds.</p>
      <button
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        <PlusIcon /> New Sale Return
      </button>
    </div>
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
  const header = ['Date', 'Credit Note', 'Parent Invoice', 'Customer', 'Location', 'Status', 'Total', 'Refunded', 'Due']
  const lines = rows.map((r) => [
    r.date || r.return_date || r.created_at, r.invoice_no, r.parent_invoice_no,
    r.customer_name, r.location_name, r.payment_status,
    r.total_amount, r.refunded_amount, r.balance_due,
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
    rose:    'from-rose-50 to-rose-100 ring-rose-200 text-rose-700',
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
          <option key={`${o.value}-${o.label}`} value={o.value}>{o.label}</option>
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
        type="date" value={value}
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
        <PagerButton onClick={() => onChange(1)}            disabled={page === 1}>«</PagerButton>
        <PagerButton onClick={() => onChange(page - 1)}     disabled={page === 1}>‹</PagerButton>
        <span className="px-3 py-1.5 text-xs font-semibold text-gray-700">Page {page} of {totalPages}</span>
        <PagerButton onClick={() => onChange(page + 1)}     disabled={page >= totalPages}>›</PagerButton>
        <PagerButton onClick={() => onChange(totalPages)}   disabled={page >= totalPages}>»</PagerButton>
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
function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
    </svg>
  )
}
function ChevronDownIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
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
function ReturnIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────
// ViewReturnPaymentsModal — matches the user's reference layout:
// Customer / Business / Invoice meta on top, then the payments table,
// then Print + Close. "Add payment" only shows when there's an
// outstanding refund due.
// ─────────────────────────────────────────────────────────────────────
function ViewReturnPaymentsModal({ ret, company, onClose, onAddPayment }) {
  const c = company || {}
  const cust = ret.customer || {}
  const due = Number(ret.balance_due || 0)
  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtD = (d) => d ? new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
  const payments = ret.payments || (Number(ret.amount_paid) > 0 ? [{
    id: 'refund',
    paid_on: ret.updated_at || ret.created_at,
    reference: ret.invoice_number,
    amount: ret.amount_paid,
    method: ret.refund_method || '—',
    note: 'Refund recorded with credit note',
    payment_account_name: ret.meta?.payment_account_name || '—',
  }] : [])

  return (
    <Modal open onClose={onClose} title={`View Payments  (Invoice No.: ${ret.invoice_no || ret.invoice_number || '—'})`} size="3xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <div className="font-semibold text-gray-900 mb-1">Customer:</div>
          <div className="text-gray-700">{cust.name || ret.customer_name || 'Walk-in'}</div>
          {cust.address && <div className="text-gray-600 text-xs">{cust.address}</div>}
          {(cust.phone || cust.mobile) && <div className="text-gray-600 text-xs">Mobile: {cust.phone || cust.mobile}</div>}
        </div>
        <div>
          <div className="font-semibold text-gray-900 mb-1">Business:</div>
          <div className="text-gray-700">{c.name || c.business_name || '—'}</div>
          {c.address && <div className="text-gray-600 text-xs">{c.address}</div>}
          {(c.phone || c.mobile) && <div className="text-gray-600 text-xs">Mobile: {c.phone || c.mobile}</div>}
        </div>
        <div>
          <div className="font-semibold text-gray-900 mb-1">Invoice No.:</div>
          <div className="text-gray-700">#{ret.invoice_no || ret.invoice_number || '—'}</div>
          <div className="text-gray-600 text-xs">Date: {fmtD(ret.return_date || ret.created_at)}</div>
          <div className="text-gray-600 text-xs">Payment Status: <span className={due > 0 ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>{due > 0 ? 'Due' : 'Paid'}</span></div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        {due > 0 && (
          <Button variant="secondary" onClick={onAddPayment} className="!bg-brand-600 !text-white hover:!bg-brand-700">+ Add payment</Button>
        )}
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2 whitespace-nowrap">Date</th>
              <th className="px-3 py-2 whitespace-nowrap">Reference No</th>
              <th className="px-3 py-2 text-right whitespace-nowrap">Amount</th>
              <th className="px-3 py-2 whitespace-nowrap">Payment Method</th>
              <th className="px-3 py-2 whitespace-nowrap">Payment Note</th>
              <th className="px-3 py-2 whitespace-nowrap">Payment Account</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {payments.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400 italic">No records found</td></tr>
            ) : payments.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 text-gray-700">{fmtD(p.paid_on)}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-700">{p.reference || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium whitespace-nowrap">{fmt(p.amount)}</td>
                <td className="px-3 py-2 text-gray-700">{p.method || '—'}</td>
                <td className="px-3 py-2 text-gray-600">{p.note || '—'}</td>
                <td className="px-3 py-2 text-gray-700">{p.payment_account_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={() => window.open(`/sales/returns/${ret.id}?print=1`, '_blank')}>Print</Button>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// AddReturnPaymentModal — refund add-payment form. Mirrors the sale
// Add Payment modal: amount + method + Payment Account dropdown.
// Calls refundSellReturn() which bumps amount_paid / balance_due and
// posts a PaymentAccountTransaction so the chosen account's ledger
// reflects the cash leaving.
// ─────────────────────────────────────────────────────────────────────
function AddReturnPaymentModal({ ret, onClose, onSaved }) {
  const balanceDue = Math.max(0, Number(ret.balance_due || 0))
  const [amount,    setAmount]    = useState(balanceDue ? balanceDue.toFixed(2) : '')
  const [method,    setMethod]    = useState('CASH')
  const [accountId, setAccountId] = useState('')
  const [note,      setNote]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [err,       setErr]       = useState('')
  const [accounts,  setAccounts]  = useState([])
  useEffect(() => {
    getPaymentAccounts({ active: 'true' })
      .then((r) => setAccounts(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => setAccounts([]))
  }, [])

  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const submit = async () => {
    setErr('')
    const amt = Number(amount)
    if (!amt || amt <= 0) { setErr('Amount must be greater than zero.'); return }
    if (amt > balanceDue + 0.01) { setErr(`Amount cannot exceed balance due (${fmt(balanceDue)}).`); return }
    setSaving(true)
    try {
      const updated = await refundSellReturn(ret.id, {
        amount: amt,
        method,
        payment_account_id: accountId || undefined,
        notes: note || undefined,
      })
      window.alert('Refund recorded.')
      onSaved?.(updated)
    } catch (e) {
      const msg = e?.errors?.detail || e?.payload?.detail || e?.message || 'Failed to record refund.'
      setErr(msg); window.alert(msg)
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'block text-[12px] font-medium text-gray-700 mb-1'
  const ipt = 'w-full h-10 rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title={`Add Refund Payment — ${ret.invoice_no || ret.invoice_number || ''}`} size="lg">
      <div className="space-y-3">
        {err && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

        <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-sm">
          <span className="text-gray-600">Outstanding refund due</span>
          <span className="font-semibold text-rose-700">{fmt(balanceDue)}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={lbl}>Amount</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={ipt} />
          </div>
          <div>
            <label className={lbl}>Payment Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={ipt}>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="MOBILE_BANKING">Mobile Banking</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Payment Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={ipt}>
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.account_type ? ` (${a.account_type})` : ''}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={lbl}>Note</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={`${ipt} h-auto py-2`} placeholder="Reference / cashier note" />
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Record Refund</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// EditReturnModal — matches the user's reference layout. Lets the
// operator change per-line Return Quantity + header Discount Type
// + Discount Amount. Saves via updateSellReturn() which recomputes
// the credit-note total + balance_due + payment_status.
// ─────────────────────────────────────────────────────────────────────
function EditReturnModal({ ret, onClose, onSaved }) {
  const parentInvoice = ret.parent_invoice_no || '—'
  const parentDate = ret.parent_sale_date || ret.return_date
  const customer = ret.customer || {}
  const initialItems = (ret.items || []).map((it) => ({
    id: it.id,
    name: it.product_name || it.description || '—',
    unit: it.unit || 'Pc(s)',
    unit_price: Number(it.unit_price) || 0,
    sell_quantity: Number(it.original_quantity || it.sell_quantity || it.quantity || 0),
    quantity: Number(it.quantity || 0),
  }))
  const [items, setItems] = useState(initialItems)
  const [dType, setDType] = useState(String(ret.meta?.discount_type || 'PERCENTAGE').toUpperCase())
  const [dValue, setDValue] = useState(String(ret.meta?.discount_value ?? 0))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const fmtMoneyLocal = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const subtotal = items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity || 0), 0)
  const discount = dType === 'PERCENTAGE'
    ? Math.min(subtotal, subtotal * (Number(dValue) || 0) / 100)
    : Math.min(subtotal, Number(dValue) || 0)
  const total = Math.max(0, subtotal - discount)

  const submit = async () => {
    setErr('')
    // Each line must be ≤ sold quantity.
    const bad = items.find((it) => Number(it.quantity || 0) > Number(it.sell_quantity || 0))
    if (bad) { setErr(`${bad.name}: return qty cannot exceed sold qty (${bad.sell_quantity}).`); return }
    setSaving(true)
    try {
      const updated = await updateSellReturn(ret.id, {
        items: items.map((it) => ({ id: it.id, quantity: Number(it.quantity || 0) })),
        discount_type: dType,
        discount_value: Number(dValue) || 0,
      })
      window.alert('Credit note updated.')
      onSaved?.(updated)
    } catch (e) {
      const msg = e?.errors?.detail || e?.payload?.detail || e?.message || 'Failed to update.'
      setErr(msg); window.alert(msg)
    } finally { setSaving(false) }
  }

  const lbl = 'block text-[12px] font-medium text-gray-700 mb-1'
  const ipt = 'w-full h-9 rounded-md border border-gray-300 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title="Sell Return" size="3xl">
      {/* Parent Sale panel — context for the operator. */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Parent Sale</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
          <div><span className="text-rose-600 font-semibold">Invoice No.:</span> {parentInvoice}</div>
          <div><span className="text-rose-600 font-semibold">Customer:</span> {customer.name || ret.customer_name || '—'}</div>
          <div><span className="text-rose-600 font-semibold">Date:</span> {parentDate ? new Date(parentDate).toLocaleDateString() : '—'}</div>
          <div><span className="text-rose-600 font-semibold">Business Location:</span> {ret.location_name || '—'}</div>
        </div>
      </div>

      {err && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className={lbl}>Invoice No.:</label>
          <input value={ret.invoice_no || ret.invoice_number || ''} readOnly className={`${ipt} bg-gray-50`} />
        </div>
        <div>
          <label className={lbl}>Date: <span className="text-rose-500">*</span></label>
          <input type="datetime-local" value={(ret.return_date || ret.created_at || '').slice(0, 16)} readOnly className={`${ipt} bg-gray-50`} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-emerald-200">
        <table className="w-full text-sm">
          <thead className="bg-emerald-500 text-white">
            <tr>
              <th className="px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Product Name</th>
              <th className="px-2 py-2 text-right">Unit Price</th>
              <th className="px-2 py-2 text-right">Sell Quantity</th>
              <th className="px-2 py-2 text-right">Return Quantity</th>
              <th className="px-2 py-2 text-right">Return Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id} className="bg-gray-50 border-t border-emerald-100">
                <td className="px-2 py-2 text-gray-700">{i + 1}</td>
                <td className="px-2 py-2 text-gray-900">{it.name}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtMoneyLocal(it.unit_price)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{Number(it.sell_quantity).toFixed(2)} {it.unit}</td>
                <td className="px-2 py-2 w-32">
                  <input
                    type="number"
                    min="0"
                    max={it.sell_quantity}
                    step="0.01"
                    value={it.quantity}
                    onChange={(e) => setItems((arr) => arr.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))}
                    className={ipt + ' text-right'}
                  />
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtMoneyLocal(Number(it.unit_price) * Number(it.quantity || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div>
          <label className={lbl}>Discount Type:</label>
          <select value={dType} onChange={(e) => setDType(e.target.value)} className={ipt}>
            <option value="PERCENTAGE">Percentage</option>
            <option value="FIXED">Fixed</option>
          </select>
        </div>
        <div>
          <label className={lbl}>Discount Amount:</label>
          <input type="number" min="0" step="0.01" value={dValue} onChange={(e) => setDValue(e.target.value)} className={ipt} />
        </div>
      </div>

      <div className="mt-3 text-right text-sm space-y-0.5">
        <div><span className="text-gray-600">Total Return Discount: </span><span className="font-medium">(−) {fmtMoneyLocal(discount)}</span></div>
        <div><span className="text-gray-600">Total Return Tax  − : </span><span className="font-medium">(+) {fmtMoneyLocal(0)}</span></div>
        <div className="text-base"><span className="text-gray-600">Return Total: </span><span className="font-bold text-emerald-700">{fmtMoneyLocal(total)}</span></div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}
