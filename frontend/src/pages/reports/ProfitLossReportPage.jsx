import { useCallback, useEffect, useMemo, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import EmptyState from '../../components/ui/EmptyState'
import {
  getProfitLossSummary,
  getProfitLossBreakdown,
} from '../../api/accounting'
import { getLocations } from '../../api/inventory'
import { getCompanyProfile } from '../../api/companyProfile'

const currentYear = new Date().getFullYear()
const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const TABS = [
  { value: 'products',   label: 'Profit by products',   icon: <IconBox /> },
  { value: 'categories', label: 'Profit by categories', icon: <IconTag /> },
  { value: 'brands',     label: 'Profit by brands',     icon: <IconAward /> },
  { value: 'locations',  label: 'Profit by locations',  icon: <IconMapPin /> },
  { value: 'invoice',    label: 'Profit by invoice',    icon: <IconReceipt /> },
  { value: 'date',       label: 'Profit by date',       icon: <IconCalendar /> },
  { value: 'customer',   label: 'Profit by customer',   icon: <IconUser /> },
  { value: 'day',        label: 'Profit by day',        icon: <IconCalendar /> },
]

export default function ProfitLossReportPage() {
  const [locations, setLocations] = useState([])
  const [locationId, setLocationId] = useState('')
  const [dateFrom,   setDateFrom]   = useState(`${currentYear}-01-01`)
  const [dateTo,     setDateTo]     = useState(`${currentYear}-12-31`)

  const [summary, setSummary] = useState({})
  const [loadingSummary, setLoadingSummary] = useState(true)

  const [activeTab, setActiveTab]   = useState('products')
  const [breakdown, setBreakdown]   = useState({ results: [], total: '0', count: 0 })
  const [loadingBreakdown, setLoadingBreakdown] = useState(true)

  const [search, setSearch] = useState('')

  useEffect(() => {
    getLocations({ active_only: 'true' })
      .then((r) => { const _l = Array.isArray(r) ? r : (r?.results ?? []); setLocations(_l); if (_l.length === 1) setLocationId((v) => v || String(_l[0].id)) })
      .catch(() => {})
  }, [])

  const buildParams = useCallback(() => {
    const p = {}
    if (locationId) p.location_id = locationId
    if (dateFrom)   p.date_from   = dateFrom
    if (dateTo)     p.date_to     = dateTo
    return p
  }, [locationId, dateFrom, dateTo])

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true)
    try {
      const res = await getProfitLossSummary(buildParams())
      setSummary(res || {})
    } catch {
      setSummary({})
    } finally {
      setLoadingSummary(false)
    }
  }, [buildParams])

  const loadBreakdown = useCallback(async () => {
    setLoadingBreakdown(true)
    try {
      const res = await getProfitLossBreakdown({ ...buildParams(), group_by: activeTab })
      setBreakdown(res || { results: [], total: '0', count: 0 })
    } catch {
      setBreakdown({ results: [], total: '0', count: 0 })
    } finally {
      setLoadingBreakdown(false)
    }
  }, [buildParams, activeTab])

  useEffect(() => { loadSummary()  }, [loadSummary])
  useEffect(() => { loadBreakdown() }, [loadBreakdown])

  // Real-time refresh — poll every 30 seconds so new sales,
  // expenses, returns, etc. that other operators record show up
  // without anyone having to reload. Pauses on tab hide so an
  // idle tab doesn't burn server cycles, and re-fires on focus.
  useEffect(() => {
    let id = null
    const start = () => {
      if (id) return
      id = setInterval(() => {
        if (!document.hidden) { loadSummary(); loadBreakdown() }
      }, 30000)
    }
    const stop = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => {
      if (document.hidden) { stop() }
      else { loadSummary(); loadBreakdown(); start() }
    }
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [loadSummary, loadBreakdown])

  // ── Modern A4 print — opens a popup with a self-contained
  // styled report instead of dumping the live page DOM. Pulls
  // company profile + the active location name live so the
  // header is per-tenant; nothing hardcoded.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const locationName = locationId
      ? (locations.find((l) => l.id === locationId)?.name || '')
      : 'All locations'
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const money = (n) => `৳ ${fmt(n)}`
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'

    // Two columns — Revenue side (credits) and Cost side (debits)
    // — so the printed sheet reads like a real Income Statement.
    const revenueRows = [
      ['Total Sales',              summary.total_sales],
      ['Closing Stock (Cost)',     summary.closing_stock_purchase],
      ['Total Sell Return',        summary.total_sell_return,        '−'],
      ['Total Sell Shipping',      summary.total_sell_shipping],
      ['Total Sell Discount',      summary.total_sell_discount,      '−'],
      ['Total Customer Reward',    summary.total_customer_reward,    '−'],
      ['Total Sell Round Off',     summary.total_sell_round_off],
    ]
    const costRows = [
      ['Opening Stock (Cost)',         summary.opening_stock_purchase],
      ['Total Purchase',               summary.total_purchase],
      ['Total Purchase Shipping',      summary.total_purchase_shipping],
      ['Purchase Additional Expenses', summary.purchase_additional_expenses],
      ['Total Stock Adjustment',       summary.total_stock_adjustment],
      ['Total Transfer Shipping',      summary.total_transfer_shipping],
      ['Total COGS',                   summary.total_cogs],
      ['Total Expense',                summary.total_expense],
      ['Total Purchase Return',        summary.total_purchase_return,   '−'],
      ['Total Purchase Discount',      summary.total_purchase_discount, '−'],
      ['Total Stock Recovered',        summary.total_stock_recovered,   '−'],
    ]

    const tdRows = (rows) => rows.map(([label, val, sign]) => `<tr>
      <td>${esc(label)}</td>
      <td class="sign">${sign || ''}</td>
      <td class="num">${money(val)}</td>
    </tr>`).join('')

    // Active-tab breakdown table — gives the printed page some
    // line-level evidence under the totals.
    const bdRows = (breakdown?.results || []).map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(r.label || r.name || r.product_name || r.invoice_number || r.date || '—')}</td>
      <td class="num">${money(r.profit || r.gross_profit || 0)}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">No breakdown data.</td></tr>'

    const w = window.open('', '_blank', 'width=1100,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    const grossClass = Number(summary.gross_profit || 0) >= 0 ? 'positive' : 'negative'
    const netClass   = Number(summary.net_profit   || 0) >= 0 ? 'positive' : 'negative'
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Profit / Loss — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:12mm 10mm;font-size:11px}
  .row{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:14px}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px;margin:0}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:11px;line-height:1.5}
  .kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px}
  .kpi .label{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .value{font-size:14px;font-weight:700;color:#111827;margin-top:2px}
  .kpi.positive .value{color:#10b981}
  .kpi.negative .value{color:#ef4444}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 8px;border:1px solid #0f9971}
  th.num{text-align:right}
  td{padding:5px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sign{text-align:right;color:#6b7280;width:24px}
  tfoot td{background:#f9fafb;font-weight:700;border-top:2px solid #111827}
  h3{font-size:11px;color:#10b981;margin:14px 0 6px;letter-spacing:.4px;text-transform:uppercase}
  .net{margin-top:14px;border:2px solid #111827;border-radius:6px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center}
  .net .label{font-size:13px;font-weight:700;color:#111827}
  .net .value{font-size:18px;font-weight:800}
  .net.positive .value{color:#10b981}
  .net.negative .value{color:#ef4444}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:9px;color:#6b7280}
  @page{size:A4 portrait;margin:8mm}
</style></head><body>

<div class="row">
  <div>
    <h1 class="title">Profit / Loss Report</h1>
    <div class="block" style="margin-top:6px">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Period</div>
    <div><b>${esc(fmtDate(dateFrom))} → ${esc(fmtDate(dateTo))}</b></div>
    <div class="sub" style="margin-top:4px">Location: <b>${esc(locationName)}</b></div>
    <div class="sub" style="margin-top:4px">Generated: ${esc(new Date().toLocaleString())}</div>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="label">Total Sales</div><div class="value">${money(summary.total_sales)}</div></div>
  <div class="kpi ${grossClass}"><div class="label">Gross Profit</div><div class="value">${money(summary.gross_profit)}</div></div>
  <div class="kpi ${netClass}"><div class="label">Net Profit</div><div class="value">${money(summary.net_profit)}</div></div>
</div>

<div class="grid2">
  <div>
    <h3>Revenue & Adjustments</h3>
    <table>
      <thead><tr><th>Item</th><th></th><th class="num">Amount</th></tr></thead>
      <tbody>${tdRows(revenueRows)}</tbody>
    </table>
  </div>
  <div>
    <h3>Cost & Expenses</h3>
    <table>
      <thead><tr><th>Item</th><th></th><th class="num">Amount</th></tr></thead>
      <tbody>${tdRows(costRows)}</tbody>
    </table>
  </div>
</div>

<div class="net ${netClass}">
  <div class="label">Net Profit / Loss</div>
  <div class="value">${money(summary.net_profit)}</div>
</div>

<h3>${esc(activeTab[0].toUpperCase() + activeTab.slice(1))} — Top Lines</h3>
<table>
  <thead><tr>
    <th style="width:32px">#</th>
    <th>Item</th>
    <th class="num">Profit</th>
  </tr></thead>
  <tbody>${bdRows}</tbody>
</table>

<div class="footer">
  <div>Total rows shown: <b>${breakdown?.count ?? 0}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = breakdown.results || []
    if (!q) return rows
    return rows.filter((r) => (r.name || '').toLowerCase().includes(q))
  }, [breakdown.results, search])

  const grossProfit = Number(summary.gross_profit || 0)
  const netProfit   = Number(summary.net_profit   || 0)

  const exportCsv = () => {
    const rows = filteredRows
    if (!rows.length) return
    const head = ['Name', 'Gross Profit']
    const lines = [head.join(',')].concat(rows.map((r) =>
      [`"${(r.name || '').replace(/"/g, '""')}"`, Number(r.gross_profit || 0).toFixed(2)].join(',')
    ))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `profit-loss-${activeTab}-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Profit / Loss Report</h1>
          <p className="mt-0.5 text-sm text-emerald-50">Revenue, cost of goods, expenses and net profit.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary" size="sm"
            onClick={() => { loadSummary(); loadBreakdown() }}
            loading={loadingSummary || loadingBreakdown}
          >
            ⟳ Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={handlePrint} leftIcon={<IconPrint />}>Print</Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-emerald-700">Filters</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Business Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
        </div>
      </Card>

      {/* Hero summary — Gross & Net */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HeroStat
          label="Gross Profit"
          value={fmtMoney(grossProfit)}
          formula="Total sell price − Total purchase price"
          accent={grossProfit >= 0 ? 'emerald' : 'rose'}
        />
        <HeroStat
          label="Net Profit"
          value={fmtMoney(netProfit)}
          formula="Gross + (sell shipping + sell add-ons + stock recovered + purchase return/discount + sell round-off) − (stock adjustment + expenses + purchase shipping + transfer shipping + purchase add-ons + sell discount + customer reward)"
          accent={netProfit >= 0 ? 'brand' : 'rose'}
        />
      </div>

      {/* Two-column merchant P&L breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card padding="p-0" className="overflow-hidden">
          <SectionHeader title="Costs &amp; Outflows" tone="rose" />
          <div className="divide-y divide-gray-50">
            <PLRow label="Opening Stock" hint="By purchase price" value={summary.opening_stock_purchase} loading={loadingSummary} />
            <PLRow label="Opening Stock" hint="By sale price"     value={summary.opening_stock_sale}     loading={loadingSummary} />
            <PLRow label="Total purchase" hint="Exc. tax, Discount" value={summary.total_purchase} loading={loadingSummary} />
            <PLRow label="Total Stock Adjustment"           value={summary.total_stock_adjustment} loading={loadingSummary} />
            <PLRow label="Total Expense"                    value={summary.total_expense}          loading={loadingSummary} />
            <PLRow label="Total purchase shipping charge"   value={summary.total_purchase_shipping} loading={loadingSummary} />
            <PLRow label="Purchase additional expenses"     value={summary.purchase_additional_expenses} loading={loadingSummary} />
            <PLRow label="Total transfer shipping charge"   value={summary.total_transfer_shipping} loading={loadingSummary} />
            <PLRow label="Total Sell discount"              value={summary.total_sell_discount}    loading={loadingSummary} />
            <PLRow label="Total customer reward"            value={summary.total_customer_reward}  loading={loadingSummary} />
            <PLRow label="Total Sell Return"                value={summary.total_sell_return}      loading={loadingSummary} />
          </div>
        </Card>

        <Card padding="p-0" className="overflow-hidden">
          <SectionHeader title="Revenue &amp; Add-backs" tone="emerald" />
          <div className="divide-y divide-gray-50">
            <PLRow label="Closing stock" hint="By purchase price"  value={summary.closing_stock_purchase} loading={loadingSummary} />
            <PLRow label="Closing stock" hint="By sale price"      value={summary.closing_stock_sale}     loading={loadingSummary} />
            <PLRow label="Total Sales"   hint="Exc. tax, Discount" value={summary.total_sales}            loading={loadingSummary} />
            <PLRow label="Total sell shipping charge"   value={summary.total_sell_shipping}     loading={loadingSummary} />
            <PLRow label="Sell additional expenses"     value={summary.sell_additional_expenses} loading={loadingSummary} />
            <PLRow label="Total Stock Recovered"        value={summary.total_stock_recovered}   loading={loadingSummary} />
            <PLRow label="Total Purchase Return"        value={summary.total_purchase_return}   loading={loadingSummary} />
            <PLRow label="Total Purchase discount"      value={summary.total_purchase_discount} loading={loadingSummary} />
            <PLRow label="Total sell round off"         value={summary.total_sell_round_off}    loading={loadingSummary} />
          </div>
        </Card>
      </div>

      {/* ── 8 tabs ─────────────────────────────────────────────────────── */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="overflow-x-auto border-b border-gray-100">
          <div className="flex">
            {TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setActiveTab(t.value)}
                className={[
                  'inline-flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
                  activeTab === t.value
                    ? 'border-emerald-600 text-emerald-700 bg-emerald-50/40'
                    : 'border-transparent text-gray-500 hover:text-navy-800 hover:bg-gray-50',
                ].join(' ')}
              >
                <span className="text-emerald-600">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <p className="text-sm text-gray-500">
              {breakdown.count} row{breakdown.count === 1 ? '' : 's'} ·
              <span className="ml-1 font-semibold text-navy-800">Total: {fmtMoney(breakdown.total)}</span>
            </p>
            <div className="flex items-center gap-2">
              <input
                type="search"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm w-56"
              />
              <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!filteredRows.length}>Export CSV</Button>
            </div>
          </div>

          {loadingBreakdown ? (
            <div className="flex justify-center py-10">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
            </div>
          ) : filteredRows.length === 0 ? (
            <EmptyState title="No data" message="Nothing to show for the current filters and tab." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3">{labelForGroup(activeTab)}</th>
                    <th className="px-4 py-3 text-right">Gross Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredRows.map((r) => (
                    <tr key={String(r.id) || r.name} className="hover:bg-gray-50/40">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-navy-800">{r.name}</span>
                        {r.subtitle && <span className="ml-2 text-[11px] text-gray-400">{r.subtitle}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
                        <span className={Number(r.gross_profit) >= 0 ? 'text-emerald-700 font-semibold' : 'text-emerald-600 font-semibold'}>
                          {fmtMoney(r.gross_profit)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t border-gray-200 text-sm font-semibold">
                    <td className="px-4 py-3 text-gray-700">Total</td>
                    <td className="px-4 py-3 text-right text-navy-800 tabular-nums">{fmtMoney(breakdown.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

function labelForGroup(g) {
  switch (g) {
    case 'products':   return 'Product'
    case 'categories': return 'Category'
    case 'brands':     return 'Brand'
    case 'locations':  return 'Location'
    case 'invoice':    return 'Invoice'
    case 'date':       return 'Date'
    case 'customer':   return 'Customer'
    case 'day':        return 'Day of Week'
    default:           return 'Group'
  }
}

function PLRow({ label, hint, value, loading }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <div>
        <p className="text-sm text-navy-800">{label}{hint && ':'}</p>
        {hint && <p className="text-[11px] text-gray-400">({hint})</p>}
      </div>
      <p className={`tabular-nums whitespace-nowrap text-sm ${Number(value || 0) ? 'font-semibold text-navy-800' : 'text-gray-400'}`}>
        {loading ? <span className="inline-block h-3 w-16 rounded bg-gray-100 animate-pulse" /> : `৳ ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      </p>
    </div>
  )
}

function SectionHeader({ title, tone = 'emerald' }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    green:   'bg-green-50   text-green-700   border-green-100',
    teal:    'bg-teal-50    text-teal-700    border-teal-100',
    // Back-compat keys so existing call sites that pass 'brand' / 'rose' still render green.
    brand:   'bg-emerald-50 text-emerald-700 border-emerald-100',
    rose:    'bg-lime-50    text-lime-700    border-lime-100',
  }
  return (
    <div className={`px-5 py-3 border-b ${tones[tone] ?? tones.emerald}`}>
      <h3 className="text-base font-bold" dangerouslySetInnerHTML={{ __html: title }} />
    </div>
  )
}

const ACCENTS = {
  emerald: 'from-emerald-600 to-green-600',
  green:   'from-green-600   to-teal-600',
  teal:    'from-teal-600    to-emerald-600',
  // Back-compat keys.
  brand:   'from-emerald-600 to-green-600',
  rose:    'from-lime-600    to-emerald-600',
}

function HeroStat({ label, value, formula, accent = 'brand' }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-soft p-5">
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-3xl font-extrabold tracking-tight bg-gradient-to-r ${ACCENTS[accent] ?? ACCENTS.brand} bg-clip-text text-transparent tabular-nums`}>
        {value}
      </p>
      <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">{formula}</p>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────

function IconBox()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 7.5l-9-4.5-9 4.5M21 7.5v9l-9 4.5m9-13.5l-9 4.5m0 0v9m0-9L3 7.5m0 0v9l9 4.5" /></svg> }
function IconTag()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10V5a1 1 0 00-1-1h-5L4 14l6 6 10-10z" /><circle cx="15" cy="9" r="1.5" /></svg> }
function IconAward()    { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="9" r="7" /><path d="M8 15l-2 6 6-3 6 3-2-6" /></svg> }
function IconMapPin()   { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" /></svg> }
function IconReceipt()  { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4a1 1 0 011-1h10a1 1 0 011 1v17l-3-2-3 2-3-2-3 2V4z" /></svg> }
function IconCalendar() { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></svg> }
function IconUser()     { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></svg> }
function IconPrint()    { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2M7 14h10v7H7z" /></svg> }
