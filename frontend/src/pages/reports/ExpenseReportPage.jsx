/**
 * Expense Report — modern, table-first layout.
 *
 * • Filters (Business location · Category · Date range) AUTO-APPLY on
 *   change (debounced) — no Apply click needed.
 * • Real-time: 30-second silent poll + refetch on tab focus.
 * • KPI strip → By Category table (share bars + sticky totals) →
 *   Transactions drill-down with client-side search.
 * • Print = self-contained A4 popup (company header + filter chips +
 *   KPI strip + both tables). CSV = both sections in one file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangeField from '../../components/ui/DateRangeField'
import { getExpenseReport } from '../../api/reports'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()

const monthStart = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString().slice(0, 10)
}
const monthEnd = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).toISOString().slice(0, 10)
}

export default function ExpenseReportPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState('')
  const [category,   setCategory]   = useState('')
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(monthEnd())
  const [search,     setSearch]     = useState('')

  // ── Data ───────────────────────────────────────────────────────────────────
  const [report,  setReport]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const fetchReport = useCallback(async (silent = false) => {
    if (!dateFrom || !dateTo) return
    if (!silent) setLoading(true)
    setError('')
    try {
      const data = await getExpenseReport({
        date_from:   dateFrom,
        date_to:     dateTo,
        category:    category || undefined,
        location_id: locationId || undefined,
      })
      setReport(data)
    } catch (err) {
      setError(err.message || 'Failed to load report')
      if (!silent) setReport(null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateFrom, dateTo, category, locationId])

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
  // an immediate refetch when the operator returns to the tab/window.
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

  const onReset = () => {
    setLocationId(''); setCategory(''); setSearch('')
    setDateFrom(monthStart()); setDateTo(monthEnd())
  }

  const total           = Number(report?.total_expenses || 0)
  const byCategory      = report?.by_category ?? []
  const items           = report?.items ?? []
  const categoryOptions = report?.category_options ?? []
  const locationOptions = report?.location_options ?? []
  // Single-branch (free tier) → default the Business Location filter to the only branch.
  useEffect(() => { if (!locationId && locationOptions.length === 1) setLocationId(String(locationOptions[0].id)) }, [report]) // eslint-disable-line react-hooks/exhaustive-deps
  const avgPerTxn       = items.length ? total / items.length : 0

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    const q = search.trim().toLowerCase()
    return items.filter((i) =>
      (i.description || '').toLowerCase().includes(q) ||
      (i.reference_no || '').toLowerCase().includes(q) ||
      (i.category_label || '').toLowerCase().includes(q) ||
      (i.expense_account || '').toLowerCase().includes(q) ||
      (i.payment_account || '').toLowerCase().includes(q)
    )
  }, [items, search])

  // ── CSV — both sections (category summary + transactions) ────────────────
  const csvHref = useMemo(() => buildCsv(byCategory, items, total), [byCategory, items, total])

  // ── Modern A4 print — self-contained popup with company header,
  // filter chips, KPI strip, By-Category table and Transactions table.
  const handlePrint = async () => {
    const company = await getCompanyProfile().catch(() => ({}))
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const locName = locationId ? (locationOptions.find((l) => l.id === locationId)?.name || '') : 'All Locations'
    const catName = category ? (categoryOptions.find((c) => c.value === category)?.label || category) : 'All Categories'

    const catRows = byCategory.map((c, i) => {
      const pct = total > 0 ? (Number(c.total) / total) * 100 : 0
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(c.label || c.category)}</td>
        <td class="num">${fmtInt(c.count)}</td>
        <td class="num">${pct.toFixed(1)}%</td>
        <td class="num bold">${fmtBDT(c.total)}</td>
      </tr>`
    }).join('') || '<tr><td colspan="5" class="empty">No expenses recorded for these filters.</td></tr>'

    const txnRows = filteredItems.map((i, idx) => `<tr>
      <td>${idx + 1}</td>
      <td class="nowrap">${esc(i.date)}</td>
      <td class="mono">${esc(i.reference_no || '—')}</td>
      <td>${esc(i.category_label || i.category)}</td>
      <td>${esc(i.expense_account || '—')}</td>
      <td>${esc(i.payment_account || '—')}</td>
      <td>${esc(i.description || '—')}</td>
      <td class="num bold">${fmtBDT(i.amount)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No transactions.</td></tr>'

    const w = window.open('', '_blank', 'width=1200,height=900')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Expense Report — ${esc(company?.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:10mm 8mm;font-size:10.5px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:800;color:#10b981;margin:0}
  .meta{font-size:10px;line-height:1.55}
  .sub{color:#6b7280;font-size:9px}
  .filters{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 14px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:10px}
  .filters .k{color:#065f46;font-weight:700;text-transform:uppercase;font-size:8.5px;letter-spacing:.3px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
  .kpi{border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px}
  .kpi .l{font-size:8.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
  .kpi .v{font-size:13px;font-weight:700;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:9.5px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:5px 7px;border:1px solid #0f9971;white-space:nowrap}
  th.num{text-align:right}
  td{padding:4px 7px;border:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-family:ui-monospace,monospace}
  .bold{font-weight:700}
  .nowrap{white-space:nowrap}
  .empty{text-align:center;color:#9ca3af;padding:14px}
  tfoot td{background:#ecfdf5;font-weight:800;border-top:2px solid #065f46}
  h3{font-size:11px;color:#10b981;margin:14px 0 5px;text-transform:uppercase;letter-spacing:.4px}
  .footer{margin-top:10px;display:flex;justify-content:space-between;color:#6b7280;font-size:9px}
  @page{size:A4 portrait;margin:7mm}
</style></head><body>

<div class="hdr">
  <div>
    <h1 class="title">Expense Report</h1>
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
  <div><div class="k">Location</div>${esc(locName)}</div>
  <div><div class="k">Category</div>${esc(catName)}</div>
  ${search ? `<div><div class="k">Search</div>${esc(search)}</div>` : '<div></div>'}
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Total Expense</div><div class="v" style="color:#dc2626">${fmtBDT(total)}</div></div>
  <div class="kpi"><div class="l">Transactions</div><div class="v">${fmtInt(items.length)}</div></div>
  <div class="kpi"><div class="l">Categories</div><div class="v">${fmtInt(byCategory.length)}</div></div>
  <div class="kpi"><div class="l">Avg / Transaction</div><div class="v">${fmtBDT(avgPerTxn)}</div></div>
</div>

<h3>Expense by Category</h3>
<table>
  <thead><tr>
    <th>#</th><th>Expense Category</th>
    <th class="num">Transactions</th><th class="num">Share</th><th class="num">Total Expense</th>
  </tr></thead>
  <tbody>${catRows}</tbody>
  ${byCategory.length ? `<tfoot><tr>
    <td colspan="2">TOTAL</td>
    <td class="num">${fmtInt(items.length)}</td>
    <td class="num">100%</td>
    <td class="num">${fmtBDT(total)}</td>
  </tr></tfoot>` : ''}
</table>

<h3>Transactions</h3>
<table>
  <thead><tr>
    <th>#</th><th>Date</th><th>Reference</th><th>Category</th>
    <th>Account</th><th>Paid From</th><th>Description</th><th class="num">Amount</th>
  </tr></thead>
  <tbody>${txnRows}</tbody>
  ${filteredItems.length ? `<tfoot><tr>
    <td colspan="7">TOTAL (${filteredItems.length} transactions)</td>
    <td class="num">${fmtBDT(filteredItems.reduce((s, i) => s + Number(i.amount || 0), 0))}</td>
  </tr></tfoot>` : ''}
</table>

<div class="footer">
  <div>All figures from the live expense ledger.</div>
  <div>Powered by Iffaa</div>
</div>

<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-emerald-500 px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Expense Report</h1>
            <p className="text-xs text-emerald-50 mt-0.5">
              Total spend by category with a full transactions drill-down.
              Filters apply instantly; data refreshes automatically.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchReport()}
              disabled={loading}
              title="Refresh now (auto-refresh every 30s)"
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25 disabled:opacity-50"
            >
              ⟳ Refresh
            </button>
            <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
              Reports / Expenses
            </span>
          </div>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total expense"     value={fmtBDT(total)} accent="rose" />
        <Kpi label="Transactions"      value={fmtInt(items.length)} accent="green" />
        <Kpi label="Categories"        value={fmtInt(byCategory.length)} accent="teal" />
        <Kpi label="Avg / transaction" value={fmtBDT(avgPerTxn)} accent="lime" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-emerald-700">
            <FilterIcon />
            <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
            <span className="text-[10px] text-gray-400 normal-case font-normal">— apply instantly</span>
          </div>
          <button
            onClick={onReset}
            className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:border-gray-300"
          >
            Reset
          </button>
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
          <FieldSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              { value: '', label: 'All categories' },
              ...categoryOptions.map((c) => ({ value: c.value, label: c.label })),
            ]}
          />
          <DateRangeField from={dateFrom} to={dateTo} onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }} />
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Categories table ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Expense by Category</h2>
            <p className="text-xs text-gray-500 mt-0.5">Totals grouped by expense category, with each category's share of spend.</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={csvHref}
              download={`expense-report-${dateFrom}_${dateTo}.csv`}
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
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : byCategory.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-gray-400">
              No expenses recorded for these filters.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Expense category</th>
                  <th className="px-5 py-3 text-right">Transactions</th>
                  <th className="px-5 py-3 text-right">Share</th>
                  <th className="px-5 py-3 text-right">Total expense</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {byCategory.map((c) => {
                  const pct = total > 0 ? (Number(c.total) / total) * 100 : 0
                  return (
                    <tr key={c.category} className="hover:bg-emerald-50/40 transition-colors">
                      <td className="px-5 py-3 text-gray-900 font-medium">{c.label || c.category}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmtInt(c.count)}</td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-24 rounded-full bg-gray-100 overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 tabular-nums w-12 text-right">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right font-semibold text-gray-900 tabular-nums">{fmtBDT(c.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
                  <td className="px-5 py-3">
                    <span className="text-xs uppercase tracking-wider">Total</span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmtInt(items.length)}</td>
                  <td className="px-5 py-3 text-right">100%</td>
                  <td className="px-5 py-3 text-right text-base font-bold tabular-nums">{fmtBDT(total)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* ── Transactions drill-down ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Transactions</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {items.length === 0
                ? 'No transactions for these filters.'
                : `${fmtInt(filteredItems.length)} of ${fmtInt(items.length)} transactions`}
            </p>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, reference, category, account…"
            className="w-full sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-400">
              {items.length === 0 ? 'No transactions.' : 'No transactions match the search.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Reference</th>
                  <th className="px-5 py-3">Category</th>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-5 py-3">Paid from</th>
                  <th className="px-5 py-3">Description</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredItems.map((i) => (
                  <tr key={i.id} className="hover:bg-emerald-50/40 transition-colors">
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{i.date}</td>
                    <td className="px-5 py-3 font-mono text-xs text-emerald-700">{i.reference_no || '—'}</td>
                    <td className="px-5 py-3 text-gray-800">{i.category_label || i.category}</td>
                    <td className="px-5 py-3 text-gray-700">{i.expense_account}</td>
                    <td className="px-5 py-3 text-gray-700">{i.payment_account}</td>
                    <td className="px-5 py-3 text-gray-600 max-w-xs truncate">{i.description || '—'}</td>
                    <td className="px-5 py-3 text-right font-medium text-gray-900 tabular-nums">{fmtBDT(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
                  <td className="px-5 py-3" colSpan={6}>
                    <span className="text-xs uppercase tracking-wider">
                      Total ({fmtInt(filteredItems.length)} transactions)
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-base font-bold tabular-nums">
                    {fmtBDT(filteredItems.reduce((s, i) => s + Number(i.amount || 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export — both sections in one file so the spreadsheet mirrors
// exactly what the page (and the printed report) shows.
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(byCategory, items, total) {
  if (!byCategory?.length && !items?.length) return '#'
  const escape = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = []
  lines.push('EXPENSE BY CATEGORY')
  lines.push(['Expense Category', 'Transactions', 'Total Expense'].join(','))
  for (const c of byCategory) {
    lines.push([c.label || c.category, c.count, c.total].map(escape).join(','))
  }
  lines.push(['TOTAL', items.length, total].map(escape).join(','))
  lines.push('')
  lines.push('TRANSACTIONS')
  lines.push(['Date', 'Reference', 'Category', 'Account', 'Paid From', 'Description', 'Amount'].join(','))
  for (const i of items) {
    lines.push([
      i.date, i.reference_no, i.category_label || i.category,
      i.expense_account, i.payment_account, i.description, i.amount,
    ].map(escape).join(','))
  }
  return URL.createObjectURL(
    new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
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
    lime:    'from-lime-50 to-lime-100 ring-lime-200 text-lime-700',
    rose:    'from-rose-50 to-rose-100 ring-rose-200 text-rose-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.emerald} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
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
