import { useCallback, useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Button from '../../components/ui/Button'
import DateRangeField from '../../components/ui/DateRangeField'
import { getBalanceSummary } from '../../api/accounting'
import { getLocations } from '../../api/inventory'

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const todayIso = () => new Date().toISOString().slice(0, 10)

export default function BalanceSheetPage() {
  const [locations, setLocations] = useState([])
  const [locationId, setLocationId] = useState('')
  // Balance sheet is "as of" a single date — we drive it from the shared
  // range picker and use the range's END date as the as-of date.
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
      setError(err?.message || 'Failed to load balance summary.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [locationId, asOf])

  useEffect(() => { load() }, [load])

  const assets       = data?.assets || {}
  const liabilities  = data?.liabilities || {}
  const accounts     = assets.accounts || []
  const totalAssets       = Number(data?.total_assets || 0)
  const totalLiabilities  = Number(data?.total_liabilities || 0)
  const netWorth          = totalAssets - totalLiabilities

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Balance Sheet</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Merchant-view snapshot of what you own vs. what you owe.
        </p>
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

      {/* Hero stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Total Assets"
          value={fmtMoney(totalAssets)}
          accent="emerald"
          hint="Cash, receivables, stock"
        />
        <StatCard
          label="Total Liabilities"
          value={fmtMoney(totalLiabilities)}
          accent="rose"
          hint="Suppliers owed"
        />
        <StatCard
          label="Net Worth"
          value={fmtMoney(netWorth)}
          accent={netWorth >= 0 ? 'brand' : 'amber'}
          hint="Assets − Liabilities"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      {loading ? (
        <Card>
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ── Liabilities ── */}
          <Card padding="p-0" className="overflow-hidden">
            <div className="bg-rose-50 px-5 py-3 border-b border-rose-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-rose-700">Liabilities</h3>
              <span className="text-xs font-semibold text-rose-700 tabular-nums">{fmtMoney(totalLiabilities)}</span>
            </div>
            <div className="divide-y divide-gray-50">
              <Row label="Supplier Due" value={fmtMoney(liabilities.supplier_due)} muted={!Number(liabilities.supplier_due)} />
            </div>
            <div className="bg-gray-50 px-5 py-3 border-t border-gray-200 flex items-center justify-between">
              <span className="text-sm font-bold text-navy-800">Total Liabilities</span>
              <span className="text-base font-extrabold text-rose-600 tabular-nums">{fmtMoney(totalLiabilities)}</span>
            </div>
          </Card>

          {/* ── Assets ── */}
          <Card padding="p-0" className="overflow-hidden">
            <div className="bg-emerald-50 px-5 py-3 border-b border-emerald-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-emerald-700">Assets</h3>
              <span className="text-xs font-semibold text-emerald-700 tabular-nums">{fmtMoney(totalAssets)}</span>
            </div>
            <div className="divide-y divide-gray-50">
              <Row label="Customer Due"  value={fmtMoney(assets.customer_due)}  muted={!Number(assets.customer_due)} />
              <Row label="Closing stock" value={fmtMoney(assets.closing_stock)} muted={!Number(assets.closing_stock)} />

              {/* Account Balances section */}
              <div className="px-5 py-3">
                <p className="text-sm font-semibold text-navy-800 mb-2">Account Balances</p>
                {accounts.length === 0 ? (
                  <p className="text-xs text-gray-400 pl-2">No payment accounts configured.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {accounts.map((a) => (
                      <li key={a.id} className="flex items-center justify-between pl-2 text-sm">
                        <span className="text-gray-700">{a.name}</span>
                        <span className={`tabular-nums ${Number(a.balance) ? 'font-semibold text-navy-800' : 'text-gray-400'}`}>
                          {fmtMoney(a.balance)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {accounts.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between pl-2 text-xs">
                    <span className="text-gray-500 uppercase tracking-wider">Accounts subtotal</span>
                    <span className="font-semibold text-navy-800 tabular-nums">{fmtMoney(assets.accounts_total)}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="bg-gray-50 px-5 py-3 border-t border-gray-200 flex items-center justify-between">
              <span className="text-sm font-bold text-navy-800">Total Assets</span>
              <span className="text-base font-extrabold text-emerald-700 tabular-nums">{fmtMoney(totalAssets)}</span>
            </div>
          </Card>
        </div>
      )}

      <p className="text-center text-xs text-gray-400">
        Balance sheet computed from sales, purchases, inventory cost-price and payment-account balances.
        Reload after recording new transactions to see updates.
      </p>
    </div>
  )
}

function Row({ label, value, muted }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 text-sm">
      <span className={muted ? 'text-gray-500' : 'text-navy-800 font-medium'}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-gray-400' : 'font-semibold text-navy-800'}`}>{value}</span>
    </div>
  )
}

const ACCENTS = {
  emerald: { bg: 'from-emerald-500 to-teal-500',   ring: 'ring-emerald-100' },
  rose:    { bg: 'from-rose-500    to-pink-500',   ring: 'ring-rose-100' },
  brand:   { bg: 'from-brand-600   to-indigo-600', ring: 'ring-brand-100' },
  amber:   { bg: 'from-amber-500   to-orange-500', ring: 'ring-amber-100' },
}

function StatCard({ label, value, hint, accent = 'brand' }) {
  const a = ACCENTS[accent] ?? ACCENTS.brand
  return (
    <div className={`rounded-xl border border-gray-200 bg-white shadow-soft p-5 ring-1 ${a.ring}`}>
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-3xl font-extrabold tracking-tight bg-gradient-to-r ${a.bg} bg-clip-text text-transparent tabular-nums`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}
