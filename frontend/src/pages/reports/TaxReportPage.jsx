/**
 * Tax Report
 *
 * Three tabs in one fetch:
 *   • Input Tax  — tax paid to suppliers on Purchase lines.
 *   • Output Tax — tax collected from customers on FINAL Sale lines.
 *   • Expense Tax — tax paid on operating Expenses.
 *
 * Summary banner shows the net formula: Output − Input − Expense.
 * Each tab gets its own sticky tfoot with the tab's own running total.
 * Green theme.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { getTaxReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtDT  = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const yearStart = () => `${new Date().getFullYear()}-01-01`
const yearEnd   = () => `${new Date().getFullYear()}-12-31`

const TABS = [
  { id: 'input',   label: 'Input Tax',   icon: <ArrowDownIcon />, hint: 'Tax paid to suppliers on purchases.' },
  { id: 'output',  label: 'Output Tax',  icon: <ArrowUpIcon />,   hint: 'Tax collected from customers on sales.' },
  { id: 'expense', label: 'Expense Tax', icon: <WalletIcon />,    hint: 'Tax paid on operating expenses.' },
]

export default function TaxReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState('')
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(yearEnd())
  const [search,     setSearch]     = useState('')

  // ── Tab + paging ───────────────────────────────────────────────────────────
  const [tab,  setTab]  = useState('input')
  const [page,  setPage]  = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Data ───────────────────────────────────────────────────────────────────
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const fetchReport = useCallback(async (silent = false) => {
    if (!dateFrom || !dateTo) return
    if (!silent) setLoading(true)
    setError('')
    try {
      const params = { date_from: dateFrom, date_to: dateTo }
      if (locationId) params.location_id = locationId
      const res = await getTaxReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateFrom, dateTo, locationId])

  // Auto-apply — every filter change re-fires the request (the old
  // page required a manual "Apply filters" click, which read as
  // broken filters). Debounced to coalesce rapid changes.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll while the tab is visible plus
  // an immediate refetch when the operator returns to the tab/window,
  // so new sales / purchases / expenses show their tax here without
  // a manual reload.
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

  // Reset page when changing tab.
  useEffect(() => { setPage(1) }, [tab])

  const onReset = () => {
    setLocationId(''); setSearch('')
    setDateFrom(yearStart()); setDateTo(yearEnd())
  }

  const summary         = data?.summary ?? {}
  const allRows         = data?.rows?.[tab] ?? []
  const tabTotals       = data?.totals?.[tab] ?? { count: 0, tax: '0' }
  const locationOptions = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side search across the active tab's rows.
  const filtered = useMemo(() => {
    if (!search.trim()) return allRows
    const q = search.trim().toLowerCase()
    return allRows.filter((r) =>
      (r.reference_no || '').toLowerCase().includes(q) ||
      (r.party_name   || '').toLowerCase().includes(q) ||
      (r.tax_number   || '').toLowerCase().includes(q) ||
      (r.payment_method || '').toLowerCase().includes(q)
    )
  }, [allRows, search])

  const filteredTotal = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.tax_amount || 0), 0),
    [filtered]
  )

  const count       = filtered.length
  const totalPages  = Math.max(Math.ceil(count / limit), 1)
  const pageRows    = filtered.slice((page - 1) * limit, page * limit)
  const csvHref     = useMemo(() => buildCsv(filtered, tab), [filtered, tab])

  const netTax = Number(summary.net_tax || 0)

  // ── Modern A4 print — one document carrying ALL THREE tax
  // sections (Input / Output / Expense) + the net-tax summary, so
  // the printed report is a complete tax statement, not just the
  // active tab.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const locName = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'

    const partySection = (rows, label, partyHead) => {
      const body = rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td class="nowrap">${esc(fmtDT(r.date))}</td>
        <td class="mono">${esc(r.reference_no || '—')}</td>
        <td>${esc(r.party_name || '—')}</td>
        <td class="mono">${esc(r.tax_number || '—')}</td>
        <td class="num">${fmtBDT(r.total_amount)}</td>
        <td class="num bold">${fmtBDT(r.tax_amount)}</td>
        <td>${esc(r.payment_method || '—')}</td>
        <td class="num">${fmtBDT(r.discount)}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">No entries in the selected period.</td></tr>'
      const tot = rows.reduce((s, r) => s + Number(r.tax_amount || 0), 0)
      return `<h3>${esc(label)}</h3>
      <table>
        <thead><tr>
          <th>#</th><th>Date</th><th>Reference</th><th>${esc(partyHead)}</th><th>Tax No.</th>
          <th class="num">Total</th><th class="num">Tax</th><th>Method</th><th class="num">Discount</th>
        </tr></thead>
        <tbody>${body}</tbody>
        ${rows.length ? `<tfoot><tr><td colspan="6">TOTAL (${rows.length} entries)</td><td class="num">${fmtBDT(tot)}</td><td colspan="2"></td></tr></tfoot>` : ''}
      </table>`
    }

    const expenseRows = data?.rows?.expense ?? []
    const expBody = expenseRows.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td class="nowrap">${esc(fmtDT(r.date))}</td>
      <td class="mono">${esc(r.reference_no || '—')}</td>
      <td>${esc(r.party_name || '—')}</td>
      <td>${esc(r.payment_method || '—')}</td>
      <td class="num">${fmtBDT(r.total_amount)}</td>
      <td class="num bold">${fmtBDT(r.tax_amount)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No entries in the selected period.</td></tr>'
    const expTot = expenseRows.reduce((s, r) => s + Number(r.tax_amount || 0), 0)

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Tax Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  .kpi.net .v{color:${netTax >= 0 ? '#dc2626' : '#059669'}}
  table{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:6px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-family:ui-monospace,monospace}
  .bold{font-weight:700}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:12px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  h3{font-size:11px;color:#10b981;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.4px}
  .net-box{margin-top:12px;border:2px solid #111827;border-radius:6px;padding:9px 14px;display:flex;justify-content:space-between;align-items:center}
  .net-box .l{font-size:12px;font-weight:700}
  .net-box .v{font-size:16px;font-weight:800;color:${netTax >= 0 ? '#dc2626' : '#059669'}}
  .footer{margin-top:10px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Tax Report</h1>
    <div class="meta">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Period</div>
    <div><b>${esc(dateFrom)} → ${esc(dateTo)}</b></div>
    <div class="sub" style="margin-top:4px">Location: <b>${esc(locName)}</b></div>
    <div class="sub" style="margin-top:4px">Generated: ${esc(new Date().toLocaleString())}</div>
  </div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Output Tax (Sales)</div><div class="v">${fmtBDT(summary.output_tax)}</div></div>
  <div class="kpi"><div class="l">Input Tax (Purchases)</div><div class="v">${fmtBDT(summary.input_tax)}</div></div>
  <div class="kpi"><div class="l">Expense Tax</div><div class="v">${fmtBDT(summary.expense_tax)}</div></div>
  <div class="kpi net"><div class="l">Net Tax</div><div class="v">${fmtBDT(summary.net_tax)}</div></div>
</div>

${partySection(data?.rows?.output ?? [], 'Output Tax — collected from customers on sales', 'Customer')}
${partySection(data?.rows?.input ?? [], 'Input Tax — paid to suppliers on purchases', 'Supplier')}

<h3>Expense Tax — paid on operating expenses</h3>
<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Reference</th><th>Category / For</th><th>Paid From</th>
    <th class="num">Amount</th><th class="num">Tax</th>
  </tr></thead>
  <tbody>${expBody}</tbody>
  ${expenseRows.length ? `<tfoot><tr><td colspan="6">TOTAL (${expenseRows.length} entries)</td><td class="num">${fmtBDT(expTot)}</td></tr></tfoot>` : ''}
</table>

<div class="net-box">
  <div class="l">NET TAX (Output − Input − Expense) — ${netTax >= 0 ? 'Payable to authority' : 'Refund / carry-forward'}</div>
  <div class="v">${fmtBDT(summary.net_tax)}</div>
</div>

<div class="footer">
  <div>All figures from the live sales / purchases / expense ledgers.</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Tax Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Tax details for the selected date range — Input (purchases),
              Output (sales), and Expense in one view.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Tax
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Output tax (sales)"        value={fmtBDT(summary.output_tax)}  accent="emerald" />
        <Kpi label="Input tax (purchases)"     value={fmtBDT(summary.input_tax)}   accent="teal" />
        <Kpi label="Expense tax"               value={fmtBDT(summary.expense_tax)} accent="lime" />
        <Kpi label="Net tax (Output − Input − Expense)"
             value={fmtBDT(summary.net_tax)}
             sub={netTax >= 0 ? 'Payable to authority' : 'Refund / carry-forward'}
             accent="green" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FieldSelect
            label="Business location"
            value={locationId}
            onChange={setLocationId}
            options={[
              { value: '', label: 'All locations' },
              ...locationOptions.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
          <div className="self-end flex justify-end gap-2">
            <button
              onClick={onReset}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
            >
              Reset
            </button>
            <button
              onClick={() => fetchReport()}
              disabled={loading}
              title="Refresh now (auto-refresh every 30s; filters apply instantly)"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              ⟳ Refresh
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <nav className="flex gap-1">
            {TABS.map((t) => {
              const total = data?.totals?.[t.id]?.tax || 0
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={[
                    'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition',
                    tab === t.id
                      ? 'bg-emerald-50 text-emerald-700 shadow-sm ring-1 ring-emerald-200'
                      : 'text-gray-600 hover:bg-gray-50',
                  ].join(' ')}
                  title={t.hint}
                >
                  {t.icon}
                  {t.label}
                  <span className={[
                    'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                    tab === t.id ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600',
                  ].join(' ')}>
                    {fmtBDT(total)}
                  </span>
                </button>
              )
            })}
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`tax-${tab}-${dateFrom}_${dateTo}.csv`}
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

        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search reference, party or tax number…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          <p className="text-xs text-gray-500">
            {TABS.find((t) => t.id === tab)?.hint}
          </p>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : pageRows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No tax entries for this tab in the selected period.
            </div>
          ) : tab === 'expense' ? (
            <ExpenseTaxTable rows={pageRows} totalAmount={filteredTotal} count={count} />
          ) : (
            <PartyTaxTable rows={pageRows} totalAmount={filteredTotal} count={count} tab={tab} />
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
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables — Input / Output use Supplier or Customer columns; Expense is its own.
// ─────────────────────────────────────────────────────────────────────────────

function PartyTaxTable({ rows, totalAmount, count, tab }) {
  const partyHeading = tab === 'input' ? 'Supplier' : 'Customer'
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Reference</th>
          <th className="px-5 py-3">{partyHeading}</th>
          <th className="px-5 py-3">Tax number</th>
          <th className="px-5 py-3 text-right">Total</th>
          <th className="px-5 py-3 text-right">Tax</th>
          <th className="px-5 py-3">Method</th>
          <th className="px-5 py-3 text-right">Discount</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.date)}</td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.reference_no}</td>
            <td className="px-5 py-3 text-gray-800">{r.party_name}</td>
            <td className="px-5 py-3 font-mono text-xs text-gray-500">{r.tax_number || '—'}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.total_amount)}</td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-emerald-700">{fmtBDT(r.tax_amount)}</td>
            <td className="px-5 py-3 text-gray-700">{r.payment_method || '—'}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-500">{fmtBDT(r.discount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={4}>
            <span className="text-xs uppercase tracking-wider">Totals · {count.toLocaleString()} entries</span>
          </td>
          <td className="px-5 py-3 text-right" />
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(totalAmount)}</td>
          <td className="px-5 py-3" colSpan={2} />
        </tr>
      </tfoot>
    </table>
  )
}

function ExpenseTaxTable({ rows, totalAmount, count }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Date</th>
          <th className="px-5 py-3">Reference</th>
          <th className="px-5 py-3">Category / For</th>
          <th className="px-5 py-3">Paid from</th>
          <th className="px-5 py-3 text-right">Amount</th>
          <th className="px-5 py-3 text-right">Tax</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.date)}</td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.reference_no || '—'}</td>
            <td className="px-5 py-3">
              <div className="text-gray-800">{r.party_name}</div>
              {r.category && r.category !== r.party_name && (
                <div className="text-[11px] text-gray-400">{r.category}</div>
              )}
            </td>
            <td className="px-5 py-3 text-gray-700">{r.payment_method || '—'}</td>
            <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtBDT(r.total_amount)}</td>
            <td className="px-5 py-3 text-right tabular-nums font-semibold text-emerald-700">{fmtBDT(r.tax_amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" colSpan={4}>
            <span className="text-xs uppercase tracking-wider">Totals · {count.toLocaleString()} entries</span>
          </td>
          <td className="px-5 py-3 text-right" />
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(totalAmount)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export — columns adapt per tab
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows, tab) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // UTF-8 BOM so Bangla text and the ৳ symbol open correctly in Excel.
  const blobify = (lines) => URL.createObjectURL(
    new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  )
  const taxTotal = rows.reduce((s, r) => s + Number(r.tax_amount || 0), 0)

  if (tab === 'expense') {
    const header = ['Date', 'Reference', 'Category / For', 'Paid from', 'Amount', 'Tax']
    const lines = rows.map((r) => [
      r.date, r.reference_no, r.party_name, r.payment_method, r.total_amount, r.tax_amount,
    ].map(esc).join(','))
    lines.push(['TOTAL', '', '', '', '', taxTotal.toFixed(2)].join(','))
    return blobify([header.join(','), ...lines])
  }
  const partyLabel = tab === 'input' ? 'Supplier' : 'Customer'
  const header = ['Date', 'Reference', partyLabel, 'Tax number', 'Total', 'Tax', 'Method', 'Discount']
  const lines = rows.map((r) => [
    r.date, r.reference_no, r.party_name, r.tax_number,
    r.total_amount, r.tax_amount, r.payment_method, r.discount,
  ].map(esc).join(','))
  lines.push(['TOTAL', '', '', '', '', taxTotal.toFixed(2), '', ''].join(','))
  return blobify([header.join(','), ...lines])
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, accent = 'emerald' }) {
  const COLORS = {
    emerald: 'from-emerald-50 to-emerald-100 ring-emerald-200 text-emerald-700',
    green:   'from-green-50 to-green-100 ring-green-200 text-green-700',
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
function ArrowDownIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clipRule="evenodd" />
    </svg>
  )
}
function ArrowUpIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 11-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
    </svg>
  )
}
function WalletIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.5 4A1.5 1.5 0 001 5.5V6h18v-.5A1.5 1.5 0 0017.5 4h-15zM19 8.5H1v6A1.5 1.5 0 002.5 16h15a1.5 1.5 0 001.5-1.5v-6zM3 13.25a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zm4.75-.75a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" />
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
