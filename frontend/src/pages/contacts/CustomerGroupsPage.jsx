/**
 * Customer Groups — Contacts → Customer Groups
 *
 * Pricing / segmentation buckets you can assign customers to. Each group
 * carries a +/- "calc percentage" applied to product selling prices and
 * an optional Selling Price Group label that maps to an external price
 * tier (Retail, Wholesale…). Green theme to match the rest of Contacts.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'

import Modal, { ModalFooter } from '../../components/ui/Modal'
import FilterToggle from '../../components/ui/FilterToggle'
import { useDefaultPageSize } from '../../context/SettingsContext'
import { getCompanyProfile } from '../../api/companyProfile'
import {
  getCustomerGroups, createCustomerGroup,
  updateCustomerGroup, deleteCustomerGroup,
} from '../../api/sales'

const fmtPct = (n) => {
  const v = Number(n || 0)
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)} %`
}
const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export default function CustomerGroupsPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [status, setStatus] = useState('active')
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [search, setSearch] = useState('')

  // ── Paging ─────────────────────────────────────────────────────────────────
  const defaultPageSize = useDefaultPageSize(25)
  const [page, setPage]   = useState(1)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  // ── Modal state ────────────────────────────────────────────────────────────
  const [editing,  setEditing]  = useState(null)   // null | 'new' | group object
  const [deleting, setDeleting] = useState(null)

  const fetchData = async () => {
    setLoading(true); setError('')
    try {
      const params = {}
      if (status === 'active') params.active_only = 'true'
      if (search.trim())       params.search = search.trim()
      const res = await getCustomerGroups(params)
      let arr = Array.isArray(res) ? res : (res?.results ?? [])
      if (status === 'inactive') arr = arr.filter((r) => !r.is_active)
      setRows(arr)
      setPage(1)
    } catch (err) {
      setError(err.message || 'Failed to load customer groups')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const onApply = () => fetchData()
  const onReset = () => {
    setStatus('active'); setSearch('')
    setTimeout(fetchData, 0)
  }

  const count      = rows.length
  const totalPages = Math.max(Math.ceil(count / limit), 1)
  const pageRows   = rows.slice((page - 1) * limit, page * limit)
  const csvHref    = useMemo(() => buildCsv(rows), [rows])

  // ── Print handler ───────────────────────────────────────────────────────
  // Opens a self-contained popup with a clean printable report. Replaces
  // the bare window.print() call which captured the whole page DOM —
  // including action-menu HTML — into the printed output.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const fmtPct = (n) => {
      const v = Number(n || 0)
      if (v === 0) return '0%'
      return `${v > 0 ? '+' : ''}${v}%`
    }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
    const rowsHtml = rows.map((g, i) => `<tr>
      <td>${i + 1}</td>
      <td><b>${esc(g.name || '')}</b></td>
      <td>${esc(g.calc_type || g.price_calculation_type || '—')}</td>
      <td class="num">${fmtPct(g.calc_percentage || g.amount)}</td>
      <td>${esc(g.description || '—')}</td>
      <td class="num">${esc(g.member_count != null ? String(g.member_count) : '—')}</td>
      <td>${esc(fmtDate(g.created_at))}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No customer groups.</td></tr>'

    const w = window.open('', '_blank', 'width=1100,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Customer Groups — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:14mm 10mm;font-size:12px}
  .row{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:14px}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px;margin:0}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:11px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:7px 8px;border:1px solid #0f9971}
  td{padding:7px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:18px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:10px;color:#6b7280}
  @page{size:A4;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">Customer Groups</h1>
    <div class="block" style="margin-top:6px">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:6px">${rows.length} group${rows.length === 1 ? '' : 's'} · ${stats.discounts} discount · ${stats.markups} markup</div>
  </div>
</div>

<table>
  <thead><tr>
    <th style="width:32px">#</th>
    <th>Group Name</th>
    <th>Price Calc Type</th>
    <th class="num">Adjustment %</th>
    <th>Description</th>
    <th class="num">Members</th>
    <th>Created</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

<div class="footer">
  <div>Total groups: <b>${stats.total}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  const stats = useMemo(() => {
    let discounts = 0, markups = 0
    for (const r of rows) {
      const v = Number(r.calc_percentage || 0)
      if (v < 0) discounts += 1
      else if (v > 0) markups += 1
    }
    return { total: rows.length, discounts, markups }
  }, [rows])

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Customer Groups</h1>
          <p className="text-xs text-emerald-50 mt-0.5">
            Bucket customers into pricing tiers — apply a discount or
            mark-up across every line, and tag the group to a selling-price
            label for downstream reports.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm hover:bg-emerald-50"
        >
          <PlusIcon /> Add Group
        </button>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Total groups"   value={stats.total}     accent="emerald" />
        <Kpi label="Discount tiers" value={stats.discounts} accent="teal" />
        <Kpi label="Mark-up tiers"  value={stats.markups}   accent="green" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} />
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 ${filtersOpen ? '' : 'hidden'}`}>
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
          <FieldText
            label="Search"
            value={search}
            onChange={setSearch}
            onEnter={onApply}
            placeholder="Group name or selling-price label…"
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
            placeholder="Search groups…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`customer-groups-${new Date().toISOString().slice(0, 10)}.csv`}
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
            <GroupsTable
              rows={pageRows}
              onEdit={(g) => setEditing(g)}
              onDelete={(g) => setDeleting(g)}
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
        <GroupModal
          open={Boolean(editing)}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchData() }}
        />
      )}
      {deleting && (
        <DeleteModal
          open={Boolean(deleting)}
          group={deleting}
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

function GroupsTable({ rows, onEdit, onDelete }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3 w-24">Action</th>
          <th className="px-5 py-3">Group name</th>
          <th className="px-5 py-3">Calc. type</th>
          <th className="px-5 py-3 text-right">Calc. value</th>
          <th className="px-5 py-3">Selling price group</th>
          <th className="px-5 py-3">Description</th>
          <th className="px-5 py-3">Added on</th>
          <th className="px-5 py-3 text-center">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => {
          const calc   = Number(r.calc_percentage || 0)
          const type   = r.price_calculation_type || 'percentage'
          const isFix  = type === 'fixed'
          const label  = isFix
            ? `${calc > 0 ? '+' : ''}${calc.toFixed(2)}`
            : fmtPct(calc)
          return (
            <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
              <td className="px-5 py-3">
                <RowMenu onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
              </td>
              <td className="px-5 py-3">
                <div className="font-medium text-gray-900">{r.name}</div>
              </td>
              <td className="px-5 py-3 text-xs text-gray-600 capitalize">{type}</td>
              <td className="px-5 py-3 text-right tabular-nums">
                <span className={[
                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                  calc < 0 ? 'bg-teal-50 text-teal-700'
                    : calc > 0 ? 'bg-amber-50 text-amber-700'
                    : 'bg-gray-100 text-gray-600',
                ].join(' ')}>
                  {label}
                </span>
              </td>
              <td className="px-5 py-3 text-gray-700">
                {r.price_group
                  ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{r.price_group}</span>
                  : <span className="text-gray-400">—</span>}
              </td>
              <td className="px-5 py-3 text-xs text-gray-500 max-w-xs truncate">{r.description || '—'}</td>
              <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
              <td className="px-5 py-3 text-center">
                <span className={[
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                  r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600',
                ].join(' ')}>
                  {r.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
            </tr>
          )
        })}
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
        <UsersIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No customer groups yet.</p>
      <p className="mt-1 text-xs text-gray-500">Create one to set a pricing tier for a segment of customers.</p>
      <button
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        <PlusIcon /> Add Group
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function GroupModal({ open, group, onClose, onSaved }) {
  const isEdit = Boolean(group)
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm()
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      reset(isEdit ? {
        name:                   group.name || '',
        price_calculation_type: group.price_calculation_type || 'percentage',
        calc_percentage:        group.calc_percentage ?? '0',
        price_group:            group.price_group || '',
        description:            group.description || '',
        is_active:              group.is_active ?? true,
      } : {
        name: '',
        price_calculation_type: 'percentage',
        calc_percentage: '0',
        price_group: '', description: '', is_active: true,
      })
      setError('')
    }
  }, [open, group, isEdit, reset])

  const calcType = watch('price_calculation_type') || 'percentage'
  const isFixed  = calcType === 'fixed'

  const onSubmit = async (data) => {
    setError('')
    try {
      const payload = {
        ...data,
        price_calculation_type: data.price_calculation_type || 'percentage',
        calc_percentage: Number(data.calc_percentage || 0),
      }
      if (isEdit) await updateCustomerGroup(group.id, payload)
      else        await createCustomerGroup(payload)
      onSaved?.()
    } catch (err) {
      setError(err.message || 'Failed to save group')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Customer Group' : 'Add Customer Group'} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <Field label="Customer Group Name" required error={errors.name?.message}>
          <input
            {...register('name', { required: 'Name is required' })}
            placeholder="Customer Group Name"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </Field>

        <Field label="Price calculation type">
          <select
            {...register('price_calculation_type')}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed</option>
          </select>
        </Field>

        <Field
          label={isFixed ? 'Calculation amount' : 'Calculation Percentage (%)'}
          hint={
            isFixed
              ? 'Flat per-line adjustment in your currency. Negative = discount, positive = mark-up.'
              : 'Negative = discount, positive = mark-up. e.g. -5 or 10.'
          }
        >
          <input
            type="number" step="0.0001"
            {...register('calc_percentage')}
            placeholder={isFixed ? 'Calculation amount' : 'Calculation Percentage (%)'}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </Field>

        <details className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-gray-600">
            More options
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Selling price group" hint="Optional label that links to a price tier (e.g. Retail).">
              <input
                {...register('price_group')}
                placeholder="Retail / Wholesale / VIP…"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </Field>
            <Field label="Description">
              <input
                {...register('description')}
                placeholder="What is this group for?"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </Field>
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
          {isEdit ? 'Save changes' : 'Create group'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function DeleteModal({ open, group, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteCustomerGroup(group.id)
      onDeleted?.()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete Customer Group" size="sm">
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <p className="text-sm text-gray-700">
          Delete <strong>{group?.name}</strong>? Customers assigned to this
          group will keep their assignment but the group will no longer
          show in pickers.
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
  const header = ['Group name', 'Calc. percentage', 'Selling price group', 'Description', 'Status', 'Added on']
  const lines = rows.map((r) => [
    r.name, r.calc_percentage, r.price_group, r.description,
    r.is_active ? 'Active' : 'Inactive', r.created_at,
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
    emerald: 'from-emerald-50 to-emerald-100 ring-emerald-200 text-emerald-700',
    green:   'from-green-50 to-green-100 ring-green-200 text-green-700',
    teal:    'from-teal-50 to-teal-100 ring-teal-200 text-teal-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.emerald} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
    </div>
  )
}

function Field({ label, required, hint, error, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint  && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

function FieldText({ label, value, onChange, onEnter, placeholder }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      />
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
function UsersIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
