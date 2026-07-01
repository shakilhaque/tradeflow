import { useEffect, useState } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useForm }  from 'react-hook-form'
import Card         from '../../components/ui/Card'
import Button       from '../../components/ui/Button'
import Badge        from '../../components/ui/Badge'
import Input        from '../../components/ui/Input'
import Select       from '../../components/ui/Select'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import Logo         from '../../components/Logo'
import InvoiceSlip  from '../../components/invoice/InvoiceSlip'
import { useAuth }  from '../../context/AuthContext'
import { getSale, addPayment, finalizeSale, voidSale, updateSale, updateSaleHeader, getCustomers, getCustomerCreditSummary } from '../../api/sales'
import { getCompanyProfile } from '../../api/companyProfile'

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  n == null ? '—' : `৳ ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
}) : '—')

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—')

const SALE_STATUS_VARIANT = {
  QUOTATION: 'indigo', PROFORMA: 'blue', DRAFT: 'yellow', FINAL: 'green', PENDING: 'blue', VOIDED: 'red',
}
const PAY_STATUS_VARIANT = { DUE: 'red', PARTIAL: 'yellow', PAID: 'green' }
const PAY_METHOD_LABEL   = {
  CASH: 'Cash', CARD: 'Card', BANK_TRANSFER: 'Bank Transfer',
  BKASH: 'bKash', NAGAD: 'Nagad', CHEQUE: 'Cheque', CREDIT: 'Credit',
}

// ── Add Payment modal ─────────────────────────────────────────────────────────

function AddPaymentModal({ open, onClose, saleId, balanceDue, onAdded }) {
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')
  const amount = watch('amount')
  const change = Math.max(0, (Number(amount) || 0) - (balanceDue || 0))

  const onSubmit = async (data) => {
    setServerError('')
    try {
      await addPayment(saleId, {
        amount:    Number(data.amount),
        method:    data.method,
        reference: data.reference?.trim() || undefined,
      })
      reset()
      onAdded?.()
      onClose()
    } catch (err) {
      setServerError(err?.message || 'Failed to record payment')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record payment">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Amount" type="number" step="0.01" required
          error={errors.amount?.message}
          {...register('amount', {
            required: 'Amount is required',
            min: { value: 0.01, message: 'Must be greater than 0' },
          })}
        />
        <Select label="Method" required error={errors.method?.message} {...register('method', { required: true })}>
          <option value="">Select…</option>
          <option value="CASH">Cash</option>
          <option value="CARD">Card</option>
          <option value="BANK_TRANSFER">Bank Transfer</option>
          <option value="BKASH">bKash</option>
          <option value="NAGAD">Nagad</option>
          <option value="CHEQUE">Cheque</option>
        </Select>
        <Input label="Reference (optional)" {...register('reference')} />

        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Balance due</span><span className="font-semibold">{fmtMoney(balanceDue)}</span></div>
          {change > 0 && <div className="flex justify-between text-emerald-700"><span>Change</span><span className="font-semibold">{fmtMoney(change)}</span></div>}
        </div>

        {serverError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{serverError}</div>}

        <ModalFooter>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" loading={isSubmitting}>Record payment</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

// ── Void modal ────────────────────────────────────────────────────────────────

function VoidModal({ open, onClose, saleId, onVoided }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')

  const onSubmit = async (data) => {
    setServerError('')
    try {
      await voidSale(saleId, { reason: data.reason })
      reset()
      onVoided?.()
      onClose()
    } catch (err) {
      setServerError(err?.message || 'Failed to void sale')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Void this sale?">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-gray-600">
          Voiding a finalized sale reverses the journal entry and any stock movements.
          This cannot be undone.
        </p>
        <Input
          label="Reason"
          required
          error={errors.reason?.message}
          {...register('reason', { required: 'A reason is required.' })}
        />
        {serverError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{serverError}</div>}
        <ModalFooter>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button variant="danger" type="submit" loading={isSubmitting}>Confirm void</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SaleDetailPage() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const [searchParams] = useSearchParams()
  const { user }  = useAuth()

  const isAdmin   = ['owner', 'admin'].includes(user?.role)
  const canPay    = user?.permissions?.includes('sales.payment') || isAdmin || user?.role === 'manager'

  const [sale,       setSale]      = useState(null)
  const [loading,    setLoading]   = useState(true)
  const [payOpen,    setPayOpen]   = useState(false)
  const [editOpen,   setEditOpen]  = useState(false)
  const [voidOpen,   setVoidOpen]  = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [error,      setError]     = useState('')
  // Tenant's company profile — drives the invoice header (logo +
  // company name + branch). Falls back to the user record while the
  // tenant hasn't filled in Settings → Company Profile yet.
  const [companyProfile, setCompanyProfile] = useState(null)
  // Customer's overall outstanding (every other unpaid sale) — printed
  // under the invoice totals so the cashier hands a slip that shows
  // BOTH this invoice's due and what they owe across all invoices.
  const [customerTotalDue, setCustomerTotalDue] = useState(0)

  useEffect(() => {
    let cancelled = false
    getCompanyProfile()
      .then((p) => { if (!cancelled) setCompanyProfile(p || {}) })
      .catch(() => { if (!cancelled) setCompanyProfile({}) })
    return () => { cancelled = true }
  }, [])

  // Refresh the customer total due any time the loaded sale's
  // customer changes (after the sale itself has loaded).
  useEffect(() => {
    let cancelled = false
    const cid = sale?.customer?.id || sale?.customer_id
    if (!cid) { setCustomerTotalDue(0); return }
    getCustomerCreditSummary(cid)
      .then((cs) => {
        if (cancelled) return
        // current_due includes THIS sale's balance_due — strip it so
        // the printed slip shows the customer's OTHER outstanding.
        const total = Number(cs?.current_due || 0)
        const thisDue = Number(sale?.balance_due || 0)
        setCustomerTotalDue(Math.max(0, total - thisDue))
      })
      .catch(() => { if (!cancelled) setCustomerTotalDue(0) })
    return () => { cancelled = true }
  }, [sale?.customer?.id, sale?.customer_id, sale?.balance_due])

  const loadSale = async () => {
    setLoading(true)
    try {
      setSale(await getSale(id))
    } catch (e) {
      setError(e?.message || 'Failed to load sale')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSale() /* eslint-disable-next-line */ }, [id])

  // Auto-open the Edit modal when arriving with ?edit=1 (e.g. from the
  // All Sales / List Quotation action menu) once the sale has loaded.
  useEffect(() => {
    if (!loading && sale && searchParams.get('edit') === '1') {
      setEditOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, sale])

  const handleFinalize = async () => {
    setFinalizing(true)
    try {
      await finalizeSale(id)
      loadSale()
    } catch (err) {
      setError(err.message || 'Failed to finalize')
    } finally {
      setFinalizing(false)
    }
  }

  if (loading) return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
    </div>
  )

  if (error || !sale) return (
    <div className="rounded-xl bg-rose-50 border border-rose-200 px-6 py-8 text-center text-rose-700">
      {error || 'Sale not found'}
      <div className="mt-4">
        <Button variant="secondary" onClick={() => navigate('/sells')}>← Back to Sales</Button>
      </div>
    </div>
  )

  const isFinal    = sale.status === 'FINAL'
  const isDraft    = sale.status === 'DRAFT'
  const isVoided   = sale.status === 'VOIDED'
  const hasBalance = Number(sale.balance_due) > 0

  const invoiceNo  = sale.invoice_number || (sale.id ? `INV-${sale.id.slice(0, 8)}` : '—')
  const payments     = sale.sale_payments || sale.payments || []
  const meta         = sale.meta || {}
  const dueDate      = meta.due_date || sale.due_date || null
  // Detail endpoint doesn't include payment_method directly — fall back to
  // the first recorded payment's method (matches the design).
  const paymentMethod = sale.payment_method || payments[0]?.method || null

  return (
    <div className="space-y-6">
      {/* ── Top action bar ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => window.print()} leftIcon={<IconPrint />}>Print</Button>
        <Button variant="secondary" size="sm" onClick={() => window.print()} leftIcon={<IconDownload />}>PDF</Button>
        {isDraft && (
          <Button loading={finalizing} onClick={handleFinalize}>Finalize Sale</Button>
        )}
        {isFinal && hasBalance && canPay && (
          <Button onClick={() => setPayOpen(true)} leftIcon={<IconPlus />}>Record payment</Button>
        )}
      </div>

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => navigate('/sells')}
            className="mt-1 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-200 text-gray-500 hover:text-navy-800 hover:bg-gray-50"
            aria-label="Back"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" /></svg>
          </button>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-extrabold tracking-tight text-navy-800">{invoiceNo}</h1>
              {sale.payment_status && (
                <Badge variant={PAY_STATUS_VARIANT[sale.payment_status] ?? 'gray'}>{sale.payment_status}</Badge>
              )}
              {sale.status && sale.status !== 'FINAL' && (
                <Badge variant={SALE_STATUS_VARIANT[sale.status] ?? 'gray'}>{sale.status}</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {sale.status === 'DRAFT' ? 'Drafted' : 'Issued'} {fmtDateTime(sale.finalized_at || sale.created_at)}
              {(sale.finalized_by_name || sale.created_by_name) && (
                <> · by <span className="text-navy-700 font-medium">{sale.finalized_by_name || sale.created_by_name}</span></>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!isVoided && (
            <Button variant="secondary" size="sm" leftIcon={<IconEdit />} onClick={() => setEditOpen(true)}>Edit</Button>
          )}
        </div>
      </div>

      {/* ── Main layout: invoice + right rail ─────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Invoice card */}
        <div className="lg:col-span-2">
          <Card padding="p-0">
            <div id="invoice-printable" className="p-6 sm:p-8">
              {/* Header — pulled from the tenant's Company Profile so
                  every tenant prints THEIR brand. No more hard-coded
                  "Acme Trading Co." or "Iffaa Accounting · BIN MAIN". */}
              <div className="flex items-start justify-between gap-6">
                <div className="flex items-start gap-3">
                  {companyProfile?.logo_url ? (
                    <img
                      src={companyProfile.logo_url}
                      alt={companyProfile?.name || 'Logo'}
                      className="h-12 w-12 object-contain rounded-md"
                    />
                  ) : (
                    <Logo variant="icon" size="md" />
                  )}
                  <div>
                    <p className="text-lg font-bold text-navy-800 leading-tight">
                      {companyProfile?.name || user?.business_name || '—'}
                    </p>
                    <p className="text-xs text-gray-500">
                      {[sale.location_name, sale.location_code]
                        .filter(Boolean).join(' · ') || ''}
                    </p>
                    {companyProfile?.address && (
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {companyProfile.address}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Invoice</p>
                  <p className="mt-0.5 text-xl font-extrabold text-navy-800 tracking-tight">{invoiceNo}</p>
                </div>
              </div>

              {/* Bill To + Invoice meta */}
              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Bill to</p>
                  <p className="mt-2 text-base font-bold text-navy-800">
                    {sale.customer?.name || sale.customer_name || 'Walk-in customer'}
                  </p>
                  {sale.customer?.address && (
                    <p className="mt-1 text-sm text-gray-600">{sale.customer.address}</p>
                  )}
                  <div className="mt-1 text-sm text-gray-600 space-y-0.5">
                    {sale.customer?.phone && <p>{sale.customer.phone}</p>}
                    {sale.customer?.email && (
                      <p>
                        <a href={`mailto:${sale.customer.email}`} className="text-brand-600 hover:underline">
                          {sale.customer.email}
                        </a>
                      </p>
                    )}
                  </div>
                </div>
                <div className="md:text-right">
                  <dl className="inline-block text-sm">
                    <Meta label="Issued"   value={fmtDate(sale.finalized_at || sale.created_at)} />
                    {dueDate && <Meta label="Due" value={fmtDate(dueDate)} />}
                    {paymentMethod && (
                      <Meta label="Payment" value={PAY_METHOD_LABEL[paymentMethod] || paymentMethod} />
                    )}
                  </dl>
                </div>
              </div>

              {/* Items table */}
              <div className="mt-8 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                      <th className="pb-2 text-left">Item</th>
                      <th className="pb-2 text-right">Qty</th>
                      <th className="pb-2 text-right">Price</th>
                      <th className="pb-2 text-right">Disc.</th>
                      <th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(sale.items || []).map((item) => (
                      <tr key={item.id}>
                        <td className="py-3">
                          <div className="font-medium text-navy-800">{item.product_name}</div>
                          {item.product_sku && (
                            <div className="text-[11px] text-gray-400 font-mono">{item.product_sku}</div>
                          )}
                        </td>
                        <td className="py-3 text-right text-gray-700 whitespace-nowrap">
                          {item.quantity} {item.unit_label || ''}
                        </td>
                        <td className="py-3 text-right text-gray-700 whitespace-nowrap tabular-nums">{fmtMoney(item.unit_price)}</td>
                        <td className="py-3 text-right text-gray-500 whitespace-nowrap tabular-nums">
                          {Number(item.item_discount) > 0 ? `−${fmtMoney(item.item_discount)}` : '—'}
                        </td>
                        <td className="py-3 text-right font-semibold text-navy-800 whitespace-nowrap tabular-nums">
                          {fmtMoney(item.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="mt-6 flex justify-end">
                <dl className="w-full max-w-xs text-sm space-y-2">
                  <Row label="Subtotal" value={fmtMoney(sale.subtotal)} />
                  {Number(sale.discount) > 0 && (
                    <Row label="Discount" value={`−${fmtMoney(sale.discount)}`} valueClass="text-emerald-700" />
                  )}
                  {Number(sale.tax_amount) > 0 && (
                    <Row label={`Tax (${Number(sale.tax_rate || 0)}% VAT)`} value={fmtMoney(sale.tax_amount)} />
                  )}
                  <div className="my-2 border-t border-gray-100" />
                  <div className="flex items-center justify-between">
                    <dt className="font-bold text-navy-800">
                      {sale.payment_status === 'PAID' ? 'Total paid' : 'Total due'}
                    </dt>
                    <dd className={`text-2xl font-extrabold tracking-tight tabular-nums ${
                      sale.payment_status === 'PAID' ? 'text-emerald-600' : 'text-navy-800'
                    }`}>
                      {fmtMoney(sale.total_amount)}
                    </dd>
                  </div>
                  {hasBalance && (
                    <div className="flex items-center justify-between text-sm">
                      <dt className="text-gray-500">Balance due</dt>
                      <dd className="font-semibold text-rose-600 tabular-nums">{fmtMoney(sale.balance_due)}</dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* Footer note */}
              <div className="mt-8 border-t border-gray-100 pt-4 text-xs text-gray-500 italic">
                {sale.notes || meta.sell_note ||
                  'Thank you for your business. Payment terms: Net 7. Goods once sold are not returnable without prior approval.'}
              </div>
            </div>
          </Card>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* Payment history */}
          <Card>
            <h3 className="text-base font-bold text-navy-800">Payment history</h3>
            <div className="mt-4 space-y-3">
              {payments.length === 0 ? (
                <p className="text-sm text-gray-400">No payments recorded yet.</p>
              ) : payments.map((pmt) => (
                <div key={pmt.id} className="rounded-lg border border-gray-100 bg-gray-50/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-navy-800">
                      {Number(pmt.amount) >= Number(sale.total_amount) ? 'Full payment received' : 'Partial payment'}
                    </p>
                    <span className="text-sm font-bold text-emerald-600 tabular-nums whitespace-nowrap">
                      +{fmtMoney(pmt.amount)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500">
                    {PAY_METHOD_LABEL[pmt.method] || pmt.method || 'Cash'}
                    {pmt.reference && <> · <span className="font-mono">{pmt.reference}</span></>}
                  </p>
                  <p className="text-[11px] text-gray-400">{fmtDateTime(pmt.paid_at || pmt.created_at)}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Activity timeline */}
          <Card>
            <h3 className="text-base font-bold text-navy-800">Activity</h3>
            <ol className="mt-4 space-y-3">
              <TimelineItem
                color="brand"
                title={isDraft ? 'Draft created' : 'Invoice issued'}
                by={sale.created_by_name}
                at={sale.created_at}
              />
              {payments.length > 0 && (
                <TimelineItem
                  color="emerald"
                  title={`Payment received${payments[0].method ? ` via ${PAY_METHOD_LABEL[payments[0].method] || payments[0].method}` : ''}`}
                  by={sale.finalized_by_name || sale.created_by_name}
                  at={payments[0].paid_at || payments[0].created_at}
                />
              )}
              {sale.finalized_at && (
                <TimelineItem
                  color="navy"
                  title="Finalized"
                  by={sale.finalized_by_name || sale.created_by_name}
                  at={sale.finalized_at}
                />
              )}
              {sale.payment_status === 'PAID' && (
                <TimelineItem
                  color="emerald"
                  title="Marked as fully paid"
                  by="System"
                  at={sale.updated_at || sale.finalized_at}
                />
              )}
              {sale.status === 'VOIDED' && (
                <TimelineItem
                  color="rose"
                  title="Voided"
                  by={sale.finalized_by_name || 'System'}
                  at={sale.updated_at}
                />
              )}
            </ol>
          </Card>
        </div>
      </div>

      {/* ── Print-only InvoiceSlip ──────────────────────────────────────
          Hidden on screen, takes over the page on window.print().
          Pulls company name/logo/payment/terms from the tenant's
          SystemSetting profile so every tenant prints their own slip. */}
      <InvoiceSlip
        mode="print-only"
        invoice={{
          number:   invoiceNo,
          date:     sale.finalized_at || sale.created_at,
          due_date: dueDate,
          notes:    sale.notes || meta.sell_note,
          location_code: sale.location_code,
          location_name: sale.location_name,
        }}
        customer={{
          name:    sale.customer?.name || sale.customer_name || 'Walk-in customer',
          address: sale.customer?.address,
          phone:   sale.customer?.phone,
          email:   sale.customer?.email,
        }}
        items={(sale.items || []).map((it) => ({
          id:           it.id,
          product_name: it.product_name,
          description:  it.product_name,
          sku:          it.product_sku,
          note:         it.note,
          unit_price:   it.unit_price,
          quantity:     it.quantity,
          line_total:   it.line_total,
        }))}
        totals={{
          subtotal:   sale.subtotal,
          discount:   sale.discount,
          tax_amount: sale.tax_amount,
          tax_rate:   sale.tax_rate,
          total:      sale.total_amount,
          paid:       sale.amount_paid,
          balance_due: sale.balance_due,
          customer_total_due: customerTotalDue,
        }}
      />

      {/* Modals */}
      <AddPaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        saleId={id}
        balanceDue={sale.balance_due}
        onAdded={loadSale}
      />
      <VoidModal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        saleId={id}
        onVoided={() => { loadSale() }}
      />
      <EditSaleModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        sale={sale}
        onSaved={() => { setEditOpen(false); loadSale() }}
      />
    </div>
  )
}

// ── Edit Sale modal ─────────────────────────────────────────────────────────
// Works on ANY status. For editable sales (DRAFT/QUOTATION/PROFORMA) it
// also lets the operator change discount + tax via updateSale(); for
// FINAL sales only the journal-safe header fields (customer, date,
// notes) are editable via updateSaleHeader() — money/stock changes on a
// finalised sale must go through a Sell Return or Void.
function EditSaleModal({ open, onClose, sale, onSaved }) {
  const editable = sale && ['DRAFT', 'QUOTATION', 'PROFORMA'].includes(sale.status)
  const [customers, setCustomers] = useState([])
  const [custSearch, setCustSearch] = useState('')
  const [form, setForm] = useState({
    customer_id: '', sale_date: '', notes: '',
    discount: '', tax_rate: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open || !sale) return
    setErr('')
    const cust = sale.customer
    setForm({
      customer_id: sale.customer_id || sale.customer?.id || '',
      sale_date: sale.sale_date ? new Date(sale.sale_date).toISOString().slice(0, 16) : '',
      notes: sale.notes || '',
      discount: sale.discount != null ? String(sale.discount) : '',
      tax_rate: sale.tax_rate != null ? String(sale.tax_rate) : '',
    })
    setCustSearch(cust ? `${cust.name}${cust.phone ? ` (${cust.phone})` : ''}` : '')
    getCustomers({ active_only: 'true' })
      .then((res) => setCustomers(Array.isArray(res) ? res : (res?.results ?? [])))
      .catch(() => setCustomers([]))
  }, [open, sale])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target?.value ?? e }))

  const submit = async () => {
    setErr('')
    setSaving(true)
    try {
      if (editable) {
        // Full edit path — discount/tax recompute totals server-side.
        await updateSale(sale.id, {
          customer_id: form.customer_id || null,
          notes:       form.notes,
          discount:    Number(form.discount || 0),
          tax_rate:    Number(form.tax_rate || 0),
        })
      }
      // Header fields work for every status (incl. FINAL).
      await updateSaleHeader(sale.id, {
        customer_id: form.customer_id || null,
        sale_date:   form.sale_date ? new Date(form.sale_date).toISOString() : undefined,
        notes:       form.notes,
      })
      window.alert('Sale updated.')
      onSaved?.()
    } catch (e) {
      const msg = e?.errors?.detail || e?.payload?.detail || e?.message || 'Failed to update sale.'
      setErr(msg); window.alert(msg)
    } finally {
      setSaving(false)
    }
  }

  if (!open || !sale) return null
  const lbl = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1'
  const ipt = 'h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title={`Edit Sale — ${sale.invoice_number || String(sale.id).slice(0, 8)}`} size="lg">
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        {!editable && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This sale is <b>{sale.status}</b>. Customer, date and notes can be edited here.
            To change items, prices or discounts on a finalised sale, use a <b>Sell Return</b> or <b>Void</b>.
          </div>
        )}

        <div>
          <label className={lbl}>Customer</label>
          <input
            list="editsale-cust-options"
            value={custSearch}
            onChange={(e) => {
              const v = e.target.value
              setCustSearch(v)
              const m = customers.find((c) => `${c.name}${c.phone ? ` (${c.phone})` : ''}` === v)
              setForm((f) => ({ ...f, customer_id: m?.id || '' }))
            }}
            placeholder="Walk-in — type a name or phone"
            className={ipt}
          />
          <datalist id="editsale-cust-options">
            {customers.map((c) => <option key={c.id} value={`${c.name}${c.phone ? ` (${c.phone})` : ''}`} />)}
          </datalist>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Sale Date</label>
            <input type="datetime-local" value={form.sale_date} onChange={set('sale_date')} className={ipt} />
          </div>
          {editable && (
            <>
              <div>
                <label className={lbl}>Header Discount (৳)</label>
                <input type="number" min="0" step="0.01" value={form.discount} onChange={set('discount')} className={ipt} />
              </div>
              <div>
                <label className={lbl}>Tax Rate (%)</label>
                <input type="number" min="0" step="0.01" value={form.tax_rate} onChange={set('tax_rate')} className={ipt} />
              </div>
            </>
          )}
        </div>

        <div>
          <label className={lbl}>Notes</label>
          <textarea rows={3} value={form.notes} onChange={set('notes')} className={`${ipt} h-auto py-2`} />
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Save Changes</Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Helpers (presentational) ─────────────────────────────────────────────────

function Row({ label, value, valueClass = '' }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`tabular-nums whitespace-nowrap ${valueClass || 'text-navy-800'}`}>{value}</dd>
    </div>
  )
}

function Meta({ label, value }) {
  return (
    <div className="flex items-center gap-6 text-sm py-0.5 md:justify-end">
      <dt className="text-gray-400">{label}</dt>
      <dd className="font-semibold text-navy-800 whitespace-nowrap">{value}</dd>
    </div>
  )
}

const DOT_COLORS = {
  brand:   'bg-brand-500',
  emerald: 'bg-emerald-500',
  navy:    'bg-navy-700',
  rose:    'bg-rose-500',
}

function TimelineItem({ color = 'brand', title, by, at }) {
  return (
    <li className="flex gap-3">
      <div className="relative mt-1 flex flex-col items-center">
        <span className={`h-2 w-2 rounded-full ${DOT_COLORS[color] ?? DOT_COLORS.brand}`} />
        <span className="mt-0.5 w-px flex-1 bg-gray-100" />
      </div>
      <div className="pb-1 -mt-0.5">
        <p className="text-sm font-semibold text-navy-800">{title}</p>
        <p className="text-[11px] text-gray-500">
          {by ? <>{by} · </> : null}{fmtDateTime(at)}
        </p>
      </div>
    </li>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────

function IconPrint() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2M7 14h10v7H7z" /></svg>
}
function IconMail() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18a0 0 0 010 0v14a0 0 0 010 0H3a0 0 0 010 0V5z" /><path d="M3 7l9 6 9-6" /></svg>
}
function IconDownload() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
}
function IconPlus() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
}
function IconEdit() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
}
function IconCopy() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
}
function IconRefresh() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
}
