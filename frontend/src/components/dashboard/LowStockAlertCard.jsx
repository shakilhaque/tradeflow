import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLowStock } from '../../api/products'

// Show clean quantities: "1" / "5" instead of "1.0000" / "5.0000",
// while still allowing fractional units (e.g. 1.5) when they exist.
const fmtQty = (n) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })

/**
 * LowStockAlertCard — dashboard widget showing every product whose
 * on-hand stock has dropped to or below its reorder_level (the
 * "Alert quantity" set on Add Product). Empty state celebrates the
 * tenant; otherwise lists the worst offenders + a count badge.
 *
 * Data is pulled live from /api/inventory/low-stock/ so the alert
 * always reflects the current FIFO + ProductStock snapshot. Works
 * for every tenant out of the box — only products that the tenant
 * configured with reorder_level > 0 are counted, so noisy alerts
 * from never-tracked products are impossible.
 */
export default function LowStockAlertCard() {
  const [loading, setLoading] = useState(true)
  const [rows,    setRows]    = useState([])
  const [count,   setCount]   = useState(0)

  useEffect(() => {
    let cancelled = false
    getLowStock({ limit: 6 })
      .then((res) => {
        if (cancelled) return
        const arr = Array.isArray(res?.results) ? res.results : []
        setRows(arr)
        setCount(Number(res?.count || arr.length))
      })
      .catch(() => { if (!cancelled) { setRows([]); setCount(0) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="rounded-2xl bg-white shadow-soft border border-gray-100 overflow-hidden h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-rose-50 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.515 2.63H3.72c-1.345 0-2.188-1.463-1.515-2.63L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Low Stock Alert</h3>
            <p className="text-xs text-gray-500">Items at or below their alert quantity</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {count > 0 && (
            <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700">{count}</span>
          )}
          <Link to="/reports/stock" className="whitespace-nowrap text-xs font-semibold text-brand-600 hover:text-brand-700">
            View all →
          </Link>
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="flex justify-center py-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500">
            <span className="block text-2xl">✓</span>
            All products are above their alert quantity.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link to="/products" className="block truncate text-sm font-medium text-gray-900 hover:text-brand-600">
                    {r.name}
                  </Link>
                  <div className="truncate text-[11px] text-gray-500 font-mono">
                    {r.sku || '—'}
                    {r.category ? ` · ${r.category}` : ''}
                  </div>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="text-sm font-semibold text-rose-600 tabular-nums">
                    {fmtQty(r.on_hand)} <span className="text-xs text-gray-400">/ {fmtQty(r.reorder_level)}</span>
                  </div>
                  <div className="text-[11px] text-gray-500">{r.unit || ''}</div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {count > rows.length && (
          <div className="mt-3 border-t border-gray-100 pt-2 text-right">
            <Link to="/reports/stock" className="text-xs font-semibold text-brand-600 hover:text-brand-700">
              View all {count} →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
