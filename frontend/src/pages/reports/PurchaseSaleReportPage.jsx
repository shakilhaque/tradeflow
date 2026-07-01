/**
 * Purchase & Sale Report
 *
 * Single-screen financial summary: side-by-side Purchases vs Sales totals
 * plus an Overall net section. Matches the emerald-header style of the
 * inspiration screenshot but uses gradient cards for a cleaner look and
 * makes the two key bottom numbers (Net + Due) genuinely scannable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { getPurchaseSaleReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const yearStart = () => `${new Date().getFullYear()}-01-01`
const yearEnd   = () => `${new Date().getFullYear()}-12-31`

const PRESETS = [
  { id: 'today',      label: 'Today' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'ytd',        label: 'Year to date' },
  { id: 'this_year',  label: 'This year' },
]

function presetRange(id) {
  const now = new Date()
  const iso = (d) => d.toISOString().slice(0, 10)
  switch (id) {
    case 'today':
      return { from: iso(now), to: iso(now) }
    case 'this_month':
      return {
        from: iso(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
        to:   iso(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12)),
      }
    case 'last_month':
      return {
        from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)),
        to:   iso(new Date(now.getFullYear(), now.getMonth(), 0, 12)),
      }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to: iso(now) }
    case 'this_year':
    default:
      return { from: yearStart(), to: yearEnd() }
  }
}

export default function PurchaseSaleReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState('')
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(yearEnd())

  // ── Data ───────────────────────────────────────────────────────────────────
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [tenantNotReady, setTenantNotReady] = useState(false)
  const [showDateMenu, setShowDateMenu] = useState(false)

  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(''); setTenantNotReady(false)
    try {
      const params = {}
      if (locationId) params.location_id = locationId
      if (dateFrom)   params.date_from   = dateFrom
      if (dateTo)     params.date_to     = dateTo
      const res = await getPurchaseSaleReport(params)
      setData(res)
    } catch (err) {
      if (err?.status === 503 && err?.errors?.code === 'tenant_not_ready') {
        setTenantNotReady(true)
      } else {
        setError(err.message || 'Failed to load report')
      }
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [locationId, dateFrom, dateTo])

  // Auto-apply — location AND date changes refetch instantly (300 ms
  // debounce). The old page only auto-fetched on location; date edits
  // silently did nothing until "Apply custom range" was clicked.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll while the tab is visible plus
  // an immediate refetch on tab/window focus, so new purchases and
  // sales land here without a manual reload.
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

  const applyPreset = (id) => {
    const r = presetRange(id)
    setDateFrom(r.from); setDateTo(r.to)
    setShowDateMenu(false)
    // Debounced auto-apply effect picks the new dates up.
  }

  const onApplyDates = () => {
    setShowDateMenu(false)
    fetchReport()
  }

  const purchases       = data?.purchases ?? {}
  const sales           = data?.sales ?? {}
  const overall         = data?.overall ?? {}
  const locationOptions = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const saleMinusPurchase = Number(overall.sale_minus_purchase || 0)
  const dueAmount         = Number(overall.due_amount || 0)

  // ── CSV / Excel — all three sections in one file ────────────────
  const csvHref = useMemo(() => {
    if (!data) return '#'
    const lines = [
      'PURCHASES',
      'Item,Amount',
      `Total Purchase,${purchases.total_purchase ?? ''}`,
      `Purchase Including Tax,${purchases.total_purchase_with_tax ?? ''}`,
      `Total Purchase Return (incl. tax),${purchases.total_return_with_tax ?? ''}`,
      `Purchase Due,${purchases.purchase_due ?? ''}`,
      '',
      'SALES',
      'Item,Amount',
      `Total Sale,${sales.total_sale ?? ''}`,
      `Sale Including Tax,${sales.total_sale_with_tax ?? ''}`,
      `Total Sell Return (incl. tax),${sales.total_return_with_tax ?? ''}`,
      `Sale Due,${sales.sale_due ?? ''}`,
      '',
      'OVERALL',
      'Item,Amount',
      `Net Sale (Sale − Sell Return),${overall.net_sale ?? ''}`,
      `Net Purchase (Purchase − Purchase Return),${overall.net_purchase ?? ''}`,
      `Sale − Purchase (net),${overall.sale_minus_purchase ?? ''}`,
      `Due Amount (customer − supplier),${overall.due_amount ?? ''}`,
    ]
    // UTF-8 BOM so Bangla text + ৳ open correctly in Excel.
    return URL.createObjectURL(
      new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    )
  }, [data, purchases, sales, overall])

  // ── Modern A4 print — self-contained popup: company header +
  // period chips + side-by-side Purchases / Sales tables + the
  // Overall net section.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const locName = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'

    const sectionTable = (title, rows) => `<h3>${esc(title)}</h3>
    <table>
      <thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows.map(([k, v, cls]) => `<tr>
        <td>${esc(k)}</td><td class="num ${cls || ''}">${fmtBDT(v)}</td>
      </tr>`).join('')}</tbody>
    </table>`

    const w = window.open('', '_blank', 'width=1000,height=850')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Purchase &amp; Sale Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:11mm 10mm;font-size:11px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:9px;margin-bottom:12px}
  .title{font-size:21px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10.5px;line-height:1.55}
  .sub{color:#6b7280;font-size:9.5px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 8px;border:1px solid #0f9971}
  th.num{text-align:right}
  td{padding:5px 8px;border:1px solid #e5e7eb}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .bold{font-weight:700}
  .rose{color:#dc2626}
  .amber{font-weight:700;color:#b45309}
  h3{font-size:11.5px;color:#10b981;margin:0 0 5px;text-transform:uppercase;letter-spacing:.4px}
  .overall{margin-top:14px;border:2px solid #111827;border-radius:6px;overflow:hidden}
  .overall .bar{background:#10b981;color:#fff;font-weight:700;font-size:11px;padding:7px 12px}
  .overall .tiles{display:grid;grid-template-columns:1fr 1fr}
  .overall .tile{padding:11px 14px;border-right:1px solid #e5e7eb}
  .overall .tile:last-child{border-right:none}
  .overall .l{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .overall .v{font-size:17px;font-weight:800;margin-top:3px}
  .overall .h{font-size:9px;color:#6b7280;margin-top:4px}
  .footer{margin-top:12px;display:flex;justify-content:space-between;color:#6b7280;font-size:9px}
  @page{size:A4 portrait;margin:9mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Purchase &amp; Sale Report</h1>
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

<div class="grid2">
  <div>
    ${sectionTable('Purchases', [
      ['Total Purchase', purchases.total_purchase],
      ['Purchase Including Tax', purchases.total_purchase_with_tax, 'bold'],
      ['Total Purchase Return (incl. tax)', purchases.total_return_with_tax, 'rose'],
      ['Purchase Due (owed to suppliers)', purchases.purchase_due, 'amber'],
    ])}
  </div>
  <div>
    ${sectionTable('Sales', [
      ['Total Sale', sales.total_sale],
      ['Sale Including Tax', sales.total_sale_with_tax, 'bold'],
      ['Total Sell Return (incl. tax)', sales.total_return_with_tax, 'rose'],
      ['Sale Due (owed by customers)', sales.sale_due, 'amber'],
    ])}
  </div>
</div>

<div class="overall">
  <div class="bar">Overall · (Sale − Sell Return) − (Purchase − Purchase Return)</div>
  <div class="tiles">
    <div class="tile">
      <div class="l">Sale − Purchase (net)</div>
      <div class="v" style="color:${saleMinusPurchase >= 0 ? '#059669' : '#dc2626'}">${fmtBDT(saleMinusPurchase)}</div>
      <div class="h">Net sale ${fmtBDT(overall.net_sale)} − net purchase ${fmtBDT(overall.net_purchase)}</div>
    </div>
    <div class="tile">
      <div class="l">Due Amount (customer − supplier)</div>
      <div class="v" style="color:${dueAmount >= 0 ? '#059669' : '#dc2626'}">${fmtBDT(dueAmount)}</div>
      <div class="h">Sale due ${fmtBDT(sales.sale_due)} − purchase due ${fmtBDT(purchases.purchase_due)} ·
        ${dueAmount < 0 ? 'We owe suppliers more than customers owe us.' : 'Customers owe us more than we owe suppliers.'}</div>
    </div>
  </div>
</div>

<div class="footer">
  <div>Purchases vs sales for the selected period, with returns and dues.</div>
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
            <h1 className="text-xl font-bold text-white tracking-tight">Purchase &amp; Sale Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Purchase and sale details for the selected period — side-by-side
              comparison with net and dues.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Combined
          </span>
        </div>
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
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

          <div className="ml-auto relative">
            <button
              onClick={() => setShowDateMenu((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <CalendarIcon /> Quick dates
              <ChevronIcon />
            </button>
            {showDateMenu && (
              <div className="absolute right-0 top-full mt-2 z-10 w-48 rounded-xl border border-gray-100 bg-white shadow-lg py-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p.id)}
                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-emerald-50 hover:text-emerald-700"
                  >
                    {p.label}
                  </button>
                ))}
                <div className="border-t border-gray-100 mt-1 pt-1">
                  <button
                    onClick={onApplyDates}
                    className="block w-full text-left px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    Apply custom range →
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => fetchReport()}
            disabled={loading}
            title="Refresh now (auto-refresh every 30s; filters apply instantly)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-50"
          >
            ⟳ Refresh
          </button>
          <a
            href={csvHref}
            download={`purchase-sale-${dateFrom}_${dateTo}.csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
          >
            ⬇ CSV / Excel
          </a>
          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:border-emerald-500 hover:text-emerald-700"
          >
            <PrintIcon /> Print / PDF
          </button>
        </div>
      </div>

      {tenantNotReady && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-200 text-xs font-bold text-emerald-800">i</span>
          <div className="flex-1">
            <p className="font-semibold">Your workspace is being prepared</p>
            <p className="text-xs mt-0.5">
              The Purchase &amp; Sale data will be available as soon as your tenant
              database finishes setting up. Refresh in a moment.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            Refresh
          </button>
        </div>
      )}
      {error && !tenantNotReady && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Side-by-side stat cards ───────────────────────────────────────── */}
      {loading && !data ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="h-72 rounded-2xl bg-gray-100 animate-pulse" />
          <div className="h-72 rounded-2xl bg-gray-100 animate-pulse" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Purchases */}
          <SummaryCard tone="orange" title="Purchases" icon={<CartIcon />}>
            <Row label="Total Purchase"                value={fmtBDT(purchases.total_purchase)} />
            <Row label="Purchase Including Tax"        value={fmtBDT(purchases.total_purchase_with_tax)} bold />
            <Row label="Total Purchase Return (incl. tax)"
                 value={fmtBDT(purchases.total_return_with_tax)} tone="rose" />
            <Row label="Purchase Due"
                 value={fmtBDT(purchases.purchase_due)}
                 hint="Outstanding amount we owe suppliers."
                 emphasize="amber" />
          </SummaryCard>

          {/* Sales */}
          <SummaryCard tone="orange" title="Sales" icon={<CashIcon />}>
            <Row label="Total Sale"                    value={fmtBDT(sales.total_sale)} />
            <Row label="Sale Including Tax"            value={fmtBDT(sales.total_sale_with_tax)} bold />
            <Row label="Total Sell Return (incl. tax)"
                 value={fmtBDT(sales.total_return_with_tax)} tone="rose" />
            <Row label="Sale Due"
                 value={fmtBDT(sales.sale_due)}
                 hint="Outstanding amount customers owe us."
                 emphasize="amber" />
          </SummaryCard>
        </div>
      )}

      {/* ── Overall section ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 px-6 py-3">
          <h2 className="text-sm font-bold text-white tracking-tight">
            Overall · (Sale − Sell Return) − (Purchase − Purchase Return)
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
          <OverallTile
            label="Sale − Purchase (net)"
            value={fmtBDT(saleMinusPurchase)}
            positive={saleMinusPurchase >= 0}
            help={
              <>
                <span className="text-gray-500">Net sale</span>{' '}
                <span className="font-mono">{fmtBDT(overall.net_sale)}</span>
                {' − '}
                <span className="text-gray-500">net purchase</span>{' '}
                <span className="font-mono">{fmtBDT(overall.net_purchase)}</span>
              </>
            }
          />
          <OverallTile
            label="Due amount (customer − supplier)"
            value={fmtBDT(dueAmount)}
            positive={dueAmount >= 0}
            help={
              <>
                <span className="text-gray-500">Sale due</span>{' '}
                <span className="font-mono">{fmtBDT(sales.sale_due)}</span>
                {' − '}
                <span className="text-gray-500">purchase due</span>{' '}
                <span className="font-mono">{fmtBDT(purchases.purchase_due)}</span>
              </>
            }
            invertedNote={
              dueAmount < 0
                ? 'Negative means we owe suppliers more than customers owe us.'
                : 'Positive means customers owe us more than we owe suppliers.'
            }
          />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────────────────

function SummaryCard({ title, icon, tone = 'orange', children }) {
  const headers = {
    orange: 'from-emerald-500 to-emerald-600',
  }
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className={`bg-gradient-to-r ${headers[tone]} px-6 py-3 flex items-center justify-between`}>
        <h3 className="text-base font-bold text-white tracking-tight">{title}</h3>
        <span className="text-white/90">{icon}</span>
      </div>
      <div className="divide-y divide-gray-50">
        {children}
      </div>
    </div>
  )
}

function Row({ label, value, hint, tone, bold, emphasize }) {
  const valueTone = tone === 'rose' ? 'text-emerald-600' : 'text-gray-900'
  const wrap = emphasize === 'amber'
    ? 'bg-emerald-50/40'
    : ''
  return (
    <div className={`flex items-start justify-between px-6 py-3.5 ${wrap}`}>
      <div className="flex flex-col">
        <span className={`text-sm ${bold ? 'font-semibold text-gray-800' : 'text-gray-700'}`}>
          {label}
        </span>
        {hint && <span className="text-[11px] text-gray-500 mt-0.5">{hint}</span>}
      </div>
      <span className={`text-sm tabular-nums whitespace-nowrap ${valueTone} ${bold ? 'font-bold' : 'font-medium'}`}>
        {value}
      </span>
    </div>
  )
}

function OverallTile({ label, value, positive, help, invertedNote }) {
  return (
    <div className="px-6 py-5">
      <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={[
        'mt-1 text-3xl font-bold tabular-nums',
        // Positive = emerald, negative = a deeper green (lime/teal would clash with brand);
        // keeps the all-green theme while still flagging sign.
        positive ? 'text-emerald-600' : 'text-teal-700',
      ].join(' ')}>
        {value}
      </p>
      <p className="mt-2 text-[11px] text-gray-500">{help}</p>
      {invertedNote && (
        <p className={[
          'mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          positive ? 'bg-emerald-100 text-emerald-700' : 'bg-teal-100 text-teal-700',
        ].join(' ')}>
          {invertedNote}
        </p>
      )}
    </div>
  )
}

function FieldSelect({ label, value, onChange, options }) {
  return (
    <div className="min-w-[200px]">
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
        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

function CartIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M1 1.75A.75.75 0 011.75 1h1.628a1.75 1.75 0 011.734 1.51L5.18 3a65.25 65.25 0 0113.36 1.412.75.75 0 01.58.875 48.645 48.645 0 01-1.618 6.2.75.75 0 01-.712.513H6a2.503 2.503 0 00-2.292 1.5H17.25a.75.75 0 010 1.5H2.76a.75.75 0 01-.748-.807 4.002 4.002 0 012.716-3.486L3.626 2.716a.25.25 0 00-.248-.216H1.75A.75.75 0 011 1.75zM6 17.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM15.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
    </svg>
  )
}
function CashIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.273 5.625A4.483 4.483 0 015.5 4.275V3.75a.75.75 0 011.5 0v.525a4.483 4.483 0 013.227 1.35.75.75 0 01-1.06 1.06A3 3 0 005.5 8a.75.75 0 010 1.5 4.5 4.5 0 11-3.227-3.875zM12.5 6.25a.75.75 0 01.75-.75 4.5 4.5 0 110 9 .75.75 0 010-1.5 3 3 0 003-3 .75.75 0 01-1.5 0 1.5 1.5 0 11-3 0 .75.75 0 01.75-.75z" />
    </svg>
  )
}
function CalendarIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.75 2a.75.75 0 01.75.75V4h7V2.75a.75.75 0 011.5 0V4h.25A2.75 2.75 0 0118 6.75v8.5A2.75 2.75 0 0115.25 18H4.75A2.75 2.75 0 012 15.25v-8.5A2.75 2.75 0 014.75 4H5V2.75A.75.75 0 015.75 2zM3.5 9v6.25c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V9h-13z" clipRule="evenodd" />
    </svg>
  )
}
function ChevronIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
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
