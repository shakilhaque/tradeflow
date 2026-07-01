/**
 * Purchase Payment Report — every PurchasePayment instalment paid to a
 * supplier. Mirror of the Sell Payment Report but for the buy side, with
 * a fuchsia/pink accent so the two are easy to tell apart at a glance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { Link } from 'react-router-dom'
import { getPurchasePaymentReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'
import { useDefaultPageSize } from '../../context/SettingsContext'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()
const fmtDT  = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const yearStart = () => `${new Date().getFullYear()}-01-01`
const yearEnd   = () => `${new Date().getFullYear()}-12-31`

const METHOD_COLOR = {
  cash:          'bg-emerald-100 text-emerald-700',
  card:          'bg-emerald-100 text-emerald-700',
  bank_transfer: 'bg-emerald-100 text-emerald-700',
  mobile:        'bg-emerald-100 text-emerald-700',
  other:         'bg-gray-100 text-gray-700',
}

export default function PurchasePaymentReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [method,     setMethod]     = useState('')
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(yearEnd())
  const [search,     setSearch]     = useState('')

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
      if (supplierId) params.supplier_id = supplierId
      if (locationId) params.location_id = locationId
      if (method)     params.method      = method
      if (dateFrom)   params.date_from   = dateFrom
      if (dateTo)     params.date_to     = dateTo
      if (search.trim()) params.search   = search.trim()
      const res = await getPurchasePaymentReport(params)
      setData(res)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setData(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, limit, supplierId, locationId, method, dateFrom, dateTo, search])

  // Auto-apply — every filter change re-fires the request with a
  // 350 ms debounce (the old page only refetched on page/limit, so
  // the dropdowns looked dead until "Apply filters" was clicked).
  const debounceRef = useRef(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchReport(), 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fetchReport])

  // Real-time — 30-second silent poll + refetch on tab/window focus.
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
    setSupplierId(''); setLocationId(''); setMethod(''); setSearch('')
    setDateFrom(yearStart()); setDateTo(yearEnd())
    setPage(1)
  }

  const rows             = data?.rows ?? []
  const footer           = data?.footer ?? {}
  const byMethod         = data?.by_method ?? []
  const totalPages       = data?.total_pages ?? 1
  const count            = data?.count ?? 0
  const supplierOptions  = data?.supplier_options ?? []
  const locationOptions  = data?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const methodOptions    = data?.method_options ?? []

  const cashRow   = byMethod.find((m) => m.method === 'cash')
  const cardRow   = byMethod.find((m) => m.method === 'card')
  const bankRow   = byMethod.find((m) => m.method === 'bank_transfer')
  const mobileRow = byMethod.find((m) => m.method === 'mobile')

  const csvHref = useMemo(() => buildCsv(rows, footer), [rows, footer])

  // ── Modern A4 print — self-contained popup with company header,
  // filter chips, KPI strip and the payments table + TOTALS footer.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const supName  = supplierId ? (supplierOptions.find((s) => s.id === supplierId)?.name || '') : 'All Suppliers'
    const locName  = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const methName = method ? (methodOptions.find((m) => m.value === method)?.label || method) : 'All Methods'

    const body = rows.map((r, i) => `<tr>
      <td>${i + 1 + (page - 1) * limit}</td>
      <td class="mono">${esc(r.reference_no || '—')}</td>
      <td class="nowrap">${esc(fmtDT(r.paid_on))}</td>
      <td>${esc(r.supplier_name || '—')}</td>
      <td>${esc(r.method_label || '—')}</td>
      <td class="mono">${esc(r.purchase_ref || '—')}</td>
      <td class="num bold">${fmtBDT(r.amount)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No payments for these filters.</td></tr>'

    const w = window.open('', '_blank', 'width=1250,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Purchase Payment Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:9mm 8mm;font-size:10px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:9.5px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:9px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 6px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 6px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-family:ui-monospace,monospace}
  .bold{font-weight:700}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  .footer{margin-top:8px;display:flex;justify-content:space-between;color:#6b7280;font-size:8.5px}
  @page{size:A4 landscape;margin:6mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Purchase Payment Report</h1>
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
  <div><div class="k">Supplier</div>${esc(supName)}</div>
  <div><div class="k">Location</div>${esc(locName)}</div>
  <div><div class="k">Method</div>${esc(methName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : `<div><div class="k">Rows</div>Page ${page} — ${rows.length} of ${count}</div>`}
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Paid Out</div><div class="v" style="color:#dc2626">${fmtBDT(footer.total_amount)}</div></div>
  <div class="kpi"><div class="l">Payments</div><div class="v">${fmtInt(footer.count)}</div></div>
  <div class="kpi"><div class="l">Methods In Use</div><div class="v">${fmtInt(byMethod.length)}</div></div>
</div>

<table>
  <thead><tr>
    <th>#</th><th>Reference</th><th>Paid On</th><th>Supplier</th>
    <th>Method</th><th>Purchase Ref</th><th class="num">Amount</th>
  </tr></thead>
  <tbody>${body}</tbody>
  ${rows.length ? `<tfoot><tr>
    <td colspan="6">TOTALS (all filtered rows · ${fmtInt(footer.count)} payments)</td>
    <td class="num">${fmtBDT(footer.total_amount)}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>Every payment made to suppliers against purchases in the selected period.</div>
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
            <h1 className="text-xl font-bold text-white tracking-tight">Purchase Payment Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Every payment paid to a supplier against a Purchase, with filter
              by supplier, location, method and date.
            </p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            Reports / Supplier Payments
          </span>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Total paid"
             value={fmtBDT(footer.total_amount)}
             sub={`${fmtInt(footer.count)} payments`}
             accent="emerald" />
        <Kpi label="Cash"   value={fmtBDT(cashRow?.total)}   sub={`${fmtInt(cashRow?.count)} txns`}   accent="emerald" />
        <Kpi label="Card"   value={fmtBDT(cardRow?.total)}   sub={`${fmtInt(cardRow?.count)} txns`}   accent="green" />
        <Kpi label="Bank"   value={fmtBDT(bankRow?.total)}   sub={`${fmtInt(bankRow?.count)} txns`}   accent="teal" />
        <Kpi label="Mobile" value={fmtBDT(mobileRow?.total)} sub={`${fmtInt(mobileRow?.count)} txns`} accent="teal" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-emerald-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <FieldSelect
            label="Supplier"
            value={supplierId}
            onChange={setSupplierId}
            options={[
              { value: '', label: 'All suppliers' },
              ...supplierOptions.map((s) => ({ value: s.id, label: s.name })),
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
            label="Payment method"
            value={method}
            onChange={setMethod}
            options={[
              { value: '', label: 'All methods' },
              ...methodOptions.map((m) => ({ value: m.value, label: m.label })),
            ]}
          />
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
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
              placeholder="Purchase ref, supplier or payment ref…"
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
          <p className="text-sm font-semibold text-gray-800">Payments</p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`purchase-payments-${dateFrom}_${dateTo}.csv`}
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
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No supplier payments for these filters.
            </div>
          ) : (
            <PaymentsTable rows={rows} footer={footer} />
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

function PaymentsTable({ rows, footer = {} }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Action</th>
          <th className="px-5 py-3">Reference</th>
          <th className="px-5 py-3">Paid on</th>
          <th className="px-5 py-3 text-right">Amount</th>
          <th className="px-5 py-3">Supplier</th>
          <th className="px-5 py-3">Method</th>
          <th className="px-5 py-3">Purchase</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-emerald-50/40 transition-colors">
            <td className="px-5 py-3">
              {r.purchase_id ? (
                <Link
                  to={`/purchases/${r.purchase_id}`}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  View
                </Link>
              ) : (
                <span className="text-xs text-gray-300">—</span>
              )}
            </td>
            <td className="px-5 py-3 font-mono text-xs font-semibold text-emerald-700">{r.reference_no}</td>
            <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">{fmtDT(r.paid_on)}</td>
            <td className="px-5 py-3 text-right font-semibold text-gray-900 tabular-nums">{fmtBDT(r.amount)}</td>
            <td className="px-5 py-3 text-gray-800">{r.supplier_name}</td>
            <td className="px-5 py-3">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${METHOD_COLOR[r.method] ?? 'bg-gray-100 text-gray-700'}`}>
                {r.method_label}
              </span>
            </td>
            <td className="px-5 py-3 font-mono text-xs text-gray-700">{r.purchase_ref}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
          <td className="px-5 py-3" />
          <td className="px-5 py-3" colSpan={2}>
            <span className="text-xs uppercase tracking-wider">Totals (all filtered rows)</span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums text-base font-bold">{fmtBDT(footer.total_amount)}</td>
          <td className="px-5 py-3 text-xs uppercase tracking-wider" colSpan={3}>
            {fmtInt(footer.count)} payment{footer.count === 1 ? '' : 's'}
          </td>
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
  const header = ['Reference', 'Paid on', 'Amount', 'Supplier', 'Method', 'Purchase', 'Location']
  const lines = rows.map((r) => [
    r.reference_no, r.paid_on, r.amount, r.supplier_name,
    r.method_label, r.purchase_ref, r.location_name,
  ].map(esc).join(','))
  lines.push(['TOTAL', '', footer.total_amount ?? '', '', '', '', ''].map(esc).join(','))
  // UTF-8 BOM so Bangla text + ৳ open correctly in Excel.
  return URL.createObjectURL(
    new Blob(['\ufeff' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  )
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
      <p className="mt-1 text-xl font-bold tabular-nums truncate">{value}</p>
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
