/**
 * <InvoiceSlip> — the single, reusable invoice / receipt template.
 *
 * Used everywhere an invoice slip is printed:
 *   - Sale detail page (full A4 invoice)
 *   - POS receipt modal (compact preview + print)
 *   - Sale-return detail, etc. (drop-in via the same component)
 *
 * Per-tenant individuality
 * ────────────────────────
 * The layout is shared (single design system), but every tenant sees
 * their OWN brand block, payment info, terms and accent color because
 * the component pulls those fields from `/api/settings/company-profile/`
 * (the per-tenant SystemSetting store on the tenant DB). Tenant A's
 * printed slip cannot match tenant B's because:
 *
 *   - company.name + company.logo_url drive the top-right brand block
 *   - invoice.tagline appears under the brand name
 *   - invoice.payment.* drive the Payment Info block
 *   - invoice.terms is the Terms & Conditions footer
 *   - invoice.primary_color is the table-header accent (teal default)
 *   - invoice.authorised_sign labels the signature line
 *
 * Props:
 *   - invoice  : { number, date, due_date?, notes?, location_code?, location_name? }
 *   - customer : { name, address?, phone?, email? }
 *   - items    : [{ description, unit_price, quantity, line_total, ... }]
 *   - totals   : { subtotal, discount?, tax_amount?, tax_rate?, total }
 *   - company  : (optional) pre-fetched company profile to avoid an extra
 *                round-trip when the parent already has it.
 *   - mode     : "screen" (default) | "print-only" (collapses to a hidden
 *                element that becomes the only visible thing in @media print)
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtMoney = (n, symbol = '৳') =>
  n == null || n === ''
    ? '—'
    : `${symbol} ${Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`

// BD mobile display normaliser. Imported / legacy customer rows
// sometimes lost the leading "0" (Excel turns "01633…" into 1633…
// on CSV save). fmtBdPhone() restores the canonical 11-digit
// "01XXXXXXXXX" form for display so the printed invoice always
// shows the full number, regardless of how the row got into the DB.
// Leaves non-BD / international / landline numbers unchanged.
const fmtBdPhone = (p) => {
  if (p == null) return ''
  const s = String(p).trim()
  if (!s) return ''
  const d = s.replace(/\D/g, '')
  if (d.length === 10 && d.startsWith('1')) return `0${d}`
  if (d.length === 13 && d.startsWith('880')) return `0${d.slice(3)}`
  if (d.length === 14 && d.startsWith('8800')) return `0${d.slice(4)}`
  return s
}

const fmtDate = (d) => {
  if (!d) return '—'
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return String(d)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd} / ${mm} / ${yyyy}`
}

const DEFAULTS = {
  name:                          '',
  logo_url:                      '',
  address:                       '',
  phone:                         '',
  email:                         '',
  tax_number:                    '',
  website:                       '',
  invoice_tagline:               'TAGLINE SPACE HERE',
  invoice_thank_you:             'Thank you for your business',
  invoice_payment_bank_account:  '',
  invoice_payment_ac_name:       '',
  invoice_payment_bank_details:  '',
  invoice_terms:                 'Goods once sold are not returnable without prior approval. Payment terms: Net 7.',
  invoice_primary_color:         '#14b8a6',
  invoice_authorised_sign:       'Authorised Sign',
  invoice_footer_note:           '',
}

export default function InvoiceSlip({
  invoice,
  customer,
  items = [],
  totals = {},
  company: companyProp,
  currencySymbol = '৳',
  mode = 'screen',
  className = '',
  id = 'invoice-slip',
  // 'INVOICE' (default) | 'QUOTATION' | 'PROFORMA' — drives the big
  // wordmark + the "Invoice to / Invoice#" labels so a quotation
  // print clearly reads "QUOTATION".
  docType = 'INVOICE',
}) {
  const [company, setCompany] = useState(companyProp || null)

  useEffect(() => {
    if (companyProp) { setCompany(companyProp); return }
    let cancelled = false
    getCompanyProfile()
      .then((p) => { if (!cancelled) setCompany(p || {}) })
      .catch(() => { if (!cancelled) setCompany({}) })
    return () => { cancelled = true }
  }, [companyProp])

  const c = { ...DEFAULTS, ...(company || {}) }
  const accent = c.invoice_primary_color || DEFAULTS.invoice_primary_color

  const rootClass = mode === 'print-only'
    ? `invoice-slip invoice-slip--print-only ${className}`
    : `invoice-slip ${className}`

  // In print-only mode we portal the slip directly under <body> so the
  // @media print rule `body > *:not(.invoice-slip) { display: none }`
  // can actually find it as a direct body child. Otherwise the slip
  // is nested inside a Modal / page wrapper / etc. and that rule
  // hides its OWN ancestors, blanking the print preview.
  const tree = (
    <div id={id} className={rootClass} data-tenant-invoice>
      {/* Local styles so it renders the same in print and on screen,
          independent of the host page's tailwind reset/typography. */}
      <style>{INVOICE_CSS}</style>

      <div className="inv-paper">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="inv-header">
          <h1 className="inv-title">{docType || 'INVOICE'}</h1>
          <div className="inv-brand">
            {c.logo_url ? (
              <img src={c.logo_url} alt={c.name || 'Logo'} className="inv-brand__logo" />
            ) : (
              <div className="inv-brand__logo inv-brand__logo--placeholder" aria-hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 19h18M5 19V9l7-5 7 5v10" />
                </svg>
              </div>
            )}
            <div className="inv-brand__text">
              <div className="inv-brand__name">{c.name || 'Brand Name'}</div>
              <div className="inv-brand__tagline">{c.invoice_tagline || DEFAULTS.invoice_tagline}</div>
            </div>
          </div>
        </header>

        {/* ── Bill-to + Invoice meta ─────────────────────────────────── */}
        <section className="inv-meta">
          <div className="inv-meta__left">
            <div className="inv-meta__label">{(docType === 'QUOTATION' ? 'Quotation' : docType === 'PROFORMA' ? 'Proforma' : 'Invoice')} to:</div>
            <div className="inv-meta__customer">{customer?.name || 'Walk-in customer'}</div>
            {customer?.address && <div className="inv-meta__line">{customer.address}</div>}
            {customer?.phone   && <div className="inv-meta__line">{fmtBdPhone(customer.phone)}</div>}
            {customer?.email   && <div className="inv-meta__line">{customer.email}</div>}
          </div>
          <div className="inv-meta__right">
            <div className="inv-meta__row">
              <span className="inv-meta__label">{(docType === 'QUOTATION' ? 'Quotation#' : docType === 'PROFORMA' ? 'Proforma#' : 'Invoice#')}</span>
              <span className="inv-meta__val">{invoice?.number || '—'}</span>
            </div>
            <div className="inv-meta__row">
              <span className="inv-meta__label">Date</span>
              <span className="inv-meta__val">{fmtDate(invoice?.date)}</span>
            </div>
            {invoice?.due_date && (
              <div className="inv-meta__row">
                <span className="inv-meta__label">Due</span>
                <span className="inv-meta__val">{fmtDate(invoice.due_date)}</span>
              </div>
            )}
          </div>
        </section>

        {/* ── Items table ────────────────────────────────────────────── */}
        <section className="inv-table-wrap">
          <table className="inv-table">
            <thead>
              <tr style={{ '--accent': accent }}>
                <th className="inv-th inv-th--sl">SL.</th>
                <th className="inv-th inv-th--desc">Item Description</th>
                <th className="inv-th inv-th--num">Price</th>
                <th className="inv-th inv-th--num">Qty.</th>
                <th className="inv-th inv-th--num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(items || []).map((it, i) => (
                <tr key={it.id ?? i}>
                  <td className="inv-td">{i + 1}</td>
                  <td className="inv-td inv-td--desc">
                    <div className="inv-td__title">
                      {it.product_name || it.name || it.description || '—'}
                    </div>
                    {it.sku && <div className="inv-td__sub">{it.sku}</div>}
                    {it.note && <div className="inv-td__note">{it.note}</div>}
                  </td>
                  <td className="inv-td inv-td--num">{fmtMoney(it.unit_price, currencySymbol)}</td>
                  <td className="inv-td inv-td--num">{it.quantity}</td>
                  <td className="inv-td inv-td--num">
                    {fmtMoney(it.line_total ?? Number(it.unit_price || 0) * Number(it.quantity || 0), currencySymbol)}
                  </td>
                </tr>
              ))}
              {(!items || items.length === 0) && (
                <tr><td className="inv-td inv-td--empty" colSpan={5}>No items</td></tr>
              )}
            </tbody>
          </table>
        </section>

        {/* ── Bottom block: thank-you + totals ─────────────────────────
            Payment Info block (Account # / A/C Name / Bank Details)
            removed per spec — every tenant wanted a cleaner invoice
            footer. */}
        <section className="inv-bottom">
          <div className="inv-bottom__left">
            <div className="inv-thanks">{c.invoice_thank_you || DEFAULTS.invoice_thank_you}</div>
          </div>
          <div className="inv-bottom__right">
            <div className="inv-totals__row">
              <span className="inv-totals__lbl">Sub Total:</span>
              <span className="inv-totals__val">{fmtMoney(totals.subtotal, currencySymbol)}</span>
            </div>
            {Number(totals.discount) > 0 && (
              <div className="inv-totals__row">
                <span className="inv-totals__lbl">Discount:</span>
                <span className="inv-totals__val">−{fmtMoney(totals.discount, currencySymbol)}</span>
              </div>
            )}
            {/* VAT row — only render when there's an actual VAT
                charge. POS / Add Sale name the field "Vat", so we
                match that label here. A 0% / blank VAT row added
                noise to cash sale invoices for tenants who don't use
                VAT — hidden now. */}
            {(Number(totals.tax_rate) > 0 || Number(totals.tax_amount) > 0) && (
              <div className="inv-totals__row">
                <span className="inv-totals__lbl">Vat:</span>
                <span className="inv-totals__val">
                  {Number(totals.tax_amount) > 0
                    ? fmtMoney(totals.tax_amount, currencySymbol)
                    : `${Number(totals.tax_rate).toFixed(2)}%`}
                </span>
              </div>
            )}
            <div className="inv-totals__rule" style={{ background: accent }} />
            <div className="inv-totals__row inv-totals__row--grand">
              <span className="inv-totals__lbl">Total:</span>
              <span className="inv-totals__val">{fmtMoney(totals.total, currencySymbol)}</span>
            </div>
            {/* Payment + due block — three states driven entirely
                by paid vs total (recomputed at render time so a stale
                balance_due from the API can never lie):
                  • Fully paid  (paid = total)  → only "Paid" (green)
                  • Partial pay (0 < paid < total) → "Paid" + red
                    "Due (this invoice)" + red "Customer Total Due"
                  • Unpaid      (paid = 0)      → red "Due" + red
                    "Customer Total Due"
                Per spec partial invoices must surface BOTH the amount
                already paid AND the remaining due so the customer
                can see exactly what's settled and what's owed. */}
            {(() => {
              const totalN = Number(totals.total) || 0
              const paidN  = Number(totals.paid)  || 0
              const dueN   = Math.max(0, totalN - paidN)
              const fullyPaid = dueN < 0.005 && paidN > 0
              const partial   = paidN > 0 && dueN >= 0.005
              const showCustomerDue = !fullyPaid && Number(totals.customer_total_due) > 0
              return (
                <>
                  {(fullyPaid || partial) && (
                    <div className="inv-totals__row" style={{ color: '#047857', fontWeight: 700, marginTop: 6 }}>
                      <span className="inv-totals__lbl">Paid:</span>
                      <span className="inv-totals__val">{fmtMoney(paidN, currencySymbol)}</span>
                    </div>
                  )}
                  {dueN > 0.005 && (
                    <div className="inv-totals__row" style={{ color: '#b91c1c', fontWeight: 700, marginTop: partial ? 2 : 6 }}>
                      <span className="inv-totals__lbl">Due (this invoice):</span>
                      <span className="inv-totals__val">{fmtMoney(dueN, currencySymbol)}</span>
                    </div>
                  )}
                  {showCustomerDue && (
                    <div className="inv-totals__row" style={{ color: '#b91c1c', fontWeight: 700, borderTop: '1px dashed #fca5a5', paddingTop: 4, marginTop: 4 }}>
                      <span className="inv-totals__lbl">Customer Total Due:</span>
                      <span className="inv-totals__val">{fmtMoney(totals.customer_total_due, currencySymbol)}</span>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </section>

        {/* ── Terms & signature ─────────────────────────────────────── */}
        <footer className="inv-footer">
          <div className="inv-terms">
            <div className="inv-terms__title">Terms & Conditions</div>
            <div className="inv-terms__body">{c.invoice_terms || DEFAULTS.invoice_terms}</div>
            {c.invoice_footer_note && (
              <div className="inv-terms__note">{c.invoice_footer_note}</div>
            )}
          </div>
          <div className="inv-sign">
            <div className="inv-sign__line" />
            <div className="inv-sign__label">{c.invoice_authorised_sign || DEFAULTS.invoice_authorised_sign}</div>
          </div>
        </footer>
      </div>
    </div>
  )

  // Print-only mode portals to <body> so the @media print rule that
  // hides every other body child can find the slip as a sibling
  // (not nested inside a Modal / page wrapper / etc).
  if (mode === 'print-only' && typeof document !== 'undefined') {
    return createPortal(tree, document.body)
  }
  return tree
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped CSS. Kept inline so the component is self-contained — drop it
// anywhere and it prints identically.
// ─────────────────────────────────────────────────────────────────────────────
const INVOICE_CSS = `
.invoice-slip { color: #1f2937; font-family: 'Inter', system-ui, -apple-system, Segoe UI, sans-serif; }
.invoice-slip .inv-paper {
  background: #fff; max-width: 800px; margin: 0 auto;
  padding: 48px 56px; box-sizing: border-box;
}
.invoice-slip .inv-header {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
}
.invoice-slip .inv-title {
  font-size: 44px; font-weight: 900; letter-spacing: 0.02em;
  color: #111827; margin: 0; line-height: 1;
}
.invoice-slip .inv-brand { display: flex; align-items: center; gap: 12px; }
.invoice-slip .inv-brand__logo {
  width: 44px; height: 44px; object-fit: contain; border-radius: 6px;
}
.invoice-slip .inv-brand__logo--placeholder {
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #1f2937; color: #1f2937;
}
.invoice-slip .inv-brand__name {
  font-size: 20px; font-weight: 700; color: #111827; line-height: 1.1;
}
.invoice-slip .inv-brand__tagline {
  font-size: 9px; letter-spacing: 0.18em; color: #6b7280;
  text-transform: uppercase; margin-top: 2px;
}
.invoice-slip .inv-meta {
  display: flex; justify-content: space-between; gap: 32px;
  margin-top: 36px; font-size: 13px;
}
.invoice-slip .inv-meta__label {
  font-size: 12px; color: #6b7280; margin-bottom: 4px;
}
.invoice-slip .inv-meta__customer {
  font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 4px;
}
.invoice-slip .inv-meta__line { color: #374151; line-height: 1.5; }
.invoice-slip .inv-meta__right { text-align: right; min-width: 220px; }
.invoice-slip .inv-meta__row {
  display: flex; justify-content: space-between; gap: 18px; margin-bottom: 6px;
}
.invoice-slip .inv-meta__row .inv-meta__label {
  font-weight: 700; color: #111827; margin: 0;
}
.invoice-slip .inv-meta__val { color: #4b5563; }

.invoice-slip .inv-table-wrap { margin-top: 36px; }
.invoice-slip .inv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.invoice-slip .inv-table thead tr {
  border: 1.5px solid var(--accent, #14b8a6); border-radius: 8px;
}
.invoice-slip .inv-th {
  padding: 12px 10px; text-align: left;
  font-weight: 700; color: #111827; font-size: 13px;
}
.invoice-slip .inv-th--num { text-align: right; }
.invoice-slip .inv-th--sl  { width: 8%; }
.invoice-slip .inv-th--desc { width: 44%; }
.invoice-slip .inv-td {
  padding: 16px 10px; border-bottom: 1px solid #e5e7eb;
  vertical-align: top; color: #374151;
}
.invoice-slip .inv-td--num { text-align: right; white-space: nowrap; }
.invoice-slip .inv-td__title { color: #111827; }
.invoice-slip .inv-td__sub {
  font-size: 11px; color: #9ca3af; margin-top: 2px;
}
.invoice-slip .inv-td__note {
  font-size: 11px; color: #4b5563; margin-top: 2px; font-style: italic;
  white-space: pre-wrap;
}
.invoice-slip .inv-td--empty {
  text-align: center; color: #9ca3af; padding: 24px;
}

.invoice-slip .inv-bottom {
  display: flex; justify-content: space-between; gap: 32px;
  margin-top: 32px;
}
.invoice-slip .inv-thanks {
  font-size: 14px; font-weight: 700; color: #111827; margin-bottom: 18px;
}
.invoice-slip .inv-payment__title {
  font-size: 13px; font-weight: 700; color: #111827; margin-bottom: 6px;
}
.invoice-slip .inv-payment__row {
  display: flex; gap: 10px; font-size: 12px; line-height: 1.7;
}
.invoice-slip .inv-payment__lbl { color: #6b7280; min-width: 100px; }
.invoice-slip .inv-payment__val { color: #111827; }

.invoice-slip .inv-bottom__right { min-width: 260px; }
.invoice-slip .inv-totals__row {
  display: flex; justify-content: space-between; gap: 16px;
  font-size: 13px; padding: 6px 0; color: #374151;
}
.invoice-slip .inv-totals__lbl { color: #111827; font-weight: 600; }
.invoice-slip .inv-totals__rule { height: 1px; margin: 8px 0; }
.invoice-slip .inv-totals__row--grand {
  font-size: 18px; font-weight: 800; color: #111827;
  padding-top: 6px;
}

.invoice-slip .inv-footer {
  display: flex; justify-content: space-between; gap: 32px;
  margin-top: 48px;
}
.invoice-slip .inv-terms__title {
  font-size: 13px; font-weight: 700; color: #111827; margin-bottom: 6px;
}
.invoice-slip .inv-terms__body {
  font-size: 11px; color: #6b7280; line-height: 1.6; max-width: 380px;
}
.invoice-slip .inv-terms__note {
  font-size: 10px; color: #9ca3af; margin-top: 4px; font-style: italic;
}
.invoice-slip .inv-sign { text-align: center; min-width: 200px; align-self: flex-end; }
.invoice-slip .inv-sign__line {
  border-top: 1px solid #1f2937; width: 200px; margin-bottom: 4px;
}
.invoice-slip .inv-sign__label {
  font-size: 12px; font-weight: 600; color: #111827;
}

/* Print-only mode: invisible on screen, visible only when window.print() fires. */
.invoice-slip--print-only { display: none; }
@media print {
  /* Strategy: collapse every sibling element so the invoice flows
     from the top of the page instead of sitting in the middle of
     whatever leftover layout box visibility:hidden left behind. */
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.invoice-slip) { display: none !important; }
  /* Defensive: hide anything else that managed to inject itself
     above the slip (Sidebar/Header/Modal overlays mounted via portals). */
  body *:not(.invoice-slip):not(.invoice-slip *) { visibility: hidden !important; }
  .invoice-slip, .invoice-slip * { visibility: visible !important; }
  .invoice-slip {
    position: static !important;
    display: block !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .invoice-slip .inv-paper {
    max-width: 100% !important;
    margin: 0 !important;
    padding: 8mm 12mm !important;
    box-shadow: none !important;
  }
  @page { margin: 6mm; size: auto; }
}
`
