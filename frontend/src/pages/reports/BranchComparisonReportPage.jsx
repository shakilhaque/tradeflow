import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBranchComparison } from '../../api/reports'
import DateRangeField from '../../components/ui/DateRangeField'

const currentYear = new Date().getFullYear()
const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()

/**
 * Branch Comparison — consolidated owner analytics (Phase 4). Side-by-side
 * sales / purchases / expenses / profit per branch + a TOTAL roll-up.
 * Owner-only on the server; the page shows a friendly notice otherwise.
 */
export default function BranchComparisonReportPage() {
  const [dateFrom, setDateFrom] = useState(`${currentYear}-01-01`)
  const [dateTo,   setDateTo]   = useState(`${currentYear}-12-31`)
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setData(await getBranchComparison({ date_from: dateFrom || undefined, date_to: dateTo || undefined }))
    } catch (err) {
      setError(err?.errors?.detail || err?.message || 'Failed to load branch comparison.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const branches = data?.branches ?? []
  const totals   = data?.totals ?? {}

  const kpis = useMemo(() => ([
    { label: 'Branches',     value: fmtInt(branches.length),     accent: 'text-slate-900' },
    { label: 'Total Sales',  value: fmtBDT(totals.sales),        accent: 'text-emerald-600' },
    { label: 'Total Expenses', value: fmtBDT(totals.expenses),   accent: 'text-rose-600' },
    { label: 'Net Profit',   value: fmtBDT(totals.net_profit),   accent: 'text-indigo-600' },
  ]), [branches.length, totals])

  const COLS = [
    ['branch',       'Branch',        'left'],
    ['orders',       'Orders',        'right'],
    ['sales',        'Sales',         'right'],
    ['paid',         'Paid',          'right'],
    ['due',          'Due',           'right'],
    ['cogs',         'COGS',          'right'],
    ['gross_profit', 'Gross Profit',  'right'],
    ['purchases',    'Purchases',     'right'],
    ['expenses',     'Expenses',      'right'],
    ['net_profit',   'Net Profit',    'right'],
  ]

  const cell = (row, key) => {
    if (key === 'branch') return row.branch
    if (key === 'orders') return fmtInt(row.orders)
    return fmtBDT(row[key])
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Branch Comparison</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Consolidated view across every branch — sales, purchases, expenses and profit side by side.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DateRangeField
            from={dateFrom}
            to={dateTo}
            onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      {/* KPI strip */}
      {!error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{k.label}</p>
              <p className={`mt-1 text-xl font-bold ${k.accent}`}>{k.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Per-branch table */}
      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {COLS.map(([key, label, align]) => (
                  <th key={key} className={`px-4 py-3 ${align === 'right' ? 'text-right' : ''}`}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={COLS.length} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : branches.length === 0 ? (
                <tr><td colSpan={COLS.length} className="px-4 py-10 text-center text-gray-400">No branches found.</td></tr>
              ) : branches.map((row) => (
                <tr key={row.branch_id} className="hover:bg-emerald-50/30">
                  {COLS.map(([key, , align]) => (
                    <td key={key} className={`px-4 py-3 whitespace-nowrap ${align === 'right' ? 'text-right tabular-nums' : 'font-medium text-gray-900'} ${key === 'net_profit' ? (Number(row.net_profit) < 0 ? 'text-rose-600 font-semibold' : 'text-emerald-700 font-semibold') : 'text-gray-700'}`}>
                      {cell(row, key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {branches.length > 0 && !loading && (
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-emerald-50/40 font-semibold text-gray-900">
                  <td className="px-4 py-3">Total · All Branches</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtInt(totals.orders)}</td>
                  {['sales', 'paid', 'due', 'cogs', 'gross_profit', 'purchases', 'expenses', 'net_profit'].map((k) => (
                    <td key={k} className="px-4 py-3 text-right tabular-nums">{fmtBDT(totals[k])}</td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
