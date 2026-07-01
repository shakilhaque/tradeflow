/**
 * <PosInvoiceSlip> — classic centered POS invoice (Ongko-style).
 *
 * Used ONLY for sales made on POS / opened from the POS "Recent Transactions"
 * list. Other screens keep the modern <InvoiceSlip>. Layout matches the
 * tenant's requested format:
 *
 *   - centered shop name + address + mobile
 *   - "Invoice" title
 *   - left meta: Invoice No / Customer / Mobile / Agent
 *   - right meta: Date / Name of Staff
 *   - table: Product | Quantity | Unit Price | Subtotal
 *   - payments (Advance / Total Paid) on the left, Subtotal / Total on the right
 *   - Code-128 barcode of the invoice number at the bottom
 *
 * Brand block (name / address / phone) is pulled from the per-tenant
 * company profile, so every tenant prints their own header.
 *
 * Props:
 *   invoice  : { number, date }
 *   customer : { name, phone }
 *   agent    : string   (service staff / sales agent)
 *   staff    : string   (cashier / name of staff)
 *   items    : [{ name, sku, quantity, unit, unit_price, subtotal }]
 *   payments : [{ label, amount, date }]
 *   totals   : { subtotal, total, paid }
 *   company  : (optional) pre-fetched company profile
 *   mode     : "screen" | "print-only"
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import JsBarcode from 'jsbarcode'
import { getCompanyProfile } from '../../api/companyProfile'

const money = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num2 = (n) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDateTime = (d) => {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return String(d)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  let h = date.getHours()
  const min = String(date.getMinutes()).padStart(2, '0')
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${dd}-${mm}-${yyyy} ${String(h).padStart(2, '0')}:${min} ${ap}`
}
const fmtDate = (d) => {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return String(d)
  return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`
}

function Barcode({ value }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, String(value), {
        format: 'CODE128', width: 1.6, height: 46, displayValue: true,
        fontSize: 13, margin: 0, textMargin: 2,
      })
    } catch { /* invalid value — leave blank */ }
  }, [value])
  return <svg ref={ref} />
}

export default function PosInvoiceSlip({
  invoice = {}, customer = {}, agent = '', staff = '',
  items = [], payments = [], totals = {},
  company: companyProp, mode = 'screen', className = '', id = 'pos-invoice-slip',
}) {
  const [company, setCompany] = useState(companyProp || null)
  useEffect(() => {
    if (companyProp) { setCompany(companyProp); return }
    let cancelled = false
    getCompanyProfile().then((p) => { if (!cancelled) setCompany(p || {}) }).catch(() => { if (!cancelled) setCompany({}) })
    return () => { cancelled = true }
  }, [companyProp])

  const c = company || {}
  const phones = [c.phone, c.alt_phone, c.phone_2].filter(Boolean).join(', ')

  const rootClass = mode === 'print-only'
    ? `pos-inv pos-inv--print-only ${className}`
    : `pos-inv ${className}`

  const tree = (
    <div id={id} className={rootClass}>
      <style>{POS_INV_CSS}</style>
      <div className="pos-inv__paper">
        {/* Header */}
        <div className="pos-inv__head">
          <div className="pos-inv__shop">{c.name || 'Company Name'}</div>
          {c.address && <div className="pos-inv__addr">{c.address}</div>}
          {phones && <div className="pos-inv__phone"><b>Mobile:</b> {phones}</div>}
        </div>
        <div className="pos-inv__doctitle">Invoice</div>

        {/* Meta */}
        <table className="pos-inv__meta">
          <tbody>
            <tr>
              <td className="pos-inv__meta-col">
                <div><b>Invoice No.</b> {invoice.number || '—'}</div>
                <div className="pos-inv__mt"><b>Customer</b></div>
                <div>{customer.name || 'Walk-in customer'}</div>
                {customer.phone && <div><b>Mobile:</b> {customer.phone}</div>}
                {agent && <div className="pos-inv__mt"><b>Agent-</b> {agent}</div>}
              </td>
              <td className="pos-inv__meta-col pos-inv__meta-col--right">
                <div><b>Date</b> {fmtDateTime(invoice.date)}</div>
                <div className="pos-inv__mt"><b>Name of Staff</b> {staff || ''}</div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Items */}
        <table className="pos-inv__table">
          <thead>
            <tr>
              <th className="l">Product</th>
              <th className="c">Quantity</th>
              <th className="r">Unit Price</th>
              <th className="r">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="l">{i + 1}. {it.name}{it.sku ? ` , ${it.sku}` : ''}</td>
                <td className="c">{num2(it.quantity)} {it.unit || 'Pc(s)'}</td>
                <td className="r">{num2(it.unit_price)}</td>
                <td className="r">{num2(it.subtotal ?? Number(it.unit_price || 0) * Number(it.quantity || 0))}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td className="c" colSpan={4} style={{ padding: 18, color: '#888' }}>No items</td></tr>}
          </tbody>
        </table>

        <div className="pos-inv__rule" />

        {/* Payments (left) + totals (right) — table so it never overflows */}
        <table className="pos-inv__foot">
          <tbody>
            <tr>
              <td className="pos-inv__pay">
                {payments.map((p, i) => (
                  <div className="pos-inv__pay-row" key={i}>
                    <span className="pos-inv__pay-lbl">{p.label || 'Advance'}</span>
                    <span className="pos-inv__pay-amt">{money(p.amount)}</span>
                    <span className="pos-inv__pay-date">{p.date ? fmtDate(p.date) : ''}</span>
                  </div>
                ))}
                <div className="pos-inv__pay-row pos-inv__pay-row--bold">
                  <span className="pos-inv__pay-lbl">Total Paid</span>
                  <span className="pos-inv__pay-amt">{money(totals.paid)}</span>
                  <span className="pos-inv__pay-date" />
                </div>
              </td>
              <td className="pos-inv__totals">
                <div className="pos-inv__tot-row"><span><b>Subtotal:</b></span><span>{money(totals.subtotal)}</span></div>
                <div className="pos-inv__tot-row"><span><b>Total:</b></span><span>{money(totals.total)}</span></div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Barcode */}
        <div className="pos-inv__barcode"><Barcode value={invoice.number} /></div>
      </div>
    </div>
  )

  if (mode === 'print-only' && typeof document !== 'undefined') {
    return createPortal(tree, document.body)
  }
  return tree
}

const POS_INV_CSS = `
.pos-inv { color: #000; font-family: 'Times New Roman', Georgia, serif; }
.pos-inv__paper { background:#fff; width:100%; max-width: 760px; margin: 0 auto; padding: 24px 28px; box-sizing:border-box; }
.pos-inv__head { text-align:center; }
.pos-inv__shop { font-size: 26px; font-weight: 700; line-height: 1.15; }
.pos-inv__addr { font-size: 12px; margin-top: 6px; }
.pos-inv__phone { font-size: 12px; margin-top: 2px; }
.pos-inv__doctitle { text-align:center; font-size: 20px; margin: 14px 0 16px; }

.pos-inv__meta { width:100%; table-layout:fixed; border-collapse:collapse; font-size: 13px; line-height: 1.5; }
.pos-inv__meta td { vertical-align: top; padding: 0; }
.pos-inv__meta-col { width: 60%; word-break: break-word; }
.pos-inv__meta-col--right { width: 40%; text-align: right; }
.pos-inv__mt { margin-top: 8px; }

.pos-inv__table { width:100%; table-layout:fixed; border-collapse:collapse; font-size: 13px; margin-top: 18px; }
.pos-inv__table th { border-top:1px solid #000; border-bottom:1px solid #000; padding: 7px 6px; font-weight:700; }
.pos-inv__table td { padding: 9px 6px; border-bottom: 1px solid #eee; word-break: break-word; }
.pos-inv__table .l { text-align:left; }
.pos-inv__table .c { text-align:center; width: 20%; }
.pos-inv__table .r { text-align:right; width: 18%; }
.pos-inv__rule { border-top:1px solid #000; margin-top: 2px; }

.pos-inv__foot { width:100%; table-layout:fixed; border-collapse:collapse; margin-top: 16px; font-size: 13px; }
.pos-inv__foot td { vertical-align: top; padding: 0; }
.pos-inv__pay { width: 60%; }
.pos-inv__totals { width: 40%; }
.pos-inv__pay-row { display:flex; gap: 14px; padding: 3px 0; }
.pos-inv__pay-row--bold { font-weight:700; }
.pos-inv__pay-lbl { font-weight:700; min-width: 78px; }
.pos-inv__pay-amt { min-width: 70px; }
.pos-inv__pay-date { color:#000; }
.pos-inv__tot-row { display:flex; justify-content:space-between; gap: 18px; padding: 3px 0; }
.pos-inv__barcode { text-align:center; margin-top: 24px; }
.pos-inv__barcode svg { max-width: 100%; }

.pos-inv--print-only { display:none; }
@media print {
  html, body { margin:0 !important; padding:0 !important; background:#fff !important; }
  body > *:not(.pos-inv) { display:none !important; }
  body *:not(.pos-inv):not(.pos-inv *) { visibility:hidden !important; }
  .pos-inv, .pos-inv * { visibility:visible !important; }
  .pos-inv { position:static !important; display:block !important; width:100% !important; margin:0 !important; padding:0 !important; }
  .pos-inv__paper { max-width:100% !important; margin:0 !important; padding: 10mm 14mm !important; }
  @page { margin: 6mm; size: auto; }
}
`
