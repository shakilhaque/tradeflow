/**
 * Customers & Suppliers Report
 *
 * One unified ledger row per contact (Customer or Supplier) with their
 * lifetime activity totals and outstanding Due. Green theme matches the
 * rest of the Reports group.
 *
 * Notes
 *   • 'Customer Group' filter from the source screenshot is rendered as a
 *     disabled placeholder — IFFAA doesn't have a CustomerGroup model yet,
 *     so the column / dropdown is kept for layout parity but inert.
 *   • 'Opening Balance Due' column is also surfaced for layout parity but
 *     always 0 — opening-balance tracking can be added later without UI
 *     changes (the field is already in the API response).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getContactsReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()

const TYPE_BADGE = {
  customer: 'bg-emerald-100 text-emerald-700',
  supplier: 'bg-teal-100 text-teal-700',
}

export default function ContactsReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [type,   setType]   = useState('all')
  const [search, setSearch] = useState('')

  // ── Paging ─────────────────────────────────────────────────────────────────
  const [page,  setPage]  = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const params = { type, page, limit }
      if (search.trim()) params.search = search.trim()
      const res = await getContactsReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [type, page, limit, search])

  // Auto-apply — every filter change (type, search, page, limit)
  // re-fires the request with a 350 ms debounce. The old page didn't
  // refetch on search keystrokes, so the search box looked dead until
  // Enter / Apply was hit.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll + refetch on tab/window focus,
  // so new sales / purchases / payments move contact dues without a
  // manual reload.
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

  // Reset to page 1 when changing the type filter.
  useEffect(() => { setPage(1) }, [type])

  const onApply = () => {
    if (page === 1) fetchReport()
    else setPage(1)
  }

  const rows         = data?.rows ?? []
  const footer       = data?.footer ?? {}
  const totalPages   = data?.total_pages ?? 1
  const count        = data?.count ?? 0
  const typeOptions  = data?.type_options ?? [
    { value: 'all',      label: 'All contacts' },
    { value: 'customer', label: 'Customers only' },
    { value: 'supplier', label: 'Suppliers only' },
  ]

  const csvHref = useMemo(() => buildCsv(rows, footer), [rows, footer])

  // ── Modern A4 print — self-contained popup: company header +
  // filter chips + KPI strip + the contacts ledger table with the
  // full-set TOTALS footer.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const typeLabel = typeOptions.find((t) => t.value === type)?.label || 'All contacts'

    const body = rows.map((r, i) => `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td>${esc(r.name)}<div class="muted">${esc([r.phone, r.email].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(r.type)}</td>
      <td class="num">${fmtBDT(r.total_purchase)}</td>
      <td class="num">${fmtBDT(r.total_purchase_return)}</td>
      <td class="num">${fmtBDT(r.total_sale)}</td>
      <td class="num">${fmtBDT(r.total_sell_return)}</td>
      <td class="num">${fmtBDT(r.opening_balance_due)}</td>
      <td class="num bold">${fmtBDT(r.due)}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No contacts with activity for the current filter.</td></tr>'

    const w = window.open('', '_blank', 'width=1250,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Customers &amp; Suppliers Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:9.5px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:9px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:#9ca3af;font-size:8px}
  .bold{font-weight:700}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Customers &amp; Suppliers Report</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">Rows: Page ${page} — ${rows.length} of ${count}</div>
  </div>
</div>

<div class="filters">
  <div><div class="k">Type</div>${esc(typeLabel)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : '<div></div>'}
  <div><div class="k">Contacts</div>${fmtInt(footer.customer_count)} customers · ${fmtInt(footer.supplier_count)} suppliers</div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Customers</div><div class="v">${fmtInt(footer.customer_count)}</div></div>
  <div class="kpi"><div class="l">Total Suppliers</div><div class="v">${fmtInt(footer.supplier_count)}</div></div>
  <div class="kpi"><div class="l">Net Receivable (customers owe us)</div><div class="v" style="color:#059669">${fmtBDT(footer.customer_due)}</div></div>
  <div class="kpi"><div class="l">Net Payable (we owe suppliers)</div><div class="v" style="color:#dc2626">${fmtBDT(footer.supplier_due)}</div></div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>Contact</th><th>Type</th>
    <th class="num">Total Purchase</th><th class="num">Purchase Return</th>
    <th class="num">Total Sale</th><th class="num">Sell Return</th>
    <th class="num">Opening Due</th><th class="num">Due</th>
  </tr></thead>
  <tbody>${body}</tbody>
  ${rows.length ? `<tfoot><tr>
    <td colspan="3">TOTALS (all filtered contacts)</td>
    <td class="num">${fmtBDT(footer.total_purchase)}</td>
    <td class="num">${fmtBDT(footer.total_purchase_return)}</td>
    <td class="num">${fmtBDT(footer.total_sale)}</td>
    <td class="num">${fmtBDT(footer.total_sell_return)}</td>
    <td class="num">${fmtBDT(footer.opening_balance_due)}</td>
    <td class="num">${fmtBDT(footer.due)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>Unified contact ledger — lifetime activity and outstanding due per contact.</div>
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
            <h1 className="text-xl font-bold text-white tracking-tight">Customers &amp; Suppliers Reports</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Unified contact ledger — every customer and supplier with their
              lifetime activity and outstanding due.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Contacts
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total customers"   value={fmtInt(footer.customer_count)} accent="emerald" />
        <Kpi label="Total suppliers"   value={fmtInt(footer.supplier_count)} accent="teal" />
        {/* Server-side per-type totals across the FULL set — the old
            page summed only the current page's rows, so these
            headline numbers changed as the operator flipped pages. */}
        <Kpi label="Net receivable"
             value={fmtBDT(footer.customer_due)}
             sub="What customers owe us"
             accent="green" />
        <Kpi label="Net payable"
             value={fmtBDT(footer.supplier_due)}
             sub="What we owe suppliers"
             accent="lime" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <FieldSelect
            label="Customer group"
            value=""
            onChange={() => {}}
            options={[{ value: '', label: 'All groups (not configured yet)' }]}
            disabled
            hint="Customer groups will be configurable in a future release."
          />
          <FieldSelect
            label="Type"
            value={type}
            onChange={setType}
            options={typeOptions.map((o) => ({ value: o.value, label: o.label }))}
          />
          <div className="self-end flex gap-2 justify-end">
            <button
              onClick={() => { setType('all'); setSearch(''); setPage(1) }}
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
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onApply()}
            placeholder="Search contact name, phone or email…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`contacts-report-${new Date().toISOString().slice(0, 10)}.csv`}
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
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            >
              {[10, 25, 50, 100, 200, 500].map((n) => (
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
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No contacts with activity for the current filter.
            </div>
          ) : (
            <ContactsTable rows={rows} footer={footer} />
          )}
        </div>

        {!loading && rows.length > 0 && (
          <Pager
            page={page}
            totalPages={totalPages}
            count={count}
            limit={limit}
            onChange={setPage}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

function ContactsTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Contact</th>
          <th className="px-5 py-3 text-center">Type</th>
          <th className="px-5 py-3 text-right">Total purchase</th>
          <th className="px-5 py-3 text-right">Purchase return</th>
          <th className="px-5 py-3 text-right">Total sale</th>
          <th className="px-5 py-3 text-right">Sell return</th>
          <th className="px-5 py-3 text-right">Opening due</th>
          <th className="px-5 py-3 text-right">Due</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={`${r.type}-${r.contact_id}`} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3">
              <div className="font-medium text-gray-900">{r.name}</div>
              {(r.phone || r.email) && (
                <div className="text-[11px] text-gray-400">
                  {[r.phone, r.email].filter(Boolean).join(' · ')}
                </div>
              )}
            </td>
            <td className="px-5 py-3 text-center">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${TYPE_BADGE[r.type] ?? 'bg-gray-100 text-gray-700'}`}>
                {r.type}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">{fmtBDT(r.total_purchase)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.total_purchase_return)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">{fmtBDT(r.total_sale)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.total_sell_return)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-500">{fmtBDT(r.opening_balance_due)}</td>
            <td className="px-5 py-3 text-right tabular-nums">
              <DueCell value={r.due} type={r.type} />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={2}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered rows)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.total_purchase)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.total_purchase_return)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.total_sale)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.total_sell_return)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.opening_balance_due)}</td>
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(footer.due)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

function DueCell({ value, type }) {
  const v = Number(value || 0)
  if (v === 0) return <span className="text-gray-500">{fmtBDT(0)}</span>
  // Positive due for a customer = they owe us → emerald.
  // Positive due for a supplier = we owe them → teal.
  // Negative (rare — overpayment / credit) → grey.
  const tone = v < 0
    ? 'text-gray-500'
    : type === 'customer'
      ? 'text-emerald-700 font-semibold'
      : 'text-teal-700 font-semibold'
  return <span className={tone}>{fmtBDT(value)}</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows, footer = {}) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    'Contact', 'Type', 'Phone', 'Email',
    'Total Purchase', 'Purchase Return',
    'Total Sale', 'Sell Return',
    'Opening Balance Due', 'Due',
  ]
  const lines = rows.map((r) => [
    r.name, r.type, r.phone, r.email,
    r.total_purchase, r.total_purchase_return,
    r.total_sale, r.total_sell_return,
    r.opening_balance_due, r.due,
  ].map(esc).join(','))
  lines.push(['TOTAL', '', '', '',
    footer.total_purchase ?? '', footer.total_purchase_return ?? '',
    footer.total_sale ?? '', footer.total_sell_return ?? '',
    footer.opening_balance_due ?? '', footer.due ?? ''].map(esc).join(','))
  // UTF-8 BOM so Bangla text + the taka symbol open correctly in Excel.
  return URL.createObjectURL(
    new Blob(['﻿' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, accent = 'emerald' }) {
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
      {sub && <p className="mt-0.5 text-[11px] opacity-80">{sub}</p>}
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
