/**
 * <RegisterSlip> — print-only "Register Details" sheet (table format).
 *
 * Mirrors <PosInvoiceSlip>: a clean, centered, table-based layout with the
 * tenant's brand header that takes over the page on window.print(). The
 * on-screen Register Details modal keeps its own rich UI; this is only what
 * actually prints.
 *
 * Props:
 *   data    : register details payload (open_time, close_time, payment_methods,
 *             totals, products_sold, products_grand_total, user, location)
 *   company : (optional) pre-fetched company profile
 *   mode    : "screen" | "print-only"
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCompanyProfile } from '../../api/companyProfile'

const money = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDT = (s) =>
  s ? new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function RegisterSlip({ data, company: companyProp, mode = 'print-only', className = '', id = 'register-slip' }) {
  const [company, setCompany] = useState(companyProp || null)
  useEffect(() => {
    if (companyProp) { setCompany(companyProp); return }
    let cancelled = false
    getCompanyProfile().then((p) => { if (!cancelled) setCompany(p || {}) }).catch(() => { if (!cancelled) setCompany({}) })
    return () => { cancelled = true }
  }, [companyProp])

  if (!data) return null
  const c = company || {}
  const phones = [c.phone, c.alt_phone, c.phone_2].filter(Boolean).join(', ')
  const t = data.totals || {}

  const rootClass = mode === 'print-only' ? `reg-slip reg-slip--print-only ${className}` : `reg-slip ${className}`

  const tree = (
    <div id={id} className={rootClass}>
      <style>{REG_CSS}</style>
      <div className="reg-slip__paper">
        <div className="reg-slip__head">
          <div className="reg-slip__shop">{c.name || 'Company Name'}</div>
          {c.address && <div className="reg-slip__addr">{c.address}</div>}
          {phones && <div className="reg-slip__phone"><b>Mobile:</b> {phones}</div>}
        </div>
        <div className="reg-slip__doctitle">Register Details</div>
        <div className="reg-slip__period">{fmtDT(data.open_time)} &nbsp;–&nbsp; {fmtDT(data.close_time)}</div>

        {/* Payment methods */}
        <table className="reg-slip__tbl">
          <thead>
            <tr><th className="l">Payment Method</th><th className="r">Sell</th><th className="r">Expense</th></tr>
          </thead>
          <tbody>
            {(data.payment_methods || []).map((m) => (
              <tr key={m.key}>
                <td className="l">{m.label}</td>
                <td className="r">{m.sell === '—' ? '—' : money(m.sell)}</td>
                <td className="r">{m.expense === '—' ? '—' : money(m.expense)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <table className="reg-slip__tbl reg-slip__tbl--totals">
          <tbody>
            <tr><td className="l">Total Sales</td><td className="r">{money(t.total_sales)}</td></tr>
            <tr><td className="l">Total Refund</td><td className="r">{money(t.total_refund)}</td></tr>
            <tr><td className="l">Total Payment</td><td className="r">{money(t.total_payment)}</td></tr>
            <tr><td className="l">Credit Sales</td><td className="r">{money(t.credit_sales)}</td></tr>
            <tr><td className="l">Total Expenses</td><td className="r">{money(t.total_expenses)}</td></tr>
          </tbody>
        </table>

        {/* Products sold */}
        <div className="reg-slip__subtitle">Details of products sold</div>
        <table className="reg-slip__tbl">
          <thead>
            <tr><th className="l" style={{ width: '8%' }}>#</th><th className="l">Brands</th><th className="r">Quantity</th><th className="r">Total amount</th></tr>
          </thead>
          <tbody>
            {(data.products_sold || []).length === 0 ? (
              <tr><td className="c" colSpan={4} style={{ padding: 12, color: '#666' }}>No sales yet.</td></tr>
            ) : data.products_sold.map((r, i) => (
              <tr key={r.brand}>
                <td className="l">{i + 1}.</td>
                <td className="l">{r.brand}</td>
                <td className="r">{Number(r.qty).toLocaleString()}</td>
                <td className="r">{money(r.amount)}</td>
              </tr>
            ))}
            {(data.products_sold || []).length > 0 && data.products_grand_total && (
              <tr className="reg-slip__grand">
                <td className="l" colSpan={2}>Grand Total</td>
                <td className="r">{Number(data.products_grand_total.qty).toLocaleString()}</td>
                <td className="r">{money(data.products_grand_total.amount)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Footer */}
        <div className="reg-slip__foot">
          <div><b>User:</b> {data.user?.name || '—'}</div>
          {data.user?.email && <div><b>Email:</b> {data.user.email}</div>}
          <div><b>Business Location:</b> {data.location?.name || '—'}</div>
        </div>
      </div>
    </div>
  )

  if (mode === 'print-only' && typeof document !== 'undefined') {
    return createPortal(tree, document.body)
  }
  return tree
}

const REG_CSS = `
.reg-slip { color:#000; font-family: 'Times New Roman', Georgia, serif; }
.reg-slip__paper { background:#fff; width:100%; max-width: 760px; margin:0 auto; padding: 18px 24px; box-sizing:border-box; }
.reg-slip__head { text-align:center; }
.reg-slip__shop { font-size: 22px; font-weight:700; line-height:1.1; }
.reg-slip__addr { font-size: 11px; margin-top: 4px; }
.reg-slip__phone { font-size: 11px; margin-top: 1px; }
.reg-slip__doctitle { text-align:center; font-size: 17px; margin: 8px 0 1px; }
.reg-slip__period { text-align:center; font-size: 11px; margin-bottom: 8px; }
.reg-slip__subtitle { font-weight:700; font-size: 12px; margin: 9px 0 3px; }
.reg-slip__tbl { width:100%; table-layout:fixed; border-collapse:collapse; font-size: 12px; margin-top: 4px; page-break-inside: avoid; }
.reg-slip__tbl th { border-top:1px solid #000; border-bottom:1px solid #000; padding: 3px 6px; font-weight:700; }
.reg-slip__tbl td { padding: 2.5px 6px; border-bottom:1px solid #eee; word-break: break-word; }
.reg-slip__tbl tr { page-break-inside: avoid; }
.reg-slip__tbl .l { text-align:left; }
.reg-slip__tbl .r { text-align:right; width: 22%; }
.reg-slip__tbl .c { text-align:center; }
.reg-slip__tbl--totals td { border-bottom:1px dashed #ccc; }
.reg-slip__grand td { font-weight:700; border-top:1px solid #000; border-bottom:1px solid #000; }
.reg-slip__foot { margin-top: 10px; font-size: 12px; line-height: 1.45; page-break-inside: avoid; }

.reg-slip--print-only { display:none; }
@media print {
  html, body { margin:0 !important; padding:0 !important; background:#fff !important; }
  body > *:not(.reg-slip) { display:none !important; }
  body *:not(.reg-slip):not(.reg-slip *) { visibility:hidden !important; }
  .reg-slip, .reg-slip * { visibility:visible !important; }
  .reg-slip { position:static !important; display:block !important; width:100% !important; margin:0 !important; padding:0 !important; }
  .reg-slip__paper { max-width:100% !important; margin:0 !important; padding: 6mm 10mm !important; page-break-inside: avoid; }
  @page { margin: 5mm; size: auto; }
}
`
