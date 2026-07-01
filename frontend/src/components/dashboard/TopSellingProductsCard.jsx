import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getTopSellingProducts } from '../../api/dashboard'

// Clean integer-ish quantities: "247" not "247.0000", but keep fractions.
const fmtQty   = (n) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
const fmtMoney = (n) => `৳${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
]

const RANK_COLORS = [
  'bg-amber-100 text-amber-700',
  'bg-gray-100 text-gray-600',
  'bg-orange-100 text-orange-700',
  'bg-brand-50 text-brand-600',
  'bg-violet-50 text-violet-600',
]

/**
 * TopSellingProductsCard — dashboard widget listing the best-selling
 * products for the selected period (Today / Weekly / Monthly). Data comes
 * live from the sales report grouped by product, so it works for every
 * tenant with no setup. Sits beside the Low Stock Alert card.
 */
export default function TopSellingProductsCard() {
  const [period,  setPeriod]  = useState('today')
  const [loading, setLoading] = useState(true)
  const [rows,    setRows]    = useState([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getTopSellingProducts(period, 5)
      .then((res) => { if (!cancelled) setRows(Array.isArray(res) ? res : []) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [period])

  return (
    <div className="rounded-2xl bg-white shadow-soft border border-gray-100 overflow-hidden h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-pink-100 text-pink-600">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7l-9 9-3-3-5 5" /><path d="M14 7h6v6" /></svg>
          </span>
          <h3 className="text-sm font-semibold text-gray-900">Top Selling Products</h3>
        </div>
        {/* Period filter */}
        <div className="flex items-center rounded-lg bg-gray-100 p-0.5 text-[11px] font-semibold">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={[
                'rounded-md px-2.5 py-1 transition-colors',
                period === p.key ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-500 hover:text-gray-700',
              ].join(' ')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="flex justify-center py-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-pink-500 border-t-transparent" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500">
            <span className="block text-2xl">🛒</span>
            No sales in this period yet.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${RANK_COLORS[i] ?? RANK_COLORS[4]}`}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to="/products" className="block truncate text-sm font-medium text-gray-900 hover:text-brand-600">
                      {r.name}
                    </Link>
                    <div className="truncate text-[11px] text-gray-500">
                      {fmtQty(r.qty)} sold
                    </div>
                  </div>
                </div>
                <div className="text-right whitespace-nowrap text-sm font-semibold text-gray-900 tabular-nums">
                  {fmtMoney(r.revenue)}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 border-t border-gray-100 pt-2 text-right">
          <Link to="/reports/products" className="text-xs font-semibold text-brand-600 hover:text-brand-700">
            View product report →
          </Link>
        </div>
      </div>
    </div>
  )
}
