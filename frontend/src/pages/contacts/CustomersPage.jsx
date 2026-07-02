/**
 * Customers list — Contacts → Customers
 *
 * Reads /api/sales/customers/ which now annotates total_sale_due and
 * total_sell_return_due per row. The "Customer Group / Opening Balance /
 * Custom Field N" columns from the inspiration screenshot are mentioned
 * in placeholder text — IFFAA doesn't track those yet and adding them
 * would require a Customer schema change; this page is structured so
 * those columns can plug in later without UI changes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import Modal, { ModalFooter } from '../../components/ui/Modal'
import FilterToggle from '../../components/ui/FilterToggle'
import BdPhoneInput, {
  validateBdPhone, validateLettersOnly, validateBusinessName,
  stripAtKeystroke, NON_LETTERS_RE, NON_BUSINESS_RE,
} from '../../components/form/BdPhoneInput'
import { useDefaultPageSize } from '../../context/SettingsContext'
import { fmtPhone } from '../../utils/phone'
import { getCompanyProfile } from '../../api/companyProfile'
import {
  getCustomers, createCustomer, updateCustomer, deleteCustomer,
  getCustomerCreditSummary, payCustomer, getCustomerGroups,
} from '../../api/sales'
import { getPaymentAccounts } from '../../api/accounting'
import { showToast } from '../../lib/toast.jsx'

// UI payment method → backend SalePayment.Method code.
const PAY_METHODS = [
  { label: 'Cash', code: 'CASH' },
  { label: 'Card', code: 'CARD' },
  { label: 'Bank Transfer', code: 'BANK_TRANSFER' },
  { label: 'bKash', code: 'MOBILE' },
  { label: 'Nagad', code: 'MOBILE' },
  { label: 'Cheque', code: 'OTHER' },
  { label: 'Other', code: 'OTHER' },
]

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200]

export default function CustomersPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [status,         setStatus]         = useState('active')
  const [noSaleSince,    setNoSaleSince]    = useState('')
  const [search,         setSearch]         = useState('')
  const [customerGroup,  setCustomerGroup]  = useState('')   // group id ('' = all)
  const [payStatus,      setPayStatus]      = useState('')   // '' | due | partial | paid
  const [groups,         setGroups]         = useState([])

  // Load customer groups once for the filter + the Add/Edit modal.
  useEffect(() => {
    getCustomerGroups()
      .then((res) => setGroups(Array.isArray(res) ? res : (res?.results ?? [])))
      .catch(() => setGroups([]))
  }, [])

  // ── Paging (client-side over the API response — list is moderate size) ────
  // Initial page size honors Settings → System → Default datatable page
  // entries. The user can still pick a different size from the dropdown
  // below; this just sets the starting value.
  const defaultPageSize = useDefaultPageSize(25)
  const [page,  setPage]  = useState(1)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)

  // ── Modal state ────────────────────────────────────────────────────────────
  const [editing,    setEditing]    = useState(null)   // null | "new" | customer object
  const [deleting,   setDeleting]   = useState(null)   // customer object
  const [notesFor,   setNotesFor]   = useState(null)   // customer object (Documents & Note modal)
  const [paying,     setPaying]     = useState(null)   // customer object (Pay modal)

  // Toggle is_active on the server. Used by both Deactivate and Activate
  // in the row menu — same endpoint, opposite payload.
  const handleToggleActive = async (cust) => {
    const next = !cust.is_active
    const verb = next ? 'activate' : 'deactivate'
    if (!window.confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${cust.name}?`)) return
    try {
      await updateCustomer(cust.id, { is_active: next })
      fetchData()
    } catch (e) {
      alert(e?.message || `Failed to ${verb} customer.`)
    }
  }

  const fetchData = async () => {
    setLoading(true); setError('')
    try {
      const params = {}
      if (status === 'active')   params.status = 'active'
      if (status === 'inactive') params.status = 'inactive'
      if (search.trim())         params.search = search.trim()
      if (noSaleSince)           params.no_sale_since = noSaleSince
      if (customerGroup)         params.customer_group = customerGroup
      if (payStatus)             params.payment_status = payStatus
      const res = await getCustomers(params)
      // The endpoint may return either an array or {results: [...]}.
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
      setPage(1)
    } catch (err) {
      setError(err.message || 'Failed to load customers')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, customerGroup, payStatus])

  // Live search — re-fetch as the user types, debounced so we don't fire a
  // request on every keystroke. Skips the initial mount (the [status] effect
  // already loaded the list).
  const didMountSearch = useRef(false)
  useEffect(() => {
    if (!didMountSearch.current) { didMountSearch.current = true; return }
    const t = setTimeout(() => { fetchData() }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const onApply = () => fetchData()
  const onReset = () => {
    setStatus('active'); setNoSaleSince(''); setSearch('')
    setCustomerGroup(''); setPayStatus('')
    setTimeout(fetchData, 0)
  }

  // KPI numbers across the visible (filtered) set.
  const totals = useMemo(() => {
    let dueSales = 0, dueReturns = 0
    for (const r of rows) {
      dueSales   += Number(r.total_sale_due       || 0)
      dueReturns += Number(r.total_sell_return_due || 0)
    }
    return { dueSales, dueReturns }
  }, [rows])

  const count       = rows.length
  const totalPages  = Math.max(Math.ceil(count / limit), 1)
  const pageRows    = rows.slice((page - 1) * limit, page * limit)
  const csvHref     = useMemo(() => buildCsv(rows), [rows])

  // ── Print handler ───────────────────────────────────────────────────────
  // Emits a clean A4 landscape report instead of the page DOM, so the
  // browser's print dialog doesn't pick up the Actions menu HTML
  // ("ActionsToggle Dropdown PayViewEdit…") that the user reported as
  // garbage in the printed output. Pulls company profile live for the
  // header so a multi-tenant build never bakes a name into the print.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const money = (n) => `৳ ${fmt(n)}`
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const totals = rows.reduce((acc, r) => ({
      credit_limit:     acc.credit_limit     + Number(r.credit_limit     || 0),
      opening_balance:  acc.opening_balance  + Number(r.opening_balance  || 0),
      advance_balance:  acc.advance_balance  + Number(r.advance_balance  || 0),
      total_sale_due:   acc.total_sale_due   + Number(r.total_sale_due   || 0),
      total_return_due: acc.total_return_due + Number(r.total_sell_return_due || 0),
    }), { credit_limit: 0, opening_balance: 0, advance_balance: 0, total_sale_due: 0, total_return_due: 0 })
    const rowsHtml = rows.map((c, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(c.contact_id || '')}</td>
      <td>${esc(c.business_name || '')}</td>
      <td><b>${esc(c.name || '')}</b>${c.phone ? `<br><span class="sub">${esc(fmtPhone(c.phone))}</span>` : ''}</td>
      <td>${esc(c.email || '')}</td>
      <td>${esc(c.tax_number || '')}</td>
      <td class="num">${c.credit_limit ? money(c.credit_limit) : 'No Limit'}</td>
      <td>${esc(c.pay_term ? `${c.pay_term} ${c.pay_term_type || 'days'}` : '—')}</td>
      <td class="num">${money(c.opening_balance)}</td>
      <td class="num">${money(c.advance_balance)}</td>
      <td>${esc(fmtDate(c.created_at))}</td>
      <td>${esc(c.customer_group_name || '—')}</td>
    </tr>`).join('') || '<tr><td colspan="12" class="empty">No customers.</td></tr>'

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Customers — ${esc(company?.business_name || '')}</title>
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
    <h1 class="title">Customers</h1>
    <div class="block" style="margin-top:4px">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">${rows.length} record${rows.length === 1 ? '' : 's'}</div>
  </div>
</div>

<table>
  <thead><tr>
    <th>#</th>
    <th>Contact ID</th>
    <th>Business Name</th>
    <th>Name</th>
    <th>Email</th>
    <th>Tax No</th>
    <th class="num">Credit Limit</th>
    <th>Pay Term</th>
    <th class="num">Opening Balance</th>
    <th class="num">Advance Balance</th>
    <th>Added On</th>
    <th>Customer Group</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="6" style="text-align:right">Totals:</td>
    <td class="num">${money(totals.credit_limit)}</td>
    <td></td>
    <td class="num">${money(totals.opening_balance)}</td>
    <td class="num">${money(totals.advance_balance)}</td>
    <td colspan="2"></td>
  </tr></tfoot>
</table>

<div class="footer">
  <div>Sales Due: <b>${money(totals.total_sale_due)}</b> · Returns Due: <b>${money(totals.total_return_due)}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Customers</h1>
          <p className="text-xs text-emerald-50 mt-0.5">
            Manage your customer master records — name, contact info, tax number
            and outstanding dues.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm hover:bg-emerald-50"
        >
          <PlusIcon /> Add Customer
        </button>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Total customers"        value={fmtInt(count)}                  accent="emerald" />
        <Kpi label="Outstanding sale dues"  value={fmtBDT(totals.dueSales)}        accent="green"   />
        <Kpi label="Pending return refunds" value={fmtBDT(totals.dueReturns)}      accent="teal"    />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} />

        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
          <FieldSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active',   label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'all',      label: 'All' },
            ]}
          />
          <FieldDate
            label="Has no sale since"
            value={noSaleSince}
            onChange={setNoSaleSince}
            hint="Show only customers without a sale on or after this date."
          />
          <FieldSelect
            label="Customer group"
            value={customerGroup}
            onChange={setCustomerGroup}
            options={[
              { value: '', label: 'All groups' },
              ...groups.map((g) => ({ value: String(g.id), label: g.name })),
            ]}
            hint="Assign customers to a group from the Add/Edit form."
          />
          <FieldSelect
            label="Payment status"
            value={payStatus}
            onChange={setPayStatus}
            options={[
              { value: '',        label: 'All' },
              { value: 'due',     label: 'Due' },
              { value: 'partial', label: 'Partial' },
              { value: 'paid',    label: 'Paid' },
            ]}
            hint="Filter by outstanding sale dues."
          />
          <div className="self-end flex justify-end gap-2">
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

      {/* ── Table card ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onApply()}
            placeholder="Search name, phone, email or tax number…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`customers-${new Date().toISOString().slice(0, 10)}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <DownloadIcon /> CSV
            </a>
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
            <EmptyState onAdd={() => setEditing('new')} />
          ) : (
            <CustomersTable
              rows={pageRows}
              onView={(c) => setEditing(c)}            /* same modal — fields are visible */
              onEdit={(c) => setEditing(c)}
              onDelete={(c) => setDeleting(c)}
              onDeactivate={handleToggleActive}
              onNotes={(c) => setNotesFor(c)}
              onPay={(c) => setPaying(c)}
            />
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

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {editing && (
        <CustomerModal
          open={Boolean(editing)}
          customer={editing === 'new' ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchData() }}
        />
      )}
      {deleting && (
        <DeleteModal
          open={Boolean(deleting)}
          customer={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); fetchData() }}
        />
      )}
      {notesFor && (
        <NotesModal
          customer={notesFor}
          onClose={() => setNotesFor(null)}
          onSaved={() => { setNotesFor(null); fetchData() }}
        />
      )}
      {paying && (
        <CustomerPaymentModal
          customer={paying}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); fetchData() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

function fmtPayTerm(r) {
  if (!r.pay_term_value) return '—'
  const label = r.pay_term_period || 'days'
  return `${r.pay_term_value} ${label}`
}

function CustomersTable({ rows, onView, onEdit, onDelete, onDeactivate, onNotes, onPay }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3 w-24">Action</th>
          <th className="px-5 py-3">Code</th>
          <th className="px-5 py-3">Business / Name</th>
          <th className="px-5 py-3">Email</th>
          <th className="px-5 py-3">Mobile</th>
          <th className="px-5 py-3">Tax no.</th>
          <th className="px-5 py-3">Pay term</th>
          <th className="px-5 py-3 text-right whitespace-nowrap">Opening</th>
          <th className="px-5 py-3 text-right whitespace-nowrap">Advance</th>
          <th className="px-5 py-3 whitespace-nowrap">Added on</th>
          <th className="px-5 py-3 text-center">Status</th>
          <th className="px-5 py-3 text-right whitespace-nowrap">Sale due</th>
          <th className="px-5 py-3 text-right whitespace-nowrap">Return due</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3">
              <RowMenu
                customer={r}
                onView={onView}
                onEdit={onEdit}
                onDelete={onDelete}
                onDeactivate={onDeactivate}
                onNotes={onNotes}
                onPay={onPay}
              />
            </td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.display_code || '—'}</td>
            <td className="px-5 py-3">
              <div className="font-medium text-gray-900">{r.business_name || r.name}</div>
              {/* Show the contact-person name underneath only when it
                  actually differs from the business name — otherwise the
                  composed name (which equals business_name) duplicates it. */}
              {r.business_name && r.name && r.name !== r.business_name && (
                <div className="text-[11px] text-gray-400">{r.name}</div>
              )}
            </td>
            <td className="px-5 py-3 text-gray-700">{r.email || '—'}</td>
            <td className="px-5 py-3 text-gray-700">{fmtPhone(r.phone) || '—'}</td>
            <td className="px-5 py-3 font-mono text-xs text-gray-500">{r.tax_number || '—'}</td>
            <td className="px-5 py-3 text-xs text-gray-700">{fmtPayTerm(r)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700 whitespace-nowrap">{fmtBDT(r.opening_balance)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700 whitespace-nowrap">{fmtBDT(r.advance_balance)}</td>
            <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
            <td className="px-5 py-3 text-center">
              <span className={[
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600',
              ].join(' ')}>
                {r.is_active ? 'Active' : 'Inactive'}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
              <span className={Number(r.total_sale_due) > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-500'}>
                {fmtBDT(r.total_sale_due)}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
              <span className={Number(r.total_sell_return_due) > 0 ? 'text-teal-700 font-semibold' : 'text-gray-500'}>
                {fmtBDT(r.total_sell_return_due)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RowMenu({ customer, onView, onEdit, onDelete, onDeactivate, onNotes, onPay }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const navigate = useNavigate()
  const isActive = customer.is_active !== false

  // The customer table sits inside both an outer Card with overflow-hidden
  // AND a scrollable overflow-x-auto wrapper. A normal absolute-positioned
  // dropdown gets clipped by both. We render the menu in a React portal
  // at document.body with position:fixed and compute its anchor from the
  // button's getBoundingClientRect — this lets it appear over the table
  // regardless of how deeply nested the row is.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      // 6px gap below the button, aligned to its left edge. If the menu
      // would spill off the right edge of the viewport, flip to align
      // against the right edge instead.
      const MENU_WIDTH = 192   // w-48
      const pad = 8
      let left = r.left
      if (left + MENU_WIDTH + pad > window.innerWidth) {
        left = Math.max(pad, window.innerWidth - MENU_WIDTH - pad)
      }
      setPos({ top: r.bottom + 6, left })
    }
    place()
    // Reposition on scroll / resize so the menu doesn't drift away from
    // the button when the page moves under it.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown',   onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown',   onKey)
    }
  }, [open])

  // One source of truth for menu items.
  const items = [
    { key: 'pay',    label: 'Pay',        icon: '💵', onClick: () => onPay(customer) },
    { key: 'view',   label: 'View',       icon: '👁', onClick: () => onView(customer) },
    { key: 'edit',   label: 'Edit',       icon: '✎',  onClick: () => onEdit(customer) },
    { key: 'delete', label: 'Delete',     icon: '🗑', onClick: () => onDelete(customer), danger: true },
    { key: 'tog',    label: isActive ? 'Deactivate' : 'Activate',
      icon: isActive ? '⏻' : '✓',
      onClick: () => onDeactivate(customer),
    },
    { key: 'ledger', label: 'Ledger',     icon: '📒', onClick: () => navigate(`/contacts/customers/${customer.id}/ledger`) },
    { key: 'sales',  label: 'Sales',      icon: '🧾', onClick: () => navigate(`/sells?customer_id=${customer.id}`) },
    { key: 'docs',   label: 'Documents & Note', icon: '📎', onClick: () => onNotes(customer) },
  ]

  return (
    <div className="inline-block">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
      >
        Actions <ChevronDownIcon />
      </button>

      {open && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-48 rounded-lg border border-gray-100 bg-white shadow-lg py-1"
        >
          {items.map((it) => (
            <React.Fragment key={it.key}>
              {it.key === 'ledger' && <div className="my-1 border-t border-gray-100" />}
              <button
                onMouseDown={(e) => {
                  // mousedown not click — the document-level mousedown
                  // listener fires first on click and would close the
                  // menu before the click handler runs.
                  e.preventDefault()
                  setOpen(false)
                  it.onClick()
                }}
                className={`block w-full text-left px-3 py-1.5 text-xs ${
                  it.danger
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-gray-700 hover:bg-emerald-50 hover:text-emerald-700'
                }`}
              >
                <span className="mr-2 inline-block w-3 text-center">{it.icon}</span>
                {it.label}
              </button>
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <PeopleIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No customers match these filters.</p>
      <p className="mt-1 text-xs text-gray-500">Add your first customer to start tracking sales and dues.</p>
      <button
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        <PlusIcon /> Add Customer
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals — create / edit / delete
// ─────────────────────────────────────────────────────────────────────────────

// Exported so the Sale-on-POS "+ Add Customer" button can reuse the
// exact same rich Add/Edit Contact modal (individual/business, credit
// limit, address, etc.) instead of a stripped-down duplicate.
export function CustomerModal({ open, customer, groups = [], onClose, onSaved }) {
  const isEdit = Boolean(customer)
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm()
  const [error, setError] = useState('')
  // Showing all the optional fields hidden by default keeps the modal short
  // on the common case (just name + phone + credit limit).
  const [moreOpen, setMoreOpen] = useState(false)

  // Payment accounts — used so a change to Advance balance moves the same
  // amount in/out of a real account (keeps List Accounts in sync).
  const [accounts, setAccounts] = useState([])
  const [advanceAccountId, setAdvanceAccountId] = useState('')
  useEffect(() => {
    if (!open) return
    getPaymentAccounts({ is_active: true })
      .then((d) => setAccounts(Array.isArray(d) ? d : d?.results || []))
      .catch(() => setAccounts([]))
    setAdvanceAccountId('')
  }, [open])

  // Reactive toggle — `_is_individual` is stored as a STRING ('true'|'false')
  // in the form so the radio buttons stay in sync with form state. We
  // convert to a real boolean inside onSubmit before sending to the server.
  // (Storing as a boolean made the DOM-vs-state value mismatch unselect
  // both radios after a reset — common react-hook-form gotcha with radios.)
  const isIndividualStr = watch('_is_individual')
  const isIndividual = isIndividualStr !== 'false'   // default true

  useEffect(() => {
    if (open) {
      reset(isEdit ? {
        contact_type:    customer.contact_type    || 'customer',
        _is_individual:  (customer.is_individual ?? true) ? 'true' : 'false',
        contact_id:      customer.contact_id || '',
        // Individual
        prefix:          customer.prefix || '',
        first_name:      customer.first_name  || '',
        middle_name:     customer.middle_name || '',
        last_name:       customer.last_name   || '',
        date_of_birth:   customer.date_of_birth || '',
        // Business
        business_name:   customer.business_name || '',
        // Contact
        email:           customer.email || '',
        phone:           customer.phone || '',
        alternate_phone: customer.alternate_phone || '',
        landline:        customer.landline || '',
        // Address
        address:         customer.address || '',
        address_line_2:  customer.address_line_2 || '',
        city:            customer.city || '',
        state:           customer.state || '',
        country:         customer.country || '',
        zip_code:        customer.zip_code || '',
        shipping_address: customer.shipping_address || '',
        // Billing
        tax_number:      customer.tax_number || '',
        notes:           customer.notes || '',
        is_active:       customer.is_active ?? true,
        pay_term_value:  customer.pay_term_value ?? '',
        pay_term_period: customer.pay_term_period || '',
        opening_balance: customer.opening_balance ?? '0',
        advance_balance: customer.advance_balance ?? '0',
        credit_limit:    customer.credit_limit    ?? '0',
        custom_field_1:  customer.custom_field_1 || '',
        custom_field_2:  customer.custom_field_2 || '',
        custom_field_3:  customer.custom_field_3 || '',
        custom_field_4:  customer.custom_field_4 || '',
        customer_group:  customer.customer_group || '',
      } : {
        contact_type: 'customer', _is_individual: 'true', contact_id: '',
        prefix: '', first_name: '', middle_name: '', last_name: '', date_of_birth: '',
        business_name: '',
        email: '', phone: '', alternate_phone: '', landline: '',
        address: '', address_line_2: '', city: '', state: '', country: '', zip_code: '',
        shipping_address: '',
        tax_number: '', notes: '', is_active: true,
        pay_term_value: '', pay_term_period: '',
        opening_balance: '0', advance_balance: '0', credit_limit: '5000',
        custom_field_1: '', custom_field_2: '', custom_field_3: '', custom_field_4: '',
        customer_group: '',
      })
      setError('')
      setMoreOpen(false)
    }
  }, [open, customer, isEdit, reset])

  const onSubmit = async (data) => {
    setError('')
    // _is_individual is a string in the form state ('true' | 'false') so the
    // radio DOM and form state stay in sync. Convert to boolean for the API,
    // and drop the underscore-prefixed field name from the payload.
    const { _is_individual, ...rest } = data
    const payload = {
      ...rest,
      is_individual:   _is_individual !== 'false',
      pay_term_value:  data.pay_term_value === '' || data.pay_term_value == null
        ? null : Number(data.pay_term_value),
      opening_balance: Number(data.opening_balance || 0),
      advance_balance: Number(data.advance_balance || 0),
      credit_limit:    Number(data.credit_limit    || 0),
      // Customer group FK — blank select → null (unassigned).
      customer_group:  data.customer_group || null,
      // Account to move cash to/from when the advance balance changes.
      advance_account_id: advanceAccountId || undefined,
      // DOB blank → null (backend rejects '' for DateField)
      date_of_birth:   data.date_of_birth || null,
    }
    try {
      // Return the saved record so callers (e.g. POS) can auto-select
      // the newly-created customer immediately.
      const saved = isEdit
        ? await updateCustomer(customer.id, payload)
        : await createCustomer(payload)
      onSaved?.(saved)
    } catch (err) {
      // Surface field-level errors from DRF — the generic "Validation failed."
      // hides the actual reason (e.g. "first_name: Required"). Walk the errors
      // dict and build a one-line summary.
      const fe = err?.errors
      let detail = ''
      if (fe && typeof fe === 'object') {
        if (fe.detail) {
          detail = Array.isArray(fe.detail) ? fe.detail[0] : String(fe.detail)
        } else if (fe.non_field_errors) {
          detail = Array.isArray(fe.non_field_errors) ? fe.non_field_errors[0] : String(fe.non_field_errors)
        } else {
          detail = Object.entries(fe)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('  ·  ')
        }
      }
      setError(
        detail
        || (err?.message && err.message !== 'Validation failed.' ? err.message : '')
        || 'Failed to save customer.'
      )
    }
  }

  // Shared classNames so the form stays tidy
  const ipt = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
  const sel = "rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Contact' : 'Add a new contact'} size="3xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {/* ── Row 1: Type, Individual/Business radio, Contact ID ────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <Field label="Contact type" required>
            <select {...register('contact_type', { required: true })} className={`${ipt}`}>
              <option value="">Please select</option>
              <option value="supplier">Suppliers</option>
              <option value="customer">Customers</option>
              <option value="both">Both (Supplier &amp; Customer)</option>
            </select>
          </Field>
          <Field label="">
            <div className="flex items-center gap-4 h-[42px]">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="radio" value="true"  {...register('_is_individual')} />
                Individual
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="radio" value="false" {...register('_is_individual')} />
                Business
              </label>
            </div>
          </Field>
          <Field label="Contact ID" hint="Leave empty to autogenerate.">
            <input {...register('contact_id')} placeholder="Contact ID" className={ipt} />
          </Field>
        </div>

        {/* ── Row 2: Individual fields vs Business fields ────────────────── */}
        {isIndividual ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Prefix">
              <select {...register('prefix')} className={ipt}>
                <option value="">Mr / Mrs / Miss</option>
                <option value="Mr">Mr</option>
                <option value="Mrs">Mrs</option>
                <option value="Miss">Miss</option>
                <option value="Ms">Ms</option>
                <option value="Dr">Dr</option>
              </select>
            </Field>
            <Field label="First name" required error={errors.first_name?.message}>
              <input
                {...stripAtKeystroke(
                  register('first_name', {
                    required: 'Required',
                    validate: validateLettersOnly('First name'),
                  }),
                  NON_LETTERS_RE,
                )}
                placeholder="First Name"
                className={ipt}
              />
            </Field>
            <Field label="Last name" error={errors.last_name?.message}>
              <input
                {...stripAtKeystroke(
                  register('last_name', {
                    // Optional — only letters validation when something is typed.
                    validate: (v) => !v || validateLettersOnly('Last name')(v),
                  }),
                  NON_LETTERS_RE,
                )}
                placeholder="Last name (optional)"
                className={ipt}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            <Field label="Business name" required error={errors.business_name?.message}>
              <input
                {...stripAtKeystroke(
                  register('business_name', {
                    required: 'Required',
                    validate: validateBusinessName,
                  }),
                  NON_BUSINESS_RE,
                )}
                placeholder="Business Name"
                className={ipt}
              />
            </Field>
          </div>
        )}

        {/* ── Row 3: Contact details (both branches) ─────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Field label="Mobile" required hint="11 digits, +88 fixed." error={errors.phone?.message}>
            <BdPhoneInput
              {...register('phone', {
                required: 'Mobile is required',
                validate: validateBdPhone,
              })}
              placeholder="01XXXXXXXXX"
            />
          </Field>
          <Field label="Alternate contact" error={errors.alternate_phone?.message}>
            <BdPhoneInput
              {...register('alternate_phone', {
                validate: (v) => !v || validateBdPhone(v),
              })}
              placeholder="Alternate contact number"
            />
          </Field>
          <Field label="Landline">
            <input {...register('landline')} placeholder="Landline" className={ipt} />
          </Field>
          <Field label="Email" error={errors.email?.message}>
            <input
              type="email"
              {...register('email', {
                validate: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Enter a valid email address.',
              })}
              placeholder="name@example.com"
              className={ipt}
            />
          </Field>
        </div>

        {/* DOB only for individuals */}
        {isIndividual && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <Field label="Date of birth">
              <input type="date" {...register('date_of_birth')} className={ipt} />
            </Field>
          </div>
        )}

        {/* ── Address (optional, both branches) ──────────────────────────── */}
        <Field label="Address" hint="Optional.">
          <input {...register('address')} placeholder="Address" className={ipt} />
        </Field>

        {/* ── More Information toggle ────────────────────────────────────── */}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        >
          More Information {moreOpen ? '▲' : '▼'}
        </button>

        {moreOpen && (
          <div className="space-y-4 border-t border-gray-100 pt-4">

            {/* ── Tax / Balances / Pay term / Credit ─────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Tax number">
                <input {...register('tax_number')} placeholder="Tax number" className={ipt} />
              </Field>
              <Field label="Opening balance">
                <input type="number" step="0.01" {...register('opening_balance')} placeholder="0" className={ipt} />
              </Field>
              <Field label="Pay term" hint="Net 30 = 30 Days, Net 1 = 1 Months">
                <div className="flex gap-2">
                  <input type="number" min="0" {...register('pay_term_value')} placeholder="Pay term" className={ipt} />
                  <select {...register('pay_term_period')} className={sel}>
                    <option value="">Please Select</option>
                    <option value="days">Days</option>
                    <option value="months">Months</option>
                  </select>
                </div>
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Customer group" hint="Used by the Customers list group filter.">
                <select {...register('customer_group')} className={sel}>
                  <option value="">No group</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field
                label="Credit limit"
                hint="Maximum outstanding allowed on credit. Defaults to 5000 so the customer can buy on credit; set 0 for cash-only — POS Credit Sale button then stays disabled."
              >
                <input type="number" step="0.01" min="0" {...register('credit_limit')} placeholder="5000" className={ipt} />
              </Field>
              <Field label="Advance balance" hint="Paid ahead — applied to future invoices.">
                <input type="number" step="0.01" min="0" {...register('advance_balance')} placeholder="0" className={ipt} />
              </Field>
              <Field label="Advance account" hint="Where the cash moves when advance changes (add → deposit, remove → withdraw).">
                <select value={advanceAccountId} onChange={(e) => setAdvanceAccountId(e.target.value)} className={ipt}>
                  <option value="">Select account…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>

            {/* ── Address ─────────────────────────────────────────────── */}
            {/* Address line 1 lives in the main form now (optional). This
                section keeps the secondary address line only. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Address line 2">
                <input {...register('address_line_2')} placeholder="Address line 2" className={ipt} />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <Field label="City">
                <input {...register('city')} placeholder="City" className={ipt} />
              </Field>
              <Field label="State">
                <input {...register('state')} placeholder="State" className={ipt} />
              </Field>
              <Field label="Country">
                <input {...register('country')} placeholder="Country" className={ipt} />
              </Field>
              <Field label="ZIP code">
                <input {...register('zip_code')} placeholder="Zip/Postal Code" className={ipt} />
              </Field>
            </div>
            <Field label="Shipping address" hint="Leave blank to use the billing address above.">
              <input {...register('shipping_address')} placeholder="Shipping address" className={ipt} />
            </Field>
          </div>
        )}

        {/* ── Custom fields ───────────────────────────────────────────── */}
        <details className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-gray-500">
            Custom fields (optional)
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {['custom_field_1', 'custom_field_2', 'custom_field_3', 'custom_field_4'].map((k, i) => (
              <Field key={k} label={`Custom field ${i + 1}`}>
                <input
                  {...register(k)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
              </Field>
            ))}
          </div>
        </details>

        <Field label="Notes">
          <textarea
            {...register('notes')}
            rows={2}
            placeholder="Internal notes (optional)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </Field>

        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            {...register('is_active')}
            className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-200"
          />
          Active
        </label>
      </form>
      <ModalFooter>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {isEdit ? 'Save changes' : 'Create customer'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function DeleteModal({ open, customer, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteCustomer(customer.id)
      onDeleted?.()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete Customer" size="sm">
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <p className="text-sm text-gray-700">
          Delete <strong>{customer?.name}</strong>? This soft-deletes the
          record — past sales remain in the database but the customer is
          hidden from new lookups.
        </p>
      </div>
      <ModalFooter>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Cancel
        </button>
        <button
          onClick={confirm}
          disabled={loading}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
        >
          {loading ? 'Deleting…' : 'Delete'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NotesModal — Documents & Note item from the Actions menu.
// Documents (attachments) are a separate feature; for now this is a focused
// editor for the customer's `notes` field so the menu item does something
// useful immediately.
// ─────────────────────────────────────────────────────────────────────────────

function NotesModal({ customer, onClose, onSaved }) {
  const [notes,   setNotes]   = useState(customer.notes || '')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const save = async () => {
    setSaving(true); setError('')
    try {
      await updateCustomer(customer.id, { notes })
      onSaved?.()
    } catch (e) {
      setError(e?.message || 'Failed to save notes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Documents & Note · ${customer.name}`} size="md">
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Internal note</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={5}
            placeholder="Anything you want to remember about this customer — preferred contact times, credit history notes, delivery instructions, etc."
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </div>

        <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-4 py-3 text-xs text-gray-500">
          📎 File attachments are coming in a future update. For now this modal edits the customer's internal note.
        </div>
      </div>
      <ModalFooter>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </ModalFooter>
    </Modal>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// QuickPayModal — Pay menu item.
// Records a receipt against the customer's outstanding due. The actual
// payment line is recorded on individual sales (existing SalePayment flow),
// so this modal walks the user to the filtered Sales list where they can
// pick a specific invoice. Keeps the data model honest (every payment is
// tied to a sale row, not a free-floating customer-level credit).
// ─────────────────────────────────────────────────────────────────────────────

function CustomerPaymentModal({ customer, onClose, onSaved }) {
  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const [summary, setSummary] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('Cash')
  const [accountId, setAccountId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getCustomerCreditSummary(customer.id)
      .then((s) => {
        setSummary(s)
        const due = Number(s?.current_due || 0)
        if (due > 0) setAmount(String(due))   // auto-fill the customer's due
      })
      .catch(() => setSummary(null))
    getPaymentAccounts({ is_active: true })
      .then((d) => setAccounts(Array.isArray(d) ? d : d?.results || []))
      .catch(() => setAccounts([]))
  }, [customer.id])

  const due     = Number(summary?.current_due || customer.total_sale_due || 0)
  const advance = Number(summary?.advance_balance || 0)
  const opening = Number(summary?.opening_balance || 0)
  const amt     = Number(amount) || 0
  const toAdvance = Math.max(amt - due, 0)

  const save = async () => {
    if (amt <= 0) { showToast({ title: 'Enter amount', message: 'Payment amount must be greater than 0.', variant: 'error' }); return }
    setBusy(true)
    try {
      const code = (PAY_METHODS.find((m) => m.label === method) || {}).code || 'CASH'
      const res = await payCustomer(customer.id, {
        amount: amt, method: code, payment_account_id: accountId || undefined, note,
      })
      showToast({
        title: 'Payment saved',
        message: Number(res?.added_to_advance) > 0
          ? `${fmt(res.applied_to_due)} settled, ${fmt(res.added_to_advance)} added to advance.`
          : `${fmt(amt)} received.`,
      })
      onSaved()
    } catch (e) {
      showToast({ title: 'Payment failed', message: e?.message || 'Please try again.', variant: 'error' })
    } finally { setBusy(false) }
  }

  const lbl = 'mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500'
  const ipt = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:ring-1 focus:ring-brand-300'

  return (
    <Modal open onClose={onClose} title="Add payment" size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3 text-sm">
            <span className="text-gray-500">Customer name: </span>
            <span className="font-semibold text-brand-700">{customer.name}</span>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3 text-xs space-y-1">
            <Row k="Total Sale Due" v={fmt(due)} strong={due > 0} />
            <Row k="Advance Balance" v={fmt(advance)} />
            <Row k="Opening Balance" v={fmt(opening)} />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={lbl}>Amount *</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={ipt} />
            {toAdvance > 0 && <p className="mt-1 text-[11px] text-emerald-600">{fmt(toAdvance)} will be added to advance.</p>}
          </div>
          <div>
            <label className={lbl}>Payment Method *</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={ipt}>
              {PAY_METHODS.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Payment Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={ipt}>
              <option value="">None</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className={lbl}>Payment Note</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={ipt} />
        </div>
      </div>
      <ModalFooter>
        <button onClick={onClose} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300">Close</button>
        <button onClick={save} disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
      </ModalFooter>
    </Modal>
  )
}

function Row({ k, v, strong }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-gray-500">{k}:</span>
      <span className={strong ? 'font-bold text-rose-600' : 'font-semibold text-gray-800'}>{v}</span>
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
  const header = [
    'Code', 'Name', 'Email', 'Mobile', 'Tax number',
    'Added on', 'Address', 'Status', 'Sale due', 'Return due',
  ]
  const lines = rows.map((r) => [
    r.display_code, r.name, r.email, r.phone, r.tax_number,
    r.created_at, r.address, r.is_active ? 'Active' : 'Inactive',
    r.total_sale_due, r.total_sell_return_due,
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

function Field({ label, required, error, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

function FieldSelect({ label, value, onChange, options, disabled, hint }) {
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
      {hint && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
    </div>
  )
}

function FieldDate({ label, value, onChange, hint }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      />
      {hint && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
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
function PeopleIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="7" r="3" />
      <path d="M2 21a7 7 0 0114 0" />
      <circle cx="17" cy="6" r="2.5" />
      <path d="M14.5 14.2A5 5 0 0122 18" />
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
