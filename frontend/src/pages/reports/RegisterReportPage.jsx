/**
 * Register Report
 *
 * Each row is a synthesised cashier-shift = one cashier × one day × one
 * location. Open / Close times come from the first / last SalePayment of
 * the day. Columns split totals by payment method (Cash, Card, Bank
 * Transfer, Mobile, Other) rather than the generic "Custom Payment 1..7"
 * scheme from the source screenshot — clearer and uses the real enum.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { getRegisterReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const today      = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString().slice(0, 10)
}
const monthEnd   = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).toISOString().slice(0, 10)
}

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDT = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const STATUS_OPTIONS = [
  { value: 'all',    label: 'All sessions' },
  { value: 'open',   label: 'Open only' },
  { value: 'closed', label: 'Closed only' },
]

export default function RegisterReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [userId,     setUserId]     = useState('')
  const [locationId, setLocationId] = useState('')
  const [statusF,    setStatusF]    = useState('all')
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(monthEnd())

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
      const params = { page, limit }
      if (userId)     params.user_id     = userId
      if (locationId) params.location_id = locationId
      if (statusF)    params.status      = statusF
      if (dateFrom)   params.date_from   = dateFrom
      if (dateTo)     params.date_to     = dateTo

      const res = await getRegisterReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, limit, userId, locationId, statusF, dateFrom, dateTo])

  // Auto-apply — every filter change (cashier, location, status,
  // dates) re-fires the request with a 300 ms debounce. The old page
  // only refetched on status/page/limit, so the cashier / location /
  // date filters looked dead until "Apply filters" was clicked.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll while the tab is visible plus
  // an immediate refetch on tab/window focus, so payments landing at
  // the till update the open session's totals without a reload.
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
    if (page === 1) fetchReport()
    else setPage(1)
  }

  const onReset = () => {
    setUserId(''); setLocationId(''); setStatusF('all')
    setDateFrom(monthStart()); setDateTo(monthEnd())
    setPage(1)
  }

  const rows           = data?.rows ?? []
  const footer         = data?.footer ?? {}
  const totalPages     = data?.total_pages ?? 1
  const count          = data?.count ?? 0
  const userOptions    = data?.user_options ?? []
  const locationOptions = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const csvHref = useMemo(() => buildCsv(rows, footer), [rows, footer])

  // ── Modern A4 print — self-contained popup: company header +
  // filter chips + summary strip + the sessions table with the
  // server-side TOTALS footer.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const cashName = userId ? (userOptions.find((u) => u.id === userId)?.name || '') : 'All Cashiers'
    const locName  = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const statusLabel = STATUS_OPTIONS.find((s) => s.value === statusF)?.label || 'All sessions'

    const body = rows.map((r, i) => `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td class="nowrap">${esc(fmtDT(r.open_time))}</td>
      <td class="nowrap">${esc(fmtDT(r.close_time))}</td>
      <td>${esc(r.user_name || '—')}</td>
      <td>${esc(r.location_name || '—')}</td>
      <td>${esc(r.status || '—')}</td>
      <td class="num">${fmtBDT(r.cash)}</td>
      <td class="num">${fmtBDT(r.card)}</td>
      <td class="num">${fmtBDT(r.bank_transfer)}</td>
      <td class="num">${fmtBDT(r.mobile)}</td>
      <td class="num">${fmtBDT(r.other)}</td>
      <td class="num bold">${fmtBDT(r.total)}</td>
    </tr>`).join('') || '<tr><td colspan="12" class="empty">No register sessions for these filters.</td></tr>'

    const w = window.open('', '_blank', 'width=1300,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Register Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:9.5px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:8.5px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .bold{font-weight:700}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Register Report — Cashier Sessions</h1>
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
  <div><div class="k">Cashier</div>${esc(cashName)}</div>
  <div><div class="k">Location</div>${esc(locName)}</div>
  <div><div class="k">Status</div>${esc(statusLabel)}</div>
  <div><div class="k">Rows</div>Page ${page} — ${rows.length} of ${count}</div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Sessions</div><div class="v">${Number(footer.session_count || 0).toLocaleString()}</div></div>
  <div class="kpi"><div class="l">Open / Closed</div><div class="v">${Number(footer.open_count || 0).toLocaleString()} / ${Number(footer.closed_count || 0).toLocaleString()}</div></div>
  <div class="kpi"><div class="l">Cash Collected</div><div class="v">${fmtBDT(footer.cash)}</div></div>
  <div class="kpi"><div class="l">Total Collected</div><div class="v" style="color:#059669">${fmtBDT(footer.total)}</div></div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>Open</th><th>Close</th><th>Cashier</th><th>Location</th><th>Status</th>
    <th class="num">Cash</th><th class="num">Card</th><th class="num">Bank Tr.</th>
    <th class="num">Mobile</th><th class="num">Other</th><th class="num">Total</th>
  </tr></thead>
  <tbody>${body}</tbody>
  ${rows.length ? `<tfoot><tr>
    <td colspan="6">TOTALS (all filtered sessions)</td>
    <td class="num">${fmtBDT(footer.cash)}</td>
    <td class="num">${fmtBDT(footer.card)}</td>
    <td class="num">${fmtBDT(footer.bank_transfer)}</td>
    <td class="num">${fmtBDT(footer.mobile)}</td>
    <td class="num">${fmtBDT(footer.other)}</td>
    <td class="num">${fmtBDT(footer.total)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>One row per cashier × day × location; open/close from the first and last payment of the shift.</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-600 via-emerald-600 to-emerald-600 px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Register Report</h1>
            <p className="text-xs text-emerald-100 mt-0.5">
              Daily cashier sessions with payment-method totals. Each row is
              one cashier × one day × one location, with open / close times
              taken from the first and last payment of the shift.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Register
          </span>
        </div>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="Total sessions"
          primary={Number(footer.session_count || 0).toLocaleString()}
          accent="green" />
        <SummaryCard label="Open right now"
          primary={Number(footer.open_count || 0).toLocaleString()}
          accent="emerald" sub={footer.closed_count != null ? `${footer.closed_count} closed` : ''} />
        <SummaryCard label="Cash collected"
          primary={fmtBDT(footer.cash)}
          accent="green" />
        <SummaryCard label="Total collected"
          primary={fmtBDT(footer.total)}
          accent="teal" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <FieldSelect
            label="Cashier"
            value={userId}
            onChange={setUserId}
            options={[
              { value: '', label: 'All cashiers' },
              ...userOptions.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <FieldSelect
            label="Business location"
            value={locationId}
            onChange={setLocationId}
            options={[
              { value: '', label: 'All locations' },
              ...locationOptions.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <FieldSelect
            label="Status"
            value={statusF}
            onChange={setStatusF}
            options={STATUS_OPTIONS}
          />
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onReset}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
          >
            Reset
          </button>
          <button
            onClick={onApply}
            disabled={loading}
            title="Refresh now (auto-refresh every 30s; filters apply instantly)"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            ⟳ Refresh
          </button>
        </div>
      </div>

      {/* ── Table card ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <p className="text-sm font-semibold text-gray-800">Sessions</p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`register-${dateFrom}_${dateTo}.csv`}
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
              {[10, 25, 50, 100, 200].map((n) => (
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
          ) : error ? (
            <div className="px-6 py-10 text-center text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No register sessions for these filters.
            </div>
          ) : (
            <RegisterTable rows={rows} footer={footer} />
          )}
        </div>

        {!loading && !error && rows.length > 0 && (
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

function RegisterTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Open</th>
          <th className="px-5 py-3">Close</th>
          <th className="px-5 py-3">Cashier</th>
          <th className="px-5 py-3">Location</th>
          <th className="px-5 py-3 text-center">Status</th>
          <th className="px-5 py-3 text-right">Cash</th>
          <th className="px-5 py-3 text-right">Card</th>
          <th className="px-5 py-3 text-right">Bank tr.</th>
          <th className="px-5 py-3 text-right">Mobile</th>
          <th className="px-5 py-3 text-right">Other</th>
          <th className="px-5 py-3 text-right">Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r, i) => (
          <tr key={`${r.user_id}-${r.day}-${r.location_id}-${i}`} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.open_time)}</td>
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.close_time)}</td>
            <td className="px-5 py-3">
              <div className="font-medium text-gray-900">{r.user_name}</div>
              {r.user_email && (
                <div className="text-[11px] text-gray-400">{r.user_email}</div>
              )}
            </td>
            <td className="px-5 py-3 text-gray-700">{r.location_name}</td>
            <td className="px-5 py-3 text-center">
              <span className={[
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                r.status === 'OPEN'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-gray-100 text-gray-600',
              ].join(' ')}>
                {r.status === 'OPEN' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                {r.status}
              </span>
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-900">{fmtBDT(r.cash)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.card)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.bank_transfer)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.mobile)}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.other)}</td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-gray-900">{fmtBDT(r.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={5}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered sessions)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.cash)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.card)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.bank_transfer)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.mobile)}</td>
          <td className="px-5 py-3 text-right tabular-nums">{fmtBDT(footer.other)}</td>
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(footer.total)}</td>
        </tr>
      </tfoot>
    </table>
  )
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
    'Open', 'Close', 'Cashier', 'Email', 'Location', 'Status',
    'Cash', 'Card', 'Bank transfer', 'Mobile', 'Other', 'Total',
  ]
  const lines = rows.map((r) => [
    r.open_time, r.close_time, r.user_name, r.user_email, r.location_name, r.status,
    r.cash, r.card, r.bank_transfer, r.mobile, r.other, r.total,
  ].map(esc).join(','))
  lines.push(['TOTAL', '', '', '', '', '',
    footer.cash ?? '', footer.card ?? '', footer.bank_transfer ?? '',
    footer.mobile ?? '', footer.other ?? '', footer.total ?? ''].map(esc).join(','))
  // UTF-8 BOM so Bangla text + ৳ open correctly in Excel.
  return URL.createObjectURL(
    new Blob(['﻿' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function SummaryCard({ label, primary, sub, accent = 'emerald' }) {
  const COLORS = {
    emerald: 'from-emerald-50 to-emerald-100 ring-emerald-200 text-emerald-700',
    green:   'from-green-50 to-green-100 ring-green-200 text-green-700',
    teal:    'from-teal-50 to-teal-100 ring-teal-200 text-teal-700',
    lime:    'from-lime-50 to-lime-100 ring-lime-200 text-lime-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.emerald} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{primary}</p>
      {sub && <p className="mt-1 text-xs opacity-80 leading-snug">{sub}</p>}
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
