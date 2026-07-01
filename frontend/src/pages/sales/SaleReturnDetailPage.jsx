import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Button     from '../../components/ui/Button'
import Card       from '../../components/ui/Card'
import Badge      from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import CreditNoteSlip from '../../components/invoice/CreditNoteSlip'
import { DEMO_RETURNS, REFUND_METHODS, RETURN_REASONS } from '../../data/demoSales'
import { getSellReturn } from '../../api/sales'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtMoney = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STATUS_VARIANT = {
  REFUNDED: 'green', PARTIAL: 'yellow', DUE: 'red', PENDING: 'gray',
}

const reasonLabel = (v) => RETURN_REASONS.find((r) => r.value === v)?.label || v
const methodLabel = (v) => REFUND_METHODS.find((m) => m.value === v)?.label || v

export default function SaleReturnDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [ret, setRet] = useState(undefined)   // undefined = loading
  // Tenant header for the Credit Note slip.
  const [companyProfile, setCompanyProfile] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await getSellReturn(id)
        if (active) setRet(data)
      } catch {
        // Fallback to demo data so UI is still usable when API is offline
        if (active) setRet(DEMO_RETURNS.find((r) => r.id === id) || null)
      }
    })()
    getCompanyProfile()
      .then((p) => { if (active) setCompanyProfile(p || {}) })
      .catch(() => { if (active) setCompanyProfile({}) })
    return () => { active = false }
  }, [id])

  // Auto-fire print when arrived with ?print=1 (from the Sell Returns
  // list → Action ▾ → Print). Waits for the slip to render.
  useEffect(() => {
    if (!ret || ret === undefined) return
    if (searchParams.get('print') === '1') {
      const t = setTimeout(() => window.print(), 200)
      return () => clearTimeout(t)
    }
  }, [ret, searchParams])

  if (ret === undefined) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    )
  }

  if (!ret) {
    return (
      <Card>
        <EmptyState
          title="Sale return not found"
          message="The credit note you're looking for doesn't exist or has been deleted."
          action={<Button onClick={() => navigate('/sales/returns')}>Back to list</Button>}
        />
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-gray-900">Sale Return</h1>
            <Badge variant={STATUS_VARIANT[ret.payment_status] ?? 'gray'} dot>
              {ret.payment_status}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-sm text-gray-500">{ret.invoice_no}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/sales/returns')}>← Back</Button>
          <Button variant="secondary" onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      {/* Meta cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetaCard title="Customer">
          <div className="font-medium text-gray-900">{ret.customer_name || 'Walk-in'}</div>
          <div className="text-xs text-gray-500">Customer</div>
        </MetaCard>

        <MetaCard title="Parent Sale">
          <Link to={`/sales/${ret.parent_sale_id}`} className="font-mono text-sm text-brand-600 hover:underline">
            {ret.parent_invoice_no}
          </Link>
          <div className="text-xs text-gray-500">Original invoice</div>
        </MetaCard>

        <MetaCard title="Return Date">
          <div className="font-medium text-gray-900">{ret.return_date}</div>
          <div className="text-xs text-gray-500">{ret.location_name}</div>
        </MetaCard>
      </div>

      {/* Items */}
      <Card padding="p-0">
        <div className="border-b border-gray-100 px-5 py-3 font-semibold text-gray-900">Returned items</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">Reason</th>
                <th className="px-5 py-3 text-right">Qty</th>
                <th className="px-5 py-3 text-right">Unit Price</th>
                <th className="px-5 py-3 text-right">Line Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {ret.items.map((it, i) => (
                <tr key={i}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-900">{it.product_name}</div>
                    <div className="font-mono text-xs text-gray-400">{it.sku}</div>
                  </td>
                  <td className="px-5 py-3 text-gray-600">{reasonLabel(it.reason)}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{it.qty}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{fmtMoney(it.unit_price)}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-900">{fmtMoney(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Refund summary */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-gray-500">Total Returned</div>
          <div className="mt-1 font-mono text-2xl font-bold text-gray-900">{fmtMoney(ret.total_amount)}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-gray-500">Refunded</div>
          <div className="mt-1 font-mono text-2xl font-bold text-green-700">{fmtMoney(ret.refunded_amount)}</div>
          <div className="mt-1 text-xs text-gray-500">via {methodLabel(ret.refund_method)}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-gray-500">Outstanding</div>
          <div className={['mt-1 font-mono text-2xl font-bold', Number(ret.balance_due) > 0 ? 'text-red-600' : 'text-gray-900'].join(' ')}>
            {fmtMoney(ret.balance_due)}
          </div>
        </Card>
      </div>

      {ret.notes && (
        <Card>
          <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Notes</div>
          <p className="whitespace-pre-wrap text-sm text-gray-700">{ret.notes}</p>
        </Card>
      )}

      {/* Print-only Credit Note slip — hidden on screen, takes over
          when window.print() fires. Tenant-branded header + items
          table + Authorised Signatory / totals footer. */}
      <CreditNoteSlip ret={ret} company={companyProfile} mode="print-only" />
    </div>
  )
}

function MetaCard({ title, children }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-gray-500">{title}</div>
      <div className="mt-1">{children}</div>
    </Card>
  )
}
