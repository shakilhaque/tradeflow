import { useCallback, useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import EmptyState from '../../components/ui/EmptyState'
import DateRangeField from '../../components/ui/DateRangeField'
import { getCashFlowLedger, getPaymentAccounts } from '../../api/accounting'
import { getLocations } from '../../api/inventory'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, {
  month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const KIND_VARIANT = {
  SELL:         { bg: 'bg-emerald-50 text-emerald-700 border-emerald-100', label: 'Sell' },
  PURCHASE:     { bg: 'bg-violet-50  text-violet-700  border-violet-100',  label: 'Purchase' },
  EXPENSE:      { bg: 'bg-rose-50    text-rose-700    border-rose-100',    label: 'Expense' },
  DEPOSIT:      { bg: 'bg-brand-50   text-brand-700   border-brand-100',   label: 'Deposit' },
  WITHDRAWAL:   { bg: 'bg-amber-50   text-amber-700   border-amber-100',   label: 'Withdrawal' },
  TRANSFER_IN:  { bg: 'bg-teal-50    text-teal-700    border-teal-100',    label: 'Transfer In' },
  TRANSFER_OUT: { bg: 'bg-orange-50  text-orange-700  border-orange-100',  label: 'Transfer Out' },
  ADJUSTMENT:   { bg: 'bg-gray-100   text-gray-700    border-gray-200',    label: 'Adjustment' },
}

const TXN_TYPE_OPTIONS = [
  { value: 'ALL',          label: 'All' },
  { value: 'SELL',         label: 'Sales' },
  { value: 'PURCHASE',     label: 'Purchases' },
  { value: 'EXPENSE',      label: 'Expenses' },
  { value: 'DEPOSIT',      label: 'Deposits' },
  { value: 'WITHDRAWAL',   label: 'Withdrawals' },
  { value: 'TRANSFER_IN',  label: 'Transfers In' },
  { value: 'TRANSFER_OUT', label: 'Transfers Out' },
  { value: 'ADJUSTMENT',   label: 'Adjustments' },
]

export default function CashFlowPage() {
  const [accounts,  setAccounts]  = useState([])
  const [locations, setLocations] = useState([])

  const [filters, setFilters] = useState({
    account_id:  '',
    location_id: '',
    txn_type:    'ALL',
    date_from:   `${currentYear}-01-01`,
    date_to:     `${currentYear}-12-31`,
  })
  const [page,  setPage]  = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  const [data,    setData]    = useState({ results: [], count: 0, total_pages: 1, summary: {} })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    Promise.all([
      getPaymentAccounts({ active: 'true' }).catch(() => []),
      getLocations({ active_only: 'true' }).catch(() => []),
    ]).then(([a, l]) => {
      setAccounts(Array.isArray(a) ? a : (a?.results ?? []))
      { const _l = Array.isArray(l) ? l : (l?.results ?? []); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = { page, limit }
      Object.entries(filters).forEach(([k, v]) => {
        if (v && v !== 'ALL') params[k] = v
      })
      const res = await getCashFlowLedger(params)
      setData(res || { results: [], count: 0, total_pages: 1, summary: {} })
    } catch (err) {
      setError(err?.message || 'Failed to load cash flow.')
      setData({ results: [], count: 0, total_pages: 1, summary: {} })
    } finally {
      setLoading(false)
    }
  }, [page, limit, filters])

  useEffect(() => { load() }, [load])

  // Real-time refresh — poll every 30 seconds so new sale payments,
  // expenses, deposits etc. that other operators post show up
  // without the user having to hit refresh. Stops when the tab is
  // hidden so we don't burn server cycles on inactive sessions.
  useEffect(() => {
    let id = null
    const start = () => {
      if (id) return
      id = setInterval(() => { if (!document.hidden) load() }, 30000)
    }
    const stop = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { load(); start() } }
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  const onFilter = (k) => (e) => { setPage(1); setFilters((p) => ({ ...p, [k]: e.target.value })) }
  const reset = () => {
    setFilters({
      account_id: '', location_id: '', txn_type: 'ALL',
      date_from: `${currentYear}-01-01`, date_to: `${currentYear}-12-31`,
    }); setPage(1)
  }

  const summary = data.summary || {}

  const exportCsv = () => {
    const rows = data.results || []
    if (!rows.length) return
    const head = ['Date', 'Account', 'Type', 'Description', 'Debit', 'Credit', 'Account Balance', 'Total Balance']
    const lines = [head.join(',')].concat(rows.map((r) => [
      fmtDateTime(r.date),
      (r.account_name || '').replace(/,/g, ' '),
      KIND_VARIANT[r.kind]?.label || r.kind,
      describePlain(r).replace(/,/g, ' '),
      Number(r.debit  || 0).toFixed(2),
      Number(r.credit || 0).toFixed(2),
      Number(r.account_balance || 0).toFixed(2),
      Number(r.total_balance   || 0).toFixed(2),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `cash-flow-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // Print the ledger as a clean table document (company header + table),
  // instead of printing the whole app page.
  const handlePrint = async () => {
    const rows = data.results || []
    const win  = window.open('', '_blank', 'width=1200,height=900')
    if (!win) { window.alert('Allow popups to print this report.'); return }
    const c = await getCompanyProfile().catch(() => ({})) || {}
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const bodyRows = rows.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(fmtDateTime(r.date))}</td>
      <td>${esc(r.account_name || '—')}</td>
      <td>${esc(KIND_VARIANT[r.kind]?.label || r.kind || '')}</td>
      <td>${esc(describePlain(r))}</td>
      <td class="num">${Number(r.debit || 0) > 0 ? money(r.debit) : '—'}</td>
      <td class="num">${Number(r.credit || 0) > 0 ? money(r.credit) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No cash-flow entries for these filters.</td></tr>'
    const net = Number(summary.total_credit || 0) - Number(summary.total_debit || 0)
    win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Cash Flow — ${esc(c.business_name || '')}</title>
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
  tfoot td{background:#f9fafb;font-weight:700}
  .empty{text-align:center;color:#9ca3af;padding:18px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:9px;color:#6b7280}
  @page{size:A4 landscape;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">Cash Flow</h1>
    <div class="block" style="margin-top:4px">
      <b>${esc(c.business_name || '')}</b><br>
      ${esc(c.address || '')}<br>
      ${c.phone ? 'Phone: ' + esc(c.phone) : ''}
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
    <th>#</th><th>Date</th><th>Account</th><th>Type</th><th>Description</th>
    <th class="num">Debit</th><th class="num">Credit</th>
  </tr></thead>
  <tbody>${bodyRows}</tbody>
  <tfoot><tr>
    <td colspan="5" style="text-align:right">Totals:</td>
    <td class="num">${money(summary.total_debit)}</td>
    <td class="num">${money(summary.total_credit)}</td>
  </tr></tfoot>
</table>
<div class="footer">
  <div>Total Debit: <b>${money(summary.total_debit)}</b> · Total Credit: <b>${money(summary.total_credit)}</b> · Net Flow: <b>${money(net)}</b></div>
  <div>Powered by Iffaa</div>
</div>
<script>window.onload=()=>setTimeout(()=>window.print(),250)</script>
</body></html>`)
    win.document.close()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Cash Flow</h1>
          <p className="mt-0.5 text-sm text-emerald-50">
            Unified timeline of credits and debits across every payment account.
          </p>
        </div>
        {/* Per spec — operator should be able to refresh without
            losing filter state. Auto-refresh fires on every load
            via the useEffect chain; this button is a manual
            trigger when the user knows a new sale / payment just
            posted. */}
        <Button variant="secondary" size="sm" onClick={() => load()} loading={loading}>
          ⟳ Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-brand-700">Filters</h2>
          <button onClick={reset} className="text-xs font-medium text-brand-600 hover:text-brand-700">Reset</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Account" value={filters.account_id} onChange={onFilter('account_id')}>
            <option value="">All</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Select label="Business Location" value={filters.location_id} onChange={onFilter('location_id')}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Transaction Type" value={filters.txn_type} onChange={onFilter('txn_type')}>
            {TXN_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <DateRangeField
            from={filters.date_from}
            to={filters.date_to}
            onChange={(r) => { setPage(1); setFilters((p) => ({ ...p, date_from: r.from, date_to: r.to })) }}
          />
        </div>
      </Card>

      {/* Summary banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard label="Total Debit"  value={fmtMoney(summary.total_debit)}  accent="rose" />
        <SummaryCard label="Total Credit" value={fmtMoney(summary.total_credit)} accent="emerald" />
        <SummaryCard label="Net Flow"
          value={fmtMoney(Number(summary.total_credit || 0) - Number(summary.total_debit || 0))}
          accent={Number(summary.total_credit || 0) - Number(summary.total_debit || 0) >= 0 ? 'brand' : 'amber'}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white"
            value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>entries</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!data.results?.length}>Export CSV</Button>
          <Button variant="secondary" size="sm" onClick={handlePrint} disabled={!data.results?.length}>Print</Button>
        </div>
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState title="No cash flow entries" message="No transactions match the selected filters." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3 text-right">
                    Account Balance
                    <InfoIcon title="Running balance for this account at this point in time." />
                  </th>
                  <th className="px-4 py-3 text-right">
                    Total Balance
                    <InfoIcon title="Running balance across all accounts." />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => {
                  const v = KIND_VARIANT[r.kind] || KIND_VARIANT.ADJUSTMENT
                  const debit  = Number(r.debit  || 0)
                  const credit = Number(r.credit || 0)
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/40">
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap text-xs">
                        {fmtDateTime(r.date)}
                      </td>
                      <td className="px-4 py-3 font-medium text-navy-800">{r.account_name}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${v.bg}`}>
                            {v.label}
                          </span>
                        </div>
                        <DetailLines kind={r.kind} d={r.details || {}} />
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                        {debit > 0 ? <span className="text-rose-600 font-semibold">{fmtMoney(debit)}</span> : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                        {credit > 0 ? <span className="text-emerald-700 font-semibold">{fmtMoney(credit)}</span> : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums font-medium text-navy-800">
                        {fmtMoney(r.account_balance)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums font-semibold text-navy-800">
                        {fmtMoney(r.total_balance)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 text-sm font-semibold border-t border-gray-200">
                  <td className="px-4 py-3 text-gray-700" colSpan={3}>Total:</td>
                  <td className="px-4 py-3 text-right text-rose-600 tabular-nums">{fmtMoney(summary.total_debit)}</td>
                  <td className="px-4 py-3 text-right text-emerald-700 tabular-nums">{fmtMoney(summary.total_credit)}</td>
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
    </div>
  )
}

function DetailLines({ kind, d }) {
  const lines = []
  if (kind === 'SELL') {
    if (d.customer)   lines.push(['Customer',   d.customer])
    if (d.invoice_no) lines.push(['Invoice No.', d.invoice_no])
    if (d.reference)  lines.push(['Reference',  d.reference])
    if (d.method)     lines.push(['Method',     d.method])
  } else if (kind === 'PURCHASE') {
    if (d.supplier)  lines.push(['Supplier',  d.supplier])
    if (d.reference) lines.push(['Reference', d.reference])
  } else if (kind === 'EXPENSE') {
    if (d.reference) lines.push(['Reference', d.reference])
    if (d.for)       lines.push(['Expense for', d.for])
  } else if (kind === 'TRANSFER_IN' || kind === 'TRANSFER_OUT') {
    if (d.counter_account) lines.push([kind === 'TRANSFER_IN' ? 'From' : 'To', d.counter_account])
    if (d.reference) lines.push(['Reference', d.reference])
    if (d.note)      lines.push(['Note', d.note])
  } else {
    if (d.reference) lines.push(['Reference', d.reference])
    if (d.note)      lines.push(['Note', d.note])
  }
  if (lines.length === 0) return <span className="text-xs text-gray-400">—</span>
  return (
    <ul className="space-y-0.5">
      {lines.map(([k, v]) => (
        <li key={k} className="text-xs">
          <span className="text-gray-500">{k}:</span> <span className="text-gray-800">{v}</span>
        </li>
      ))}
    </ul>
  )
}

function describePlain(r) {
  const d = r.details || {}
  const parts = [r.description]
  if (d.customer)        parts.push(`Customer: ${d.customer}`)
  if (d.invoice_no)      parts.push(`Inv ${d.invoice_no}`)
  if (d.supplier)        parts.push(`Supplier: ${d.supplier}`)
  if (d.reference)       parts.push(`Ref ${d.reference}`)
  if (d.counter_account) parts.push(`↔ ${d.counter_account}`)
  if (d.note)            parts.push(d.note)
  return parts.join(' · ')
}

const ACCENTS = {
  emerald: { bg: 'from-indigo-600 to-cyan-500',   ring: 'ring-emerald-100' },
  rose:    { bg: 'from-rose-500    to-pink-500',   ring: 'ring-rose-100' },
  brand:   { bg: 'from-brand-600   to-indigo-600', ring: 'ring-brand-100' },
  amber:   { bg: 'from-amber-500   to-orange-500', ring: 'ring-amber-100' },
}

function SummaryCard({ label, value, accent }) {
  const a = ACCENTS[accent] ?? ACCENTS.brand
  return (
    <div className={`rounded-xl border border-gray-200 bg-white shadow-soft p-4 ring-1 ${a.ring}`}>
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tracking-tight bg-gradient-to-r ${a.bg} bg-clip-text text-transparent tabular-nums`}>
        {value}
      </p>
    </div>
  )
}

function InfoIcon({ title }) {
  return (
    <span title={title} className="inline-block ml-1 text-brand-400 align-middle cursor-help">
      <svg className="inline w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 11-2 0 1 1 0 012 0zm-1 2a1 1 0 00-1 1v3a1 1 0 102 0v-3a1 1 0 00-1-1z" clipRule="evenodd" />
      </svg>
    </span>
  )
}
