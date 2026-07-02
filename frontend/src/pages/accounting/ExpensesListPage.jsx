import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import Badge from '../../components/ui/Badge'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import {
  getExpenses, deleteExpense, getExpenseCategories, updateExpense,
  getExpense, getExpensePayments, addExpensePayment,
  updateExpensePayment, deleteExpensePayment,
  getPaymentAccounts,
} from '../../api/accounting'
import { getCustomers } from '../../api/sales'
import { getSuppliers } from '../../api/purchases'
import { getCompanyProfile } from '../../api/companyProfile'
import { getLocations } from '../../api/inventory'
import Modal, { ModalFooter } from '../../components/ui/Modal'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) : '—'

const PAYMENT_VARIANT = { paid: 'green', partial: 'yellow', due: 'red' }
const PAYMENT_LABEL   = { paid: 'Paid',  partial: 'Partial', due: 'Due' }

const CATEGORY_OPTIONS = [
  { value: 'RENT',      label: 'Rent' },
  { value: 'UTILITIES', label: 'Utilities' },
  { value: 'SALARIES',  label: 'Salaries' },
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'SUPPLIES',  label: 'Supplies' },
  { value: 'TRANSPORT', label: 'Transport' },
  { value: 'OTHER',     label: 'Other' },
]

export default function ExpensesListPage() {
  const navigate = useNavigate()

  const [filtersOpen, setFiltersOpen] = useState(true)
  const [filters, setFilters] = useState({
    location_id:    '',
    expense_for:    '',
    contact:        '',
    category:       '',
    payment_status: '',
    date_from:      `${currentYear}-01-01`,
    date_to:        `${currentYear}-12-31`,
  })
  const [search, setSearch] = useState('')
  const [page,   setPage]   = useState(1)
  const [limit,  setLimit]  = useState(25)

  const [locations, setLocations] = useState([])
  const [contactOptions, setContactOptions] = useState([])
  const [expCategories, setExpCategories] = useState([])
  const [companyProfile, setCompanyProfile] = useState(null)
  const [data, setData] = useState({ results: [], count: 0, total_pages: 1, summary: {} })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  // View Payments modal state + delete confirm.
  const [paymentsExpense, setPaymentsExpense] = useState(null)
  const [confirmDelete,   setConfirmDelete]   = useState(null)
  const [editExpense,     setEditExpense]     = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const [locs, cats, company] = await Promise.all([
          getLocations({ active_only: 'true' }),
          getExpenseCategories({ active: 'true' }).catch(() => []),
          getCompanyProfile().catch(() => ({})),
        ])
        { const _l = Array.isArray(locs) ? locs : (locs?.results ?? []); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
        setExpCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
        setCompanyProfile(company || {})
      } catch { /* ignore */ }
    })()
  }, [])

  // Contact filter options — merged Customers + Suppliers from the
  // per-tenant DB, deduped by name. Loaded once so the Contact filter
  // can be a simple "All / pick one" dropdown (like Expense Category)
  // instead of a search box.
  useEffect(() => {
    (async () => {
      try {
        const [custRes, supRes] = await Promise.all([
          getCustomers({ active_only: 'true' }).catch(() => []),
          getSuppliers({ active_only: 'true' }).catch(() => []),
        ])
        const merged = new Map()
        const add = (arr) => (Array.isArray(arr) ? arr : (arr?.results ?? []))
          .forEach((c) => { if (c?.name) merged.set(c.name.toLowerCase(), c.name) })
        add(custRes); add(supRes)
        setContactOptions([...merged.values()].sort((a, b) => a.localeCompare(b)))
      } catch { /* ignore */ }
    })()
  }, [])

  const onDelete = async (row) => {
    try {
      await deleteExpense(row.id)
      setConfirmDelete(null)
      load()
    } catch (e) {
      alert(e?.message || 'Failed to delete expense.')
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {
        page, limit, search,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      }
      const res = await getExpenses(params)
      // Backend may return a paginated dict OR a plain list (older versions).
      if (Array.isArray(res)) {
        setData({ results: res, count: res.length, total_pages: 1, summary: {} })
      } else {
        setData(res || { results: [], count: 0, total_pages: 1, summary: {} })
      }
    } catch (err) {
      setError(err?.message || 'Failed to load expenses.')
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

  const resetFilters = () => {
    setFilters({
      location_id: '', expense_for: '', contact: '',
      category: '', payment_status: '',
      date_from: `${currentYear}-01-01`, date_to: `${currentYear}-12-31`,
    })
    setSearch(''); setPage(1)
  }

  const exportCsv = () => {
    const rows = data.results || []
    if (!rows.length) return
    const head = ['Date','Reference','Category','Location','Payment Status','Tax','Total','Paid','Due','For','Contact','Description']
    const lines = [head.join(',')].concat(rows.map((r) => [
      fmtDateTime(r.created_at || r.expense_date),
      r.reference_no,
      r.category_display || r.category,
      (r.location_name || '').replace(/,/g,' '),
      PAYMENT_LABEL[r.payment_status] || r.payment_status,
      Number(r.tax_amount || 0).toFixed(2),
      Number(r.amount || 0).toFixed(2),
      Number(r.paid_amount || 0).toFixed(2),
      Number(r.payment_due || 0).toFixed(2),
      (r.expense_for || '').replace(/,/g,' '),
      (r.contact_name || '').replace(/,/g,' '),
      (r.description || '').replace(/[\r\n,]/g,' '),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `expenses-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const summary = data.summary || {}
  const statusSummary = useMemo(() => {
    const sc = summary.status_counts || {}
    return Object.entries(sc).map(([k, v]) =>
      `${PAYMENT_LABEL[k] || k} - ${v}`
    ).join(', ')
  }, [summary.status_counts])

  // Page-local fallback totals
  const pageTotals = useMemo(() => {
    const rows = data.results || []
    return {
      amount: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      due:    rows.reduce((s, r) => s + Number(r.payment_due ?? 0), 0),
    }
  }, [data.results])

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Expenses</h1>
        <p className="mt-0.5 text-sm text-emerald-50">Track operational expenses across locations and payment statuses.</p>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <button type="button" onClick={() => setFiltersOpen((v) => !v)} className="flex items-center gap-2 text-sm font-semibold text-brand-700">
            Filters
            <svg className={`h-4 w-4 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          <button onClick={resetFilters} className="text-xs font-medium text-brand-600 hover:text-brand-700">
            Reset
          </button>
        </div>
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
          <Select label="Business Location" value={filters.location_id} onChange={(e) => handleFilterChange('location_id', e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          {/* "Expense for" + "Contact" filters — simple "All / pick one"
              dropdowns (same UX as Expense Category). Expense-for options
              are the Business Locations; Contact options are the merged
              Customers + Suppliers list loaded once on mount. */}
          <Select label="Expense for" value={filters.expense_for} onChange={(e) => handleFilterChange('expense_for', e.target.value)}>
            <option value="">All</option>
            {locations.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
          </Select>
          <Select label="Contact" value={filters.contact} onChange={(e) => handleFilterChange('contact', e.target.value)}>
            <option value="">All</option>
            {contactOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
          <Select label="Expense Category" value={filters.category} onChange={(e) => handleFilterChange('category', e.target.value)}>
            <option value="">All</option>
            {expCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {/* Legacy fixed categories kept for older rows. */}
            {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Date Range</label>
            <DateRangePresetPicker
              from={filters.date_from}
              to={filters.date_to}
              onChange={({ from, to }) => {
                handleFilterChange('date_from', from)
                handleFilterChange('date_to', to)
              }}
            />
          </div>
          <Select label="Payment Status" value={filters.payment_status} onChange={(e) => handleFilterChange('payment_status', e.target.value)}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="due">Due</option>
          </Select>
        </div>
      </Card>

      {/* Banner */}
      <div className="rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-500 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <h3 className="text-base font-semibold">All Expenses</h3>
        <span className="text-sm">
          Total: {fmtMoney(summary.total_amount ?? pageTotals.amount)}
          <span className="mx-2 text-white/60">·</span>
          Due: {fmtMoney(summary.total_due ?? pageTotals.due)}
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
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!data.results?.length}>
            Export CSV
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <SearchInput
            placeholder="Search reference, contact, notes..."
            value={search}
            onChange={(v) => { setSearch(v); setPage(1) }}
          />
          <Button onClick={() => navigate('/accounting/expenses/add')}>
            <span className="mr-1">+</span> Add Expense
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState title="No expenses" message="Recorded expenses will appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Reference No</th>
                  <th className="px-4 py-3">Recurring</th>
                  <th className="px-4 py-3">Expense Category</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Payment Status</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Tax</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Total Amount</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Payment Due</th>
                  <th className="px-4 py-3 whitespace-nowrap">Expense For</th>
                  <th className="px-4 py-3">Contact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <ActionMenu
                        row={r}
                        onEdit={() => setEditExpense(r)}
                        onDelete={() => setConfirmDelete(r)}
                        onViewPayment={() => setPaymentsExpense(r)}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{fmtDateTime(r.created_at || r.expense_date)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.reference_no || '—'}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {r.recurring ? (r.recurring_details || 'Recurring') : '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-700">{r.category_display || r.category}</td>
                    <td className="px-4 py-3 text-gray-700">{r.location_name || '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={PAYMENT_VARIANT[r.payment_status] ?? 'gray'}>
                        {PAYMENT_LABEL[r.payment_status] || r.payment_status || '—'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMoney(r.tax_amount)}</td>
                    <td className="px-4 py-3 text-right font-medium whitespace-nowrap">{fmtMoney(r.amount)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMoney(r.payment_due ?? Math.max((Number(r.amount)||0) - (Number(r.paid_amount)||0), 0))}</td>
                    <td className="px-4 py-3 text-gray-700">{r.expense_for || '—'}</td>
                    <td className="px-4 py-3 text-gray-700">{r.contact_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-100 text-sm font-semibold text-gray-800 border-t border-gray-200">
                  <td className="px-4 py-3" colSpan={6}>Total:</td>
                  <td className="px-4 py-3 text-gray-700">{statusSummary || '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMoney(summary.total_tax)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMoney(summary.total_amount ?? pageTotals.amount)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMoney(summary.total_due ?? pageTotals.due)}</td>
                  <td className="px-4 py-3" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {!loading && data.count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–
            <strong>{Math.min(page * limit, data.count)}</strong> of <strong>{data.count}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3">{page} / {data.total_pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= data.total_pages} onClick={() => setPage((p) => Math.min(p + 1, data.total_pages))}>Next</Button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <Modal open onClose={() => setConfirmDelete(null)} title="Delete expense?" size="sm">
          <p className="text-sm text-gray-700">
            Permanently delete expense{' '}
            <span className="font-mono font-semibold">{confirmDelete.reference_no || ''}</span> for{' '}
            <span className="font-semibold">{fmtMoney(confirmDelete.amount)}</span>? The journal
            entry will be reversed and the Payment Account balance will be restored.
          </p>
          <ModalFooter>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button onClick={() => onDelete(confirmDelete)}>Delete</Button>
          </ModalFooter>
        </Modal>
      )}

      {/* View Payments modal */}
      {paymentsExpense && (
        <ViewExpensePaymentsModal
          expense={paymentsExpense}
          company={companyProfile}
          onClose={() => setPaymentsExpense(null)}
        />
      )}

      {/* Edit Expense modal — opens with values pre-filled from the
          row's full detail payload. Save PATCHes the expense. */}
      {editExpense && (
        <EditExpenseModal
          expense={editExpense}
          locations={locations}
          onClose={() => setEditExpense(null)}
          onSaved={() => { setEditExpense(null); load() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// ViewExpensePaymentsModal — matches the screenshot:
//   Business / Reference No / Date / Payment Status header strip,
//   then a payments table with Date / Reference No / Amount / Method /
//   Note / Account / Actions. Print button emits a clean print page.
// ─────────────────────────────────────────────────────────────────────
function ViewExpensePaymentsModal({ expense: initialExpense, company, onClose }) {
  // Local copy of the expense so we can refresh after add/edit/
  // delete and re-render with the updated payments list.
  const [data, setData] = useState(initialExpense)
  const [err, setErr]   = useState('')
  const [viewPayment, setViewPayment] = useState(null)
  const [editPayment, setEditPayment] = useState(null)
  const [addOpen,     setAddOpen]     = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = async () => {
    try {
      const d = await getExpense(initialExpense.id)
      setData(d)
    } catch (e) { setErr(e?.message || 'Failed to load payments.') }
  }
  useEffect(() => {
    let cancelled = false
    getExpense(initialExpense.id)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load payments.') })
    return () => { cancelled = true }
  }, [initialExpense.id])

  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtDT = (s) => s ? new Date(s).toLocaleString() : '—'
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'

  // Payments come embedded on the detail payload (the new
  // ExpenseSerializer.payments method). Legacy expenses without
  // explicit payment rows fall back to a synthesised "initial
  // payment" row so the UI never looks empty when the expense IS
  // fully paid.
  const payments = useMemo(() => {
    const explicit = Array.isArray(data?.payments) ? data.payments : []
    if (explicit.length) return explicit
    if (Number(data?.paid_amount || data?.amount || 0) > 0) {
      return [{
        id:            '__implicit__',
        reference_no:  data.reference_no || '',
        amount:        data.paid_amount || data.amount,
        method:        data.payment_method || 'cash',
        notes:         '',
        payment_account_name: data.payment_account_name || '—',
        paid_at:       data.created_at || data.expense_date,
        _implicit:     true,
      }]
    }
    return []
  }, [data])

  const handleDelete = async (p) => {
    if (p._implicit) {
      window.alert('This payment was created automatically with the expense — delete the whole expense to remove it.')
      return
    }
    if (!window.confirm(`Delete payment of ৳ ${fmt(p.amount)}? The linked account will be auto-reversed.`)) return
    setBusyId(p.id)
    try {
      await deleteExpensePayment(p.id)
      await load()
    } catch (e) {
      window.alert(e?.message || 'Failed to delete payment.')
    } finally { setBusyId('') }
  }

  const doPrint = () => {
    const win = window.open('', '_blank', 'width=900,height=900')
    if (!win) return
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0)
    const due       = Math.max(Number(data?.amount || 0) - totalPaid, 0)
    const rowsHtml = payments.length
      ? payments.map((p, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(fmtDT(p.paid_at || p.created_at))}</td>
          <td>${esc(p.reference_no || '')}</td>
          <td class="num"><b>${money(p.amount)}</b></td>
          <td style="text-transform:capitalize">${esc((p.method || '').replace('_', ' '))}</td>
          <td>${esc(p.notes || '')}</td>
          <td>${esc(p.payment_account_name || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty">No payments recorded.</td></tr>'

    const logoBlock = company?.logo_url
      ? `<img src="${esc(company.logo_url)}" style="max-height:64px;max-width:220px">`
      : `<div class="brand">${esc(company?.business_name || company?.name || '')}</div>`

    const cancelled = (data?.payment_status || '').toLowerCase() === 'cancelled'

    win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Expense ${esc(data?.reference_no || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:14mm 10mm;font-size:12px;background:#fff}
  .row{display:flex;justify-content:space-between;gap:24px}
  .right{text-align:right}
  .brand{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:11px;line-height:1.55}
  .block b{color:#374151}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:7px 8px;border:1px solid #0f9971}
  td{padding:7px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .totals{margin-left:auto;width:320px;margin-top:16px;border-collapse:collapse}
  .totals td{border:none;padding:6px 8px}
  .totals .label{color:#374151}
  .totals .grand td{border-top:2px solid #111827;font-weight:700;font-size:13px;padding-top:10px;color:#111827}
  .badge{display:inline-block;background:#10b981;color:#fff;border-radius:3px;padding:2px 8px;font-size:10px;text-transform:capitalize;margin-right:4px}
  .badge.due{background:#ef4444}
  .badge.partial{background:#f59e0b}
  .stamp{position:fixed;top:38%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:96px;color:#ef4444;opacity:.08;font-weight:900;letter-spacing:8px;pointer-events:none}
  .empty{text-align:center;color:#9ca3af;padding:24px}
  h3{font-size:13px;color:#10b981;margin:18px 0 6px;letter-spacing:.4px}
  @page{size:A4;margin:8mm}
</style></head><body>
${cancelled ? '<div class="stamp">CANCELLED</div>' : ''}

<div class="row" style="border-bottom:2px solid #10b981;padding-bottom:12px;margin-bottom:14px">
  <div>
    ${logoBlock}
    <div class="block" style="margin-top:6px">
      <b>${esc(company?.business_name || company?.name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
      ${company?.email ? '<br>Email: ' + esc(company.email) : ''}
    </div>
  </div>
  <div class="right">
    <div class="title">EXPENSE VOUCHER</div>
    <div class="sub" style="margin-top:6px">Reference No</div>
    <div style="font-weight:600">#${esc(data?.reference_no || '')}</div>
    <div class="sub" style="margin-top:6px">Date: <b>${esc(fmtDate(data?.expense_date || data?.created_at))}</b></div>
    <div style="margin-top:6px">
      <span class="badge ${(data?.payment_status||'').toLowerCase() === 'paid' ? '' : (data?.payment_status||'').toLowerCase() === 'partial' ? 'partial' : 'due'}">${esc(data?.payment_status || '')}</span>
    </div>
  </div>
</div>

<div class="row" style="margin-bottom:8px">
  <div class="block" style="flex:1">
    <b style="color:#10b981">EXPENSE FOR</b><br>
    ${esc(data?.expense_for || data?.contact_name || '—')}
  </div>
  <div class="block" style="flex:1">
    <b style="color:#10b981">CATEGORY</b><br>
    ${esc(data?.expense_category || data?.category_display || data?.category || '—')}
  </div>
  <div class="block" style="flex:1">
    <b style="color:#10b981">BUSINESS LOCATION</b><br>
    ${esc(data?.location_name || '—')}
  </div>
</div>

<h3>PAYMENT HISTORY</h3>
<table>
  <thead><tr>
    <th style="width:32px">#</th>
    <th>Date</th>
    <th>Reference No</th>
    <th class="num">Amount</th>
    <th>Payment Method</th>
    <th>Note</th>
    <th>Payment Account</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

<table class="totals">
  <tbody>
    <tr><td class="label">Subtotal:</td><td class="num">${money(data?.amount)}</td></tr>
    <tr><td class="label">Tax:</td><td class="num">+ ${money(data?.tax_amount)}</td></tr>
    <tr class="grand"><td class="label">Total:</td><td class="num">${money(Number(data?.amount || 0) + Number(data?.tax_amount || 0))}</td></tr>
    <tr><td class="label">Paid:</td><td class="num">${money(totalPaid)}</td></tr>
    <tr><td class="label" style="color:#ef4444">Balance Due:</td><td class="num" style="color:#ef4444;font-weight:700">${money(due)}</td></tr>
  </tbody>
</table>

${data?.description ? `<h3>NOTES</h3><div class="block" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:10px;white-space:pre-line">${esc(data.description)}</div>` : ''}

<div style="margin-top:36px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#6b7280">
  <div>Generated: ${esc(new Date().toLocaleString())}</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    win.document.close()
  }

  return (
    <Modal open onClose={onClose} title={`View Payments ( Reference No: ${data?.reference_no || ''} )`} size="4xl">
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}
      <div className="space-y-4 text-sm">
        {/* Header strip — Business / Reference / Status. Includes
            an Add payment chip on the right so the operator can
            spawn a new payment without leaving the modal. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pb-3 border-b border-gray-200">
          <div>
            <div className="font-semibold text-gray-800 mb-0.5">Business:</div>
            <div className="text-gray-700 font-medium">{company?.business_name || company?.name || '—'}</div>
            {(company?.address) && <div className="text-gray-600 text-xs whitespace-pre-line">{company.address}</div>}
            {company?.phone && <div className="text-gray-600 text-xs">Mobile: {company.phone}</div>}
          </div>
          <div>
            <div className="font-semibold text-gray-800 mb-0.5">Reference No:</div>
            <div className="font-medium text-gray-800">#{data?.reference_no || '—'}</div>
            <div className="text-xs text-gray-600">Date: {fmtDate(data?.created_at || data?.expense_date)}</div>
            <div className="text-xs text-gray-600">Payment Status: <span className="capitalize">{data?.payment_status || '—'}</span></div>
          </div>
          <div className="lg:text-right">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1.5 text-xs font-semibold text-white"
            >
              ＋ Add payment
            </button>
          </div>
        </div>

        {/* Payments table — Date / Reference / Amount / Method /
            Note / Account / Actions (Edit pencil · Delete trash ·
            View eye) */}
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
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">৳ {fmt(p.amount).replace('৳ ', '')}</td>
                  <td className="px-3 py-2 text-gray-700 capitalize">{(p.method || '').replace('_', ' ')}</td>
                  <td className="px-3 py-2 text-gray-700">{p.notes || '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{p.payment_account_name || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => p._implicit
                          ? window.alert('Edit the whole expense to change this payment.')
                          : setEditPayment(p)}
                        title="Edit" className="p-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                      >✎</button>
                      <button
                        onClick={() => handleDelete(p)}
                        disabled={busyId === p.id}
                        title="Delete" className="p-1.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-600 disabled:opacity-50"
                      >🗑</button>
                      <button
                        onClick={() => setViewPayment(p)}
                        title="View" className="p-1.5 rounded bg-sky-50 hover:bg-sky-100 text-sky-700"
                      >👁</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ModalFooter>
        <Button onClick={doPrint}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>

      {addOpen && (
        <AddExpensePaymentModal
          expense={data}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); load() }}
        />
      )}
      {viewPayment && (
        <ViewSingleExpensePaymentModal payment={viewPayment} onClose={() => setViewPayment(null)} />
      )}
      {editPayment && (
        <AddExpensePaymentModal
          expense={data}
          payment={editPayment}
          onClose={() => setEditPayment(null)}
          onSaved={() => { setEditPayment(null); load() }}
        />
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// AddExpensePaymentModal — create OR edit a single payment row.
// Method-specific extras (Card / Cheque / Bank Transfer) appended
// into the notes column as labelled lines so they round-trip
// through the existing schema without a model change. Backend
// handles the PaymentAccount ledger reversal on every mutation.
// ─────────────────────────────────────────────────────────────────────
function AddExpensePaymentModal({ expense, payment, onClose, onSaved }) {
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
  const [cardHolder, setCardHolder] = useState('')
  const [cardType,   setCardType]   = useState('CREDIT_CARD')
  const [chequeBank, setChequeBank] = useState('')
  const [bankAccountNo, setBankAccountNo] = useState('')
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState('')

  useEffect(() => {
    getPaymentAccounts({ is_active: 'true' })
      .then((r) => setAccounts(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => {})
  }, [])

  // Auto-switch payment account when method changes so the money
  // lands in a sensible default ledger (Cash → CASH, Cheque/Bank
  // Transfer → BANK, Card → CARD, Mobile → MFS).
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
      if (editing) await updateExpensePayment(payment.id, body)
      else         await addExpensePayment(expense.id, body)
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
        {/* Header info row — mirrors the All Purchases AddPayment modal */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Reference No:</div>
            <div className="font-medium text-gray-800">{expense.reference_no || '—'}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Total amount:</div>
            <div className="font-medium text-gray-800">৳ {fmt(expense.amount)}</div>
          </div>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">Payment Status:</div>
            <div className="font-medium text-gray-800 capitalize">{expense.payment_status || '—'}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input label="Amount *" type="number" min="0" step="0.01"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input label="Paid on *" value={paidAt} onChange={(e) => setPaidAt(e.target.value)}
            placeholder="YYYY-MM-DD HH:MM" />
          <Select label="Payment Method *" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="cheque">Cheque</option>
            <option value="bank_transfer">Bank Transfer</option>
            <option value="mobile">Mobile Wallet</option>
            <option value="other">Other</option>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Select label="Payment Account" value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
            <option value="">None — won't post to a ledger</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.account_type ? ` (${a.account_type})` : ''}
              </option>
            ))}
          </Select>
          <Input label="Reference No" value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
            placeholder="Auto-generate if empty" />
        </div>

        {/* Method-specific extras */}
        {method === 'card' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label="Card Transaction No." value={reference}
              onChange={(e) => setReference(e.target.value)} />
            <Input label="Card Holder Name" value={cardHolder}
              onChange={(e) => setCardHolder(e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))} />
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
              onChange={(e) => setReference(e.target.value)} />
            <Input label="Bank Name" value={chequeBank}
              onChange={(e) => setChequeBank(e.target.value)} />
          </div>
        )}
        {method === 'bank_transfer' && (
          <Input label="Bank Account No" value={bankAccountNo}
            onChange={(e) => setBankAccountNo(e.target.value.replace(/[^\d -]/g, ''))} inputMode="numeric" />
        )}
        {(method === 'mobile' || method === 'other') && (
          <Input label="Reference / Transaction No." value={reference}
            onChange={(e) => setReference(e.target.value)} />
        )}

        <div>
          <label className="text-xs font-medium text-gray-700">Payment Note</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
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

// Read-only single-payment details for the 👁 button.
function ViewSingleExpensePaymentModal({ payment, onClose }) {
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

function ActionMenu({ row, onEdit, onDelete, onViewPayment }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      setPos({
        top:  r.bottom + window.scrollY + 4,
        left: r.right  + window.scrollX - 160,
      })
    }
    setOpen(true)
  }
  const closeMenu = () => setOpen(false)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!e.target.closest('[data-exp-menu]') && !e.target.closest('[data-exp-trigger]')) closeMenu()
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
        data-exp-trigger
        type="button"
        onClick={() => (open ? closeMenu() : openMenu())}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition"
      >
        Actions
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M5 7l5 6 5-6z" /></svg>
      </button>
      {/* Portal to <body> with viewport-coordinate positioning so the
          overflow-x-auto table wrapper can't clip the menu. */}
      {open && createPortal(
        <div
          data-exp-menu
          style={{ position: 'absolute', top: pos.top, left: pos.left, width: 160 }}
          className="z-[1000] rounded-lg bg-white shadow-pop ring-1 ring-black/5 overflow-hidden"
        >
          <button
            onClick={() => { closeMenu(); onEdit?.() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            ✎ Edit
          </button>
          <button
            onClick={() => { closeMenu(); onDelete?.() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
          >
            🗑 Delete
          </button>
          <button
            onClick={() => { closeMenu(); onViewPayment?.() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            📜 View Payment
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// EditExpenseModal — opens from the action menu's Edit button.
// Pre-fills every field from the existing Expense row and PATCHes
// /api/accounting/expenses/<id>/ on Update. All option lists
// (Business Location, Expense Category, Sub-category, Contact,
// Tax rate) come live from the per-tenant DB.
// ─────────────────────────────────────────────────────────────────────
function EditExpenseModal({ expense, locations, onClose, onSaved }) {
  const [locationId,    setLocationId]    = useState(expense.location_id || '')
  const [categoryId,    setCategoryId]    = useState(expense.expense_category || expense.category_id || '')
  const [subCategoryId, setSubCategoryId] = useState(expense.expense_sub_category || expense.sub_category_id || '')
  const [referenceNo,   setReferenceNo]   = useState(expense.reference_no || '')
  const [expenseDate,   setExpenseDate]   = useState((expense.expense_date || '').slice(0, 16) || new Date().toISOString().slice(0, 16))
  const [expenseForType, setExpenseForType] = useState(
    // Stored as the literal "customer"/"supplier" string on the expense
    // row; default to "none" when nothing was set.
    (expense.expense_for || '').toLowerCase().includes('supplier') ? 'supplier'
      : (expense.expense_for || '').toLowerCase().includes('customer') ? 'customer'
      : 'none'
  )
  const [contactId,     setContactId]     = useState(expense.contact_id || '')
  const [taxRate,       setTaxRate]       = useState(
    expense.tax_amount && Number(expense.amount) > 0
      ? String(Math.round((Number(expense.tax_amount) / Number(expense.amount)) * 10000) / 100)
      : '0'
  )
  const [totalAmount,   setTotalAmount]   = useState(String(Number(expense.amount || 0).toFixed(2)))
  const [note,          setNote]          = useState(expense.description || '')
  const [isRecurring,   setIsRecurring]   = useState(Boolean(expense.recurring))
  const [recurInterval, setRecurInterval] = useState('')
  const [recurUnit,     setRecurUnit]     = useState('Days')
  const [recurCount,    setRecurCount]    = useState('')

  // Lazy-load the dependent option lists from the per-tenant DB.
  const [categories, setCategories] = useState([])
  const [contacts,   setContacts]   = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState('')

  useEffect(() => {
    getExpenseCategories({ active: 'true' })
      .then((r) => setCategories(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => {})
    // Parse "interval unit / count" string from the legacy
    // recurring_details CharField so the modal shows whatever the
    // Add Expense form saved.
    const raw = String(expense.recurring_details || '').trim()
    if (raw) {
      const m = raw.match(/^(\d+)\s*(\w+)\s*\/\s*(\d*)/)
      if (m) {
        setRecurInterval(m[1] || ''); setRecurUnit(m[2] || 'Days'); setRecurCount(m[3] || '')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh contacts whenever the Expense-for type changes. Stops
  // showing stale customers when the operator switches to supplier.
  useEffect(() => {
    if (expenseForType === 'none') { setContacts([]); return }
    const fn = expenseForType === 'customer' ? getCustomers : getSuppliers
    fn({ active_only: 'true' })
      .then((r) => setContacts(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => setContacts([]))
  }, [expenseForType])

  const subCategoryOptions = useMemo(
    () => categories.filter((c) => c.parent_id === categoryId || c.parent === categoryId),
    [categories, categoryId],
  )
  const parentCategories = useMemo(
    () => categories.filter((c) => !c.parent_id && !c.parent),
    [categories],
  )

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const contactName = contacts.find((c) => c.id === contactId)?.name || ''
      const body = {
        location_id:        locationId || null,
        category_id:        categoryId || null,
        sub_category_id:    subCategoryId || null,
        reference_no:       referenceNo,
        expense_date:       expenseDate.slice(0, 10),
        expense_for:        expenseForType === 'none' ? '' : (contactName || expenseForType),
        contact_id:         expenseForType === 'none' ? null : (contactId || null),
        contact_name:       contactName,
        tax_rate:           Number(taxRate || 0),
        total_amount:       Number(totalAmount || 0),
        note:               note,
        is_recurring:       isRecurring,
        recurring_interval: recurInterval,
        recurring_unit:     recurUnit,
        recurring_count:    recurCount,
      }
      await updateExpense(expense.id, body)
      window.alert('Expense updated.')
      onSaved?.()
    } catch (e) {
      setErr(e?.message || 'Failed to update expense.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit Expense" size="4xl">
      <div className="space-y-4 text-sm">
        {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{err}</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Business Location:<span className="text-rose-500">*</span></label>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none">
              <option value="">Please Select</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.code ? ` (${l.code})` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Expense Category:</label>
            <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSubCategoryId('') }}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none">
              <option value="">Please Select</option>
              {parentCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Sub category:</label>
            <select value={subCategoryId} onChange={(e) => setSubCategoryId(e.target.value)}
              disabled={!subCategoryOptions.length}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none disabled:bg-gray-50">
              <option value="">Please Select</option>
              {subCategoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input label="Reference No"
            value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
            placeholder="Leave empty to autogenerate" />
          <Input label="Date:*"
            type="datetime-local"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)} />
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Expense for:</label>
            <select value={expenseForType} onChange={(e) => setExpenseForType(e.target.value)}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none">
              <option value="none">None</option>
              <option value="customer">Customer</option>
              <option value="supplier">Supplier</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Expense for contact:</label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)}
              disabled={expenseForType === 'none'}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none disabled:bg-gray-50">
              <option value="">Please Select</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Applicable Tax:</label>
            <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
              className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none">
              <option value="0">None — 0%</option>
              <option value="5">Tax — 5%</option>
              <option value="7.5">Tax — 7.5%</option>
              <option value="10">Tax — 10%</option>
              <option value="15">Tax — 15%</option>
            </select>
          </div>
          <Input label="Total amount:*"
            type="number" step="0.01" min="0"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)} />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Expense note:</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none" />
        </div>

        {/* Recurring strip */}
        <div className="rounded-md bg-gray-50 border border-gray-200 px-4 py-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
              Is Recurring?
            </label>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Recurring interval:</label>
              <div className="flex gap-2">
                <input type="number" min="0" value={recurInterval} onChange={(e) => setRecurInterval(e.target.value)}
                  disabled={!isRecurring}
                  className="flex-1 h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none disabled:bg-gray-100" />
                <select value={recurUnit} onChange={(e) => setRecurUnit(e.target.value)}
                  disabled={!isRecurring}
                  className="h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none disabled:bg-gray-100">
                  <option value="Days">Days</option>
                  <option value="Weeks">Weeks</option>
                  <option value="Months">Months</option>
                  <option value="Years">Years</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">No. of Repetitions:</label>
              <input type="number" min="0" value={recurCount} onChange={(e) => setRecurCount(e.target.value)}
                disabled={!isRecurring}
                className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none disabled:bg-gray-100" />
              <div className="text-[10px] text-gray-500 mt-0.5">If blank, expense will be generated infinite times</div>
            </div>
          </div>
        </div>
      </div>
      <ModalFooter>
        <Button onClick={submit} loading={busy}>Update</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}
