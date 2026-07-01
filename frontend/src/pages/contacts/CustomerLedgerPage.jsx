import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import Card from '../../components/ui/Card'
import { getCustomer, getCustomerCreditSummary, getSales } from '../../api/sales'

/**
 * Customer Ledger — running history of one customer's account.
 *
 * Three sections, computed live from the same endpoints the Customer list
 * and POS already use, so the numbers always match:
 *
 *   1. Snapshot — credit limit, opening balance, advance balance,
 *      current due (sum balance_due over FINAL sales), available credit.
 *   2. Sales — every sale of this customer with amount / paid / due / status.
 *   3. (Future) Payments separately listed — for now, balance_due per
 *      sale already shows the net effect of each payment.
 */
const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

export default function CustomerLedgerPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState(null)
  const [summary,  setSummary]  = useState(null)
  const [sales,    setSales]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  useEffect(() => {
    setLoading(true); setError('')
    Promise.all([
      getCustomer(id),
      getCustomerCreditSummary(id).catch(() => null),
      getSales({ customer_id: id, limit: 200 }).catch(() => []),
    ])
      .then(([c, s, sl]) => {
        setCustomer(c)
        setSummary(s)
        setSales(Array.isArray(sl) ? sl : (sl?.results ?? []))
      })
      .catch((e) => setError(e?.message || 'Failed to load ledger'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return <div className="py-12 text-center text-sm text-gray-400">Loading customer ledger…</div>
  }
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
  }
  if (!customer) return null

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-400">
          <Link to="/contacts/customers" className="hover:text-emerald-600">Customers</Link>
          {' / '}
          <span className="text-gray-600">Ledger</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">{customer.name}</h1>
        <p className="text-sm text-gray-500">
          {customer.phone || '—'} {customer.email && `· ${customer.email}`}
        </p>
      </div>

      {/* Snapshot */}
      {summary && (
        <Card>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <Kpi label="Credit limit"    value={fmt(summary.credit_limit)} />
            <Kpi label="Current due"     value={fmt(summary.current_due)} tone={Number(summary.current_due) > 0 ? 'amber' : 'green'} />
            <Kpi label="Available"       value={fmt(summary.available_credit)} tone="green" />
            <Kpi label="Opening balance" value={fmt(summary.opening_balance)} />
            <Kpi label="Advance"         value={fmt(summary.advance_balance)} />
          </div>
        </Card>
      )}

      {/* Sales list */}
      <Card padding="p-0">
        <div className="border-b border-gray-100 px-5 py-4 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Sales history ({sales.length})</h2>
          <button
            onClick={() => navigate(`/sells?customer_id=${id}`)}
            className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
          >
            Open full Sales view →
          </button>
        </div>
        {sales.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">No sales yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Invoice</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Paid</th>
                  <th className="px-5 py-3 text-right">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sales.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50/60">
                    <td className="px-5 py-3 text-xs text-gray-500">{fmtDate(s.sale_date || s.created_at)}</td>
                    <td className="px-5 py-3 font-mono text-xs">{s.invoice_number || s.id?.slice(0, 8)}</td>
                    <td className="px-5 py-3 text-xs">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">{s.status}</span>
                      {' '}
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">{s.payment_status}</span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{fmt(s.total_amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-gray-700">{fmt(s.amount_paid)}</td>
                    <td className="px-5 py-3 text-right tabular-nums font-semibold text-amber-700">{fmt(s.balance_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Kpi({ label, value, tone }) {
  const toneClass = tone === 'amber'
    ? 'text-amber-700'
    : tone === 'green'
      ? 'text-emerald-700'
      : 'text-gray-900'
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}
