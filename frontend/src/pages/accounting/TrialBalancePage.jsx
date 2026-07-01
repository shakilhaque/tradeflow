import { useCallback, useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Button from '../../components/ui/Button'
import DateRangeField from '../../components/ui/DateRangeField'
import { getBalanceSummary } from '../../api/accounting'
import { getLocations } from '../../api/inventory'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtMoney = (n) =>
  Number(n || 0) === 0
    ? '৳ 0.00'
    : `৳ ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const todayIso = () => new Date().toISOString().slice(0, 10)

export default function TrialBalancePage() {
  const [locations, setLocations] = useState([])
  const [locationId, setLocationId] = useState('')
  // "As of" report driven by the shared range picker — the range's END date
  // is the as-of date.
  const [periodFrom, setPeriodFrom] = useState(`${new Date().getFullYear()}-01-01`)
  const [asOf,       setAsOf]      = useState(todayIso())

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    getLocations({ active_only: 'true' })
      .then((r) => { const _l = Array.isArray(r) ? r : (r?.results ?? []); setLocations(_l); if (_l.length === 1) setLocationId((v) => v || String(_l[0].id)) })
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = { as_of_date: asOf }
      if (locationId) params.location_id = locationId
      const res = await getBalanceSummary(params)
      setData(res)
    } catch (err) {
      setError(err?.message || 'Failed to load trial balance.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [locationId, asOf])

  useEffect(() => { load() }, [load])

  // Build the row list — kept declarative so the JSX is small.
  const rows = useMemo(() => {
    if (!data) return []
    const assets   = data.assets || {}
    const liab     = data.liabilities || {}
    const accounts = assets.accounts || []

    const list = []
    list.push({ kind: 'liability', label: 'Supplier Due',  amount: Number(liab.supplier_due  || 0) })
    list.push({ kind: 'asset',     label: 'Customer Due',  amount: Number(assets.customer_due || 0) })
    if (Number(assets.closing_stock || 0)) {
      list.push({ kind: 'asset',   label: 'Closing Stock', amount: Number(assets.closing_stock) })
    }
    list.push({ kind: 'group', label: 'Account Balances' })
    for (const a of accounts) {
      list.push({
        kind:  'asset',
        label: a.name,
        amount: Number(a.balance || 0),
        indented: true,
      })
    }
    return list
  }, [data])

  const totalDebit  = useMemo(
    () => rows.filter((r) => r.kind === 'asset').reduce((s, r) => s + r.amount, 0),
    [rows],
  )
  const totalCredit = useMemo(
    () => rows.filter((r) => r.kind === 'liability').reduce((s, r) => s + r.amount, 0),
    [rows],
  )
  const balanced = totalDebit.toFixed(2) === totalCredit.toFixed(2)
  const diff     = Math.abs(totalDebit - totalCredit)

  // ── Print handler ───────────────────────────────────────────────────────
  // Same pattern as the other report pages (Customers, Suppliers,
  // Customer Groups): opens a popup with self-contained printable
  // HTML so the live DOM (and action menus etc.) can't leak into
  // the print output.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const money = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'

    const rowsHtml = rows.length === 0
      ? '<tr><td colspan="4" class="empty">No trial-balance lines.</td></tr>'
      : rows.map((r, i) => {
          if (r.kind === 'group') {
            return `<tr class="group"><td colspan="4">${esc(r.label)}</td></tr>`
          }
          const isDebit = r.kind === 'asset'
          return `<tr>
            <td>${i + 1}</td>
            <td class="${r.indented ? 'indent' : ''}">${esc(r.label)}</td>
            <td class="num">${isDebit ? `<b>${money(r.amount)}</b>` : ''}</td>
            <td class="num">${!isDebit ? `<b>${money(r.amount)}</b>` : ''}</td>
          </tr>`
        }).join('')

    const w = window.open('', '_blank', 'width=1100,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Trial Balance — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:14mm 10mm;font-size:12px}
  .row{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:14px}
  .title{font-size:22px;font-weight:700;color:#10b981;letter-spacing:.5px;margin:0}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:11px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:7px 8px;border:1px solid #0f9971}
  th.num{text-align:right}
  td{padding:6px 8px;border:1px solid #e5e7eb;vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .indent{padding-left:22px}
  .group td{background:#f3f4f6;font-weight:700;color:#10b981;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  tfoot td{background:#f9fafb;font-weight:700;border-top:2px solid #111827}
  .empty{text-align:center;color:#9ca3af;padding:24px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:10px;color:#6b7280}
  .balanced{display:inline-block;background:#10b981;color:#fff;border-radius:3px;padding:2px 8px;font-size:10px;margin-left:6px}
  .unbalanced{background:#ef4444}
  @page{size:A4 portrait;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">Trial Balance</h1>
    <div class="block" style="margin-top:6px">
      <b>${esc(company?.business_name || '')}</b><br>
      ${esc(company?.address || '')}<br>
      ${company?.phone ? 'Phone: ' + esc(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">As of</div>
    <div><b>${esc(fmtDate(data?.as_of_date || asOf))}</b></div>
    <div class="sub" style="margin-top:6px">Generated: ${esc(new Date().toLocaleString())}</div>
    <div style="margin-top:4px">
      ${balanced
          ? '<span class="balanced">BALANCED</span>'
          : `<span class="balanced unbalanced">UNBALANCED · Δ ${money(diff)}</span>`
      }
    </div>
  </div>
</div>

<table>
  <thead><tr>
    <th style="width:32px">#</th>
    <th>Account / Item</th>
    <th class="num">Debit</th>
    <th class="num">Credit</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="2" style="text-align:right">Totals:</td>
    <td class="num">${money(totalDebit)}</td>
    <td class="num">${money(totalCredit)}</td>
  </tr></tfoot>
</table>

<div class="footer">
  <div>Σ Debit: <b>${money(totalDebit)}</b> · Σ Credit: <b>${money(totalCredit)}</b></div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Trial Balance</h1>
          <p className="mt-0.5 text-sm text-emerald-50">
            Debit and credit totals across receivables, payables and payment accounts.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={handlePrint} leftIcon={<IconPrint />}>
          Print
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-brand-700">Filters</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Business Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <DateRangeField
            label="Date range (as of period end)"
            from={periodFrom}
            to={asOf}
            onChange={(r) => { setPeriodFrom(r.from); setAsOf(r.to) }}
          />
        </div>
      </Card>

      {/* Balance indicator */}
      {!loading && !error && data && (
        <div className={[
          'rounded-xl border px-5 py-3 flex items-center justify-between',
          balanced
            ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
            : 'border-amber-100 bg-amber-50 text-amber-800',
        ].join(' ')}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${balanced ? 'bg-emerald-500' : 'bg-amber-500'} text-white`}>
              {balanced ? '✓' : '!'}
            </span>
            {balanced ? 'Trial balance is in balance.' : `Trial balance is OFF by ${fmtMoney(diff)}.`}
          </div>
          <div className="text-xs">
            <span className="mr-3">Debit: <strong className="tabular-nums">{fmtMoney(totalDebit)}</strong></span>
            <span>Credit: <strong className="tabular-nums">{fmtMoney(totalCredit)}</strong></span>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <Card padding="p-0">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (
          <div id="trial-balance-print" className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-5 py-3">Trial Balance</th>
                  <th className="px-5 py-3 text-right">Debit</th>
                  <th className="px-5 py-3 text-right">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-5 py-10 text-center text-sm text-gray-400">
                      No data to display.
                    </td>
                  </tr>
                ) : rows.map((r, i) => {
                  if (r.kind === 'group') {
                    return (
                      <tr key={`g-${i}`} className="bg-gray-50/40">
                        <td className="px-5 py-2 text-sm font-semibold text-navy-800">{r.label}</td>
                        <td /><td />
                      </tr>
                    )
                  }
                  const zero = !r.amount
                  return (
                    <tr key={`${r.kind}-${i}`} className="hover:bg-gray-50/40 transition-colors">
                      <td className={`px-5 py-2.5 ${r.indented ? 'pl-9' : ''}`}>
                        <span className={zero ? 'text-gray-500' : 'text-navy-800'}>{r.label}:</span>
                      </td>
                      <td className="px-5 py-2.5 text-right whitespace-nowrap tabular-nums">
                        {r.kind === 'asset'     ? <span className={zero ? 'text-gray-400' : 'text-navy-800 font-medium'}>{fmtMoney(r.amount)}</span> : ''}
                      </td>
                      <td className="px-5 py-2.5 text-right whitespace-nowrap tabular-nums">
                        {r.kind === 'liability' ? <span className={zero ? 'text-gray-400' : 'text-navy-800 font-medium'}>{fmtMoney(r.amount)}</span> : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gradient-to-r from-gray-50 to-gray-100 border-t-2 border-gray-200">
                  <td className="px-5 py-3 text-sm font-extrabold text-navy-800">Total</td>
                  <td className="px-5 py-3 text-right text-base font-extrabold text-emerald-700 tabular-nums whitespace-nowrap">
                    {fmtMoney(totalDebit)}
                  </td>
                  <td className="px-5 py-3 text-right text-base font-extrabold text-rose-600 tabular-nums whitespace-nowrap">
                    {fmtMoney(totalCredit)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button onClick={handlePrint} leftIcon={<IconPrint />}>Print</Button>
      </div>

      <p className="text-center text-xs text-gray-400">
        In a healthy book, total Debit = total Credit. A mismatch is normal here because
        Net Worth (equity) is not posted as an explicit credit line on this page.
      </p>
    </div>
  )
}

function IconPrint() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2M7 14h10v7H7z" />
    </svg>
  )
}
