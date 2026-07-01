import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBranchDashboard } from '../../api/reports'
import DateRangeField from '../../components/ui/DateRangeField'

const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` }
const todayIso     = () => new Date().toISOString().slice(0, 10)
const fmtBDT = (n) =>
  '৳ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n) => Number(n || 0).toLocaleString()

/**
 * All-Branches Dashboard — every branch's KPI snapshot at once, side by side
 * (owner sees all branches; a branch manager sees only the branches they
 * manage). Complements the header branch switcher, which scopes the app to a
 * single branch at a time.
 */
export default function BranchDashboardPage() {
  const [dateFrom, setDateFrom] = useState(firstOfMonth())
  const [dateTo,   setDateTo]   = useState(todayIso())
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setData(await getBranchDashboard({ date_from: dateFrom || undefined, date_to: dateTo || undefined }))
    } catch (err) {
      setError(err?.errors?.detail || err?.message || 'Failed to load the branch dashboard.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const branches = data?.branches ?? []
  const totals   = data?.totals ?? {}

  const summary = useMemo(() => ([
    { label: 'Branches',      value: fmtInt(branches.length),    accent: 'text-slate-900' },
    { label: 'Total Sales',   value: fmtBDT(totals.sales),       accent: 'text-emerald-600' },
    { label: 'Total Due',     value: fmtBDT(totals.due),         accent: 'text-amber-600' },
    { label: 'Total Expenses', value: fmtBDT(totals.expenses),   accent: 'text-rose-600' },
    { label: 'Net Profit',    value: fmtBDT(totals.net_profit),  accent: 'text-indigo-600' },
  ]), [branches.length, totals])

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Branch Dashboard</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Every branch at a glance — sales, dues, expenses and profit for the period, side by side.
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

      {/* Consolidated strip */}
      {!error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {summary.map((k) => (
            <div key={k.label} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{k.label}</p>
              <p className={`mt-1 text-lg font-bold ${k.accent}`}>{k.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Per-branch cards */}
      {loading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-10 text-center text-gray-400 shadow-sm">Loading…</div>
      ) : branches.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-10 text-center text-gray-400 shadow-sm">
          No branches to show.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {branches.map((b) => {
            const netNeg = Number(b.net_profit) < 0
            return (
              <div key={b.branch_id} className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-gray-100 pb-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-gray-900">{b.branch}</h3>
                    {b.code && <p className="text-xs text-gray-400">{b.code}</p>}
                  </div>
                  <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                    {fmtInt(b.orders)} orders
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <Metric label="Sales"      value={fmtBDT(b.sales)}     accent="text-emerald-600" />
                  <Metric label="Collected"  value={fmtBDT(b.paid)}      accent="text-gray-800" />
                  <Metric label="Due"        value={fmtBDT(b.due)}       accent="text-amber-600" />
                  <Metric label="Purchases"  value={fmtBDT(b.purchases)} accent="text-gray-800" />
                  <Metric label="Expenses"   value={fmtBDT(b.expenses)}  accent="text-rose-600" />
                  <Metric label="Net Profit" value={fmtBDT(b.net_profit)} accent={netNeg ? 'text-rose-600' : 'text-indigo-700'} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, accent }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-0.5 font-bold tabular-nums ${accent}`}>{value}</p>
    </div>
  )
}
