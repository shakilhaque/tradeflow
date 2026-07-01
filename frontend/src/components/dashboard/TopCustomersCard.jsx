import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getTopCustomers } from '../../api/dashboard'

const fmtMoney = (n) => `৳${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const fmtInt   = (n) => Number(n ?? 0).toLocaleString()

// Deterministic soft colour for the avatar bubble, derived from the name.
const AVATAR_COLORS = [
  'bg-rose-100 text-rose-600',
  'bg-amber-100 text-amber-600',
  'bg-emerald-100 text-emerald-600',
  'bg-sky-100 text-sky-600',
  'bg-violet-100 text-violet-600',
  'bg-pink-100 text-pink-600',
]
const colorFor = (name) => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const initials = (name) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?'

/**
 * TopCustomersCard — dashboard widget listing the highest-spending
 * customers, pulled live from the customers ledger report (lifetime sales
 * + order count). Sits beside the "Items Sold — Last 14 Days" card.
 */
export default function TopCustomersCard() {
  const [loading, setLoading] = useState(true)
  const [rows,    setRows]    = useState([])

  useEffect(() => {
    let cancelled = false
    getTopCustomers(5)
      .then((res) => { if (!cancelled) setRows(Array.isArray(res) ? res : []) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="rounded-2xl bg-white shadow-soft border border-gray-100 overflow-hidden h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-orange-100 text-orange-600">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>
          </span>
          <h3 className="text-sm font-semibold text-gray-900">Top Customers</h3>
        </div>
        <Link to="/reports/contacts" className="whitespace-nowrap text-xs font-semibold text-brand-600 hover:text-brand-700">
          View all →
        </Link>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="flex justify-center py-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500">
            <span className="block text-2xl">👥</span>
            No customer sales yet.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${colorFor(c.name)}`}>
                    {initials(c.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to="/contacts/customers" className="block truncate text-sm font-medium text-gray-900 hover:text-brand-600">
                      {c.name}
                    </Link>
                    <div className="truncate text-[11px] text-gray-500">
                      {fmtInt(c.orders)} {c.orders === 1 ? 'order' : 'orders'}
                    </div>
                  </div>
                </div>
                <div className="text-right whitespace-nowrap text-sm font-semibold text-gray-900 tabular-nums">
                  {fmtMoney(c.total)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
