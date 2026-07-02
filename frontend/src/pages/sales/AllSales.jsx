import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Card from '../../components/ui/Card'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import CustomerTypeahead from '../../components/form/CustomerTypeahead'
import Modal from '../../components/ui/Modal'
import SearchInput from '../../components/ui/SearchInput'
import JsBarcode from 'jsbarcode'
import InvoiceSlip from '../../components/invoice/InvoiceSlip'
import { getSales, getCustomers, getSale, deleteSale, addPayment, finalizeSale, getCustomerCreditSummary } from '../../api/sales'
import EditShippingModal from '../../components/sales/EditShippingModal'
import { getLocations } from '../../api/products'
import { getPaymentAccounts } from '../../api/accounting'
import { getUsers } from '../../api/users'
import { getCompanyProfile } from '../../api/companyProfile'
import { useAuth } from '../../context/AuthContext'
import { fmtPhone } from '../../utils/phone'
import { DEMO_SALES, DEMO_LOCATIONS, DEMO_CUSTOMERS } from '../../data/demoSales'
import { useDefaultPageSize } from '../../context/SettingsContext'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const defaultDateFrom = `${currentYear}-01-01`
const defaultDateTo = `${currentYear}-12-31`

const PAYMENT_BADGE = {
  PAID: 'green',
  PARTIAL: 'yellow',
  DUE: 'red',
}

// Column list — Action is the FIRST column per spec, so the operator
// can hit the menu without scrolling on wide tables.
const ALL_COLUMNS = [
  { key: 'action', label: 'Action' },
  { key: 'date', label: 'Date' },
  { key: 'invoice_no', label: 'Invoice No' },
  { key: 'customer_name', label: 'Customer Name' },
  { key: 'location_name', label: 'Location' },
  { key: 'payment_status', label: 'Payment Status' },
  { key: 'total_amount', label: 'Total Amount' },
  { key: 'total_paid', label: 'Total Paid' },
  { key: 'sell_due', label: 'Sell Due' },
  { key: 'total_items', label: 'Total Items' },
  { key: 'added_by', label: 'Added By' },
  { key: 'service_staff', label: 'Service Staff' },
]

// Non-breaking space between currency mark and amount so they never wrap apart.
const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (s) => {
  if (!s) return '—'
  const d = new Date(s)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}
const fmtDateRangeDate = (s) => {
  if (!s) return ''
  const [y, m, d] = String(s).split('-')
  if (!y || !m || !d) return ''
  return `${m}/${d}/${y}`
}

// Enrich shared DEMO_SALES with the extra fields this list table consumes,
// so the page is fully populated when the backend is offline / errors out.
const PAYMENT_METHODS_DEMO = ['CASH', 'BKASH', 'CARD', 'BANK_TRANSFER', 'NAGAD']
const SHIPPING_STATUSES_DEMO = ['PENDING', 'SHIPPED', 'DELIVERED']

const buildDemoRows = () => DEMO_SALES.map((s, idx) => {
  const total = Number(s.total_amount || 0)
  const paid =
    s.payment_status === 'PAID' ? total :
    s.payment_status === 'PARTIAL' ? Math.round(total * 0.5) : 0
  const due = total - paid
  return {
    id: s.id,
    invoice_no: s.invoice_no,
    invoice_number: s.invoice_no,
    date: s.sale_date,
    created_at: s.sale_date,
    customer_id: s.customer_id,
    customer_name: s.customer_name,
    contact_number: DEMO_CUSTOMERS.find((c) => c.id === s.customer_id)?.phone || '',
    location_id: s.location_id,
    location_name: s.location_name,
    payment_status: s.payment_status,
    payment_method: PAYMENT_METHODS_DEMO[idx % PAYMENT_METHODS_DEMO.length],
    total_amount: total,
    total_paid: paid,
    amount_paid: paid,
    sell_due: due,
    balance_due: due,
    sell_return_due: 0,
    shipping_status: SHIPPING_STATUSES_DEMO[idx % SHIPPING_STATUSES_DEMO.length],
    item_count: (s.items || []).reduce((n, it) => n + Number(it.qty || 0), 0),
    meta: {},
    status: 'FINAL',
  }
})

const filterDemoRows = (rows, params) => {
  let out = rows
  if (params.search) {
    const q = String(params.search).toLowerCase()
    out = out.filter((r) =>
      `${r.invoice_no} ${r.customer_name} ${r.contact_number}`.toLowerCase().includes(q),
    )
  }
  if (params.location_id) out = out.filter((r) => r.location_id === params.location_id)
  if (params.customer_id) out = out.filter((r) => r.customer_id === params.customer_id)
  if (params.payment_status) out = out.filter((r) => r.payment_status === params.payment_status)
  if (params.shipping_status) out = out.filter((r) => r.shipping_status === params.shipping_status)
  return out
}

const buildDemoResponse = (params = {}) => {
  const all = filterDemoRows(buildDemoRows(), params)
  const limit = Number(params.limit) || 25
  const page = Number(params.page) || 1
  const start = (page - 1) * limit
  const results = all.slice(start, start + limit)
  const sum = (key) => all.reduce((s, r) => s + Number(r[key] || 0), 0)
  return {
    results,
    count: all.length,
    page,
    limit,
    total_pages: Math.max(Math.ceil(all.length / limit), 1),
    summary: {
      total_sales_amount: String(sum('total_amount')),
      total_paid: String(sum('total_paid')),
      total_due: String(sum('sell_due')),
    },
  }
}

function downloadText(filename, text, mime = 'text/plain;charset=utf-8;') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function ActionMenu({ row, canEdit, canDelete, onDelete, onPrintInvoice, onPackingSlip, onViewPayments, onAddPayment, onFinalize, onEditShipping, navigate }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  const close = () => setOpen(false)

  // Portal the menu out of the table so the overflow-x-auto wrapper
  // can't clip its top/bottom edges (visible-but-cut rows reported by
  // the operator). Position using viewport coords from the button.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      // Estimate menu height from the row state — the quotation
      // menu (with Finalize) is ~280px; everything else is ~280px.
      // We use a generous worst-case and flip the menu UPWARD when
      // there's more space above than below. Also keep `left`
      // inside the viewport so the menu never spills off the right
      // edge when the table is wide.
      const MENU_H = 320
      const spaceBelow = window.innerHeight - r.bottom
      const top = (spaceBelow >= MENU_H || spaceBelow >= r.top)
        ? r.bottom + 4
        : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 176 // matches w-44 (11rem * 16)
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setOpen(true)
  }

  const canTakePayment =
    row?.payment_status === 'DUE' ||
    row?.payment_status === 'PARTIAL' ||
    row?.status === 'QUOTATION'
  const isQuotation = row?.status === 'QUOTATION'

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? close() : openMenu())}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-soft transition"
      >
        Actions
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M5 7l5 6 5-6z" /></svg>
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-[60] cursor-default"
          />
          <div
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[70] w-44 overflow-hidden rounded-lg border border-gray-100 bg-white shadow-pop"
          >
            <button onClick={() => { close(); navigate(`/sales/${row.invoice_number || row.id}`) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">View</button>
            {isQuotation && onFinalize && (
              <button onClick={() => { close(); onFinalize(row) }} className="block w-full px-3 py-2 text-left text-xs font-semibold text-emerald-700 hover:bg-emerald-50">✓ Finalize → Sale</button>
            )}
            <button disabled={!canEdit} onClick={() => {
              close()
              // Edit on the ORIGIN screen: POS-made sales open back in the POS
              // cart (loaded for editing on the same page), everything else
              // keeps the inline detail editor.
              if ((row.meta?.source || '').toUpperCase() === 'POS') navigate(`/sales/pos?edit=${row.id}`)
              else navigate(`/sales/${row.invoice_number || row.id}?edit=1`)
            }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:text-gray-300">Edit</button>
            <button disabled={!canDelete} onClick={() => { close(); onDelete(row.id, row) }} className="block w-full px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 disabled:text-gray-300">Delete</button>
            <button onClick={() => { close(); onPrintInvoice(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">Print Invoice</button>
            {canTakePayment && (
              <button onClick={() => { close(); onAddPayment(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">Add Payment</button>
            )}
            <button onClick={() => { close(); onViewPayments(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">View Payments</button>
            <button onClick={() => { close(); navigate(`/sales/returns/new?sale_id=${row.id}`) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">Return Sale</button>
            <button onClick={() => { close(); onEditShipping(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">Edit Shipping</button>
            <button onClick={() => { close(); onPackingSlip(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">Packing Slip</button>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

export default function AllSales({
  forcedStatus = '',
  forcedSource = '',
  pageTitle = 'All Sales',
  pageSubtitle = 'Sales list with filters, exports, and actions.',
  addButtonLabel = '+ Add',
  addPath = '/sales/add',
  bannerTitle = 'Sales List POS',
  // 'user' (Salesperson) and 'subscription' filters removed per spec.
  // The set below is the canonical list of filter slots every variant
  // (All Sales / POS / Quotation / Drafts) gets unless a page passes
  // a narrower list explicitly.
  visibleFilters = ['location', 'status', 'customer', 'payment_status', 'source', 'date_range', 'added_by', 'service_staff', 'shipping_status'],
  searchUnderAddBar = false,
  listApi = getSales,
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const canEdit = user?.permissions?.includes('can_edit_sale') || ['owner', 'admin', 'manager'].includes(user?.role)
  // Delete is available to every user — the owner/admin can delete any sale
  // at any time, while a sub-user (manager / cashier) can delete only within
  // 24h of finalisation. The 24h window + role rule is enforced server-side
  // (see SaleDetailView.delete); the button stays enabled so staff get the
  // explanatory pop-up if they're past the window rather than a dead button.
  const canDelete = true

  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState({ total_sales_amount: '0', total_paid: '0', total_due: '0' })

  // ── Print Invoice + View Payments — both load full sale detail
  //    by row id, then route through either the print-only InvoiceSlip
  //    or the on-screen ViewPaymentsModal. Company profile is fetched
  //    once and shared so the printed slip and modal show the tenant's
  //    real brand/logo/payment info instead of the platform defaults.
  const [printSale,      setPrintSale]      = useState(null)
  const [paymentsSale,   setPaymentsSale]   = useState(null)
  const [companyProfile, setCompanyProfile] = useState(null)

  useEffect(() => {
    let cancelled = false
    getCompanyProfile()
      .then((p) => { if (!cancelled) setCompanyProfile(p || {}) })
      .catch(() => { if (!cancelled) setCompanyProfile({}) })
    return () => { cancelled = true }
  }, [])

  const onPrintInvoice = async (row) => {
    try {
      const full = await getSale(row.id)
      // Fetch the customer's other-invoices outstanding so the
      // printed slip carries Customer Total Due when present.
      let customer_total_due = 0
      const custId = full?.customer?.id || full?.customer_id
      if (custId) {
        try {
          const cs = await getCustomerCreditSummary(custId)
          const totalOutstanding = Number(cs?.current_due || 0)
          const thisDue = Number(full?.balance_due || 0)
          customer_total_due = Math.max(0, totalOutstanding - thisDue)
        } catch { /* leave at 0 */ }
      }
      setPrintSale({ ...full, _customer_total_due: customer_total_due })
      setTimeout(() => {
        window.print()
        setTimeout(() => setPrintSale(null), 300)
      }, 50)
    } catch (e) {
      alert(e?.message || 'Could not load sale for printing.')
    }
  }

  // ── Packing Slip ────────────────────────────────────────────────────────────
  // Opens a print window IN PLACE (no navigation to Shipments) with a
  // packing-slip document: company header, "Packing Slip", invoice no + date,
  // customer + shipping address, a Product / Quantity table (no prices), an
  // Authorized Signatory line and a Code-128 barcode of the invoice number.
  const onPackingSlip = async (row) => {
    try {
      const full = await getSale(row.id)
      const c = companyProfile || {}
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
      const number = full.invoice_number || full.invoice_no || '—'
      const dt = full.finalized_at || full.created_at
      const dateStr = dt
        ? new Date(dt).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—'
      const cust = full.customer || {}
      const custName = cust.name || full.customer_name || 'Walk-in customer'
      const agent = full.created_by_name || full.service_staff_name || ''

      const rowsHtml = (full.items || []).map((it, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.product_name || '')}${it.product_sku ? ` , ${esc(it.product_sku)}` : ''}${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}</td>
        <td class="r">${Number(it.quantity || 0).toFixed(2)}${it.unit_abbr ? ` ${esc(it.unit_abbr)}` : (it.unit_name ? ` ${esc(it.unit_name)}` : '')}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="empty">No items.</td></tr>'

      // Render the barcode SVG in this document, then serialise it into the
      // print window (no CDN / network dependency).
      let barcodeHtml = ''
      try {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        JsBarcode(svg, String(number), { format: 'CODE128', displayValue: true, fontSize: 14, height: 38, width: 1.5, margin: 0 })
        barcodeHtml = svg.outerHTML
      } catch { /* number prints below regardless */ }

      const w = window.open('', '_blank', 'width=840,height=920')
      if (!w) { window.alert('Allow popups to print the packing slip.'); return }
      w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Packing Slip ${esc(number)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,Arial,sans-serif;color:#1f2937;margin:0;padding:16px 22px;font-size:12px}
  .top{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6b7280;margin-bottom:10px}
  .top .mid{font-weight:600;color:#374151}
  .pack{text-align:right;color:#2563eb;font-size:12px;margin-bottom:6px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:28px}
  .co-name{font-weight:700;font-size:14px}
  .muted{color:#6b7280}
  .b{font-weight:700}
  .kv{display:flex;justify-content:space-between;gap:18px}
  .inv-label{font-size:22px;font-weight:700}
  .sec{display:flex;justify-content:space-between;gap:28px;margin-top:16px}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}
  th{background:#f3f4f6;color:#6b7280;text-align:left;padding:9px 8px;border:1px solid #e5e7eb;font-weight:600}
  td{padding:9px 8px;border:1px solid #e5e7eb;vertical-align:top}
  th.r,td.r{text-align:right} th.c,td.c{text-align:center;width:38px}
  .note{font-size:10px;color:#9ca3af}
  .empty{text-align:center;color:#9ca3af;padding:20px}
  .sign{margin-top:48px;font-weight:700}
  .barcode{margin-top:26px;text-align:center}
  @page{size:A4;margin:10mm}
</style></head><body>
<div class="top">
  <div>${esc(new Date().toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</div>
  <div class="mid">Sales List POS - ${esc(c.business_name || '')}</div>
  <div></div>
</div>
<div class="pack">Packing Slip</div>
<div class="head">
  <div>
    <div class="co-name">${esc(c.business_name || '')}</div>
    <div class="muted">${esc(c.address || '')}</div>
    <div><span class="b">Mobile:</span> ${esc(c.phone || '')}</div>
  </div>
  <div style="min-width:260px">
    <div class="kv"><span class="inv-label">Invoice No.</span><span class="inv-label">${esc(number)}</span></div>
    <div class="kv" style="margin-top:8px"><span class="b" style="font-size:15px">Date</span><span style="font-size:15px">${esc(dateStr)}</span></div>
  </div>
</div>
<div class="sec">
  <div>
    <div class="b">Customer</div>
    <div>${esc(custName)}</div>
    ${cust.phone ? `<div><span class="b">Mobile:</span> ${esc(cust.phone)}</div>` : ''}
    ${agent ? `<div><span class="b">Agent-</span> ${esc(agent)}</div>` : ''}
  </div>
  <div style="min-width:260px">
    <div class="b">Shipping Address:</div>
    <div class="muted">${esc(full.shipping_address || '')}</div>
  </div>
</div>
<table>
  <thead><tr><th class="c">#</th><th>Product</th><th class="r">Quantity</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div class="sign">Authorized Signatory</div>
<div class="barcode">${barcodeHtml}</div>
<script>window.onload=()=>setTimeout(()=>window.print(),250)</script>
</body></html>`)
      w.document.close()
    } catch (e) {
      alert(e?.message || 'Could not load the sale for the packing slip.')
    }
  }

  const onViewPayments = async (row) => {
    try {
      const full = await getSale(row.id)
      setPaymentsSale(full)
    } catch (e) {
      alert(e?.message || 'Could not load payments.')
    }
  }

  const [addPaymentSale, setAddPaymentSale] = useState(null)
  const onAddPayment = async (row) => {
    try {
      const full = await getSale(row.id)
      setAddPaymentSale(full)
    } catch (e) {
      alert(e?.message || 'Could not load sale for payment.')
    }
  }

  // Finalize a quotation → opens the FinalizeQuotationModal (payment
  // method + account like POS). On confirm it finalises the sale
  // (deducts stock) and records the payment(s) against the chosen
  // account(s), then the now-FINAL sale appears in All Sales.
  const [finalizeSale_, setFinalizeSale_] = useState(null)
  const onFinalize = async (row) => {
    try {
      const full = await getSale(row.id)
      setFinalizeSale_(full)
    } catch (e) {
      alert(e?.message || 'Could not load quotation for finalize.')
    }
  }
  // Edit Shipping — opens inline (no redirect to the Shipments page).
  const [shippingSale, setShippingSale] = useState(null)
  const onEditShipping = async (row) => {
    try {
      const full = await getSale(row.id)
      setShippingSale(full)
    } catch (e) {
      alert(e?.message || 'Could not load shipping details.')
    }
  }

  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // Set to true when the API explicitly returns "tenant_not_ready" so we
  // can show a friendly "workspace is being prepared" banner instead of
  // the demo-data fallback.
  const [tenantNotReady, setTenantNotReady] = useState(false)

  const [locations, setLocations] = useState([])
  const [customers, setCustomers] = useState([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [salesUsers, setSalesUsers] = useState([])
  const [serviceStaff, setServiceStaff] = useState([])
  // Map of user UUID → display name so the Salesperson / Service-staff
  // dropdowns show "Shakil Haque" instead of the raw UUID that comes back
  // on each sale row.
  const [usersById, setUsersById] = useState({})

  const [search, setSearch] = useState('')
  // Collapsible Filters + list cards — clicking the header toggles
  // visibility. Defaults open so nothing changes for first-load
  // muscle memory; the operator can hide them to free up vertical
  // space.
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [listOpen,    setListOpen]    = useState(true)
  const [filters, setFilters] = useState(() => {
    // Seed customer / payment-status filters from the URL so deep links like
    // /sells?customer_id=…&payment_status=DUE (e.g. the Customers page
    // "Open invoices" button) land pre-filtered to that customer's open
    // sales instead of the full list.
    const qp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
    return {
      location_id: '',
      customer_id: qp.get('customer_id') || '',
      status: '',
      payment_status: (qp.get('payment_status') || '').toUpperCase(),
      date_from: defaultDateFrom,
      date_to: defaultDateTo,
      user_id: '',
      service_staff: '',
      shipping_status: '',
      source: (forcedSource || '').toUpperCase(),
      subscription: false,
    }
  })
  const [sortBy, setSortBy] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  const dateRangeLabel = `${fmtDateRangeDate(filters.date_from)} - ${fmtDateRangeDate(filters.date_to)}`
  const visibleFilterSet = useMemo(() => new Set(visibleFilters), [visibleFilters])

  const [visibleCols, setVisibleCols] = useState(() => ALL_COLUMNS.map((c) => c.key))
  // Column Visibility dropdown removed; visibleCols stays at the
  // default ALL_COLUMNS set for every tenant.

  const buildDefaultFilters = useCallback(() => ({
    location_id: '',
    customer_id: '',
    status: (forcedStatus || '').toUpperCase(),
    payment_status: '',
    date_from: defaultDateFrom,
    date_to: defaultDateTo,
    user_id: '',
    service_staff: '',
    shipping_status: '',
    source: (forcedSource || '').toUpperCase(),
    subscription: false,
  }), [forcedStatus, forcedSource])

  useEffect(() => {
    // Prevent stale filters/search carrying between Sales tabs that reuse this component.
    setFilters(buildDefaultFilters())
    setSearch('')
    setCustomerSearch('')
    setPage(1)
  }, [location.pathname, buildDefaultFilters])

  useEffect(() => {
    const status = (forcedStatus || '').toUpperCase()
    setFilters((f) => ({ ...f, status: status || '' }))
    setPage(1)
  }, [forcedStatus])

  useEffect(() => {
    const source = (forcedSource || '').toUpperCase()
    setFilters((f) => ({ ...f, source: source || '' }))
    setPage(1)
  }, [forcedSource])

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => `${c.name} ${c.phone || ''}`.toLowerCase().includes(q))
  }, [customers, customerSearch])

  const loadMaster = useCallback(async () => {
    try {
      const [locs, custs] = await Promise.all([getLocations(true), getCustomers({ active_only: 'true' })])
      const lArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
      const cArr = Array.isArray(custs) ? custs : (custs?.results ?? [])
      setLocations(lArr.length ? lArr : DEMO_LOCATIONS)
      setCustomers(cArr.length ? cArr : DEMO_CUSTOMERS)
      // Single-branch (free tier) → default the Business Location filter to
      // the only branch so it shows the branch name instead of All Locations.
      if (lArr.length === 1) {
        setFilters((f) => ({ ...f, location_id: f.location_id || String(lArr[0].id) }))
      }
    } catch {
      setLocations(DEMO_LOCATIONS)
      setCustomers(DEMO_CUSTOMERS)
    }
    // Load tenant users for the Salesperson / Service-staff dropdowns so we
    // can map a sale's created_by_id / finalized_by_id UUID to a real name.
    // Non-fatal: if the user can't list /api/users/ the dropdowns just fall
    // back to showing a shortened UUID.
    try {
      const res = await getUsers()
      const arr = Array.isArray(res) ? res : (res?.results ?? [])
      const map = {}
      for (const u of arr) {
        map[String(u.id)] = u.name || u.username || u.email || String(u.id)
      }
      setUsersById(map)
    } catch { /* ignore */ }
  }, [])

  const loadSales = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const params = {
        page,
        limit,
        search: search || undefined,
        location_id: filters.location_id || undefined,
        customer_id: filters.customer_id || undefined,
        status: filters.status || undefined,
        payment_status: filters.payment_status || undefined,
        date_from: filters.date_from || undefined,
        date_to: filters.date_to || undefined,
        user_id: filters.user_id || undefined,
        service_staff: filters.service_staff || undefined,
        shipping_status: filters.shipping_status || undefined,
        source: filters.source || undefined,
        subscription: filters.subscription ? 'true' : undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
      }
      let data = await listApi(params)

      // Safety retry for All Sales search:
      // if user searches but hidden stale filters return zero rows,
      // retry once with relaxed filters so records are still discoverable.
      const isBaseAllSales = !forcedStatus && !forcedSource
      const hasStrictFilters = Boolean(
        filters.location_id ||
        filters.customer_id ||
        filters.status ||
        filters.payment_status ||
        filters.user_id ||
        filters.service_staff ||
        filters.shipping_status ||
        filters.source ||
        filters.subscription
      )
      const noRows = (data?.results ?? []).length === 0
      if (isBaseAllSales && search && hasStrictFilters && noRows) {
        data = await listApi({
          page,
          limit,
          search,
          date_from: filters.date_from || undefined,
          date_to: filters.date_to || undefined,
          sort_by: sortBy,
          sort_dir: sortDir,
        })
      }

      setRows(data?.results ?? [])
      setCount(data?.count ?? 0)
      setTotalPages(data?.total_pages ?? 1)
      setSummary(data?.summary ?? { total_sales_amount: '0', total_paid: '0', total_due: '0' })

      const users = new Set()
      const staff = new Set()
      ;(data?.results ?? []).forEach((r) => {
        if (r.created_by_id) users.add(r.created_by_id)
        if (r.finalized_by_id) staff.add(r.finalized_by_id)
      })
      setSalesUsers([...users])
      setServiceStaff([...staff])
    } catch (err) {
      // If the backend explicitly tells us the tenant DB isn't ready yet,
      // show an empty state + friendly banner — NOT demo data (which would
      // look like there are sales when there are none).
      if (err?.status === 503 && err?.errors?.code === 'tenant_not_ready') {
        setTenantNotReady(true)
        setRows([])
        setCount(0)
        setTotalPages(1)
        setSummary({ total_sales_amount: '0', total_paid: '0', total_due: '0' })
        setLoadError('')
      } else {
        setTenantNotReady(false)
        // Fall back to demo data so the page is testable while the backend is offline.
        const demo = buildDemoResponse({
          page,
          limit,
          search,
          location_id: filters.location_id,
          customer_id: filters.customer_id,
          payment_status: filters.payment_status,
          shipping_status: filters.shipping_status,
        })
        setRows(demo.results)
        setCount(demo.count)
        setTotalPages(demo.total_pages)
        setSummary(demo.summary)
        setLoadError(
          `${err?.message || 'Failed to load sales list.'} — showing demo data so the UI remains testable.`,
        )
      }
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters, sortBy, sortDir, listApi, forcedStatus, forcedSource])

  useEffect(() => {
    loadMaster().catch(() => {})
  }, [loadMaster])

  useEffect(() => {
    loadSales().catch(() => setLoading(false))
  }, [loadSales])

  const toggleSort = (col) => {
    const map = {
      date: 'date',
      invoice_no: 'invoice_no',
      customer_name: 'customer_name',
      location_name: 'location',
      total_amount: 'total_amount',
      total_paid: 'total_paid',
      sell_due: 'sell_due',
    }
    const target = map[col]
    if (!target) return
    if (sortBy === target) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(target)
      setSortDir('desc')
    }
  }

  const onDelete = async (saleId, sale) => {
    // Stronger prompt for FINAL sales so the operator knows they're
    // reversing stock + cash-account balance, not just hiding a row.
    const isFinal = String(sale?.status || '').toUpperCase() === 'FINAL'
    const isPrivileged = ['owner', 'admin'].includes(user?.role)
    const prompt = isFinal
      ? (
        'Delete this FINAL sale?\n\n'
        + 'This will:\n'
        + '  • Return every line item back to stock\n'
        + '  • Reverse the payment-account balance\n'
        + '  • Reverse the accounting entries\n\n'
        + (isPrivileged
            ? 'As an owner/admin you can delete a sale at any time; staff can only '
              + 'delete within 24 hours of finalisation.'
            : 'Cashiers and managers can only delete within 24 hours of finalisation. '
              + 'After that, ask the owner or create a Sell Return.')
      )
      : 'Delete this sale?'
    if (!window.confirm(prompt)) return
    try {
      await deleteSale(saleId)
      loadSales()
    } catch (err) {
      window.alert(err.message || 'Delete failed')
    }
  }

  const exportRows = rows
  const exportHeaders = ALL_COLUMNS.filter((c) => c.key !== 'action')

  const toPlainValue = (r, key) => {
    if (key === 'date') return fmtDate(r.date || r.created_at)
    if (key === 'total_amount') return r.total_amount
    if (key === 'total_paid') return r.total_paid || r.amount_paid
    if (key === 'sell_due') return r.sell_due || r.balance_due
    if (key === 'sell_return_due') return r.sell_return_due || '0.00'
    return r[key] ?? ''
  }

  const onExportCsv = () => {
    const lines = [
      exportHeaders.map((h) => `"${h.label}"`).join(','),
      ...exportRows.map((r) => exportHeaders.map((h) => `"${String(toPlainValue(r, h.key)).replace(/"/g, '""')}"`).join(',')),
    ]
    downloadText('all-sales.csv', lines.join('\n'), 'text/csv;charset=utf-8;')
  }

  const onExportExcel = () => {
    const lines = [
      exportHeaders.map((h) => h.label).join('\t'),
      ...exportRows.map((r) => exportHeaders.map((h) => String(toPlainValue(r, h.key))).join('\t')),
    ]
    downloadText('all-sales.xls', lines.join('\n'), 'application/vnd.ms-excel;charset=utf-8;')
  }

  // Build a clean, tabular printable view in a NEW window so we don't
  // print the whole app chrome (filters, sidebar, navbar). Browser's
  // "Save as PDF" target on the popup's Print dialog gives the
  // tenant the PDF — same flow as Excel/CSV downloads.
  const openPrintWindow = () => {
    const w = window.open('', '_blank', 'width=1200,height=800')
    if (!w) { window.alert('Allow popups to export this report.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const fmt = (v) => Number.isFinite(Number(v))
      ? Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : esc(v)

    const headRow = exportHeaders.map((h) => `<th>${esc(h.label)}</th>`).join('')
    const bodyRows = exportRows.map((r) => (
      '<tr>' + exportHeaders.map((h) => {
        const v = toPlainValue(r, h.key)
        const numeric = ['total_amount', 'total_paid', 'sell_due', 'sell_return_due', 'tax_amount'].includes(h.key)
        return `<td${numeric ? ' class="num"' : ''}>${numeric ? fmt(v) : esc(v)}</td>`
      }).join('') + '</tr>'
    )).join('')

    // Aggregate footer — sum the financial columns so the PDF
    // doubles as a quick reconciliation slip.
    const totals = exportRows.reduce((acc, r) => ({
      total_amount: acc.total_amount + Number(r.total_amount || 0),
      total_paid:   acc.total_paid + Number(r.total_paid || r.amount_paid || 0),
      sell_due:     acc.sell_due + Number(r.sell_due || r.balance_due || 0),
    }), { total_amount: 0, total_paid: 0, sell_due: 0 })

    const footRow = '<tr class="ft">' + exportHeaders.map((h) => {
      if (h.key === 'invoice_no') return '<td><b>Total</b></td>'
      if (h.key === 'total_amount') return `<td class="num"><b>${fmt(totals.total_amount)}</b></td>`
      if (h.key === 'total_paid')   return `<td class="num"><b>${fmt(totals.total_paid)}</b></td>`
      if (h.key === 'sell_due')     return `<td class="num"><b>${fmt(totals.sell_due)}</b></td>`
      return '<td></td>'
    }).join('') + '</tr>'

    const fromTo = (filters.date_from && filters.date_to)
      ? `${filters.date_from} → ${filters.date_to}`
      : 'All time'
    w.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(pageTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 18mm 12mm; color: #111827; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #f3f4f6; color: #374151; text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
  tbody td { padding: 6px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.ft td { background: #ecfdf5; border-top: 2px solid #10b981; }
  .footer { margin-top: 8px; color: #9ca3af; font-size: 10px; text-align: right; }
  @page { size: A4 landscape; margin: 10mm; }
</style></head>
<body>
  <h1>${esc(pageTitle)}</h1>
  <div class="meta">Date range: <b>${esc(fromTo)}</b> · Rows: <b>${exportRows.length}</b> · Generated: ${new Date().toLocaleString()}</div>
  <table>
    <thead><tr>${headRow}</tr></thead>
    <tbody>${bodyRows || `<tr><td colspan="${exportHeaders.length}" style="text-align:center;color:#9ca3af;padding:24px">No rows for the current filters.</td></tr>`}</tbody>
    ${exportRows.length ? `<tfoot>${footRow}</tfoot>` : ''}
  </table>
  <div class="footer">${esc(pageTitle)} — generated by the system.</div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100) }</script>
</body></html>`)
    w.document.close()
  }
  const onExportPdf = openPrintWindow
  const onPrint    = openPrintWindow

  const visibleSet = new Set(visibleCols)
  const show = (key) => visibleSet.has(key)

  const paidCount = rows.filter((r) => r.payment_status === 'PAID').length
  const dueCount = rows.filter((r) => r.payment_status === 'DUE').length
  const paymentMethodCounts = rows.reduce((acc, r) => {
    const m = r.payment_method || 'Unknown'
    acc[m] = (acc[m] || 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-5 py-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">{pageTitle}</h1>
            <p className="mt-1 text-sm text-emerald-50">{pageSubtitle}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* "+ Add Sale" / "+ Add Quotation" / etc. button removed
                per spec — operators add new sales from the dedicated
                Add Sale / POS pages, not from inside the list view.
                Export + Print actions remain since they apply to the
                currently filtered list. */}
            <Button variant="secondary" onClick={onExportCsv}>Export CSV</Button>
            <Button variant="secondary" onClick={onExportExcel}>Export Excel</Button>
            <Button variant="secondary" onClick={onExportPdf}>Export PDF</Button>
            <Button variant="secondary" onClick={onPrint}>Print</Button>
          </div>
        </div>
      </div>

      {tenantNotReady && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-200 text-xs font-bold text-blue-800">i</span>
          <div className="flex-1">
            <p className="font-semibold">Your workspace is being prepared</p>
            <p className="text-xs mt-0.5">
              This usually takes less than a minute. Refresh the page in a moment, or contact support
              if it persists.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      )}

      {loadError && !tenantNotReady && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-200 text-xs font-bold text-amber-800">!</span>
          <span>{loadError}</span>
        </div>
      )}

      <Card padding="p-4">
        {/* Header is now a click-to-collapse toggle. The Reset link
            still works but stops the click from bubbling up. */}
        <div
          className="mb-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 cursor-pointer select-none hover:bg-gray-100"
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <svg
              className={`h-3.5 w-3.5 text-gray-500 transition-transform ${filtersOpen ? 'rotate-90' : ''}`}
              viewBox="0 0 20 20" fill="currentColor"
            >
              <path d="M7.05 4.05a.75.75 0 011.06 0l5.13 5.13a1.25 1.25 0 010 1.77l-5.13 5.13a.75.75 0 11-1.06-1.06L11.94 10 7.05 5.11a.75.75 0 010-1.06z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Filters</p>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setPage(1)
              setFilters(buildDefaultFilters())
              setSearch('')
            }}
            className="text-xs text-brand-700 hover:underline"
          >
            Reset
          </button>
        </div>
        {filtersOpen && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visibleFilterSet.has('location') && (
            <select value={filters.location_id} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, location_id: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">Business Location</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          {visibleFilterSet.has('status') && (
            <select value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">Status</option>
              <option value="QUOTATION">Quotation</option>
              <option value="PROFORMA">Proforma</option>
              <option value="DRAFT">Draft</option>
              <option value="FINAL">Final</option>
              <option value="PENDING">Pending</option>
              <option value="VOIDED">Voided</option>
            </select>
          )}


          {visibleFilterSet.has('customer') && (
            // Modern typeahead — two-line rows (name bold + phone +
            // optional email), live phone normalisation (leading "0"
            // restored on the fly), Walk-in shortcut at the top.
            // Same component drives Add Sale, Shipments, etc.
            <div>
              <CustomerTypeahead
                customers={customers}
                value={customerSearch}
                onChange={(v) => setCustomerSearch(v)}
                onPick={(c) => {
                  setPage(1)
                  setCustomerSearch(c ? c.name : '')
                  setFilters((f) => ({ ...f, customer_id: c ? c.id : '' }))
                }}
                inputClassName="h-8 w-full rounded-md border border-gray-200 bg-white pl-8 pr-2.5 text-xs text-navy-800 placeholder-gray-400 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>
          )}

          {visibleFilterSet.has('payment_status') && (
            <select value={filters.payment_status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, payment_status: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">Payment Status</option>
              <option value="PAID">Paid</option>
              <option value="PARTIAL">Partial</option>
              <option value="DUE">Due</option>
            </select>
          )}

          {visibleFilterSet.has('source') && (
            <select value={filters.source} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, source: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">Source</option>
              <option value="POS">POS</option>
              <option value="DIRECT">Direct</option>
              <option value="ONLINE">Online</option>
            </select>
          )}

          {visibleFilterSet.has('date_range') && (
            <div>
              {/* Shared preset picker — Today / Yesterday / Last 7 /
                  Last 30 / This Month / Last Month / This month last
                  year / This Year / Last Year / Current financial
                  year / Last financial year / Custom Range. The
                  ranges are computed live so they always match the
                  tenant's current calendar.

                  Sized down from md:col-span-2 to a single cell so
                  the new Added By search filter can sit next to it
                  without overflowing on tablet widths. */}
              <DateRangePresetPicker
                from={filters.date_from}
                to={filters.date_to}
                onChange={({ from, to }) => { setPage(1); setFilters((f) => ({ ...f, date_from: from, date_to: to })) }}
              />
            </div>
          )}

          {visibleFilterSet.has('added_by') && (
            // Plain select — same look and behaviour as the
            // Shipping Status filter (user request: one
            // consistent dropdown design across the filter bar).
            <select
              value={filters.user_id}
              onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, user_id: e.target.value })) }}
              className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Added By</option>
              {Object.entries(usersById)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
            </select>
          )}

          {visibleFilterSet.has('user') && (
            <select value={filters.user_id} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, user_id: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">User (Salesperson)</option>
              {/* List every active user — see Service Staff comment below
                  for why we no longer derive this from sale rows. */}
              {Object.entries(usersById)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
            </select>
          )}

          {visibleFilterSet.has('service_staff') && (
            <select
              value={filters.service_staff}
              onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, service_staff: e.target.value })) }}
              className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Service Staff</option>
              {Object.entries(usersById)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
            </select>
          )}

          {visibleFilterSet.has('shipping_status') && (
            <select value={filters.shipping_status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, shipping_status: e.target.value })) }} className="h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
              <option value="">Shipping Status</option>
              <option value="PENDING">Pending</option>
              <option value="SHIPPED">Shipped</option>
              <option value="DELIVERED">Delivered</option>
            </select>
          )}

          {visibleFilterSet.has('subscription') && (
            <label className="flex items-center gap-2 h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 cursor-pointer hover:border-gray-300">
              <input type="checkbox" checked={filters.subscription} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, subscription: e.target.checked })) }} className="h-3.5 w-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-200" />
              Subscription
            </label>
          )}

          {!searchUnderAddBar && (
            // Shorter than before so it doesn't dominate the filter
            // row — the field still does the same thing, just lives
            // in a single grid cell instead of stretching across the
            // whole row.
            <div>
              <SearchInput value={search} onChange={(v) => { setPage(1); setSearch(v) }} placeholder="Search invoice / customer…" />
            </div>
          )}

          {/* Column Visibility dropdown removed per spec — the
              default ALL_COLUMNS layout is the only one tenants
              need; per-row customisation was rarely used and added
              clutter. */}
        </div>
        )}
      </Card>

      {/* Section title doubles as a collapse toggle for the list +
          summary + search blocks below it. Click to hide the entire
          card stack and free up vertical space. */}
      <button
        type="button"
        onClick={() => setListOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-slate-50"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-2">
          <svg
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${listOpen ? 'rotate-90' : ''}`}
            viewBox="0 0 20 20" fill="currentColor"
          >
            <path d="M7.05 4.05a.75.75 0 011.06 0l5.13 5.13a1.25 1.25 0 010 1.77l-5.13 5.13a.75.75 0 11-1.06-1.06L11.94 10 7.05 5.11a.75.75 0 010-1.06z" />
          </svg>
          {bannerTitle}
        </h2>
      </button>

      {listOpen && searchUnderAddBar && (
        <Card padding="p-3">
          <div className="max-w-sm">
            <SearchInput value={search} onChange={(v) => { setPage(1); setSearch(v) }} placeholder="Search invoice / customer…" />
          </div>
        </Card>
      )}

      {listOpen && (
      <>
      {/* Summary tiles + main list table — both collapse together. */}

      {/* Summary tiles */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Sales</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtMoney(summary.total_sales_amount)}</div>
          <div className="mt-1 h-1 w-full rounded-full bg-gradient-to-r from-indigo-400 to-sky-400" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Paid</div>
          <div className="mt-2 text-2xl font-semibold text-emerald-600">{fmtMoney(summary.total_paid)}</div>
          <div className="mt-1 h-1 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Due</div>
          <div className="mt-2 text-2xl font-semibold text-rose-600">{fmtMoney(summary.total_due)}</div>
          <div className="mt-1 h-1 w-full rounded-full bg-gradient-to-r from-rose-400 to-orange-400" />
        </div>
      </div>

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 text-sm">
          <div className="text-gray-500">Showing {Math.min((page - 1) * limit + 1, count || 0)} to {Math.min(page * limit, count)} of {count} entries</div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Show</span>
            <select value={limit} onChange={(e) => { setPage(1); setLimit(Number(e.target.value)) }} className="rounded border border-gray-300 px-2 py-1 text-sm">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-gray-500">entries</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                {ALL_COLUMNS.filter((c) => show(c.key)).map((c) => {
                  // Money columns render right-aligned data; align their
                  // headers the same way so the label sits over the numbers
                  // instead of leaving a gap on the left.
                  const isNum = ['total_amount', 'total_paid', 'sell_due', 'sell_return_due', 'tax_amount'].includes(c.key)
                  return (
                    <th key={c.key} className={`px-4 py-3 ${isNum ? 'text-right' : ''}`}>
                      <button
                        className={`inline-flex items-center gap-1 ${isNum ? 'justify-end w-full' : ''}`}
                        onClick={() => toggleSort(c.key)}
                      >
                        {c.label}
                        {sortBy === c.key || (c.key === 'location_name' && sortBy === 'location') ? (
                          <span>{sortDir === 'asc' ? '↑' : '↓'}</span>
                        ) : null}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={visibleCols.length} className="px-4 py-10 text-center text-gray-400">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={visibleCols.length} className="px-4 py-10 text-center text-gray-400">No sales found</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50/60">
                  {/* Action cell first — LEFTMOST per spec. */}
                  {show('action') && (
                    <td className="px-4 py-3 text-left">
                      <ActionMenu
                        row={r}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onDelete={onDelete}
                        onPrintInvoice={onPrintInvoice}
                        onPackingSlip={onPackingSlip}
                        onViewPayments={onViewPayments}
                        onAddPayment={onAddPayment}
                        onFinalize={onFinalize}
                        onEditShipping={onEditShipping}
                        navigate={navigate}
                      />
                    </td>
                  )}
                  {show('date') && <td className="px-4 py-3 text-gray-600">{fmtDate(r.date || r.created_at)}</td>}
                  {show('invoice_no') && <td className="px-4 py-3 font-mono text-xs">
                    {r.id ? (
                      <button
                        onClick={() => navigate(`/sales/${r.invoice_number || r.invoice_no || r.id}`)}
                        className="text-brand-600 hover:text-brand-700 hover:underline"
                      >
                        {r.invoice_no || r.invoice_number || '—'}
                      </button>
                    ) : (r.invoice_no || r.invoice_number || '—')}
                  </td>}
                  {show('customer_name') && <td className="px-4 py-3 text-gray-700">{r.customer_name || 'Walk-in'}</td>}
                  {show('contact_number') && <td className="px-4 py-3 text-gray-600">{fmtPhone(r.contact_number) || '—'}</td>}
                  {show('location_name') && <td className="px-4 py-3 text-gray-600">{r.location_name || '—'}</td>}
                  {show('payment_status') && (
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onViewPayments(r)}
                        title="View payment history"
                        className="cursor-pointer"
                      >
                        <Badge variant={PAYMENT_BADGE[r.payment_status] || 'gray'}>
                          {r.payment_status || 'DUE'}
                        </Badge>
                      </button>
                    </td>
                  )}
                  {show('payment_method') && <td className="px-4 py-3 text-gray-600">{r.payment_method || '—'}</td>}
                  {/* Financial columns are basic transaction info — every
                      user who can see the sales list sees the sale's own
                      Total / Paid / Due, sourced straight from the
                      serializer (total_amount, amount_paid→total_paid,
                      balance_due→sell_due). Previously gated behind
                      can_view_reports, which blanked them to "—" for
                      cashiers even on sales they rang up. */}
                  {show('total_amount') && <td className="px-4 py-3 text-right font-medium text-gray-900 whitespace-nowrap tabular-nums">{fmtMoney(r.total_amount)}</td>}
                  {show('total_paid') && <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap tabular-nums">{fmtMoney(r.total_paid ?? r.amount_paid)}</td>}
                  {show('sell_due') && <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap tabular-nums">{fmtMoney(r.sell_due ?? r.balance_due)}</td>}
                  {show('sell_return_due') && <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap tabular-nums">{fmtMoney(r.sell_return_due || 0)}</td>}
                  {show('shipping_status') && <td className="px-4 py-3 text-gray-600">{r.shipping_status || r.meta?.shipping_status || '—'}</td>}
                  {show('total_items') && <td className="px-4 py-3 text-gray-600">{Number(r.item_count || 0).toFixed(2)}</td>}
                  {/* "Added By" — the user account that saved the sale
                      (owner/admin). Falls back to location_name only
                      when no user record is linked. */}
                  {show('added_by') && (
                    <td className="px-4 py-3 text-gray-600">
                      {r.created_by_name || r.finalized_by_name || r.location_name || '—'}
                    </td>
                  )}
                  {/* "Service Staff" — the salesperson the cashier
                      picked on Add Sale (resolved server-side from
                      meta.service_staff UUID → user name). Just the
                      name, no parentheses. */}
                  {show('service_staff') && (
                    <td className="px-4 py-3 text-gray-700">
                      {r.service_staff_name || '—'}
                    </td>
                  )}
                  {show('sell_note') && <td className="px-4 py-3 text-gray-600">{r.meta?.sell_note || '—'}</td>}
                  {show('staff_note') && <td className="px-4 py-3 text-gray-600">{r.meta?.staff_note || '—'}</td>}
                  {show('shipping_details') && <td className="px-4 py-3 text-gray-600">{r.meta?.shipping_details || '—'}</td>}
                  {show('table') && <td className="px-4 py-3 text-gray-600">{r.meta?.table_ref || '—'}</td>}
                </tr>
              ))}
            </tbody>
            {!loading && rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-gray-200 bg-gray-100 text-xs font-semibold text-gray-700">
                  <td className="px-4 py-3" colSpan={Math.max(1, visibleCols.length)}>
                    Total: Paid - {paidCount} | Due - {dueCount} | Methods: {Object.entries(paymentMethodCounts).map(([k, v]) => `${k} - ${v}`).join(', ') || '—'} | Sales: {fmtMoney(summary.total_sales_amount)} | Paid: {fmtMoney(summary.total_paid)} | Due: {fmtMoney(summary.total_due)} | Items: {Number(summary.total_items ?? rows.reduce((s, r) => s + Number(r.item_count || 0), 0)).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
          <div className="text-xs text-gray-500">Page {page} of {totalPages}</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      </Card>
      </>
      )}

      {/* ── Print-only InvoiceSlip ────────────────────────────────────
          Mounts only while a sale is queued for printing. The
          @media print rules baked into InvoiceSlip's scoped CSS hide
          everything else on the page, so window.print() emits ONLY
          the tenant-branded slip — not the All Sales filter chrome
          the user saw before. */}
      {printSale && (
        <InvoiceSlip
          mode="print-only"
          company={companyProfile}
          invoice={{
            number:   printSale.invoice_number || printSale.invoice_no || '—',
            date:     printSale.finalized_at || printSale.created_at,
            due_date: printSale.due_date,
            location_code: printSale.location_code,
            location_name: printSale.location_name,
          }}
          customer={{
            name:    printSale.customer?.name || printSale.customer_name || 'Walk-in customer',
            address: printSale.customer?.address,
            phone:   printSale.customer?.phone,
            email:   printSale.customer?.email,
          }}
          items={(printSale.items || []).map((it) => ({
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
            subtotal:   printSale.subtotal,
            discount:   printSale.discount,
            tax_amount: printSale.tax_amount,
            tax_rate:   printSale.tax_rate,
            total:      printSale.total_amount,
            // Without these, the slip's recompute defaults paid=0 →
            // dueN = total, which made every Print-Invoice click on a
            // PAID sale still print "Due (this invoice)". Now we pass
            // the real numbers through.
            paid:                printSale.amount_paid,
            balance_due:         printSale.balance_due,
            customer_total_due:  printSale._customer_total_due,
          }}
        />
      )}

      {/* ── View Payments modal ──────────────────────────────────── */}
      {paymentsSale && (
        <ViewPaymentsModal
          sale={paymentsSale}
          company={companyProfile}
          onClose={() => setPaymentsSale(null)}
        />
      )}

      {/* ── Add Payment modal ────────────────────────────────────── */}
      {addPaymentSale && (
        <AddPaymentModal
          sale={addPaymentSale}
          company={companyProfile}
          onClose={() => setAddPaymentSale(null)}
          onSaved={() => { setAddPaymentSale(null); loadSales() }}
        />
      )}

      {/* ── Finalize Quotation modal ─────────────────────────────── */}
      {finalizeSale_ && (
        <FinalizeQuotationModal
          sale={finalizeSale_}
          onClose={() => setFinalizeSale_(null)}
          onSaved={() => { setFinalizeSale_(null); loadSales() }}
        />
      )}

      {/* ── Edit Shipping modal (inline — stays on this page) ─────── */}
      {shippingSale && (
        <EditShippingModal
          sale={shippingSale}
          onClose={() => setShippingSale(null)}
          onSaved={() => { setShippingSale(null); loadSales() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// ViewPaymentsModal — fires from Action ▾ → "View Payments" AND from
// clicking the Payment Status badge on a row. Shows customer + business
// header plus the payment history table for the sale.
// ─────────────────────────────────────────────────────────────────────
function ViewPaymentsModal({ sale, company, onClose }) {
  const payments = sale.sale_payments || sale.payments || []
  const fmtBdt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtDateTime = (d) => {
    if (!d) return '—'
    const dt = new Date(d)
    if (Number.isNaN(dt.getTime())) return String(d)
    return dt.toLocaleString()
  }
  const PAY_METHOD_LABEL = {
    CASH: 'Cash', CARD: 'Card', BANK_TRANSFER: 'Bank Transfer',
    BKASH: 'bKash', NAGAD: 'Nagad', CHEQUE: 'Cheque', CREDIT: 'Credit',
    MOBILE: 'Mobile Wallet', MIXED: 'Mixed',
  }
  const invoiceNo = sale.invoice_number || sale.invoice_no || (sale.id ? String(sale.id).slice(0, 8) : '—')
  const customerName = sale.customer?.name || sale.customer_name || 'Walk-in customer'
  const businessName = company?.name || ''
  const businessLine = [company?.address, company?.phone && `Mobile: ${company.phone}`]
    .filter(Boolean).join('\n')

  return (
    <Modal open onClose={onClose} title={`View Payments — Invoice ${invoiceNo}`} size="3xl">
      <div className="space-y-4">
        {/* Header strip */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-lg border border-gray-100 bg-gray-50/60 p-4 text-sm">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Customer</p>
            <p className="mt-1 font-medium text-gray-900">{customerName}</p>
            {sale.customer?.phone && <p className="text-xs text-gray-600">{sale.customer.phone}</p>}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Business</p>
            <p className="mt-1 font-medium text-gray-900">{businessName || '—'}</p>
            {company?.address && <p className="text-xs text-gray-600 whitespace-pre-line">{company.address}</p>}
            {company?.phone && <p className="text-xs text-gray-600">Mobile: {company.phone}</p>}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Invoice</p>
            <p className="mt-1 font-medium text-gray-900">#{invoiceNo}</p>
            <p className="text-xs text-gray-600">Date: {fmtDateTime(sale.finalized_at || sale.created_at)}</p>
            <p className="text-xs text-gray-600">Status: <span className="font-semibold">{sale.payment_status || '—'}</span></p>
          </div>
        </div>

        {/* Payments table */}
        <div className="overflow-x-auto rounded-lg border border-gray-100">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Reference No</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Payment Method</th>
                <th className="px-3 py-2 text-left">Payment Note</th>
                <th className="px-3 py-2 text-left">Payment Account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {payments.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No payments recorded.</td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50/60">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDateTime(p.paid_at || p.created_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{p.reference || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900 tabular-nums">{fmtBdt(p.amount)}</td>
                  <td className="px-3 py-2 text-gray-700">{PAY_METHOD_LABEL[p.method] || p.method || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{p.notes || p.note || '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{p.payment_account_name || p.payment_account || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// AddPaymentModal — used from Action ▾ → "Add Payment" on DUE / PARTIAL
// / QUOTATION rows. Saves via addPayment(sale_id, ...) and the chosen
// payment_account_id drives the Account Book ledger the money lands in.
// ─────────────────────────────────────────────────────────────────────
function AddPaymentModal({ sale, company, onClose, onSaved }) {
  const balanceDue = Math.max(0, Number(sale.total_amount || 0) - Number(sale.amount_paid || 0))
  const [amount,   setAmount]   = useState(balanceDue ? balanceDue.toFixed(2) : '')
  const [method,   setMethod]   = useState('CASH')
  const [paidOn,   setPaidOn]   = useState(() => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [accountId,    setAccountId]    = useState('')
  const [note,         setNote]         = useState('')
  const [accounts,     setAccounts]     = useState([])
  const [saving,       setSaving]       = useState(false)
  const [err,          setErr]          = useState('')
  // Customer advance balance — lets the cashier settle this due from the
  // customer's prepaid credit, same as the POS multiple-pay modal.
  const [advanceBalance, setAdvanceBalance] = useState(0)

  // Method-specific fields. Each is only relevant when the matching
  // payment_method is selected; they're sent through to the server
  // anyway since the backend ignores keys that don't apply.
  const [cardNumber,        setCardNumber]        = useState('')
  const [cardHolderName,    setCardHolderName]    = useState('')
  const [cardTransactionNo, setCardTransactionNo] = useState('')
  const [cardType,          setCardType]          = useState('CREDIT_CARD')
  const [cardMonth,         setCardMonth]         = useState('')
  const [cardYear,          setCardYear]          = useState('')
  const [cardSecurityCode,  setCardSecurityCode]  = useState('')
  const [chequeNo,          setChequeNo]          = useState('')
  const [bankAccountNo,     setBankAccountNo]     = useState('')

  useEffect(() => {
    getPaymentAccounts({ active: 'true' })
      .then((res) => {
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        setAccounts(arr)
      })
      .catch(() => setAccounts([]))
  }, [])

  // Pull the customer's advance (prepaid) balance so "Advance Balance"
  // can be offered as a payment method.
  useEffect(() => {
    const cid = sale.customer_id || sale.customer?.id
    if (!cid) { setAdvanceBalance(0); return }
    getCustomerCreditSummary(cid)
      .then((res) => setAdvanceBalance(Number(res?.advance_balance || 0)))
      .catch(() => setAdvanceBalance(0))
  }, [sale])

  const invoiceNo = sale.invoice_number || sale.invoice_no || (sale.id ? String(sale.id).slice(0, 8) : '—')
  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const submit = async () => {
    setErr('')
    const amt = Number(amount)
    if (!amt || amt <= 0) { setErr('Amount must be greater than zero.'); return }
    if (amt > balanceDue) { setErr(`Amount cannot exceed balance due (${fmt(balanceDue)}).`); return }
    if (!method) { setErr('Pick a payment method.'); return }
    if (method === 'ADVANCE' && amt > advanceBalance) {
      setErr(`Amount exceeds the customer's advance balance (${fmt(advanceBalance)}).`); return
    }
    // Method-specific required fields — mirror the same gating the
    // POS / Add Sale page use so the recorded payment is auditable.
    if (method === 'CARD' && !cardNumber.trim()) { setErr('Card Number is required for Card payments.'); return }
    if (method === 'CHEQUE' && !chequeNo.trim()) { setErr('Cheque No. is required for Cheque payments.'); return }
    if (method === 'BANK_TRANSFER' && !bankAccountNo.trim()) { setErr('Bank Account No is required for Bank Transfer payments.'); return }

    // Pick the best reference for this method. Cheque uses the cheque
    // number, Bank Transfer the bank account number, Card the
    // transaction number — all flow into SalePayment.reference so the
    // Account Book / List Payments rows carry an audit token.
    const referenceForLedger =
      (method === 'CARD' && cardTransactionNo) ||
      (method === 'CHEQUE' && chequeNo) ||
      (method === 'BANK_TRANSFER' && bankAccountNo) ||
      ''

    setSaving(true)
    try {
      await addPayment(sale.id, {
        amount:             amt,
        method,
        payment_account_id: method === 'ADVANCE' ? undefined : (accountId || undefined),
        reference:          referenceForLedger || note || undefined,
        notes:              note || undefined,
        paid_on:            paidOn ? new Date(paidOn).toISOString() : undefined,
        // Method-specific extras. Backend silently drops keys that
        // don't apply to the chosen method.
        ...(method === 'CARD' && {
          card_number:         cardNumber,
          card_holder_name:    cardHolderName,
          card_transaction_no: cardTransactionNo,
          card_type:           cardType,
          card_month:          cardMonth,
          card_year:           cardYear,
          card_security_code:  cardSecurityCode,
        }),
        ...(method === 'CHEQUE' && { cheque_no: chequeNo }),
        ...(method === 'BANK_TRANSFER' && { bank_account_no: bankAccountNo }),
      })
      onSaved?.()
    } catch (e) {
      setErr(e?.message || 'Failed to record payment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Add payment" size="2xl">
      <div className="space-y-4">
        {/* Header strip — Customer / Invoice / Total */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3 text-sm">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Customer</p>
            <p className="mt-0.5 font-medium text-gray-900">{sale.customer?.name || sale.customer_name || 'Walk-in customer'}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Invoice No.</p>
            <p className="mt-0.5 font-medium text-gray-900">{invoiceNo}</p>
            <p className="text-xs text-gray-500">{company?.name || '—'}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Total amount</p>
            <p className="mt-0.5 font-bold text-gray-900">{fmt(sale.total_amount)}</p>
            <p className="text-xs text-rose-600">Balance due: {fmt(balanceDue)}</p>
          </div>
        </div>

        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Amount *</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Paid on *</label>
            <input type="datetime-local" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Payment Method *</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="BKASH">bKash</option>
              <option value="NAGAD">Nagad</option>
              <option value="CHEQUE">Cheque</option>
              <option value="MOBILE">Mobile Wallet</option>
              <option value="ADVANCE">Advance Balance</option>
            </select>
            {method === 'ADVANCE' && (
              <p className="mt-1 text-[11px] text-emerald-700">Advance Balance: {fmt(advanceBalance)}</p>
            )}
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Payment Account</label>
            <select
              value={method === 'ADVANCE' ? '' : accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={method === 'ADVANCE'}
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm disabled:bg-gray-100 disabled:text-gray-400"
            >
              <option value="">{method === 'ADVANCE' ? 'Not required' : 'None'}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.account_type ? ` (${a.account_type})` : ''}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">
              {method === 'ADVANCE'
                ? 'Paid from the customer’s advance balance — no account needed.'
                : 'The recorded payment posts against this account on the Account Book / List Accounts page.'}
            </p>
          </div>

          {/* ── CARD-specific fields ───────────────────────────────── */}
          {method === 'CARD' && (
            <>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Card Number</label>
                <input
                  inputMode="numeric"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value.replace(/[^\d ]/g, ''))}
                  placeholder="Card Number"
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Card holder name</label>
                <input
                  value={cardHolderName}
                  onChange={(e) => setCardHolderName(e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))}
                  placeholder="Card holder name"
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Card Transaction No.</label>
                <input
                  value={cardTransactionNo}
                  onChange={(e) => setCardTransactionNo(e.target.value)}
                  placeholder="Card Transaction No."
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Card Type</label>
                <select value={cardType} onChange={(e) => setCardType(e.target.value)} className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">
                  <option value="CREDIT_CARD">Credit Card</option>
                  <option value="DEBIT_CARD">Debit Card</option>
                  <option value="PREPAID">Prepaid</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Month</label>
                <input
                  inputMode="numeric" maxLength={2}
                  value={cardMonth}
                  onChange={(e) => setCardMonth(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  placeholder="MM"
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Year</label>
                <input
                  inputMode="numeric" maxLength={4}
                  value={cardYear}
                  onChange={(e) => setCardYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="YYYY"
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Security Code</label>
                <input
                  inputMode="numeric" maxLength={4}
                  value={cardSecurityCode}
                  onChange={(e) => setCardSecurityCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="CVV"
                  className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
              </div>
            </>
          )}

          {/* ── CHEQUE-specific field ──────────────────────────────── */}
          {method === 'CHEQUE' && (
            <div className="md:col-span-3">
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Cheque No.</label>
              <input
                value={chequeNo}
                onChange={(e) => setChequeNo(e.target.value)}
                placeholder="Cheque No."
                className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
              />
            </div>
          )}

          {/* ── BANK TRANSFER-specific field ───────────────────────── */}
          {method === 'BANK_TRANSFER' && (
            <div className="md:col-span-3">
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Bank Account No</label>
              <input
                inputMode="numeric"
                value={bankAccountNo}
                onChange={(e) => setBankAccountNo(e.target.value.replace(/[^\d -]/g, ''))}
                placeholder="Bank Account No"
                className="h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
              />
            </div>
          )}

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Payment Note</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Reference / receipt number / note…" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={submit} loading={saving} disabled={saving}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// FinalizeQuotationModal — Action ▾ → "Finalize → Sale" on a QUOTATION
// row. Works exactly like the POS payment step:
//   • Finalising deducts FIFO stock and turns the quotation into a
//     FINAL sale (so it now shows on All Sales).
//   • The owner picks one or MORE payment rows. Each row's amount is
//     posted to the chosen Payment Account, so the money lands in the
//     right List Accounts ledger (cash → cash account, bank → that bank
//     account, etc.) — multi-pay supported just like POS.
// ─────────────────────────────────────────────────────────────────────
function FinalizeQuotationModal({ sale, onClose, onSaved }) {
  const total = Number(sale.total_amount || 0)
  const [accounts, setAccounts] = useState([])
  const [rows, setRows] = useState([
    { method: 'CASH', payment_account_id: '', amount: total ? total.toFixed(2) : '' },
  ])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    getPaymentAccounts({ active: 'true' })
      .then((res) => setAccounts(Array.isArray(res) ? res : (res?.results ?? [])))
      .catch(() => setAccounts([]))
  }, [])

  const fmt = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const paidTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  const setRow = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, { method: 'CASH', payment_account_id: '', amount: '' }])
  const removeRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const METHODS = [
    ['CASH', 'Cash'], ['CARD', 'Card'], ['BANK_TRANSFER', 'Bank Transfer'],
    ['MOBILE_BANKING', 'Mobile Banking'], ['CHEQUE', 'Cheque'], ['CREDIT', 'Credit (due)'],
  ]

  const submit = async () => {
    setErr('')
    const payRows = rows.filter((r) => Number(r.amount) > 0)
    if (paidTotal > total + 0.01) {
      setErr(`Payments (${fmt(paidTotal)}) exceed the quotation total (${fmt(total)}).`)
      return
    }
    setSaving(true)
    try {
      // 1. Finalise — deducts FIFO stock, assigns invoice number.
      await finalizeSale(sale.id)
      // 2. Record each payment row against its chosen account.
      for (const r of payRows) {
        if (r.method === 'CREDIT') continue   // credit = leave as due, no ledger entry
        await addPayment(sale.id, {
          amount:             Number(r.amount),
          method:             r.method,
          payment_account_id: r.payment_account_id || undefined,
        })
      }
      window.alert('Quotation finalised. It now appears in All Sales.')
      onSaved?.()
    } catch (e) {
      const msg = e?.errors?.detail || e?.payload?.detail || e?.message || 'Failed to finalize quotation.'
      if (e?.status === 409 && e?.payload?.back_order_required) {
        setErr('Not enough stock to finalise. Some items are short — restock or reduce quantities first.')
        window.alert('Not enough stock to finalise this quotation.')
      } else {
        setErr(msg)
        window.alert(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  const invoiceNo = sale.invoice_number || sale.invoice_no || (sale.id ? String(sale.id).slice(0, 8) : '—')
  const lbl = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1'
  const ipt = 'h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title={`Finalize Quotation — ${invoiceNo}`} size="2xl">
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
          <span className="text-gray-600">Quotation total</span>
          <span className="font-semibold text-gray-900">{fmt(total)}</span>
        </div>
        <p className="text-xs text-gray-500">
          Finalising deducts stock and converts this quotation into a sale. Add one or more
          payment lines below — each amount lands in the chosen account (just like POS).
          Leave blank / use “Credit (due)” to finalise on account.
        </p>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_36px] gap-2 items-end">
              <div>
                {i === 0 && <label className={lbl}>Payment Method</label>}
                <select value={r.method} onChange={(e) => setRow(i, { method: e.target.value })} className={ipt}>
                  {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                {i === 0 && <label className={lbl}>Payment Account</label>}
                <select
                  value={r.payment_account_id}
                  onChange={(e) => setRow(i, { payment_account_id: e.target.value })}
                  className={ipt}
                  disabled={r.method === 'CREDIT'}
                >
                  <option value="">Select account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}{a.account_type ? ` (${a.account_type})` : ''}</option>
                  ))}
                </select>
              </div>
              <div>
                {i === 0 && <label className={lbl}>Amount</label>}
                <input
                  type="number" min="0" step="0.01"
                  value={r.amount}
                  onChange={(e) => setRow(i, { amount: e.target.value })}
                  className={ipt}
                  disabled={r.method === 'CREDIT'}
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                className="h-9 rounded-md border border-gray-200 text-gray-400 hover:text-rose-600 disabled:opacity-40"
                title="Remove line"
              >×</button>
            </div>
          ))}
          <button type="button" onClick={addRow} className="text-xs font-semibold text-brand-600 hover:text-brand-700">+ Add another payment line</button>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm">
          <span className="text-gray-600">Total entered</span>
          <span className={`font-semibold ${paidTotal > total + 0.01 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(paidTotal)}</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Finalize Sale</Button>
      </div>
    </Modal>
  )
}

