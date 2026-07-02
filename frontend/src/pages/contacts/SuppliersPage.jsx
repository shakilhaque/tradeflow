/**
 * Suppliers list — Contacts → Suppliers
 *
 * Reads /api/purchases/suppliers/ which now annotates total_purchase_due
 * and total_purchase_return_due per row. Mirror of CustomersPage with the
 * same green theme. Supplier Group is the only screenshot column we still
 * defer — groups will arrive in a later release.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import Modal, { ModalFooter } from '../../components/ui/Modal'
import FilterToggle from '../../components/ui/FilterToggle'
import BdPhoneInput, {
  validateBdPhone, validateLettersOnly, validateBusinessName,
  stripAtKeystroke, NON_LETTERS_RE, NON_BUSINESS_RE,
} from '../../components/form/BdPhoneInput'
import { useDefaultPageSize } from '../../context/SettingsContext'
import {
  getSuppliers, createSupplier, updateSupplier, deleteSupplier,
} from '../../api/purchases'
import { getCompanyProfile } from '../../api/companyProfile'

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

export default function SuppliersPage() {
  const navigate = useNavigate()
  // ── Filters ────────────────────────────────────────────────────────────────
  const [status,            setStatus]            = useState('active')
  const [filtersOpen,       setFiltersOpen]       = useState(true)
  const [noPurchaseSince,   setNoPurchaseSince]   = useState('')
  const [search,            setSearch]            = useState('')

  // ── Paging ─────────────────────────────────────────────────────────────────
  const defaultPageSize = useDefaultPageSize(25)
  const [page,  setPage]  = useState(1)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  // ── Modal state ────────────────────────────────────────────────────────────
  const [editing,  setEditing]  = useState(null)   // null | 'new' | supplier object
  const [deleting, setDeleting] = useState(null)

  const fetchData = async () => {
    setLoading(true); setError('')
    try {
      const params = {}
      if (status === 'active')   params.status = 'active'
      if (status === 'inactive') params.status = 'inactive'
      if (search.trim())         params.search = search.trim()
      if (noPurchaseSince)       params.no_purchase_since = noPurchaseSince
      const res = await getSuppliers(params)
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
      setPage(1)
    } catch (err) {
      setError(err.message || 'Failed to load suppliers')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // Live search — debounce typing 300ms so the list filters as the
  // operator types instead of forcing them to press Enter / Apply.
  // Skip the very first render (handled by the status useEffect above)
  // by checking if search is empty AND we haven't typed yet.
  useEffect(() => {
    const t = setTimeout(() => { fetchData() }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const onApply = () => fetchData()
  const onReset = () => {
    setStatus('active'); setNoPurchaseSince(''); setSearch('')
    setTimeout(fetchData, 0)
  }

  const totals = useMemo(() => {
    let due = 0, returnDue = 0
    for (const r of rows) {
      due       += Number(r.total_purchase_due        || 0)
      returnDue += Number(r.total_purchase_return_due || 0)
    }
    return { due, returnDue }
  }, [rows])

  // ── Print handler ───────────────────────────────────────────────────────
  // Builds a self-contained printable HTML and opens it in a new window
  // — never touches the live page DOM, so the row-level action menu
  // can't leak into the printed report (same fix as Customers/Customer
  // Groups).
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const money = (n) => `৳ ${fmt(n)}`
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
    const totals = rows.reduce((acc, r) => ({
      credit_limit:    acc.credit_limit    + Number(r.credit_limit || 0),
      opening_balance: acc.opening_balance + Number(r.opening_balance || 0),
      advance_balance: acc.advance_balance + Number(r.advance_balance || 0),
      total_due:       acc.total_due       + Number(r.total_purchase_due || 0),
    }), { credit_limit: 0, opening_balance: 0, advance_balance: 0, total_due: 0 })

    const rowsHtml = rows.map((s, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(s.contact_id || '')}</td>
      <td>${esc(s.business_name || '')}</td>
      <td><b>${esc(s.name || '')}</b>${s.contact ? `<br><span class="sub">${esc(s.contact)}</span>` : ''}</td>
      <td>${esc(s.email || '')}</td>
      <td>${esc(s.phone || '')}</td>
      <td>${esc(s.tax_number || '')}</td>
      <td class="num">${s.credit_limit ? money(s.credit_limit) : 'No Limit'}</td>
      <td class="num">${money(s.opening_balance)}</td>
      <td class="num">${money(s.advance_balance)}</td>
      <td class="num">${money(s.total_purchase_due)}</td>
      <td>${esc(fmtDate(s.created_at))}</td>
    </tr>`).join('') || '<tr><td colspan="12" class="empty">No suppliers.</td></tr>'

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Suppliers — ${esc(company?.business_name || '')}</title>
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
    <h1 class="title">Suppliers</h1>
    <div class="block" style="margin-top:4px">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">${rows.length} supplier${rows.length === 1 ? '' : 's'}</div>
  </div>
</div>

<table>
  <thead><tr>
    <th>#</th>
    <th>Contact ID</th>
    <th>Business Name</th>
    <th>Name</th>
    <th>Email</th>
    <th>Phone</th>
    <th>Tax No</th>
    <th class="num">Credit Limit</th>
    <th class="num">Opening Balance</th>
    <th class="num">Advance Balance</th>
    <th class="num">Total Due</th>
    <th>Added On</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="7" style="text-align:right">Totals:</td>
    <td class="num">${money(totals.credit_limit)}</td>
    <td class="num">${money(totals.opening_balance)}</td>
    <td class="num">${money(totals.advance_balance)}</td>
    <td class="num">${money(totals.total_due)}</td>
    <td></td>
  </tr></tfoot>
</table>

<div class="footer">
  <div>Total suppliers: <b>${rows.length}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  const count       = rows.length
  const totalPages  = Math.max(Math.ceil(count / limit), 1)
  const pageRows    = rows.slice((page - 1) * limit, page * limit)
  const csvHref     = useMemo(() => buildCsv(rows), [rows])

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Suppliers</h1>
          <p className="text-xs text-emerald-50 mt-0.5">
            Manage your supplier master records — name, contact info, tax
            number and outstanding dues.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/contacts/suppliers/import')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/40 bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:bg-white/20"
          >
            📥 Import Suppliers
          </button>
          <button
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm hover:bg-emerald-50"
          >
            <PlusIcon /> Add Supplier
          </button>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Total suppliers"          value={fmtInt(count)}           accent="emerald" />
        <Kpi label="Outstanding purchase dues" value={fmtBDT(totals.due)}     accent="green"   />
        <Kpi label="Pending return refunds"    value={fmtBDT(totals.returnDue)} accent="teal"  />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} />

        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
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
            label="Has no purchase since"
            value={noPurchaseSince}
            onChange={setNoPurchaseSince}
            hint="Show only suppliers without a purchase on or after this date."
          />
          <FieldSelect
            label="Supplier group"
            value=""
            onChange={() => {}}
            options={[{ value: '', label: 'All (not configured yet)' }]}
            disabled
            hint="Supplier groups will be configurable in a future release."
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
            placeholder="Search name, contact, phone, email or tax number…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`suppliers-${new Date().toISOString().slice(0, 10)}.csv`}
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
            <SuppliersTable
              rows={pageRows}
              onEdit={(s) => setEditing(s)}
              onDelete={(s) => setDeleting(s)}
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
        <SupplierModal
          open={Boolean(editing)}
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchData() }}
        />
      )}
      {deleting && (
        <DeleteModal
          open={Boolean(deleting)}
          supplier={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); fetchData() }}
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

function SuppliersTable({ rows, onEdit, onDelete }) {
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
          <th className="px-5 py-3 text-right whitespace-nowrap">Purchase due</th>
          <th className="px-5 py-3 text-right whitespace-nowrap">Return due</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3">
              <RowMenu onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
            </td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.display_code || '—'}</td>
            <td className="px-5 py-3">
              <div className="font-medium text-gray-900">{r.business_name || r.name}</div>
              {r.business_name && (
                <div className="text-[11px] text-gray-400">{r.name}</div>
              )}
            </td>
            <td className="px-5 py-3 text-gray-700">{r.email || '—'}</td>
            <td className="px-5 py-3 text-gray-700">{r.phone || '—'}</td>
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
              <span className={Number(r.total_purchase_due) > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-500'}>
                {fmtBDT(r.total_purchase_due)}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
              <span className={Number(r.total_purchase_return_due) > 0 ? 'text-teal-700 font-semibold' : 'text-gray-500'}>
                {fmtBDT(r.total_purchase_return_due)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RowMenu({ onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
      >
        Actions <ChevronDownIcon />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-32 rounded-lg border border-gray-100 bg-white shadow-lg py-1">
          <button
            onClick={() => { setOpen(false); onEdit() }}
            className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-emerald-50 hover:text-emerald-700"
          >
            ✎ Edit
          </button>
          <button
            onClick={() => { setOpen(false); onDelete() }}
            className="block w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <TruckIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No suppliers match these filters.</p>
      <p className="mt-1 text-xs text-gray-500">Add your first supplier to start tracking purchases and dues.</p>
      <button
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        <PlusIcon /> Add Supplier
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

export function SupplierModal({ open, supplier, onClose, onSaved }) {
  const isEdit = Boolean(supplier)
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm()
  const [error,    setError]    = useState('')
  const [moreOpen, setMoreOpen] = useState(false)

  // Form value is a string ('true' | 'false') so the radio DOM and form
  // state stay in sync — same pattern as CustomersPage.
  const isIndividualStr = watch('_is_individual')
  const isIndividual = isIndividualStr === 'true'   // default false (business)

  useEffect(() => {
    if (open) {
      reset(isEdit ? {
        _is_individual:  (supplier.is_individual ?? false) ? 'true' : 'false',
        contact_id:      supplier.contact_id || '',
        prefix:          supplier.prefix || '',
        first_name:      supplier.first_name || '',
        middle_name:     supplier.middle_name || '',
        last_name:       supplier.last_name || '',
        date_of_birth:   supplier.date_of_birth || '',
        business_name:   supplier.business_name || '',
        contact:         supplier.contact || '',
        email:           supplier.email || '',
        phone:           supplier.phone || '',
        alternate_phone: supplier.alternate_phone || '',
        landline:        supplier.landline || '',
        address:         supplier.address || '',
        address_line_2:  supplier.address_line_2 || '',
        city:            supplier.city || '',
        state:           supplier.state || '',
        country:         supplier.country || '',
        zip_code:        supplier.zip_code || '',
        shipping_address: supplier.shipping_address || '',
        tax_number:      supplier.tax_number || '',
        notes:           supplier.notes || '',
        is_active:       supplier.is_active ?? true,
        pay_term_value:  supplier.pay_term_value ?? '',
        pay_term_period: supplier.pay_term_period || '',
        opening_balance: supplier.opening_balance ?? '0',
        advance_balance: supplier.advance_balance ?? '0',
        custom_field_1:  supplier.custom_field_1 || '',
        custom_field_2:  supplier.custom_field_2 || '',
        custom_field_3:  supplier.custom_field_3 || '',
        custom_field_4:  supplier.custom_field_4 || '',
      } : {
        _is_individual: 'false', contact_id: '',
        prefix: '', first_name: '', middle_name: '', last_name: '', date_of_birth: '',
        business_name: '',
        contact: '', email: '', phone: '', alternate_phone: '', landline: '',
        address: '', address_line_2: '', city: '', state: '', country: '', zip_code: '',
        shipping_address: '',
        tax_number: '', notes: '', is_active: true,
        pay_term_value: '', pay_term_period: '',
        opening_balance: '0', advance_balance: '0',
        custom_field_1: '', custom_field_2: '', custom_field_3: '', custom_field_4: '',
      })
      setError('')
      setMoreOpen(false)
    }
  }, [open, supplier, isEdit, reset])

  const onSubmit = async (data) => {
    setError('')
    const { _is_individual, ...rest } = data
    const payload = {
      ...rest,
      is_individual:   _is_individual === 'true',
      pay_term_value:
        data.pay_term_value === '' || data.pay_term_value == null
          ? null
          : Number(data.pay_term_value),
      opening_balance: Number(data.opening_balance || 0),
      advance_balance: Number(data.advance_balance || 0),
      date_of_birth:   data.date_of_birth || null,
    }
    try {
      const saved = isEdit
        ? await updateSupplier(supplier.id, payload)
        : await createSupplier(payload)
      onSaved?.(saved)
    } catch (err) {
      const fe = err?.errors
      let detail = ''
      if (fe && typeof fe === 'object') {
        if (fe.detail) detail = Array.isArray(fe.detail) ? fe.detail[0] : String(fe.detail)
        else if (fe.non_field_errors) detail = Array.isArray(fe.non_field_errors) ? fe.non_field_errors[0] : String(fe.non_field_errors)
        else {
          detail = Object.entries(fe)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('  ·  ')
        }
      }
      setError(detail || err?.message || 'Failed to save supplier')
    }
  }

  const ipt = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
  const sel = "rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Supplier' : 'Add a new contact'} size="3xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {/* Row 1: type indicator + Individual/Business radio + Contact ID */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <Field label="Contact type *">
            <select disabled value="supplier" className={`${ipt} bg-gray-50`}>
              <option value="supplier">Suppliers</option>
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

        {/* Row 2: Individual fields vs Business fields */}
        {isIndividual ? (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
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
            <Field label="First name *" error={errors.first_name?.message}>
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
            <Field label="Middle name" error={errors.middle_name?.message}>
              <input
                {...stripAtKeystroke(
                  register('middle_name', {
                    validate: (v) => !v || validateLettersOnly('Middle name')(v),
                  }),
                  NON_LETTERS_RE,
                )}
                placeholder="Middle name"
                className={ipt}
              />
            </Field>
            <Field label="Last name *" error={errors.last_name?.message}>
              <input
                {...stripAtKeystroke(
                  register('last_name', {
                    required: 'Required',
                    validate: validateLettersOnly('Last name'),
                  }),
                  NON_LETTERS_RE,
                )}
                placeholder="Last Name"
                className={ipt}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            <Field label="Business name *" error={errors.business_name?.message}>
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

        {/* Row 3: contact details */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Field label="Mobile *" hint="11 digits, +88 fixed." error={errors.phone?.message}>
            <BdPhoneInput
              {...register('phone', {
                required: 'Mobile is required',
                validate: validateBdPhone,
              })}
              placeholder="Mobile"
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

        {isIndividual && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <Field label="Date of birth">
              <input type="date" {...register('date_of_birth')} className={ipt} />
            </Field>
          </div>
        )}

        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        >
          More Information {moreOpen ? '▲' : '▼'}
        </button>

        {moreOpen && (
          <div className="space-y-4 border-t border-gray-100 pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Tax number">
                <input {...register('tax_number')} placeholder="Tax number" className={ipt} />
              </Field>
              <Field label="Opening balance">
                <input type="number" step="0.01" {...register('opening_balance')} placeholder="0" className={ipt} />
              </Field>
              <Field label="Pay term">
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
              <Field label="Advance balance" hint="Credit paid ahead — offset against future bills.">
                <input type="number" step="0.01" min="0" {...register('advance_balance')} placeholder="0" className={ipt} />
              </Field>
              <Field label="Contact person">
                <input {...register('contact')} placeholder="Primary contact at supplier" className={ipt} />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Address line 1">
                <input {...register('address')} placeholder="Address line 1" className={ipt} />
              </Field>
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

        <Field label="Notes">
          <textarea
            {...register('notes')}
            rows={2}
            placeholder="Internal notes (optional)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </Field>

        <details className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-gray-600">
            Custom fields
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((n) => (
              <Field key={n} label={`Custom field ${n}`}>
                <input
                  {...register(`custom_field_${n}`)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
              </Field>
            ))}
          </div>
        </details>

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
          {isEdit ? 'Save changes' : 'Create supplier'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function DeleteModal({ open, supplier, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteSupplier(supplier.id)
      onDeleted?.()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete Supplier" size="sm">
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <p className="text-sm text-gray-700">
          Delete <strong>{supplier?.name}</strong>? This soft-deletes the
          record — past purchases remain in the database but the supplier
          is hidden from new lookups.
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
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    'Code', 'Name', 'Contact', 'Email', 'Mobile', 'Tax number',
    'Added on', 'Address', 'Status', 'Purchase due', 'Return due',
  ]
  const lines = rows.map((r) => [
    r.display_code, r.name, r.contact, r.email, r.phone, r.tax_number,
    r.created_at, r.address, r.is_active ? 'Active' : 'Inactive',
    r.total_purchase_due, r.total_purchase_return_due,
  ].map(esc).join(','))
  return URL.createObjectURL(
    new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers (duplicated from CustomersPage to keep the page self-contained)
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
function TruckIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="15" height="13" />
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
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
