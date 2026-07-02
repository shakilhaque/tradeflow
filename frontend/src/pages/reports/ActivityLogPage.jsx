/**
 * Activity Log (Audit Trail)
 *
 * Reads from the tenant's audit_logs table via GET /api/audit-logs/.
 *
 * Filters: By (user) · Subject Type (module) · Action · Date range · search.
 * Note column renders rich context for each row:
 *   • reference / invoice number
 *   • status / payment-status transitions (old → new) as paired badges
 *   • new totals / amounts where applicable
 *
 * Pure green theme; sticky tfoot count; CSV / Print export.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getActivityLog } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtDT = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()

const yearStart = () => `${new Date().getFullYear()}-01-01`
const yearEnd   = () => `${new Date().getFullYear()}-12-31`

const ACTION_LABEL = {
  CREATE: 'Added',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  VOID:   'Voided',
  LOGIN:  'Login',
  EXPORT: 'Exported',
}

const ACTION_COLOR = {
  CREATE: 'bg-emerald-100 text-emerald-700',
  UPDATE: 'bg-teal-100 text-teal-700',
  DELETE: 'bg-red-100 text-red-700',
  VOID:   'bg-amber-100 text-amber-700',
  LOGIN:  'bg-green-100 text-green-700',
  EXPORT: 'bg-lime-100 text-lime-700',
}

const STATUS_BADGE = {
  // Sale / SellReturn payment statuses
  paid:    'bg-emerald-100 text-emerald-700',
  partial: 'bg-amber-100 text-amber-700',
  due:     'bg-red-100 text-red-700',
  // Sale lifecycle
  FINAL:     'bg-emerald-100 text-emerald-700',
  DRAFT:     'bg-gray-100 text-gray-700',
  QUOTATION: 'bg-teal-100 text-teal-700',
  PROFORMA:  'bg-teal-100 text-teal-700',
  PENDING:   'bg-amber-100 text-amber-700',
  VOIDED:    'bg-red-100 text-red-700',
  // Purchase lifecycle
  draft:     'bg-gray-100 text-gray-700',
  received:  'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
  completed: 'bg-emerald-100 text-emerald-700',
}

const PAGE_SIZE = 25

export default function ActivityLogPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [userId,   setUserId]   = useState('')
  const [moduleF,  setModuleF]  = useState('')
  const [actionF,  setActionF]  = useState('')
  const [dateFrom, setDateFrom] = useState(yearStart())
  const [dateTo,   setDateTo]   = useState(yearEnd())
  const [search,   setSearch]   = useState('')

  // ── Paging ─────────────────────────────────────────────────────────────────
  const [offset, setOffset] = useState(0)
  const [limit,  setLimit]  = useState(PAGE_SIZE)

  // ── Data ───────────────────────────────────────────────────────────────────
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const params = { limit, offset }
      if (userId)   params.user_id   = userId
      if (moduleF)  params.module    = moduleF
      if (actionF)  params.action    = actionF
      if (dateFrom) params.date_from = dateFrom
      if (dateTo)   params.date_to   = dateTo
      const res = await getActivityLog(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load activity log')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [limit, offset, userId, moduleF, actionF, dateFrom, dateTo])

  // Auto-apply — every filter change refetches with a 300 ms
  // debounce. The old page refetched on user/module/action but NOT
  // on the date inputs, so editing From/To silently did nothing
  // until "Apply filters" was clicked. (The text search stays
  // client-side and filters as you type.)
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll + refetch on tab/window focus,
  // so fresh audit entries stream in without a manual reload.
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

  const onApply = () => {
    setOffset(0)
    fetchReport()
  }
  const onReset = () => {
    setUserId(''); setModuleF(''); setActionF(''); setSearch('')
    setDateFrom(yearStart()); setDateTo(yearEnd())
    setOffset(0)
  }

  const rows           = data?.results ?? []
  const userOptions    = data?.user_options ?? []
  const moduleOptions  = data?.module_options ?? []
  const actionOptions  = data?.action_options ?? []
  // Server returns the rows for the requested window; we don't know the
  // total count without an explicit count() call. Use a sliding pager.

  // Local search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.trim().toLowerCase()
    return rows.filter((r) =>
      (r.record_repr  || '').toLowerCase().includes(q) ||
      (r.subject_label|| '').toLowerCase().includes(q) ||
      (r.user_name    || '').toLowerCase().includes(q) ||
      (r.module       || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  const csvHref = useMemo(() => buildCsv(filtered), [filtered])

  // Page navigation: we don't get a 'count' from the API so we go off the
  // returned row count vs requested limit.
  const hasNext = rows.length >= limit
  const page    = Math.floor(offset / limit) + 1

  // ── Modern A4 print — self-contained popup: company header +
  // filter chips + the audit-trail table.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const byName     = userId ? (userOptions.find((u) => u.id === userId)?.name || '') : 'All Users'
    const moduleName = moduleF ? (moduleOptions.find((m) => m.value === moduleF)?.label || moduleF) : 'All Modules'
    const actionName = actionF ? (ACTION_LABEL[actionF] || actionF) : 'All Actions'

    const noteOf = (r) => {
      const nv = r.new_value || {}
      const ov = r.old_value || {}
      const ref = nv.reference_no || nv.invoice_number || ov.reference_no || ov.invoice_number || r.record_repr || ''
      const status = nv.status || ''
      return [ref, status && `Status: ${status}`].filter(Boolean).join(' · ')
    }

    const body = filtered.map((r, i) => `<tr>
      <td>${i + 1 + offset}</td>
      <td class="nowrap">${esc(fmtDT(r.created_at))}</td>
      <td>${esc(r.subject_label || r.module)}</td>
      <td>${esc(ACTION_LABEL[r.action] || r.action)}</td>
      <td>${esc(r.user_name || '—')}</td>
      <td>${esc(noteOf(r))}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No activity for these filters.</td></tr>'

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Activity Log — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:9.5px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  table{width:100%;border-collapse:collapse;font-size:9px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 portrait;margin:7mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Activity Log</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Period</div>
    <div><b>${esc(dateFrom)} → ${esc(dateTo)}</b></div>
    <div class="sub" style="margin-top:4px">Generated: ${esc(new Date().toLocaleString())}</div>
  </div>
</div>

<div class="filters">
  <div><div class="k">By</div>${esc(byName)}</div>
  <div><div class="k">Module</div>${esc(moduleName)}</div>
  <div><div class="k">Action</div>${esc(actionName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : `<div><div class="k">Rows</div>Page ${page} — ${filtered.length} shown</div>`}
</div>

<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Subject</th><th>Action</th><th>By</th><th>Note</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>

<div class="footer">
  <div>Immutable audit trail — every create / update / delete / login / export.</div>
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
            <h1 className="text-xl font-bold text-white tracking-tight">Activity Log</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Immutable audit trail of every create / update / delete /
              login / export across your workspace.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Activity Log
          </span>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <FieldSelect
            label="By"
            value={userId}
            onChange={setUserId}
            options={[
              { value: '', label: 'All users' },
              ...userOptions.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <FieldSelect
            label="Subject type"
            value={moduleF}
            onChange={setModuleF}
            options={[
              { value: '', label: 'All subjects' },
              ...moduleOptions.map((m) => ({ value: m.value, label: m.label })),
            ]}
          />
          <FieldSelect
            label="Action"
            value={actionF}
            onChange={setActionF}
            options={[
              { value: '', label: 'All actions' },
              ...actionOptions.map((a) => ({ value: a.value, label: ACTION_LABEL[a.value] || a.label })),
            ]}
          />
          <FieldDate label="From" value={dateFrom} onChange={setDateFrom} />
          <FieldDate label="To"   value={dateTo}   onChange={setDateTo} />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 justify-between">
          <div className="flex-1 min-w-[200px] max-w-md">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              Search
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onApply()}
              placeholder="Reference, record, user, module…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </div>
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
             disabled={loading}
              title="Refresh now (auto-refresh every 30s; filters apply instantly)">
              ⟳ Refresh
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
          <p className="text-sm font-semibold text-gray-800">
            Activity entries
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`activity-log-${new Date().toISOString().slice(0, 10)}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <DownloadIcon /> CSV / Excel
            </a>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              <PrintIcon /> Print / PDF
            </button>
            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0) }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            >
              {[25, 50, 100, 200, 500].map((n) => (
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
          ) : filtered.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No activity entries for the selected filters.
            </div>
          ) : (
            <ActivityTable rows={filtered} />
          )}
        </div>

        {!loading && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3 text-sm">
            <p className="text-xs text-gray-500">
              Page <span className="font-semibold text-gray-700">{page}</span>
              {' · showing '}
              <span className="font-semibold text-gray-700">{fmtInt(filtered.length)}</span>
              {' entr'}{filtered.length === 1 ? 'y' : 'ies'}
            </p>
            <div className="inline-flex items-center gap-1">
              <PagerButton onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0}>
                ‹ Prev
              </PagerButton>
              <PagerButton onClick={() => setOffset(offset + limit)} disabled={!hasNext}>
                Next ›
              </PagerButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

function ActivityTable({ rows }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Subject</th>
          <th className="px-5 py-3">Action</th>
          <th className="px-5 py-3">By</th>
          <th className="px-5 py-3">Note</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors align-top">
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.created_at)}</td>
            <td className="px-5 py-3 text-gray-800">{r.subject_label || r.module}</td>
            <td className="px-5 py-3">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${ACTION_COLOR[r.action] ?? 'bg-gray-100 text-gray-700'}`}>
                {ACTION_LABEL[r.action] || r.action}
              </span>
            </td>
            <td className="px-5 py-3 text-gray-700">{r.user_name || '—'}</td>
            <td className="px-5 py-3 text-xs text-gray-700">
              <NoteCell row={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function NoteCell({ row }) {
  const oldVal = row.old_value || {}
  const newVal = row.new_value || {}

  // Pull out the most useful fields to surface as named lines.
  const refLabel = row.subject_label?.toLowerCase().includes('purchase')
    ? 'Reference No'
    : row.subject_label?.toLowerCase().includes('expense')
      ? 'Reference No'
      : 'Invoice No.'
  const ref = newVal.reference_no || newVal.invoice_number || oldVal.reference_no || oldVal.invoice_number || row.record_repr

  // Detect state transitions (status / payment_status / amount changes).
  const transitions = []
  for (const field of ['status', 'payment_status']) {
    if (oldVal[field] != null && newVal[field] != null && oldVal[field] !== newVal[field]) {
      transitions.push({ field, from: oldVal[field], to: newVal[field] })
    } else if (newVal[field] != null && oldVal[field] == null) {
      transitions.push({ field, to: newVal[field] })
    }
  }

  const totalNew = newVal.total_amount ?? newVal.grand_total ?? newVal.amount ?? null

  return (
    <div className="space-y-1">
      {ref && (
        <div>
          <span className="text-[11px] font-semibold text-gray-500">{refLabel}: </span>
          <span className="font-mono text-emerald-700">{ref}</span>
        </div>
      )}
      {transitions.map((t, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-semibold text-gray-500">
            {t.field === 'payment_status' ? 'Payment status' : 'Status'}:
          </span>
          {t.from != null && (
            <>
              <StatusPill value={t.from} />
              <span className="text-gray-400">→</span>
            </>
          )}
          <StatusPill value={t.to} />
        </div>
      ))}
      {totalNew != null && (
        <div>
          <span className="text-[11px] font-semibold text-gray-500">Total: </span>
          <span className="font-semibold text-gray-800">{fmtBDT(totalNew)}</span>
        </div>
      )}
      {!ref && transitions.length === 0 && totalNew == null && (
        <span className="text-gray-400">—</span>
      )}
    </div>
  )
}

function StatusPill({ value }) {
  const v = String(value || '')
  const cls = STATUS_BADGE[v] || STATUS_BADGE[v.toUpperCase()] || STATUS_BADGE[v.toLowerCase()] || 'bg-gray-100 text-gray-700'
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {v}
    </span>
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
  const header = ['Date', 'Subject', 'Action', 'By', 'Record', 'Reference', 'Old value', 'New value']
  const lines  = rows.map((r) => [
    r.created_at, r.subject_label || r.module, r.action, r.user_name,
    r.record_repr, '',
    JSON.stringify(r.old_value || {}),
    JSON.stringify(r.new_value || {}),
  ].map(esc).join(','))
  // UTF-8 BOM so Bangla text opens correctly in Excel.
  return URL.createObjectURL(
    new Blob(['﻿' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function FieldDate({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      />
    </div>
  )
}

function PagerButton({ children, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

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
