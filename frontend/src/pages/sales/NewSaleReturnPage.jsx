import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Button       from '../../components/ui/Button'
import Card         from '../../components/ui/Card'
import Input        from '../../components/ui/Input'
import Select       from '../../components/ui/Select'
import Badge        from '../../components/ui/Badge'
import EmptyState   from '../../components/ui/EmptyState'
import {
  DEMO_SALES, RETURN_REASONS, REFUND_METHODS,
} from '../../data/demoSales'
import { getSales, getSale, createSellReturn } from '../../api/sales'
import { getPaymentAccounts } from '../../api/accounting'
import useUnsavedChangesPrompt from '../../hooks/useUnsavedChangesPrompt'

const fmtMoney = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function NewSaleReturnPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const preSaleId = params.get('sale_id') || ''

  // Step 1 — pick the parent sale
  const [saleSearch, setSaleSearch] = useState('')
  const [parentSale, setParentSale] = useState(null)

  // Step 2 — items + per-line return qty
  const [lines, setLines] = useState([])      // [{...item, return_qty, reason}]

  // Step 3 — refund details
  const [refundMethod,   setRefundMethod]   = useState('CASH')
  const [refundedAmount, setRefundedAmount] = useState('')
  // Which Payment Account the refund debits. Without this, the cash
  // refund posts against the generic Cash / Bank ledger instead of
  // the specific sub-account (e.g. "City Bank") the cashier wanted.
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [paymentAccounts,  setPaymentAccounts]  = useState([])
  const [restockingFee,  setRestockingFee]  = useState(0)
  const [returnDate,     setReturnDate]     = useState(new Date().toISOString().slice(0, 10))
  const [notes,          setNotes]          = useState('')
  const [submitting,     setSubmitting]     = useState(false)
  const [serverError,    setServerError]    = useState('')

  // Block stray nav while a return is in progress (at least one line
  // with a non-zero return_qty, or a typed note).
  useUnsavedChangesPrompt(
    !submitting && (
      lines.some((l) => Number(l.return_qty || 0) > 0) || Boolean(notes && notes.trim())
    ),
  )

  // Sales loaded from API (for the picker)
  const [salesPool, setSalesPool] = useState(DEMO_SALES)

  // Load the tenant's real Payment Accounts so the cashier can pick
  // which one the refund comes from.
  useEffect(() => {
    let cancelled = false
    getPaymentAccounts({ active: 'true' })
      .then((res) => {
        if (cancelled) return
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        setPaymentAccounts(arr)
      })
      .catch(() => { /* keep list empty — the field stays disabled */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await getSales({ limit: 100 })
        const rows = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : [])
        if (!active || !rows.length) return
        const mapped = rows.map((s) => ({
          id: s.id,
          invoice_no: s.invoice_number || s.invoice_no || `SALE-${String(s.id).slice(0, 8)}`,
          sale_date: (s.sale_date || s.created_at || '').slice(0, 10),
          customer_id: s.customer?.id || s.customer_id || null,
          customer_name: s.customer?.name || s.customer_name || 'Walk-in',
          location_id: s.location?.id || s.location_id || s.location,
          location_name: s.location?.name || s.location_name || '',
          payment_status: s.payment_status,
          total_amount: Number(s.total_amount || 0),
          items: (s.items || []).map((it) => ({
            // The Sale serializer ships `product` as a plain UUID
            // string (the FK), not a nested object. Older code paths
            // expected a nested object — keep both fallbacks so the
            // page works against any response shape.
            product_id: (typeof it.product === 'object' && it.product) ? it.product.id : (it.product || it.product_id),
            product_name: it.product?.name || it.product_name || '',
            sku: it.product?.sku || it.sku || '',
            qty: Number(it.quantity || 0),
            unit_price: Number(it.unit_price || 0),
            line_total: Number(it.total_price || 0),
          })),
        }))
        setSalesPool(mapped)
      } catch {
        // keep DEMO_SALES fallback
      }
    })()
    return () => { active = false }
  }, [])

  // ── Pre-select if ?sale_id= passed in
  useEffect(() => {
    if (!preSaleId) return
    const local = salesPool.find((x) => x.id === preSaleId)
    if (local && local.items?.length) { selectSale(local); return }
    // Try API for full detail
    ;(async () => {
      try {
        const s = await getSale(preSaleId)
        selectSale({
          id: s.id,
          invoice_no: s.invoice_number,
          customer_id: s.customer?.id,
          customer_name: s.customer?.name || 'Walk-in',
          location_id: s.location,
          location_name: s.location_name || '',
          payment_status: s.payment_status,
          total_amount: Number(s.total_amount || 0),
          items: (s.items || []).map((it) => ({
            // The Sale serializer ships `product` as a plain UUID
            // string (the FK), not a nested object. Older code paths
            // expected a nested object — keep both fallbacks so the
            // page works against any response shape.
            product_id: (typeof it.product === 'object' && it.product) ? it.product.id : (it.product || it.product_id),
            product_name: it.product?.name || it.product_name || '',
            sku: it.product?.sku || it.sku || '',
            qty: Number(it.quantity || 0),
            unit_price: Number(it.unit_price || 0),
            line_total: Number(it.total_price || 0),
          })),
        })
      } catch {
        const demo = DEMO_SALES.find((x) => x.id === preSaleId)
        if (demo) selectSale(demo)
      }
    })()
  }, [preSaleId, salesPool])

  const filteredSales = useMemo(() => {
    const q = saleSearch.trim().toLowerCase()
    if (!q) return salesPool
    return salesPool.filter((s) =>
      [s.invoice_no, s.customer_name].some((v) => (v || '').toLowerCase().includes(q))
    )
  }, [saleSearch, salesPool])

  const selectSale = (sale) => {
    setParentSale(sale)
    setLines(
      sale.items.map((it) => ({
        ...it, return_qty: 0, reason: 'DEFECTIVE',
      }))
    )
  }

  const updateLine = (idx, patch) =>
    setLines((curr) => curr.map((l, i) => (i === idx ? { ...l, ...patch } : l)))

  const totalReturn = useMemo(
    () => lines.reduce((s, l) => s + Number(l.unit_price) * Number(l.return_qty || 0), 0),
    [lines],
  )
  const netRefund = Math.max(0, totalReturn - Number(restockingFee || 0))

  // Auto-default refunded = net when total changes
  useEffect(() => { setRefundedAmount(String(netRefund.toFixed(2))) }, [netRefund])

  const canSubmit = parentSale && lines.some((l) => Number(l.return_qty) > 0)

  // Returns a list of human-readable problems. Empty array = OK.
  const validateForm = () => {
    const probs = []
    if (!parentSale) probs.push('Pick a parent sale to return against.')
    if (!parentSale?.location_id) probs.push('Parent sale has no Business Location set.')
    const returningRows = lines.filter((l) => Number(l.return_qty) > 0)
    if (returningRows.length === 0) {
      probs.push('Enter a Return Qty greater than 0 for at least one item.')
    }
    returningRows.forEach((l) => {
      if (!l.product_id) {
        probs.push(`"${l.product_name || 'A row'}" is missing a product link. Pick a different sale or refresh and try again.`)
      }
      if (Number(l.return_qty) > Number(l.qty)) {
        probs.push(`"${l.product_name}": Return Qty (${l.return_qty}) cannot exceed Sold Qty (${l.qty}).`)
      }
      if (Number(l.unit_price) < 0) {
        probs.push(`"${l.product_name}": Unit Price cannot be negative.`)
      }
    })
    if (!returnDate) probs.push('Return Date is required.')
    if (!refundMethod) probs.push('Refund Method is required.')
    if (Number(refundedAmount) < 0) probs.push('Refunded Amount cannot be negative.')
    if (Number(restockingFee) < 0) probs.push('Restocking Fee cannot be negative.')
    if (Number(refundedAmount) > netRefund) {
      probs.push(`Refunded Amount cannot exceed Net Refund Owed (৳ ${netRefund.toFixed(2)}).`)
    }
    return probs
  }

  const handleSubmit = async () => {
    setServerError('')

    // 1) Client-side validation — surface every blocker in a popup
    //    so the cashier knows exactly which field is wrong before
    //    we even hit the server.
    const problems = validateForm()
    if (problems.length > 0) {
      window.alert(
        problems.length === 1
          ? problems[0]
          : `Please fix the following before saving:\n\n• ${problems.join('\n• ')}`,
      )
      setServerError(problems[0])
      return
    }

    setSubmitting(true)
    // Default refunded_amount to the net refund owed when the cashier
    // left it blank or zero — the original cash should normally come
    // straight back unless the user explicitly chose a different
    // settlement (e.g. store credit, on-account, etc.).
    const cashRefundMethods = ['CASH', 'Cash refund', 'CARD', 'BANK', 'BANK_TRANSFER', 'BKASH', 'NAGAD', 'MOBILE', 'CHEQUE']
    let refundedToSend = Number(refundedAmount || 0)
    if (refundedToSend <= 0 && cashRefundMethods.includes(refundMethod)) {
      refundedToSend = Number(netRefund.toFixed(2))
    }

    const payload = {
      parent_sale_id: parentSale.id,
      location_id: parentSale.location_id,
      items: lines
        .filter((l) => Number(l.return_qty) > 0)
        .map((l) => ({
          product_id: l.product_id,
          quantity:   Number(l.return_qty),
          unit_price: Number(l.unit_price),
          reason:     l.reason || '',
        })),
      return_date:        returnDate,
      refund_method:      refundMethod,
      refunded_amount:    refundedToSend,
      // FK of the cashier's Payment Account choice. The backend uses
      // this to debit the specific sub-ledger (e.g. "City Bank")
      // instead of the generic 1001 Cash / 1002 Bank.
      payment_account_id: paymentAccountId || null,
      restocking_fee:     Number(restockingFee || 0),
      notes,
    }
    try {
      const created = await createSellReturn(payload)
      const total = Number(created.total_amount || refundedToSend || 0)
      window.alert(
        `Sale return saved successfully.\n\n` +
        `Credit Note: ${created.invoice_number || created.id}\n` +
        `Total Return: ৳ ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
        `Refunded: ৳ ${Number(refundedToSend).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
        `Inventory has been restocked and the refund has been posted to the chosen account.`,
      )
      navigate(`/sales/returns/${created.id}`)
    } catch (err) {
      // 2) Server-side errors — DRF returns either {detail: "..."} or
      //    a per-field error map (sometimes nested for list/dict
      //    serializers like our `items`). Walk the structure
      //    recursively so we surface a real field message instead of
      //    "[object Object]" in the popup.
      const fe = err?.errors || err?.payload || {}
      const flatten = (obj, path = '') => {
        const out = []
        if (obj == null) return out
        if (typeof obj === 'string') { out.push(`${path || 'error'}: ${obj}`); return out }
        if (Array.isArray(obj)) {
          obj.forEach((v, i) => {
            const next = path ? `${path}[${i}]` : `[${i}]`
            out.push(...flatten(v, next))
          })
          return out
        }
        if (typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (k === 'detail' || k === 'status' || k === 'data' ||
                k === 'message' || k === 'errors') continue
            const next = path ? `${path}.${k}` : k
            out.push(...flatten(v, next))
          }
          return out
        }
        out.push(`${path || 'error'}: ${String(obj)}`)
        return out
      }
      const flat = flatten(fe)
      const detail = fe?.detail || err?.message || 'Failed to create sell return.'
      const popup = flat.length > 0
        ? `${detail}\n\n• ${flat.join('\n• ')}`
        : detail
      window.alert(popup)
      setServerError(detail)
      setSubmitting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">New Sale Return</h1>
          <p className="mt-0.5 text-sm text-gray-500">Issue a credit note against a finalized sale</p>
        </div>
        <Button variant="secondary" onClick={() => navigate('/sales/returns')}>
          ← Back to list
        </Button>
      </div>

      {/* Step 1 — Pick parent sale */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <StepBadge n={1} active={!parentSale} done={!!parentSale} />
          Choose a sale to return against
        </h2>

        {parentSale ? (
          <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 p-3">
            <div>
              <div className="font-mono text-xs text-gray-500">{parentSale.invoice_no}</div>
              <div className="font-medium text-gray-900">{parentSale.customer_name}</div>
              <div className="text-xs text-gray-500">
                {parentSale.location_name} • {parentSale.sale_date} • {fmtMoney(parentSale.total_amount)}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => { setParentSale(null); setLines([]) }}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <Input
              placeholder="Search by invoice # or customer name..."
              value={saleSearch}
              onChange={(e) => setSaleSearch(e.target.value)}
            />
            <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-gray-100 divide-y divide-gray-50">
              {filteredSales.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-gray-400">No sales match</div>
              )}
              {filteredSales.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => selectSale(s)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                >
                  <div>
                    <div className="font-mono text-xs text-gray-500">{s.invoice_no}</div>
                    <div className="font-medium text-gray-900">{s.customer_name}</div>
                    <div className="text-xs text-gray-500">{s.location_name} • {s.sale_date}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-gray-900">{fmtMoney(s.total_amount)}</div>
                    <Badge variant={s.payment_status === 'PAID' ? 'green' : 'yellow'}>{s.payment_status}</Badge>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Step 2 — Pick items & quantities */}
      {parentSale && (
        <Card padding="p-0">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <StepBadge n={2} active done={lines.some((l) => Number(l.return_qty) > 0)} />
              Items being returned
            </h2>
            <span className="text-xs text-gray-500">{lines.length} line{lines.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-5 py-3">Product</th>
                  <th className="px-5 py-3 text-right">Sold Qty</th>
                  <th className="px-5 py-3 text-right">Unit Price</th>
                  <th className="px-5 py-3 text-right">Return Qty</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3 text-right">Line Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lines.map((l, i) => (
                  <tr key={l.product_id} className="hover:bg-gray-50/40">
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-900">{l.product_name}</div>
                      <div className="font-mono text-xs text-gray-400">{l.sku}</div>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">{l.qty}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{fmtMoney(l.unit_price)}</td>
                    <td className="px-5 py-3 text-right">
                      <input
                        type="number" min={0} max={l.qty} step="1"
                        value={l.return_qty}
                        onChange={(e) => updateLine(i, { return_qty: Math.min(l.qty, Math.max(0, Number(e.target.value))) })}
                        className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm"
                      />
                    </td>
                    <td className="px-5 py-3">
                      <select
                        value={l.reason}
                        onChange={(e) => updateLine(i, { reason: e.target.value })}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                      >
                        {RETURN_REASONS.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">
                      {fmtMoney(Number(l.unit_price) * Number(l.return_qty || 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                  <td colSpan={5} className="px-5 py-3 text-right text-gray-700">Total Return</td>
                  <td className="px-5 py-3 text-right text-gray-900">{fmtMoney(totalReturn)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {/* Step 3 — Refund details */}
      {parentSale && (
        <Card>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <StepBadge n={3} active={canSubmit} done={false} />
            Refund details
          </h2>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Input
              label="Return date" type="date"
              value={returnDate} onChange={(e) => setReturnDate(e.target.value)}
            />
            <Select
              label="Refund method"
              value={refundMethod}
              onChange={(e) => setRefundMethod(e.target.value)}
            >
              {REFUND_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
            <Input
              label="Restocking fee" type="number" min="0" step="0.01"
              value={restockingFee}
              onChange={(e) => setRestockingFee(e.target.value)}
            />
            <Input
              label="Refunded amount" type="number" min="0" step="0.01"
              value={refundedAmount}
              onChange={(e) => setRefundedAmount(e.target.value)}
            />
            <Select
              label="Payment Account (refund from)"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">— Default (Cash / Bank) —</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.account_type ? ` (${a.account_type})` : ''}
                </option>
              ))}
            </Select>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes about the return..."
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Summary block */}
          <div className="mt-5 grid grid-cols-2 gap-3 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-4">
            <Stat label="Total Return"     value={fmtMoney(totalReturn)} />
            <Stat label="Restocking Fee"   value={`- ${fmtMoney(restockingFee)}`} negative />
            <Stat label="Net Refund Owed"  value={fmtMoney(netRefund)} />
            <Stat label="Refunded Now"     value={fmtMoney(refundedAmount)} positive />
          </div>
        </Card>
      )}

      {/* Footer actions */}
      {parentSale ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {serverError && (
            <div className="text-sm text-red-600 sm:mr-auto">{serverError}</div>
          )}
          <Button variant="secondary" onClick={() => navigate('/sales/returns')}>Cancel</Button>
          <Button disabled={!canSubmit || submitting} loading={submitting} onClick={handleSubmit}>
            Save Sale Return
          </Button>
        </div>
      ) : (
        !filteredSales.length && (
          <EmptyState
            title="No sales available"
            message="There are no finalized sales to return against."
          />
        )
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StepBadge({ n, active, done }) {
  return (
    <span
      className={[
        'inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold',
        done   ? 'bg-green-600  text-white' :
        active ? 'bg-brand-600  text-white' :
                 'bg-gray-200   text-gray-600',
      ].join(' ')}
    >
      {n}
    </span>
  )
}

function Stat({ label, value, positive, negative }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={[
        'mt-0.5 font-mono text-base font-semibold',
        positive ? 'text-green-700' : negative ? 'text-red-600' : 'text-gray-900',
      ].join(' ')}>
        {value}
      </div>
    </div>
  )
}
