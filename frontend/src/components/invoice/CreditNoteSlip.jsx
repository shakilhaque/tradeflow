import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * CreditNoteSlip — print-friendly slip for Sale Returns / Credit Notes.
 * Mirrors the reference layout the user pinned: tenant header on the
 * left, big "CN<number>" on the right, customer block below, items
 * table, totals + Authorised Signatory at the bottom.
 *
 * Renders nothing on screen by default (mode="print-only"); a small
 * @media print block makes the body show only the slip when the print
 * dialog fires.
 */
const fmtMoney = (n) =>
  n == null || n === ''
    ? '—'
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Date-only formatter — used for return_date (a Django DateField).
// Previously formatted with hours+minutes which surfaced "06:00 AM"
// for every credit note because midnight-UTC parses as 06:00 in BD
// (UTC+6). Tenants don't track refund times on credit notes; the
// list page and the audit log carry the actual created_at timestamp.
const fmtDate = (d) => {
  if (!d) return '—'
  // Accept both ISO strings and "YYYY-MM-DD". Slice the date part
  // before parsing so timezone shifts don't push the date back/
  // forward a day (a long-standing bug with Date('2026-06-07')).
  const s = String(d).slice(0, 10)
  const [yyyy, mm, dd] = s.split('-')
  if (yyyy && mm && dd) return `${dd}/${mm}/${yyyy}`
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return String(d)
  const _dd = String(dt.getDate()).padStart(2, '0')
  const _mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${_dd}/${_mm}/${dt.getFullYear()}`
}

// Date+time formatter — kept for the tiny top-bar timestamp that
// honestly reflects "when this slip was printed".
const fmtDateTime = (d) => {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return String(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const hh = dt.getHours()
  const mi = String(dt.getMinutes()).padStart(2, '0')
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const h12 = ((hh + 11) % 12) + 1
  return `${dd}/${mm}/${dt.getFullYear()} ${String(h12).padStart(2, '0')}:${mi} ${ampm}`
}

const fmtPhone = (p) => {
  if (!p) return ''
  const d = String(p).replace(/\D/g, '')
  if (d.length === 10 && d.startsWith('1')) return `0${d}`
  if (d.length === 13 && d.startsWith('880')) return `0${d.slice(3)}`
  return String(p)
}

export default function CreditNoteSlip({
  ret,
  company,
  currencySymbol = '৳',
  mode = 'print-only',  // 'print-only' (default) | 'screen'
  id = 'credit-note-slip',
}) {
  if (!ret) return null

  const c = company || {}
  const cust = ret.customer_obj || ret.customer || {}
  const items = ret.items || []
  // Net refundable total — minus restocking fee when present.
  const subtotal = Number(ret.total_amount) || 0
  const restock  = Number(ret.restocking_fee) || 0
  const grand    = Math.max(0, subtotal - restock)
  const cnNumber = ret.invoice_no || ret.invoice_number || (ret.id ? String(ret.id).slice(0, 8) : 'CN')

  const slip = (
    <div id={id} className="credit-note-slip">
      <style>{CN_CSS}</style>

      <div className="cn-paper">
        <header className="cn-topbar">
          {/* Top-bar = printed-at timestamp, NOT the credit-note
              business date — keep date+time for the audit. */}
          <span>{fmtDateTime(ret.created_at || new Date())}</span>
          <span className="cn-topbar__id">{cnNumber}</span>
        </header>

        <section className="cn-head">
          <div className="cn-head__left">
            <div className="cn-co__name">{c.name || c.business_name || 'Company Name'}</div>
            {c.address && <div className="cn-co__line">{c.address}</div>}
            {(c.phone || c.mobile) && (
              <div className="cn-co__line">
                <b>Mobile:</b> {fmtPhone(c.phone || c.mobile)}
              </div>
            )}
          </div>
          <div className="cn-head__right">
            <div className="cn-cn">{cnNumber}</div>
            <div className="cn-meta">
              <span className="cn-meta__lbl">Invoice No.</span>
              <span className="cn-meta__val">{ret.parent_invoice_no || '—'}</span>
            </div>
            <div className="cn-meta">
              <span className="cn-meta__lbl">Date</span>
              <span className="cn-meta__val">{fmtDate(ret.return_date || ret.created_at)}</span>
            </div>
          </div>
        </section>

        <section className="cn-cust">
          <div className="cn-cust__title">Customer</div>
          <div className="cn-cust__name">{cust.name || ret.customer_name || 'Walk-in customer'}</div>
          {cust.business_name && <div className="cn-cust__line">{cust.business_name}</div>}
          {cust.address && <div className="cn-cust__line">{cust.address}</div>}
          {(cust.phone || cust.mobile) && (
            <div className="cn-cust__line"><b>Mobile:</b> {fmtPhone(cust.phone || cust.mobile)}</div>
          )}
        </section>

        <table className="cn-items">
          <thead>
            <tr>
              <th className="cn-items__no">No</th>
              <th className="cn-items__name">Product</th>
              <th className="cn-items__qty">Quantity</th>
              <th className="cn-items__price">Unit Price</th>
              <th className="cn-items__sub">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={5} className="cn-items__empty">No line items.</td></tr>
            ) : items.map((it, i) => (
              <tr key={it.id || i}>
                <td className="cn-items__no">{i + 1}</td>
                <td className="cn-items__name">
                  <span className="cn-item__title">{it.product_name || it.description || '—'}</span>
                  {(it.product_sku || it.sku) && (
                    <span className="cn-item__sub"> , {it.product_sku || it.sku}</span>
                  )}
                </td>
                <td className="cn-items__qty">{Number(it.quantity || it.return_qty || 0).toFixed(2)} {it.unit || 'Pc(s)'}</td>
                <td className="cn-items__price">{fmtMoney(it.unit_price)}</td>
                <td className="cn-items__sub">{fmtMoney(it.line_total ?? Number(it.unit_price || 0) * Number(it.quantity || it.return_qty || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals — right-aligned, no signatory yet. */}
        <section className="cn-totals-wrap">
          <div className="cn-totals">
            <div className="cn-totals__row">
              <span className="cn-totals__lbl">Subtotal:</span>
              <span className="cn-totals__val">{currencySymbol} {fmtMoney(subtotal)}</span>
            </div>
            {restock > 0 && (
              <div className="cn-totals__row">
                <span className="cn-totals__lbl">Restocking fee:</span>
                <span className="cn-totals__val">− {currencySymbol} {fmtMoney(restock)}</span>
              </div>
            )}
            <div className="cn-totals__rule" />
            <div className="cn-totals__row cn-totals__row--grand">
              <span className="cn-totals__lbl">Total Refund:</span>
              <span className="cn-totals__val">{currencySymbol} {fmtMoney(grand)}</span>
            </div>
          </div>
        </section>

        {/* Spacer pushes the signatory footer to the very bottom of
            the printed page regardless of how short the items table
            is. Flex column on .cn-paper does the actual layout. */}
        <div className="cn-spacer" />
        <footer className="cn-foot">
          <div className="cn-sign">
            <div className="cn-sign__line" />
            <div className="cn-sign__lbl">Authorized Signatory</div>
          </div>
        </footer>
      </div>
    </div>
  )

  // Print-only: portal to body so the @media print rule (which hides
  // every body child except .credit-note-slip) works regardless of
  // where the slip was mounted in the React tree.
  if (mode === 'print-only') {
    if (typeof document === 'undefined') return null
    return createPortal(slip, document.body)
  }
  return slip
}

const CN_CSS = `
.credit-note-slip { display: none; }

@media print {
  body > *:not(.credit-note-slip) { display: none !important; }
  .credit-note-slip { display: block !important; }
  @page { size: A4; margin: 12mm; }
}

.credit-note-slip .cn-paper {
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #1f2937;
  max-width: 760px;
  margin: 0 auto;
  background: #fff;
  padding: 16px 22px 24px;
  /* Flex column so the signatory footer can be pushed to the very
     bottom of the page regardless of how short the items table is. */
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.credit-note-slip .cn-spacer { flex: 1 1 auto; }
@media print {
  .credit-note-slip .cn-paper { min-height: calc(100vh - 24mm); }
}
.credit-note-slip .cn-topbar {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; color: #6b7280; padding-bottom: 8px;
  border-bottom: 1px solid #f1f5f9;
}
.credit-note-slip .cn-topbar__id { color: #ea580c; font-weight: 600; }

.credit-note-slip .cn-head {
  display: flex; justify-content: space-between; gap: 24px;
  padding: 16px 0 12px;
}
.credit-note-slip .cn-head__left { flex: 1; color: #ea580c; font-size: 12px; }
.credit-note-slip .cn-co__name { font-weight: 700; color: #ea580c; margin-bottom: 2px; }
.credit-note-slip .cn-co__line { line-height: 1.4; }
.credit-note-slip .cn-head__right { text-align: right; min-width: 220px; }
.credit-note-slip .cn-cn {
  font-size: 28px; font-weight: 800; color: #111827; line-height: 1; margin-bottom: 8px;
}
.credit-note-slip .cn-meta {
  display: flex; justify-content: flex-end; gap: 18px; font-size: 12px; margin-top: 4px;
}
.credit-note-slip .cn-meta__lbl { color: #374151; font-weight: 600; }
.credit-note-slip .cn-meta__val { color: #ea580c; font-weight: 600; min-width: 120px; text-align: right; }

.credit-note-slip .cn-cust { padding: 8px 0 14px; color: #ea580c; font-size: 12px; }
.credit-note-slip .cn-cust__title { color: #111827; font-weight: 700; margin-bottom: 2px; }
.credit-note-slip .cn-cust__name { font-weight: 600; }
.credit-note-slip .cn-cust__line { line-height: 1.4; }

.credit-note-slip .cn-items {
  width: 100%; border-collapse: collapse; font-size: 12px;
  border: 1px solid #d1d5db; margin-top: 6px;
}
.credit-note-slip .cn-items th, .credit-note-slip .cn-items td {
  border: 1px solid #d1d5db; padding: 8px 10px; vertical-align: top;
}
.credit-note-slip .cn-items thead th {
  background: #fff; color: #6b7280; font-weight: 600; text-align: left;
}
.credit-note-slip .cn-items__no    { width: 40px; text-align: center; color: #6b7280; }
.credit-note-slip .cn-items__qty   { width: 110px; }
.credit-note-slip .cn-items__price { width: 110px; text-align: right; }
.credit-note-slip .cn-items__sub   { width: 110px; text-align: right; }
.credit-note-slip .cn-items__empty { text-align: center; color: #9ca3af; padding: 24px 0; }
.credit-note-slip .cn-item__title  { color: #ea580c; }
.credit-note-slip .cn-item__sub    { color: #9ca3af; }

.credit-note-slip .cn-totals-wrap {
  display: flex; justify-content: flex-end; padding-top: 12px; font-size: 12px;
}
.credit-note-slip .cn-totals { min-width: 260px; }
.credit-note-slip .cn-totals__row {
  display: flex; justify-content: space-between; padding: 4px 0;
}
.credit-note-slip .cn-totals__lbl { color: #6b7280; }
.credit-note-slip .cn-totals__val { color: #111827; font-weight: 600; }
.credit-note-slip .cn-totals__rule { height: 1px; background: #e5e7eb; margin: 4px 0; }
.credit-note-slip .cn-totals__row--grand .cn-totals__lbl,
.credit-note-slip .cn-totals__row--grand .cn-totals__val {
  font-size: 14px; font-weight: 700; color: #111827;
}

/* Signatory pinned to the bottom of the slip. */
.credit-note-slip .cn-foot {
  display: flex; justify-content: flex-end;
  padding-top: 80px; font-size: 12px;
}
.credit-note-slip .cn-sign { text-align: center; min-width: 220px; }
.credit-note-slip .cn-sign__line {
  border-top: 1px solid #111827; margin-bottom: 4px;
}
.credit-note-slip .cn-sign__lbl { font-weight: 600; color: #111827; }
`
