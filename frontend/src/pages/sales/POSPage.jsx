import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Card from '../../components/ui/Card'
import useUnsavedChangesPrompt from '../../hooks/useUnsavedChangesPrompt'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import InvoiceSlip from '../../components/invoice/InvoiceSlip'
import PosInvoiceSlip from '../../components/invoice/PosInvoiceSlip'
import RegisterSlip from '../../components/invoice/RegisterSlip'
import { showToast } from '../../lib/toast.jsx'
import OutOfStockModal from '../../components/OutOfStockModal'
// Reuse the Customers page's full Add/Edit Contact modal so the POS
// "+ Add Customer" button opens the exact same rich form.
import { CustomerModal } from '../contacts/CustomersPage'
import { useAuth } from '../../context/AuthContext'
import { fmtPhone } from '../../utils/phone'
import { useSettings, fmtCurrency } from '../../context/SettingsContext'

import { getProducts, getCategories, getBrands, getLocations, scanProductByCode, createProduct } from '../../api/products'
import { getCustomers, createSale, addPayment, finalizeSale, getCustomerCreditSummary, getPosSales, getQuotationSales, deleteSale, getSale, updateSale } from '../../api/sales'
import { getRegisterDetails, closeRegister } from '../../api/reports'
import { getAccounts, createExpense, getPaymentAccounts, createPaymentAccount } from '../../api/accounting'
import { getUsers } from '../../api/users'

// Module-level money formatter. Used by sub-components (PaymentModal,
// MultiplePayModal, ReceiptModal, etc.) that render outside POSPage's
// closure. Inside POSPage itself, the same function is shadowed with a
// settings-aware variant so the active currency symbol is respected.
const fmtMoney = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, {
  month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const TILE_TINTS = [
  'from-blue-50 to-blue-100/40',
  'from-emerald-50 to-emerald-100/40',
  'from-amber-50 to-amber-100/40',
  'from-rose-50 to-rose-100/40',
  'from-violet-50 to-violet-100/40',
  'from-cyan-50 to-cyan-100/40',
  'from-orange-50 to-orange-100/40',
  'from-lime-50 to-lime-100/40',
]
const tintFor = (id) => {
  let h = 0
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) | 0
  return TILE_TINTS[Math.abs(h) % TILE_TINTS.length]
}

const METHOD_LABEL = {
  CASH: 'Cash', CARD: 'Card', CREDIT: 'Credit', BKASH: 'bKash', NAGAD: 'Nagad', BANK_TRANSFER: 'Bank Transfer', CHEQUE: 'Cheque', MOBILE: 'Mobile Payment', OTHER: 'Other',
}

/**
 * Backend accepts only: CASH | CARD | BANK_TRANSFER | MOBILE | OTHER.
 * Map the UI-facing methods (bKash/Nagad/Cheque/Credit) into the closest
 * backend code, and prefix the original method name into the reference so
 * the original choice is still visible on the receipt / payment history.
 */
/**
 * Build a useful error string from a DRF / axios error.
 * Without this you just see "Validation failed." which hides the real cause.
 */
function extractError(err) {
  const fieldErrors = err?.errors
  if (fieldErrors && typeof fieldErrors === 'object') {
    const parts = []
    for (const [k, v] of Object.entries(fieldErrors)) {
      const msg = Array.isArray(v) ? v.join(', ') : String(v)
      parts.push(`${k}: ${msg}`)
    }
    return parts.join('\n') || err?.message || 'Failed to record sale.'
  }
  return err?.message || 'Failed to record sale.'
}

function mapMethod(uiMethod, reference = '') {
  const TO_BACKEND = {
    CASH:          { method: 'CASH'          },
    CARD:          { method: 'CARD'          },
    BANK_TRANSFER: { method: 'BANK_TRANSFER' },
    BKASH:         { method: 'MOBILE', prefix: 'bKash' },
    NAGAD:         { method: 'MOBILE', prefix: 'Nagad' },
    MOBILE:        { method: 'MOBILE'        },
    ADVANCE:       { method: 'ADVANCE'       },
    CHEQUE:        { method: 'OTHER',  prefix: 'Cheque' },
    CREDIT:        { method: 'OTHER',  prefix: 'Credit' },
    OTHER:         { method: 'OTHER'         },
  }
  const m = TO_BACKEND[uiMethod] || { method: 'OTHER', prefix: uiMethod }
  const ref = m.prefix
    ? (reference ? `${m.prefix}: ${reference}` : m.prefix)
    : reference
  return { method: m.method, reference: ref }
}

export default function POSPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const settings = useSettings()
  const fmtMoney = (n) => fmtCurrency(n, settings)
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Master data
  const [locations,  setLocations]  = useState([])
  const [categories, setCategories] = useState([])
  const [customers,  setCustomers]  = useState([])
  const [products,   setProducts]   = useState([])
  // Payment accounts (cash boxes / banks / wallets) — needed both by the
  // MultiplePayModal AND by the express Cash button so its SalePayment
  // row writes a PaymentAccountTransaction into the right cash account.
  const [paymentAccounts, setPaymentAccounts] = useState([])
  // Service-staff options — list of {id, label} from the tenant's real
  // users (the owner plus every active sub-user). Used to populate the
  // Service Staff dropdown so it's not stuck on the logged-in user.
  const [staffRoster, setStaffRoster] = useState([])

  // UI state
  const [locationId, setLocationId] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [customerId, setCustomerId] = useState('')
  // Credit snapshot for the currently-selected customer. Null until a
  // registered customer is picked; the Credit Sale button reads
  // creditSummary?.is_credit_eligible to gate itself.
  const [creditSummary, setCreditSummary] = useState(null)
  const [creditLoading, setCreditLoading] = useState(false)
  const [tableRef,    setTableRef]    = useState('')
  const [serviceStaff, setServiceStaff] = useState('')
  // Only the tenant OWNER may pick any team member as service staff. Every
  // sub-user (admin / manager / cashier) sees only themselves and is
  // auto-assigned to their own name. Role + id come from the logged-in
  // user (DB-backed); nothing hardcoded. Derived (not baked into the
  // fetch) so it re-resolves once the user hydrates from storage.
  const isOwner = user?.role === 'owner'
  const serviceStaffOptions = useMemo(() => {
    if (isOwner || !user?.id) return staffRoster
    const me = staffRoster.find((s) => s.id === String(user.id))
    return me ? [me] : []
  }, [staffRoster, isOwner, user?.id])
  useEffect(() => {
    if (!isOwner && user?.id) setServiceStaff(String(user.id))
  }, [isOwner, user?.id])
  // Two independent search inputs:
  //   • cartQuickSearch — the quick-add box on the cart panel; types
  //     trigger a small dropdown to add a single product to the cart.
  //   • gridSearch — the search box above the product TILE grid on
  //     the right; drives the visible tile list only.
  // They used to share one state, which meant typing in either filled
  // both, surprising cashiers who wanted one to stay put.
  const [cartQuickSearch, setCartQuickSearch] = useState('')
  const [gridSearch,      setGridSearch]      = useState('')

  const [items,    setItems]    = useState([])
  // Out-of-stock pop-up payload — { message, shortfalls } | null.
  const [stockAlert, setStockAlert] = useState(null)
  // Seed the cart's discount + order-tax from the Sale tab so cashiers
  // don't have to retype them. They remain editable per sale.
  // Blank (not "0") when the default is zero, so the cashier sees an empty
  // field rather than a stray 0 to clear.
  const [discount, setDiscount] = useState(() => settings.num('sale.default_discount', 0) || '')
  const [taxPct,   setTaxPct]   = useState(() => settings.num('tax.default_rate', 0) || '')

  // If settings finish loading after the page mounts, hydrate the cart
  // defaults once (only when the user hasn't already touched them).
  const [defaultsSeeded, setDefaultsSeeded] = useState(false)
  useEffect(() => {
    if (defaultsSeeded || settings.loading) return
    if (Object.keys(settings.data || {}).length === 0) return
    setDiscount((cur) => (Number(cur) === 0 ? (settings.num('sale.default_discount', 0) || '') : cur))
    setTaxPct((cur)   => (Number(cur) === 0 ? (settings.num('tax.default_rate', 0) || '')     : cur))
    setDefaultsSeeded(true)
  }, [settings, defaultsSeeded])

  // Modals
  const [addCustomerOpen, setAddCustomerOpen] = useState(false)
  // Quick "add new product" modal triggered from the + button next to
  // the product search box. Lets the cashier register a brand-new
  // SKU on the fly (name + price are required; SKU + barcode auto-
  // generate if blank) and drops it straight into the current cart.
  const [addProductOpen, setAddProductOpen] = useState(false)
  const [payOpen,         setPayOpen]         = useState(null)
  const [savingDraftAs,   setSavingDraftAs]   = useState(null)
  const [addExpenseOpen,  setAddExpenseOpen]  = useState(false)
  // Shipping modal — same five fields as the Add Sale Shipping card.
  // Lives in cart state so the cashier can fill it once per sale; the
  // Save / Charge handlers fold it into the meta blob the backend
  // saves on Sale.meta. The Shipments page reads these from meta
  // directly (no migration needed).
  const [shippingOpen, setShippingOpen] = useState(false)
  // Recent Transactions modal — opens via the floating bottom-right
  // button. Two tabs (Final / Quotation) populated live from
  // /api/sales/pos-sales/ + /api/sales/quotations/.
  const [recentOpen, setRecentOpen] = useState(false)
  // When editing a recent transaction in-place: { id, status, invoice_number,
  // readOnly }. Editable (QUOTATION/DRAFT) sales update in place on save;
  // FINAL sales load read-only (can't change committed items).
  const [editingSale, setEditingSale] = useState(null)
  // Full sale being previewed/printed as a classic POS invoice (image format).
  const [printSale, setPrintSale] = useState(null)
  // Register Details modal — opens via the top-bar button. Data
  // pulled live from /api/reports/register/details/ (cashier ×
  // location × today). All buckets are computed from per-tenant DB.
  const [registerOpen, setRegisterOpen] = useState(false)
  // Close Register modal — same shape as Details but with the
  // counted-cash / counted-card / counted-cheque inputs the cashier
  // reconciles against the drawer.
  const [closeRegOpen, setCloseRegOpen] = useState(false)
  // Mini calculator — pure client-side, no backend. Floats over POS
  // so the cashier can do a quick arithmetic check without leaving
  // the till.
  const [calcOpen, setCalcOpen] = useState(false)
  const [shipping, setShipping] = useState({
    shipping_details:  '',
    shipping_address:  '',
    shipping_charges:  '0',
    shipping_status:   '',
    delivered_to:      '',
  })
  const [completedSale,   setCompletedSale]   = useState(null)

  // Sale-specific confirmation toast when a sale is finalised on POS.
  useEffect(() => {
    if (!completedSale) return
    const inv = completedSale.invoice_number || (completedSale.id ? String(completedSale.id).slice(0, 8) : '')
    showToast({ title: 'Sale recorded', message: inv ? `Invoice #${inv} saved.` : 'Invoice saved.' })
  }, [completedSale])

  useEffect(() => {
    (async () => {
      try {
        const [locs, cats, custs, accts, usersRes] = await Promise.all([
          getLocations(true).catch(() => []),
          getCategories().catch(() => []),
          getCustomers({ active_only: 'true' }).catch(() => []),
          getPaymentAccounts({ active: 'true' }).catch(() => []),
          getUsers().catch(() => []),
        ])
        const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
        setLocations(locArr)
        setPaymentAccounts(Array.isArray(accts) ? accts : (accts?.results ?? []))
        const userArr = Array.isArray(usersRes) ? usersRes : (usersRes?.results ?? [])
        const staffOpts = userArr
          .filter((u) => u.is_active !== false && u.status !== 'suspended')
          .map((u) => ({
            id:    String(u.id),
            label: u.name || u.username || u.email || String(u.id).slice(0, 8),
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
        setStaffRoster(staffOpts)
        setCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
        setCustomers(Array.isArray(custs) ? custs : (custs?.results ?? []))
        if (locArr.length) setLocationId(locArr[0].id)
      } catch { /* ignore */ }
    })()
  }, [])

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const params = { limit: 36, light: 'true' }
        // Tile grid is driven solely by the right-panel search box.
        if (gridSearch.trim()) params.search = gridSearch.trim()
        if (categoryFilter !== 'all') params.category_id = categoryFilter
        const res = await getProducts(params)
        setProducts(Array.isArray(res) ? res : (res?.results ?? []))
      } catch {
        setProducts([])
      }
    }, 200)
    return () => clearTimeout(t)
  }, [gridSearch, categoryFilter])

  // ── Keyboard shortcuts (bindings come from Settings → Sales on POS) ──
  // Each binding stored as e.g. "shift+e" / "f2" / "ctrl+alt+p" — we
  // normalise the event the same way and look the trigger up in this map.
  const shortcutMap = useMemo(() => {
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
    return {
      [norm(settings.str('pos.ks.express_checkout'))]: 'express',
      [norm(settings.str('pos.ks.pay_checkout'))]:     'pay',
      [norm(settings.str('pos.ks.draft'))]:            'draft',
      [norm(settings.str('pos.ks.cancel'))]:           'cancel',
      [norm(settings.str('pos.ks.goto_qty'))]:         'goto_qty',
      [norm(settings.str('pos.ks.weighing_scale'))]:   'weighing',
      [norm(settings.str('pos.ks.edit_discount'))]:    'edit_discount',
      [norm(settings.str('pos.ks.edit_order_tax'))]:   'edit_order_tax',
      [norm(settings.str('pos.ks.add_payment_row'))]:  'add_payment_row',
      [norm(settings.str('pos.ks.finalize_payment'))]: 'finalize_payment',
      [norm(settings.str('pos.ks.add_new_product'))]:  'add_new_product',
    }
  }, [settings.data])

  // Refs let the keyboard handler focus inputs without re-rendering.
  const discountRef = useRef(null)
  const taxRef      = useRef(null)
  const searchRef   = useRef(null)
  const firstQtyRef = useRef(null)
  // Always-current shortcut dispatcher. The keydown listener is registered
  // once, so without this ref it would close over the FIRST render's handlers
  // (and an empty `items`), making shortcuts look broken once a cart is built.
  const shortcutActionRef = useRef(null)

  // Track when the listener is registered so a small badge in the UI
  // can confirm visually that shortcuts are wired (helps debug "nothing
  // happens" reports — if you don't see the badge, the build didn't ship).
  const [shortcutsArmed, setShortcutsArmed] = useState(false)

  useEffect(() => {
    const normaliseEventCombo = (e) => {
      const parts = []
      if (e.ctrlKey)  parts.push('ctrl')
      if (e.altKey)   parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      // Prefer e.code for letter keys so the binding is keyboard-layout
      // independent (KeyI → 'i' regardless of Shift / CapsLock state).
      let k = ''
      if (typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code)) {
        k = e.code.slice(3).toLowerCase()
      } else if (typeof e.code === 'string' && /^Digit\d$/.test(e.code)) {
        k = e.code.slice(5)
      } else if (typeof e.key === 'string') {
        k = e.key.toLowerCase()
      }
      if (!k || ['shift', 'control', 'alt', 'meta'].includes(k)) return null
      parts.push(k)
      return parts.join('+')
    }

    const onKeyDown = (e) => {
      const combo = normaliseEventCombo(e)
      if (!combo) return
      const action = shortcutMap[combo]
      if (!action) return

      // Only suppress shortcuts while typing in a genuinely free-text field
      // (a TEXTAREA like the Sell Note, or a contentEditable). Plain INPUTs —
      // most importantly the always-focused product search / qty boxes — must
      // still honour the shortcuts, otherwise shift+letter combos never fire
      // on the POS because the search box steals focus by default.
      const inFreeText =
        e.target && (e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)
      const looksLikeTyping = inFreeText && !e.ctrlKey && !e.altKey && !e.metaKey
        && !/^f\d+$/i.test(combo.split('+').pop() || '')
      if (looksLikeTyping) return

      e.preventDefault()
      e.stopPropagation()
      // Dispatch through the ref so we always run the LATEST handlers /
      // cart state, not the ones captured when the listener was registered.
      shortcutActionRef.current?.(action)
    }
    // capture:true makes sure we see the event before any inner React
    // handler can stopPropagation it (e.g. a focused input swallowing
    // the keydown).
    window.addEventListener('keydown', onKeyDown, true)
    setShortcutsArmed(true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      setShortcutsArmed(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcutMap])

  const addItem = (p) => {
    const mode = settings.str('sale.item_addition_method', 'increase_qty')
    // Out-of-stock hard stop — a 0-stock tracked product can't enter
    // the cart at all; the cashier gets the pop-up instead. Stock can
    // never go negative from a sale.
    const onHand = Number(p.total_stock ?? p.stock ?? p.on_hand ?? 0)
    const tracksStock = (p.manage_stock ?? p.meta?.manage_stock ?? true) !== false && p.product_type !== 'service'
    if (tracksStock && onHand <= 0) {
      setStockAlert({
        message: `"${p.name}" is out of stock at this location (0 available). Restock it before selling.`,
        shortfalls: [{ product_name: p.name, requested: 1, available: onHand, shortfall: 1 }],
      })
      return
    }
    setItems((prev) => {
      if (mode === 'increase_qty') {
        const existing = prev.find((x) => x.product_id === p.id)
        if (existing) {
          return prev.map((x) => x.product_id === p.id ? { ...x, qty: Number(x.qty) + 1 } : x)
        }
      }
      return [...prev, {
        product_id: p.id,
        name:  p.name,
        sku:   p.sku || '',
        unit:  p.unit_label || p.unit_name || '',
        price: Number(p.selling_price ?? p.price ?? 0),
        qty:   1,
        // Services (manage_stock off) sell freely — the pre-finalize
        // stock guard skips them via this flag.
        tracks_stock: tracksStock,
        // Carry the live on-hand snapshot from the product picker so
        // the cart row can render the "Only X.XX Pc(s) available"
        // warning + block saving once qty > available.
        available: Number(p.total_stock ?? p.stock ?? p.on_hand ?? 0),
        // Per-line override fields driven by the "click product name"
        // modal. discount_type is FIXED (currency) or PERCENT, and
        // discount_value is the raw number the cashier typed in either
        // case. The backend wants a per-unit FIXED amount, so we
        // convert at payload time (see buildPayload below).
        discount_type:  'FIXED',
        discount_value: 0,
        description:    '',
      }]
    })
  }
  const updateQty  = (idx, qty) => setItems((p) => p.map((it, i) => i === idx ? { ...it, qty } : it))
  const updateLine = (idx, patch) => setItems((p) => p.map((it, i) => i === idx ? { ...it, ...patch } : it))
  const removeItem = (idx) => setItems((p) => p.filter((_, i) => i !== idx))

  // Per-unit FIXED discount in money — the form the backend expects.
  // FIXED ⇒ the value already is per-unit currency; PERCENT ⇒ apply
  // the percentage to the unit price. Capped so we never exceed the
  // unit price (which the backend would reject).
  const lineUnitDiscount = (it) => {
    const v = Number(it.discount_value || 0)
    const price = Number(it.price || 0)
    if (v <= 0 || price <= 0) return 0
    const raw = it.discount_type === 'PERCENT' ? price * v / 100 : v
    return Math.min(raw, price)
  }
  const lineSubtotal = (it) => {
    const net = Math.max(0, Number(it.price || 0) - lineUnitDiscount(it))
    return net * Number(it.qty || 0)
  }

  // Edit-line modal — opens when the cashier clicks a product name in
  // the cart. Holds the index of the row being edited; null = closed.
  const [editLineIdx, setEditLineIdx] = useState(null)
  const clearCart  = () => {
    setItems([]); setDiscount(''); setTaxPct(''); setCustomerId(''); setTableRef(''); setServiceStaff('')
    setShipping({ shipping_details: '', shipping_address: '', shipping_charges: '0', shipping_status: '', delivered_to: '' })
    setEditingSale(null)
  }

  // Load a recent sale back INTO the POS cart on the same page (no navigation).
  // QUOTATION/DRAFT → fully editable, re-saved in place. FINAL/VOIDED → loaded
  // read-only (committed items can't be changed without a return/void).
  const startEditSale = async (row) => {
    try {
      const full = await getSale(row.id || row.invoice_number)
      const st = String(full.status || '').toUpperCase()
      const readOnly = st === 'FINAL' || st === 'VOIDED' || st === 'PAID'
      setItems((full.items || []).map((i) => ({
        product_id:     i.product,
        name:           i.product_name || '',
        sku:            i.product_sku || '',
        unit:           '',
        price:          Number(i.unit_price ?? 0),
        qty:            Number(i.quantity ?? 1),
        tracks_stock:   true,
        available:      999999,            // unknown live stock — server guards on finalize
        discount_type:  'FIXED',
        discount_value: Number(i.item_discount ?? 0),
        description:    i.note || '',
      })))
      if (full.location) setLocationId(full.location)
      setCustomerId(full.customer?.id || '')
      const meta = full.meta || {}
      setTableRef(meta.table_ref || '')
      if (meta.service_staff) setServiceStaff(String(meta.service_staff))
      setDiscount(full.discount ? String(full.discount) : '')
      setTaxPct(full.tax_rate ? String(full.tax_rate) : '')
      setEditingSale({ id: full.id, status: st, invoice_number: full.invoice_number, readOnly })
      setRecentOpen(false)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      alert(err?.message || 'Failed to load this sale.')
    }
  }

  // Open a recent sale as a printable classic POS invoice (image format),
  // on the same page — no navigation to the All Sales detail screen.
  const openInvoicePrint = async (row) => {
    try {
      const full = await getSale(row.id || row.invoice_number)
      setPrintSale(full)
      setRecentOpen(false)
    } catch (err) {
      alert(err?.message || 'Failed to load the invoice.')
    }
  }

  // Persist the cart as an editable DRAFT: update the existing record when
  // editing an editable sale, otherwise create a new one. Returns { id }.
  const persistDraft = async () => {
    const payload = buildPayload('DRAFT')
    if (editingSale && !editingSale.readOnly) {
      await updateSale(editingSale.id, payload)
      return { id: editingSale.id }
    }
    return await createSale(payload)
  }

  // Deep-link: /sales/pos?edit=<saleId> (from All Sales → Edit on a POS
  // sale) loads that sale straight into the cart for editing on this page.
  const [searchParams] = useSearchParams()
  const didAutoEdit = useRef(false)
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId || didAutoEdit.current) return
    didAutoEdit.current = true
    startEditSale({ id: editId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const subtotal   = useMemo(() => items.reduce((s, it) => s + lineSubtotal(it), 0), [items])

  // Warn before leaving when the cart has anything in it — close-tab,
  // refresh, sidebar click and external links all trigger the
  // browser's "Changes that you made may not be saved." dialog.
  useUnsavedChangesPrompt(items.length > 0)
  const discountN  = Number(discount) || 0
  const taxBase    = Math.max(subtotal - discountN, 0)
  const taxAmount  = taxBase * (Number(taxPct) || 0) / 100
  // Apply the Sale → Amount rounding method to the grand total.
  const rawTotal   = taxBase + taxAmount
  const roundMode  = settings.str('sale.rounding_method', 'none')
  const grandTotal = roundMode === 'nearest' ? Math.round(rawTotal)
                   : roundMode === 'up'      ? Math.ceil(rawTotal)
                   : roundMode === 'down'    ? Math.floor(rawTotal)
                   : rawTotal
  const itemCount  = items.reduce((s, it) => s + Number(it.qty), 0)

  const buildPayload = (status) => ({
    location_id: locationId,
    customer_id: customerId || null,
    items: items.map((it) => ({
      product_id:    it.product_id,
      quantity:      Number(it.qty),
      unit_price:    Number(it.price),
      // Per-line discount in the per-unit FIXED form the backend wants
      // (PERCENT was already converted client-side by lineUnitDiscount).
      item_discount: lineUnitDiscount(it),
      // Description carries IMEI / serial / cashier note — kept in the
      // item meta so the sale-detail + invoice can show it.
      meta: it.description ? { description: it.description } : undefined,
    })),
    discount:  discountN,
    tax_rate:  Number(taxPct) || 0,
    status,
    notes: '',
    meta: {
      source:        'POS',           // tags the sale so it shows up in Sales List POS
      table_ref:     tableRef || '',
      service_staff: serviceStaff || '',
      // Shipping fields the cashier filled in via the Shipping
      // modal. Stored in meta so the Shipments page picks them up
      // (same shape Add Sale uses); empty strings = the cashier
      // skipped the modal, which is fine.
      shipping_details:  shipping.shipping_details || '',
      shipping_address:  shipping.shipping_address || '',
      shipping_status:   shipping.shipping_status || '',
      delivered_to:      shipping.delivered_to || '',
      shipping_charges:  Number(shipping.shipping_charges) || 0,
    },
  })

  // Shared stock guard — returns true when blocked. Pops the
  // OutOfStockModal (per-product shortfall table) instead of a bare
  // window.alert. Quotations / drafts don't deduct stock so they're
  // allowed to over-order.
  const blockedByStock = (status) => {
    if (status === 'QUOTATION' || status === 'DRAFT' || status === 'PENDING') return false
    const offenders = items.filter((it) => it.tracks_stock !== false && Number(it.qty) > Number(it.available || 0))
    if (offenders.length === 0) return false
    setStockAlert({
      message: 'Cannot finalize sale — not enough stock. Reduce the quantity or restock first.',
      shortfalls: offenders.map((it) => ({
        product_name: it.name,
        requested:    Number(it.qty),
        available:    Number(it.available || 0),
        shortfall:    Number(it.qty) - Number(it.available || 0),
      })),
    })
    return true
  }

  // Central error handler for the finalize paths — routes the
  // server's 409 stock guard into the OutOfStockModal; everything
  // else keeps the plain alert.
  const handleSaleError = (err) => {
    // The standard envelope nests the flags under payload.data;
    // older builds had them at the top level — accept both.
    const pd = err?.payload?.data || err?.payload || {}
    if (err?.status === 409 && (pd.back_order_required || pd.out_of_stock)) {
      setStockAlert({
        message: err.message || 'Not enough stock to complete this sale.',
        shortfalls: pd.shortfalls || [],
      })
      return
    }
    alert(extractError(err))
  }

  const handleSaveAs = async (status) => {
    if (editingSale?.readOnly) { alert('This finalized invoice is read-only.'); return }
    if (!items.length) { alert('Cart is empty.'); return }
    if (!locationId)   { alert('Select a location.'); return }
    if (blockedByStock(status)) return
    // Backend's create-sale serializer only accepts QUOTATION / PROFORMA /
    // DRAFT. PENDING (used by Suspend) is reserved by the backend for the
    // backorder flow, so we map it to DRAFT and tag the meta so future
    // reports can distinguish "suspended at till" from "regular draft".
    const realStatus = status === 'PENDING' ? 'DRAFT' : status
    const payload = buildPayload(realStatus)
    if (status === 'PENDING') {
      payload.meta = { ...(payload.meta || {}), suspended: true }
    }
    setSavingDraftAs(status)
    try {
      if (editingSale && !editingSale.readOnly) {
        await updateSale(editingSale.id, payload)
        alert(`Updated ${editingSale.invoice_number || 'sale'}.`)
      } else {
        await createSale(payload)
        const label = status === 'PENDING' ? 'Suspended' : `Saved as ${status}`
        alert(`${label}.`)
      }
      clearCart()
    } catch (err) {
      alert(err?.message || `Failed to save as ${status}`)
    } finally {
      setSavingDraftAs(null)
    }
  }

  const handleCharge = (method) => {
    if (editingSale?.readOnly) { alert('This finalized invoice is read-only — use a Sell Return or Void to change it.'); return }
    if (!items.length) { alert('Cart is empty.'); return }
    if (!locationId)   { alert('Select a location.'); return }
    // Stock guard — every Charge path finalises the sale, so an
    // over-order would either be rejected by the backorder gate or
    // post a backorder. We block here so the cashier sees the WHICH
    // and WHY in plain text first.
    if (blockedByStock('FINAL')) return
    // Cash is the express path: confirm once with the cashier (so a
    // miss-click doesn't book the sale), then finalise + record the
    // full grand-total cash payment against the default CASH account
    // and pop the Payment-Successful receipt. The cashier no longer
    // has to step through the intermediate Payment modal.
    if (method === 'CASH') {
      const total = Number(grandTotal) || 0
      if (total <= 0) { alert('Cart total is zero.'); return }
      // Per spec — no confirmation popup. Tap Cash → sale finalises,
      // payment lands in the default Cash account, and the
      // success ReceiptModal appears as the confirmation.
      handleExpressCash()
      return
    }
    if (method === 'CREDIT') { handleExpressCredit(); return }
    setPayOpen(method)
  }

  // Express Credit Sale — single click finalises the sale on the
  // customer's credit. No payment is recorded (amount_paid = 0), so the
  // full grandTotal lands in their balance_due. The server-side guard in
  // finalize_sale() refuses to land the sale if the customer is walk-in
  // or has credit_limit=0; we also disable the button up-front for the
  // same conditions, so this path should always succeed for an eligible
  // customer.
  const handleExpressCredit = async () => {
    if (editingSale?.readOnly) { alert('This finalized invoice is read-only.'); return }
    try {
      const total = Number(grandTotal) || 0
      const sale  = await persistDraft()
      // finalizeSale's response carries the assigned invoice_number
      // (and the finalised sale state). The OLD code threw it away
      // and spread the pre-finalize DRAFT into the receipt, which is
      // why the printed slip showed a UUID slice as "Invoice#" and
      // the pre-payment balance_due.
      const finalized = await finalizeSale(sale.id)
      setCompletedSale({ ...sale, ...finalized, total, paid: 0, method: 'CREDIT', customer_snapshot: customer })
      clearCart()
    } catch (err) {
      handleSaleError(err)
    }
  }

  const handleExpressCash = async () => {
    try {
      const total = Number(grandTotal) || 0
      const sale  = await persistDraft()
      // Tell the credit-gate that this much cash is about to be recorded.
      const finalized = await finalizeSale(sale.id, { expected_payment: total })
      if (total > 0) {
        const mapped = mapMethod('CASH', '')
        const cashAccount = paymentAccounts.find((a) => a.account_type === 'CASH')
        await addPayment(sale.id, {
          amount:             total,
          method:             mapped.method,
          reference:          mapped.reference || undefined,
          payment_account_id: cashAccount ? cashAccount.id : undefined,
        })
      }
      // Merge the finalized sale (invoice_number, finalized_at, etc.)
      // over the DRAFT so the receipt prints the real invoice number.
      // Local total + paid override the server-side balance_due (which
      // is still pre-payment at finalize time).
      setCompletedSale({ ...sale, ...finalized, total, paid: total, method: 'CASH', customer_snapshot: customer })
      clearCart()
    } catch (err) {
      handleSaleError(err)
    }
  }

  const handleConfirmPayment = async ({ amount, method, reference }) => {
    try {
      const sale = await persistDraft()
      const finalized = await finalizeSale(sale.id, { expected_payment: Number(amount) || 0 })
      if (Number(amount) > 0) {
        const mapped = mapMethod(method, reference)
        await addPayment(sale.id, {
          amount:    Number(amount),
          method:    mapped.method,
          reference: mapped.reference || undefined,
        })
      }
      setPayOpen(null)
      setCompletedSale({ ...sale, ...finalized, total: grandTotal, paid: Number(amount), method, customer_snapshot: customer })
      clearCart()
    } catch (err) {
      handleSaleError(err)
    }
  }

  const handleMultiPay = async (rows) => {
    try {
      const sale = await persistDraft()
      const totalPaidPlanned = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
      const finalized = await finalizeSale(sale.id, { expected_payment: totalPaidPlanned })
      for (const r of rows) {
        if (Number(r.amount) > 0) {
          const mapped = mapMethod(r.method, r.reference)
          await addPayment(sale.id, {
            amount:             Number(r.amount),
            method:             mapped.method,
            reference:          mapped.reference || undefined,
            payment_account_id: r.payment_account_id || undefined,
          })
        }
      }
      setPayOpen(null)
      const totalPaid = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
      setCompletedSale({ ...sale, ...finalized, total: grandTotal, paid: totalPaid, method: 'MIXED', customer_snapshot: customer })
      clearCart()
    } catch (err) {
      handleSaleError(err)
    }
  }

  // Keep the shortcut dispatcher pointed at the LATEST handlers + state every
  // render, so the once-registered keydown listener always runs fresh logic.
  shortcutActionRef.current = (action) => {
    switch (action) {
      case 'express':
        if (!settings.bool('pos.disable_express_checkout')) handleCharge('CASH')
        break
      case 'pay':            setPayOpen('MULTI'); break
      case 'draft':
        if (!settings.bool('pos.disable_draft')) handleSaveAs('DRAFT')
        break
      case 'cancel':         clearCart(); break
      case 'goto_qty':       firstQtyRef.current?.focus(); firstQtyRef.current?.select?.(); break
      case 'edit_discount':
        if (!settings.bool('pos.disable_discount')) { discountRef.current?.focus(); discountRef.current?.select?.() }
        break
      case 'edit_order_tax':
        if (!settings.bool('pos.disable_order_tax')) { taxRef.current?.focus(); taxRef.current?.select?.() }
        break
      case 'add_new_product': searchRef.current?.focus(); break
      case 'finalize_payment':
      case 'add_payment_row': setPayOpen('MULTI'); break
      default: break
    }
  }

  const customer = customers.find((c) => c.id === customerId)
  const location = locations.find((l) => l.id === locationId)

  // Whenever the cashier picks (or clears) a customer, pull their live
  // credit snapshot from the server so the Due indicator and the
  // Credit Sale gate are always based on real data, not stale form
  // state.
  useEffect(() => {
    if (!customerId) {
      setCreditSummary(null)
      return
    }
    let cancelled = false
    setCreditLoading(true)
    getCustomerCreditSummary(customerId)
      .then((res) => { if (!cancelled) setCreditSummary(res) })
      .catch(() => { if (!cancelled) setCreditSummary(null) })
      .finally(() => { if (!cancelled) setCreditLoading(false) })
    return () => { cancelled = true }
  }, [customerId])

  // Credit Sale eligibility — must match server-side guard in finalize_sale.
  // Disabled when:
  //   • no customer selected (walk-in)
  //   • customer has credit_limit == 0
  //   • adding this sale would push net_due over the limit
  const creditEligible = Boolean(creditSummary?.is_credit_eligible)
  const wouldExceedLimit = creditEligible
    && (Number(creditSummary.net_due || 0) + Number(grandTotal || 0)) > Number(creditSummary.credit_limit || 0)
  const creditDisabled = !creditEligible || wouldExceedLimit
  const creditDisabledReason = !customerId
    ? "Walk-in customers can't buy on credit. Pick a registered customer first."
    : !creditEligible
      ? `${customer?.name || 'This customer'} has no credit limit set. Update the customer record to allow credit.`
      : wouldExceedLimit
        ? `This sale (৳${Number(grandTotal).toLocaleString()}) would push ${customer?.name}'s due over their credit limit of ৳${Number(creditSummary.credit_limit).toLocaleString()}.`
        : ''

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">Location:</span>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-navy-800"
          >
            {locations.length === 0 && <option value="">No locations</option>}
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <span className="hidden sm:inline text-gray-500 font-mono text-xs">{fmtDateTime(now)}</span>
          {shortcutsArmed && (
            <span
              title={
                'Active shortcuts:\n'
                + Object.entries(shortcutMap)
                    .filter(([k]) => k)
                    .map(([k, v]) => `  ${k.padEnd(12)} → ${v}`)
                    .join('\n')
              }
              className="hidden md:inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200 cursor-help"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Shortcuts ON
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShippingOpen(true)} leftIcon={<IconTruck />}>
            Shipping
            {(shipping.shipping_details || shipping.shipping_address || shipping.delivered_to) && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            )}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRecentOpen(true)} leftIcon={<IconList />}>
            Recent Transactions
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRegisterOpen(true)} leftIcon={<IconRegister />}>
            Register Details
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCloseRegOpen(true)} leftIcon={<IconLock />}>
            Close Register
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCalcOpen(true)} leftIcon={<IconCalc />}>
            Calculator
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAddExpenseOpen(true)} leftIcon={<IconMinusCircle />}>
            Add Expense
          </Button>
        </div>
      </div>

      {/* Main grid */}
      {/* Cart never narrower than 420px, never wider than 45% of the
          viewport so cashiers can read it; the product picker takes the
          remaining 55%+ on every screen ≥ lg. Stacks below lg for
          phones / small tablets. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(420px,_45%)_1fr]">
        {/* Cart column */}
        <Card padding="p-5">
          {editingSale && (
            <div className={`mb-3 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
              editingSale.readOnly
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-indigo-200 bg-indigo-50 text-indigo-800'}`}>
              <span className="font-medium">
                {editingSale.readOnly
                  ? `Viewing ${editingSale.invoice_number || 'invoice'} (finalized — read-only)`
                  : `Editing ${editingSale.invoice_number || editingSale.status} — save to update it`}
              </span>
              <button
                onClick={clearCart}
                className="shrink-0 rounded-md border border-current/30 px-2 py-1 text-xs font-semibold hover:bg-white/50"
              >
                {editingSale.readOnly ? 'Close' : 'Cancel edit'}
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <CustomerPicker
              customers={customers}
              value={customerId}
              onChange={setCustomerId}
              onAddNew={() => setAddCustomerOpen(true)}
            />
            <ProductSearchEntry
              value={cartQuickSearch}
              onChange={setCartQuickSearch}
              onPick={(p) => { addItem(p); setCartQuickSearch('') }}
              onAddNew={() => setAddProductOpen(true)}
            />
          </div>

          {/* Live credit summary — appears as soon as a registered customer
              is picked. Shows current due, credit limit, available credit. */}
          {customerId && (
            <CustomerCreditBadge
              summary={creditSummary}
              loading={creditLoading}
              wouldExceedLimit={wouldExceedLimit}
              cartTotal={grandTotal}
            />
          )}
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select value={tableRef} onChange={(e) => setTableRef(e.target.value)}>
              <option value="">Select table / service type</option>
              <option value="PRODUCT">Product purchase</option>
              <option value="SERVICE">Service</option>
              <option value="TABLE-1">Table 1</option>
              <option value="TABLE-2">Table 2</option>
              <option value="TABLE-3">Table 3</option>
            </Select>
            <Select value={serviceStaff} onChange={(e) => setServiceStaff(e.target.value)} disabled={!isOwner}>
              {isOwner && <option value="">Select service staff</option>}
              {serviceStaffOptions.length === 0 && user?.id && (
                <option value={String(user.id)}>{user.name || 'Current user'}</option>
              )}
              {serviceStaffOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </Select>
          </div>

          {/* Cart items table */}
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                  <th className="pb-2 text-left">Product</th>
                  <th className="pb-2 w-28 text-center">Quantity</th>
                  <th className="pb-2 w-24 text-right">Subtotal</th>
                  <th className="pb-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.length === 0 ? (
                  <tr><td colSpan={4} className="py-10 text-center text-sm text-gray-400">No items added yet — search above or click a product on the right.</td></tr>
                ) : items.map((it, idx) => (
                  <tr key={`${it.product_id}-${idx}`}>
                    <td className="py-2">
                      {/* Click the product name to open the per-line
                          edit modal (unit price · discount type ·
                          discount amount · description). */}
                      <button
                        type="button"
                        onClick={() => setEditLineIdx(idx)}
                        className="font-medium text-navy-800 hover:text-brand-600 hover:underline text-left"
                        title="Click to edit price, discount or add a note"
                      >
                        {it.name}
                      </button>
                      <div className="text-[11px] text-gray-400 font-mono">
                        {fmtMoney(it.price)} × {it.qty} {it.unit}
                        {lineUnitDiscount(it) > 0 && (
                          <span className="ml-1 text-emerald-600">
                            (− {it.discount_type === 'PERCENT' ? `${Number(it.discount_value)}%` : fmtMoney(it.discount_value)})
                          </span>
                        )}
                      </div>
                      {it.description && (
                        <div className="text-[11px] text-gray-500 italic truncate max-w-[220px]" title={it.description}>
                          {it.description}
                        </div>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="inline-flex items-center rounded-md border border-gray-200 overflow-hidden bg-white">
                        <button onClick={() => updateQty(idx, Math.max(0, Number(it.qty) - 1))} className="w-7 h-7 text-gray-500 hover:bg-gray-50">−</button>
                        <input
                          ref={idx === 0 ? firstQtyRef : undefined}
                          value={it.qty}
                          onChange={(e) => updateQty(idx, e.target.value)}
                          type="number" min="0" step="0.01"
                          className="w-12 h-7 border-x border-gray-200 text-center text-sm outline-none"
                        />
                        <button onClick={() => updateQty(idx, Number(it.qty) + 1)} className="w-7 h-7 text-gray-500 hover:bg-gray-50">+</button>
                      </div>
                      {/* Stock guard — when qty exceeds the on-hand
                          snapshot we cached on addItem, show the
                          available count in red. Save buttons (below)
                          gate on the same condition. Services
                          (tracks_stock false) have no inventory, so
                          the warning never applies to them. */}
                      {it.tracks_stock !== false && Number(it.qty) > Number(it.available || 0) && (
                        <div className="mt-1 text-[11px] font-semibold text-rose-600">
                          Only {Number(it.available || 0).toFixed(2)} {it.unit || 'Pc(s)'} available
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-right font-semibold text-navy-800 whitespace-nowrap tabular-nums">
                      {fmtMoney(lineSubtotal(it))}
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removeItem(idx)} className="text-gray-400 hover:text-rose-600">
                        <IconX />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer totals */}
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between"><span className="text-gray-500">Items</span><span className="font-semibold">{itemCount}</span></div>
              {!settings.bool('pos.disable_discount') && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Discount</span>
                  <input
                    ref={discountRef}
                    type="number" min="0" step="0.01"
                    value={discount}
                    placeholder="0"
                    onChange={(e) => setDiscount(e.target.value)}
                    className="h-9 w-24 rounded-md border-2 border-gray-300 px-2 text-right text-sm font-semibold tabular-nums outline-none focus:border-brand-500"
                  />
                </div>
              )}
              {!settings.bool('pos.disable_order_tax') && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Order VAT %</span>
                  <input
                    ref={taxRef}
                    type="number" min="0" step="0.01"
                    value={taxPct}
                    placeholder="0"
                    onChange={(e) => setTaxPct(e.target.value)}
                    className="h-9 w-24 rounded-md border-2 border-gray-300 px-2 text-right text-sm font-semibold tabular-nums outline-none focus:border-brand-500"
                  />
                </div>
              )}
            </div>
            <div className="text-sm rounded-xl border border-gray-100 bg-gray-50/60 p-4 space-y-1.5">
              <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
              <div className="flex justify-between text-emerald-700"><span>− Discount</span><span className="tabular-nums">{fmtMoney(discountN)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Vat ({Number(taxPct) || 0}%)</span><span className="tabular-nums">{fmtMoney(taxAmount)}</span></div>
              <div className="mt-2 pt-2 border-t border-gray-200 flex items-center justify-between">
                <span className="font-bold text-navy-800">Total</span>
                <span className="text-2xl font-extrabold text-brand-700 tabular-nums">{fmtMoney(grandTotal)}</span>
              </div>
            </div>
          </div>

          {/* Action buttons (visibility gated by Settings → Sales on POS) */}
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {/* Draft button removed from POS per spec — cashiers use
                the Suspend button for in-progress carts and the Add
                Sale page when they need a true draft for later
                editing. */}
            <ActionBtn   color="amber"   icon={<IconQuote />}  label="Quotation"  onClick={() => handleSaveAs('QUOTATION')}  loading={savingDraftAs === 'QUOTATION'} />
            {!settings.bool('pos.disable_suspend_sale') && (
              <ActionBtn color="rose"    icon={<IconPause />}  label="Suspend"    onClick={() => handleSaveAs('PENDING')}    loading={savingDraftAs === 'PENDING'} />
            )}
            {!settings.bool('pos.disable_credit_sale') && (
              <ActionBtn
                color="violet"
                icon={<IconCredit />}
                label="Credit Sale"
                onClick={() => {
                  if (creditDisabled) { alert(creditDisabledReason); return }
                  handleCharge('CREDIT')
                }}
                disabled={creditDisabled}
                title={creditDisabledReason || 'Charge this sale to the customer\'s credit account'}
              />
            )}
            <ActionBtn   color="pink"    icon={<IconCard />}   label="Card"       onClick={() => handleCharge('CARD')} />
            {!settings.bool('pos.disable_multiple_pay') && (
              <ActionBtn color="indigo"  icon={<IconStack />}  label="Multiple Pay" onClick={() => setPayOpen('MULTI')} />
            )}
            {!settings.bool('pos.disable_express_checkout') && (
              <ActionBtn color="emerald" icon={<IconCash />}   label="Cash"       onClick={() => handleCharge('CASH')} />
            )}
            <ActionBtn   color="gray"    icon={<IconX />}      label="Cancel"     onClick={clearCart} />
          </div>
        </Card>

        {/* Product grid column */}
        <Card padding="p-4">
          <div className="mb-3">
            <div className="relative">
              <span className="absolute inset-y-0 left-3 flex items-center text-gray-400 pointer-events-none">
                <IconSearch />
              </span>
              <input
                ref={searchRef}
                value={gridSearch}
                onChange={(e) => setGridSearch(e.target.value)}
                placeholder="Search product, SKU or scan barcode…"
                className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-12 text-sm outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              {settings.str('pos.ks.add_new_product') && (
                <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-gray-200 bg-white text-[10px] font-medium text-gray-500 uppercase">
                  {settings.str('pos.ks.add_new_product')}
                </kbd>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
            <PillBtn active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>All</PillBtn>
            {categories.map((c) => (
              <PillBtn key={c.id} active={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id)}>{c.name}</PillBtn>
            ))}
          </div>

          {/* Auto-fill the available column with cards of ≥ 150px each.
              At ~780px wide that's 5 columns, at ~1100px wide it's 7 —
              instead of the old fixed 2 or 3. Phone-width still gets 2.
              Max-height switches to a viewport-relative value so tall
              monitors get more vertical product real estate. */}
          <div
            className="mt-3 grid gap-3 overflow-y-auto scrollbar-thin pr-1"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              maxHeight: 'calc(100vh - 260px)',
              minHeight: '420px',
            }}
          >
            {products.length === 0 ? (
              <div className="col-span-full py-12 text-center text-sm text-gray-400">No products found.</div>
            ) : products.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => addItem(p)}
                className="group text-left rounded-xl border border-gray-100 bg-white hover:border-brand-500 hover:shadow-soft transition overflow-hidden"
              >
                <div className={`h-24 flex items-center justify-center bg-gradient-to-br ${tintFor(p.id)}`}>
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <svg className="w-9 h-9 text-navy-700/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 7.5l-9-4.5-9 4.5M21 7.5v9l-9 4.5m9-13.5l-9 4.5m0 0v9m0-9L3 7.5m0 0v9l9 4.5" />
                    </svg>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-[13px] font-semibold text-navy-800 truncate" title={p.name}>{p.name}</p>
                  <p className="text-[10px] text-gray-400 font-mono truncate">{p.sku || '—'}</p>
                  <div className="mt-1 flex items-center justify-between gap-1">
                    <p className="text-[13px] font-bold text-navy-800 tabular-nums">{fmtMoney(p.selling_price ?? p.price)}</p>
                    {/* Stock number — ONLY for tracked products. Services
                        (Manage Stock off / product_type service) have no
                        inventory so the tile shows no stock text at all.
                        Reads the real serializer field (total_stock); the
                        old code read current_stock which never exists, so
                        even tracked products showed nothing. */}
                    {(() => {
                      const tracksStock =
                        (p.manage_stock ?? p.meta?.manage_stock ?? true) !== false &&
                        p.product_type !== 'service'
                      if (!tracksStock) return null
                      const onHand = Number(p.total_stock ?? p.stock ?? p.on_hand ?? 0)
                      const unit = p.unit_name || p.unit_abbr || ''
                      return (
                        <p className={`text-[10px] font-medium ${onHand <= 0 ? 'text-rose-600' : onHand <= 5 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {onHand} {unit}
                        </p>
                      )
                    })()}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Modals */}
      {addCustomerOpen && (
        <CustomerModal
          open
          customer={null}
          onClose={() => setAddCustomerOpen(false)}
          onSaved={(c) => {
            // Auto-select the just-created customer so its name fills
            // the POS customer field immediately. Data is the live
            // DB record returned by the create endpoint.
            if (c?.id) {
              setCustomers((prev) => [c, ...prev.filter((p) => p.id !== c.id)])
              setCustomerId(c.id)
            }
            setAddCustomerOpen(false)
          }}
        />
      )}
      {addProductOpen && (
        <QuickAddProductModal
          onClose={() => setAddProductOpen(false)}
          onCreated={(p) => {
            // Drop the new product into the cart immediately so the
            // cashier doesn't have to search for it again.
            addItem(p)
            // Refresh the right-panel tile list so the new SKU also
            // appears there for the next sale.
            getProducts({ is_active: 'true', limit: 100, light: 'true' })
              .then((res) => setProducts(Array.isArray(res) ? res : (res?.results ?? [])))
              .catch(() => {})
            setAddProductOpen(false)
          }}
        />
      )}
      {addExpenseOpen && (
        <AddExpenseModal
          onClose={() => setAddExpenseOpen(false)}
          locationId={locationId}
          onSaved={() => setAddExpenseOpen(false)}
        />
      )}

      {shippingOpen && (
        <ShippingModal
          initial={shipping}
          onClose={() => setShippingOpen(false)}
          onSave={(patch) => { setShipping((s) => ({ ...s, ...patch })); setShippingOpen(false) }}
        />
      )}

      {recentOpen && (
        <RecentTxnModal
          locationId={locationId}
          onClose={() => setRecentOpen(false)}
          onEdit={startEditSale}
          onPrintInvoice={openInvoicePrint}
        />
      )}

      {printSale && (
        <PosInvoicePrintModal
          sale={printSale}
          staffRoster={staffRoster}
          onClose={() => setPrintSale(null)}
        />
      )}

      {registerOpen && (
        <RegisterDetailsModal
          locationId={locationId}
          onClose={() => setRegisterOpen(false)}
        />
      )}

      {closeRegOpen && (
        <CloseRegisterModal
          locationId={locationId}
          onClose={() => setCloseRegOpen(false)}
        />
      )}

      {calcOpen && (
        <CalculatorModal onClose={() => setCalcOpen(false)} />
      )}

      {editLineIdx != null && items[editLineIdx] && (
        <EditCartLineModal
          line={items[editLineIdx]}
          onClose={() => setEditLineIdx(null)}
          onSave={(patch) => { updateLine(editLineIdx, patch); setEditLineIdx(null) }}
        />
      )}
      {(payOpen === 'CASH' || payOpen === 'CARD' || payOpen === 'CREDIT') && (
        <PaymentModal
          method={payOpen}
          total={grandTotal}
          itemCount={itemCount}
          onClose={() => setPayOpen(null)}
          onConfirm={handleConfirmPayment}
        />
      )}
      {payOpen === 'MULTI' && (
        <MultiplePayModal
          total={grandTotal}
          itemCount={itemCount}
          advanceBalance={Number(creditSummary?.advance_balance || 0)}
          onClose={() => setPayOpen(null)}
          onConfirm={handleMultiPay}
        />
      )}
      {completedSale && (
        <ReceiptModal
          sale={completedSale}
          // Prefer the snapshot stamped on the sale object — the live
          // `customer` derives from customerId, which clearCart() reset
          // to '' before this modal mounts.
          customer={completedSale.customer_snapshot || customer}
          location={location}
          onClose={() => setCompletedSale(null)}
        />
      )}

      {/* Out-of-stock pop-up — fires on add-to-cart of a 0-stock
          product, the pre-finalize cart guard, and the server's 409
          stock guard. */}
      <OutOfStockModal data={stockAlert} onClose={() => setStockAlert(null)} />
    </div>
  )
}

function CustomerPicker({ customers, value, onChange, onAddNew }) {
  // Typeahead picker — the cashier can either click the field and pick
  // from a scrollable list, or just type to filter by name / phone.
  // Selecting an entry sets `value` to the customer id; clearing the
  // text falls back to the Walk-in customer state (value="").
  const [query, setQuery] = useState('')
  const [open, setOpen]   = useState(false)
  const ref = useRef(null)

  const selected = customers.find((c) => c.id === value)

  // Keep the visible text in sync with the selected customer (or clear it
  // when caller resets value back to '').
  useEffect(() => {
    setQuery(selected ? `${selected.name}${selected.phone ? ' · ' + fmtPhone(selected.phone) : ''}` : '')
  }, [selected?.id])

  const q = query.trim().toLowerCase()
  const filtered = !q
    ? customers.slice(0, 50)
    : customers
        .filter((c) =>
          c.name.toLowerCase().includes(q) ||
          // Match against both the raw stored phone and the
          // canonical 0-prefixed form so a cashier typing "0171..."
          // hits a row stored as "171..." and vice versa.
          (c.phone || '').toLowerCase().includes(q) ||
          fmtPhone(c.phone || '').toLowerCase().includes(q),
        )
        .slice(0, 50)

  // Close the dropdown when clicking outside.
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative flex gap-2" ref={ref}>
      <div className="relative flex-1">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            if (!e.target.value.trim()) onChange('')  // empty = walk-in
          }}
          onFocus={() => setOpen(true)}
          placeholder="Walk-in customer (type to search)"
          className="w-full h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(''); setQuery(''); setOpen(false) }}
            title="Switch to walk-in customer"
            className="absolute inset-y-0 right-2 my-auto text-gray-400 hover:text-gray-600 text-lg leading-none"
          >×</button>
        )}
        {open && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-pop max-h-72 overflow-auto">
            {/* Walk-in always sits at the top of the dropdown — explicit option,
                not just an implicit empty state. Hidden when the user is
                actively filtering and "walk" doesn't match the query. */}
            {(!q || 'walk in customer walkin'.includes(q)) && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange('')
                  setQuery('')
                  setOpen(false)
                }}
                className={`block w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-100 ${!value ? 'bg-gray-50' : ''}`}
              >
                <div className="text-sm font-medium text-gray-700">Walk-in customer</div>
                <div className="text-[11px] text-gray-400">Anonymous sale — no credit allowed</div>
              </button>
            )}

            {filtered.length === 0 ? (
              q ? (
                <div className="px-4 py-3 text-xs text-gray-400">
                  No customers match "{query}". Click + to add one.
                </div>
              ) : null
            ) : filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(c.id)
                  setQuery(`${c.name}${c.phone ? ' · ' + fmtPhone(c.phone) : ''}`)
                  setOpen(false)
                }}
                className={`block w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0 ${c.id === value ? 'bg-brand-50' : ''}`}
              >
                <div className="text-sm font-medium text-navy-800">{c.name}</div>
                <div className="text-[11px] text-emerald-700 font-mono">
                  {fmtPhone(c.phone) || '—'}
                  {Number(c.credit_limit) > 0 && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                      Credit ৳{Number(c.credit_limit).toLocaleString()}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={onAddNew} title="Add customer" className="h-10 w-10 inline-flex items-center justify-center rounded-lg bg-brand-600 hover:bg-brand-700 text-white">
        <IconPlus />
      </button>
    </div>
  )
}


function CustomerCreditBadge({ summary, loading, wouldExceedLimit, cartTotal }) {
  if (loading) {
    return (
      <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Loading customer account…
      </div>
    )
  }
  if (!summary) return null

  const limit   = Number(summary.credit_limit || 0)
  const due     = Number(summary.net_due || 0)       // ← system-created sales only
  const opening = Number(summary.opening_balance || 0)
  const avail   = Number(summary.available_credit || 0)
  const cart    = Number(cartTotal || 0)
  const fmt     = (n) => `৳${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Show pre-system opening balance separately so the cashier can see it
  // without it gating Credit Sale. It's an informational line, not a
  // blocker — see views.py credit_summary for the rationale.
  const OpeningLine = opening > 0 ? (
    <div className="mt-1 text-[11px] text-gray-500">
      Carried-over opening balance: {fmt(opening)} (informational; doesn't count against credit limit)
    </div>
  ) : null

  // Credit-limit hints are now uniformly red across every tone — the
  // cashier asked for a single high-contrast color so they catch the
  // line at a glance regardless of which message variant is shown.
  if (limit <= 0) {
    return (
      <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        <span className="font-semibold">Cash-only customer.</span>{' '}
        No credit limit set. Credit Sale button is disabled.
        {OpeningLine}
      </div>
    )
  }
  if (due > 0) {
    return (
      <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        <div className="flex items-center justify-between">
          <span className="font-semibold">Outstanding due: {fmt(due)}</span>
          <span>Limit {fmt(limit)} · Available {fmt(avail)}</span>
        </div>
        {wouldExceedLimit && (
          <div className="mt-1 font-semibold">
            ⚠ This {fmt(cart)} sale would push the customer over their credit limit.
          </div>
        )}
        {OpeningLine}
      </div>
    )
  }
  return (
    <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
      No outstanding due. Credit available: <span className="font-semibold">{fmt(avail)}</span> of {fmt(limit)}.
      {OpeningLine}
    </div>
  )
}

function ProductSearchEntry({ value, onChange, onPick, onAddNew }) {
  const [results, setResults] = useState([])
  const [show,    setShow]    = useState(false)
  const [scanError, setScanError] = useState('')
  const inputRef = useRef(null)
  // Track whether the most recent keystrokes look like a scanner burst
  // (>= 4 chars typed in under 100 ms on average). Scanners spit the
  // whole barcode in a few ms; humans type at >40 ms/char.
  const burstRef = useRef({ count: 0, lastAt: 0, firstAt: 0 })

  useEffect(() => {
    if (!value.trim()) { setResults([]); setShow(false); setScanError(''); return }
    const t = setTimeout(async () => {
      try {
        const res = await getProducts({ search: value.trim(), limit: 8, light: 'true' })
        setResults(Array.isArray(res) ? res : (res?.results ?? []))
        setShow(true)
      } catch { setResults([]) }
    }, 150)
    return () => clearTimeout(t)
  }, [value])

  // Auto-focus on mount so a scanner connected as a keyboard-wedge
  // device works without the cashier clicking first. Most retail
  // scanners just fire keystrokes into the focused element.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Track typing burst speed — used to decide whether Enter should
  // trigger an exact-match scan lookup (scanner) or just pick the
  // first dropdown result (human typing).
  const onKeyTrack = () => {
    const now = performance.now()
    const b = burstRef.current
    if (!b.count) b.firstAt = now
    b.count += 1
    b.lastAt = now
  }
  const looksLikeScan = () => {
    const b = burstRef.current
    const span = b.lastAt - b.firstAt
    return b.count >= 4 && span > 0 && (span / b.count) < 35   // < 35 ms/char on avg
  }
  const resetBurst = () => { burstRef.current = { count: 0, lastAt: 0, firstAt: 0 } }

  const onKeyDown = async (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const raw = (value || '').trim()
    if (!raw) return

    setScanError('')
    const scanLike = looksLikeScan()
    resetBurst()

    // Scanner path: try exact match by barcode/SKU. Falls back to
    // dropdown's first match if the code isn't in inventory.
    if (scanLike) {
      try {
        const product = await scanProductByCode(raw)
        if (product) { onPick(product); setShow(false); onChange(''); return }
      } catch {
        // 404 — fall through to typed-search fallback
      }
    }

    // Human path: pick the first dropdown result if any, else also
    // try the exact-match endpoint as a last attempt (so manually
    // typing a known SKU + Enter still works).
    if (results[0]) {
      onPick(results[0]); setShow(false); onChange(''); return
    }
    try {
      const product = await scanProductByCode(raw)
      if (product) { onPick(product); setShow(false); onChange(''); return }
    } catch {
      setScanError(`No product matches "${raw}".`)
    }
  }

  return (
    <div className="relative flex gap-2">
      <div className="relative flex-1">
        <span className="absolute inset-y-0 left-3 flex items-center text-brand-500 pointer-events-none">
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { onKeyTrack(); onKeyDown(e) }}
          onFocus={() => value && setShow(true)}
          onBlur={() => setTimeout(() => setShow(false), 150)}
          placeholder="Enter product name / SKU / Scan barcode"
          className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        {scanError && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {scanError}
          </div>
        )}
        {show && results.length > 0 && !scanError && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-pop max-h-72 overflow-auto">
            {results.map((p) => (
              <button
                key={p.id}
                onMouseDown={(e) => { e.preventDefault(); onPick(p); setShow(false) }}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0"
              >
                <div className="text-sm font-medium text-navy-800">{p.name}</div>
                <div className="text-[11px] text-gray-500">
                  {p.sku || '—'}{p.selling_price != null ? ` · ${fmtMoney(p.selling_price)}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* + button: opens the Quick Add Product modal so the cashier
          can create a brand-new SKU on the fly without leaving POS.
          Replaces the previous "quick-add first match" semantics —
          operators kept assuming + meant "register a new product"
          (matching the customer + next to it). */}
      <button
        type="button"
        onClick={() => onAddNew?.()}
        title="Quick add a new product"
        className="h-10 w-10 inline-flex items-center justify-center rounded-lg bg-brand-600 hover:bg-brand-700 text-white"
      >
        <IconPlus />
      </button>
    </div>
  )
}

const COLOR = {
  sky:     'bg-sky-500     hover:bg-sky-600',
  amber:   'bg-amber-500   hover:bg-amber-600',
  rose:    'bg-rose-500    hover:bg-rose-600',
  violet:  'bg-violet-500  hover:bg-violet-600',
  pink:    'bg-pink-500    hover:bg-pink-600',
  indigo:  'bg-indigo-500  hover:bg-indigo-600',
  emerald: 'bg-emerald-500 hover:bg-emerald-600',
  gray:    'bg-gray-500    hover:bg-gray-600',
}

function ActionBtn({ color, icon, label, onClick, loading, disabled, title }) {
  const isDisabled = disabled || loading
  return (
    <button type="button" onClick={onClick} disabled={isDisabled} title={title}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-white shadow-soft transition',
        COLOR[color] ?? COLOR.gray,
        loading   ? 'opacity-60 cursor-wait' : '',
        disabled  ? 'opacity-40 cursor-not-allowed grayscale' : '',
      ].join(' ')}>
      <span className="w-4 h-4">{icon}</span>
      {label}
    </button>
  )
}

function PillBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={[
        'shrink-0 rounded-full px-3.5 py-1 text-[12px] font-semibold transition',
        active
          ? 'bg-brand-600 text-white'
          : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:text-navy-800',
      ].join(' ')}>{children}</button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// QuickAddProductModal — fired by the + button next to the cart
// product search. Lets the cashier register a brand-new SKU on the
// fly without leaving POS. Only the name + selling price are required;
// SKU + barcode auto-generate server-side when blank.
// ─────────────────────────────────────────────────────────────────────
// Full-featured Add new product modal mirroring the reference UI.
// Single round-trip to /api/inventory/products/ with opening_stock
// rows so a brand-new SKU lands in the cart AND on the shelf.
function QuickAddProductModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', sku: '', barcode_type: 'C128',
    unit_id: '', brand_id: '', category_id: '',
    sub_category_id: '',
    reorder_level: '',
    business_location_ids: [],   // multi-select chips
    weight: '',
    manage_stock: true,
    description: '',
    tax_rate: '',                // applicable tax %
    tax_type: 'exclusive',
    not_for_selling: false,
    enable_imei: false,
    custom_1: '', custom_2: '', custom_3: '', custom_4: '',
    purchase_price_exc: '',
    purchase_price_inc: '',
    margin_pct: '',
    selling_price_exc: '',
  })

  // Lookup data for the dropdowns.
  const [units, setUnits] = useState([])
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [locations, setLocations] = useState([])
  // Opening stock rows — one per location the cashier wants seeded.
  const [openingStock, setOpeningStock] = useState([
    { location_id: '', quantity: '', unit_cost: '' },
  ])
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target?.value ?? e }))

  useEffect(() => {
    import('../../api/products').then((api) => {
      api.getUnits?.().then((d) => setUnits(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
      api.getBrands?.().then((d) => setBrands(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
      api.getCategories?.().then((d) => setCategories(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
      api.getLocations?.(true).then((d) => setLocations(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
    })
  }, [])

  // Two-way binding between Purchase, Margin and Selling so the cashier
  // can type any two and the third auto-fills:
  //
  //   • lastTouched='margin'  → Selling = Purchase × (1 + Margin/100)
  //   • lastTouched='selling' → Margin  = (Selling − Purchase) / Purchase × 100
  //   • lastTouched='purchase' → recompute based on whichever of
  //     selling/margin was edited most recently before this.
  //
  // Inc. tax (Purchase price) auto-fills from Exc. tax + Applicable Tax%
  // so the cashier doesn't have to retype the same number with VAT
  // baked in.
  const [priceLastTouched, setPriceLastTouched] = useState('margin') // 'margin' | 'selling' | 'purchase'
  useEffect(() => {
    const purchase = Number(form.purchase_price_exc) || 0
    const margin   = Number(form.margin_pct) || 0
    const selling  = Number(form.selling_price_exc) || 0
    const tax      = Number(form.tax_rate) || 0
    const incTax   = purchase * (1 + tax / 100)

    if (priceLastTouched === 'selling') {
      // Compute margin from purchase + selling.
      if (purchase > 0 && selling > 0) {
        const m = ((selling - purchase) / purchase * 100).toFixed(2)
        setForm((f) => ({
          ...f,
          margin_pct: m,
          purchase_price_inc: incTax.toFixed(2),
        }))
      } else {
        setForm((f) => ({ ...f, purchase_price_inc: incTax > 0 ? incTax.toFixed(2) : '' }))
      }
    } else {
      // Default: compute selling from purchase + margin.
      if (purchase > 0 && margin >= 0) {
        const s = (purchase * (1 + margin / 100)).toFixed(2)
        setForm((f) => ({
          ...f,
          selling_price_exc: s,
          purchase_price_inc: incTax.toFixed(2),
        }))
      } else {
        setForm((f) => ({ ...f, purchase_price_inc: incTax > 0 ? incTax.toFixed(2) : '' }))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.purchase_price_exc, form.margin_pct, form.selling_price_exc, form.tax_rate, priceLastTouched])

  const toggleLocationChip = (id) => {
    setForm((f) => {
      const has = f.business_location_ids.includes(id)
      return {
        ...f,
        business_location_ids: has
          ? f.business_location_ids.filter((x) => x !== id)
          : [...f.business_location_ids, id],
      }
    })
  }

  const setOpening = (idx, patch) =>
    setOpeningStock((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addOpeningRow = () =>
    setOpeningStock((rows) => [...rows, { location_id: '', quantity: '', unit_cost: '' }])
  const removeOpeningRow = (idx) =>
    setOpeningStock((rows) => rows.filter((_, i) => i !== idx))

  const submit = async () => {
    setErr('')
    if (!form.name.trim()) { setErr('Product name is required.'); return }
    if (!form.unit_id)     { setErr('Unit is required.'); return }

    setSaving(true)
    try {
      const payload = {
        name:            form.name.trim(),
        sku:             form.sku.trim() || undefined,
        barcode_type:    form.barcode_type || 'C128',
        unit_id:         form.unit_id,
        brand_id:        form.brand_id || undefined,
        category_id:     form.category_id || undefined,
        selling_price:   Number(form.selling_price_exc || 0),
        cost_price:      Number(form.purchase_price_exc || 0),
        tax_rate:        Number(form.tax_rate || 0),
        tax_type:        form.tax_type || 'exclusive',
        not_for_selling: !!form.not_for_selling,
        weight:          form.weight ? Number(form.weight) : null,
        notes:           form.description || '',
        reorder_level:   Number(form.reorder_level || 0),
        meta: {
          manage_stock: !!form.manage_stock,
          enable_imei:  !!form.enable_imei,
          business_location_ids: form.business_location_ids,
          sub_category_id: form.sub_category_id || '',
          custom_fields: [form.custom_1, form.custom_2, form.custom_3, form.custom_4],
          purchase_price_inc: Number(form.purchase_price_inc || 0),
          margin_pct: Number(form.margin_pct || 0),
        },
        // Opening stock rows the service turns into FIFO layers.
        opening_stock: openingStock
          .filter((r) => r.location_id && Number(r.quantity) > 0)
          .map((r) => ({
            location_id: r.location_id,
            quantity:    Number(r.quantity),
            unit_cost:   Number(r.unit_cost || form.purchase_price_exc || 0),
          })),
      }
      const p = await createProduct(payload)
      onCreated?.(p)
    } catch (e) {
      setErr(e?.message || 'Failed to create product.')
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1'
  const ipt = 'h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
  const sel = `${ipt} appearance-none cursor-pointer pr-7 text-emerald-700`
  const sub = 'text-xs text-gray-500 mt-0.5'

  return (
    <Modal open onClose={onClose} title="Add new product" size="3xl">
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
        )}

        {/* Row 1 — Name / SKU / Barcode Type */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={lbl}>Product Name:<span className="text-rose-500">*</span></label>
            <input value={form.name} onChange={set('name')} placeholder="Product Name" className={ipt} />
          </div>
          <div>
            <label className={lbl}>SKU: <span className="text-brand-500" title="Auto-generates if blank">ⓘ</span></label>
            <input value={form.sku} onChange={set('sku')} placeholder="SKU" className={ipt} />
          </div>
          <div>
            <label className={lbl}>Barcode Type:</label>
            <select value={form.barcode_type} onChange={set('barcode_type')} className={sel}>
              <option value="C128">Code 128 (C128)</option>
              <option value="EAN13">EAN-13</option>
              <option value="EAN8">EAN-8</option>
              <option value="UPCA">UPC-A</option>
              <option value="UPCE">UPC-E</option>
            </select>
          </div>
        </div>

        {/* Row 2 — Unit / Brand */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Unit:<span className="text-rose-500">*</span></label>
            <select value={form.unit_id} onChange={set('unit_id')} className={sel}>
              <option value="">Please Select</option>
              {/* Every unit from the tenant's Inventory → Units page is
                  surfaced here — no hardcoded filter. The seeded list
                  (Box / Kilogram / Litre / Piece / Nos) ships by
                  default; tenants can add more from the Units page and
                  they appear automatically. */}
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.abbreviation || u.abbr || '—'})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={lbl}>Brand:</label>
            <select value={form.brand_id} onChange={set('brand_id')} className={sel}>
              <option value="">Please Select</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>

        {/* Row 3 — Category / Sub Category */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Category:</label>
            <select value={form.category_id} onChange={set('category_id')} className={sel}>
              <option value="">Please Select</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Sub category:</label>
            <select value={form.sub_category_id} onChange={set('sub_category_id')} className={sel}>
              <option value="">Please Select</option>
              {categories.filter((c) => c.parent_id === form.category_id).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 4 — Alert qty / Business Locations / Weight */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={lbl}>Alert quantity:</label>
            <input type="number" min="0" step="0.01" value={form.reorder_level} onChange={set('reorder_level')} placeholder="Alert quantity" className={ipt} />
          </div>
          <div>
            <label className={lbl}>Business Locations: <span className="text-brand-500" title="Pick where this product is sold">ⓘ</span></label>
            {/* Add-branch dropdown — pick a branch from the list to
                add it to the chips below. Replaces the previous
                always-visible chip grid the user found noisy when
                there were many branches. */}
            <select
              className={sel}
              value=""
              onChange={(e) => {
                const id = e.target.value
                if (id) toggleLocationChip(id)
              }}
            >
              <option value="">Please Select</option>
              {locations
                .filter((l) => !form.business_location_ids.includes(l.id))
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.code ? ` (${l.code})` : ''}
                  </option>
                ))}
            </select>
            {/* Selected branches show as removable chips. */}
            {form.business_location_ids.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {form.business_location_ids.map((id) => {
                  const l = locations.find((x) => x.id === id)
                  if (!l) return null
                  return (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
                      {l.name}{l.code ? ` (${l.code})` : ''}
                      <button type="button" onClick={() => toggleLocationChip(id)} className="hover:text-white/80" aria-label="Remove">×</button>
                    </span>
                  )
                })}
              </div>
            )}
            {locations.length === 0 && (
              <p className="mt-1 text-xs text-gray-400">No branches configured.</p>
            )}
          </div>
          <div>
            <label className={lbl}>Weight:</label>
            <input type="number" min="0" step="0.01" value={form.weight} onChange={set('weight')} placeholder="Weight" className={ipt} />
          </div>
        </div>

        {/* Manage stock toggle */}
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={!!form.manage_stock} onChange={(e) => setForm((f) => ({ ...f, manage_stock: e.target.checked }))} />
          <span className="font-semibold">Manage Stock?</span>
          <span className="text-xs text-gray-500">Enable stock management at product level</span>
        </label>

        {/* Product description */}
        <div>
          <label className={lbl}>Product Description:</label>
          <textarea
            value={form.description}
            onChange={set('description')}
            rows={5}
            placeholder="Add notes, specs, ingredients…"
            className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-brand-500"
          />
        </div>

        {/* Tax + selling price type */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Applicable Tax:</label>
            <select value={form.tax_rate} onChange={set('tax_rate')} className={sel}>
              <option value="">None</option>
              <option value="5">VAT 5%</option>
              <option value="7.5">VAT 7.5%</option>
              <option value="10">VAT 10%</option>
              <option value="15">VAT 15%</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Selling Price Tax Type:</label>
            <select value={form.tax_type} onChange={set('tax_type')} className={sel}>
              <option value="exclusive">Exclusive</option>
              <option value="inclusive">Inclusive</option>
            </select>
          </div>
        </div>

        {/* Toggles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={!!form.not_for_selling} onChange={(e) => setForm((f) => ({ ...f, not_for_selling: e.target.checked }))} />
            Not for selling
          </label>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={!!form.enable_imei} onChange={(e) => setForm((f) => ({ ...f, enable_imei: e.target.checked }))} />
            Enable IMEI / Serial Number
          </label>
        </div>

        {/* Custom fields */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((n) => (
            <div key={n}>
              <label className={lbl}>Custom Field{n}:</label>
              <input value={form[`custom_${n}`]} onChange={set(`custom_${n}`)} placeholder={`Custom Field${n}`} className={ipt} />
            </div>
          ))}
        </div>

        {/* Purchase price block */}
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Purchase Price</p>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className={lbl}>Exc. tax:</label>
              <input
                type="number" min="0" step="0.01"
                value={form.purchase_price_exc}
                onChange={(e) => { setPriceLastTouched('purchase'); set('purchase_price_exc')(e) }}
                className={ipt}
              />
            </div>
            <div>
              <label className={lbl}>Inc. tax:</label>
              <input
                type="number" min="0" step="0.01"
                value={form.purchase_price_inc}
                readOnly
                className={`${ipt} bg-gray-50`}
              />
              <div className={sub}>Auto from Exc. tax + Applicable Tax</div>
            </div>
            <div>
              <label className={lbl}>x Margin (%):</label>
              <input
                type="number" min="0" step="0.01"
                value={form.margin_pct}
                onChange={(e) => { setPriceLastTouched('margin'); set('margin_pct')(e) }}
                placeholder="40.00"
                className={ipt}
              />
              <div className={sub}>Auto from Selling ÷ Purchase when you type the price</div>
            </div>
            <div>
              <label className={lbl}>Selling Price (Exc. tax):</label>
              <input
                type="number" min="0" step="0.01"
                value={form.selling_price_exc}
                onChange={(e) => { setPriceLastTouched('selling'); set('selling_price_exc')(e) }}
                className={ipt}
              />
              <div className={sub}>Two-way: edit this OR Margin and the other re-computes</div>
            </div>
          </div>
        </div>

        {/* Opening stock */}
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Add Opening Stock</p>
          <div className="space-y-2">
            {openingStock.map((row, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label className={lbl}>Location:</label>
                  <select value={row.location_id} onChange={(e) => setOpening(i, { location_id: e.target.value })} className={sel}>
                    <option value="">Please Select</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Quantity:</label>
                  <input type="number" min="0" step="0.01" value={row.quantity} onChange={(e) => setOpening(i, { quantity: e.target.value })} placeholder="0" className={ipt} />
                </div>
                <div>
                  <label className={lbl}>Unit Cost (Before Tax):</label>
                  <input type="number" min="0" step="0.01" value={row.unit_cost} onChange={(e) => setOpening(i, { unit_cost: e.target.value })} placeholder="0" className={ipt} />
                </div>
                <div>
                  <label className={lbl}>Subtotal (Before Tax):</label>
                  <input
                    readOnly
                    value={(Number(row.quantity || 0) * Number(row.unit_cost || form.purchase_price_exc || 0)).toFixed(2)}
                    className={`${ipt} bg-gray-50`}
                  />
                </div>
              </div>
            ))}
            <div className="flex justify-between">
              <button type="button" onClick={addOpeningRow} className="text-xs font-semibold text-brand-600 hover:underline">+ Add another row</button>
              {openingStock.length > 1 && (
                <button type="button" onClick={() => removeOpeningRow(openingStock.length - 1)} className="text-xs font-semibold text-rose-600 hover:underline">Remove last</button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={submit} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}


// (AddCustomerModal removed — POS now reuses the Customers page's
//  full CustomerModal via the import at the top of this file.)

function PaymentModal({ method, total, itemCount, onClose, onConfirm }) {
  const [amount, setAmount] = useState(method === 'CREDIT' ? '0' : total.toFixed(2))
  const [payMethod, setPayMethod] = useState(method)
  const [reference, setReference] = useState('')
  const [account,   setAccount]   = useState('')
  const [note,      setNote]      = useState('')
  const [accounts,  setAccounts]  = useState([])
  const [saving,    setSaving]    = useState(false)

  useEffect(() => {
    getAccounts({ active: 'true' })
      .then((res) => setAccounts(Array.isArray(res) ? res : (res?.results ?? [])))
      .catch(() => {})
  }, [])

  const paying  = Number(amount) || 0
  const change  = Math.max(paying - total, 0)
  const balance = Math.max(total - paying, 0)
  const isCardLike = payMethod === 'CARD'

  const confirm = async () => {
    setSaving(true)
    try { await onConfirm({ amount: Math.min(paying, total + change), method: payMethod, reference }) }
    finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="Payment" size="3xl">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-4">
        <div className="rounded-lg bg-gray-50 p-4 space-y-4">
          <p className="text-xs text-gray-500">Advance Balance: <span className="font-semibold text-navy-800">৳ 0.00</span></p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="Amount *" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Select label="Payment Method *" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="BKASH">bKash</option>
              <option value="NAGAD">Nagad</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CREDIT">Credit</option>
            </Select>
            <Select label="Payment Account" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">None</option>
              {accounts.filter((a) => a.account_type === 'ASSET').map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
          </div>
          {isCardLike && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input label="Card Number"      value={reference} onChange={(e) => setReference(e.target.value)} />
              <Input label="Card Holder Name" />
              <Input label="Card Transaction No." />
            </div>
          )}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Payment Note</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="rounded-lg bg-gradient-to-b from-emerald-500 to-teal-500 text-white p-4 space-y-3">
          <Stat label="Total Items"   value={itemCount} />
          <div className="h-px bg-white/20" />
          <Stat label="Total Payable" value={fmtMoney(total)} big />
          <div className="h-px bg-white/20" />
          <Stat label="Total Paying"  value={fmtMoney(paying)} />
          <div className="h-px bg-white/20" />
          <Stat label="Change Return" value={fmtMoney(change)} />
          <div className="h-px bg-white/20" />
          <Stat label="Due"           value={fmtMoney(balance)} />
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={confirm} loading={saving}>Finalize Payment</Button>
      </ModalFooter>
    </Modal>
  )
}

function Stat({ label, value, big }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider opacity-80">{label}</p>
      <p className={`mt-0.5 font-bold ${big ? 'text-2xl' : 'text-base'}`}>{value}</p>
    </div>
  )
}

// Pick the best default Payment Account for a given Method choice. We
// look at the account_type column: Cash → CASH, Card → CARD, Bank
// Transfer / Cheque → BANK, bKash / Nagad → MFS.
function _defaultAccountForMethod(method, accounts) {
  if (!accounts?.length) return ''
  const wantType = {
    CASH:          'CASH',
    CARD:          'CARD',
    BANK_TRANSFER: 'BANK',
    CHEQUE:        'BANK',
    BKASH:         'MFS',
    NAGAD:         'MFS',
  }[method]
  const match = accounts.find((a) => a.account_type === wantType)
  return match ? String(match.id) : ''
}

function MultiplePayModal({ total, itemCount, advanceBalance = 0, onClose, onConfirm }) {
  // Payment Accounts (cash boxes / banks / wallets). Loaded once when
  // the modal opens; quick-create adds new rows to the list in-place.
  const [accounts, setAccounts] = useState([])
  const [acctLoading, setAcctLoading] = useState(true)
  const [acctError, setAcctError] = useState('')
  const [showNewAcct, setShowNewAcct] = useState(false)
  const [activeRowIdx, setActiveRowIdx] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setAcctLoading(true); setAcctError('')
      try {
        const res  = await getPaymentAccounts({ active: 'true' })
        const list = Array.isArray(res) ? res : (res?.results ?? [])
        if (!cancelled) setAccounts(list)
      } catch (err) {
        if (!cancelled) setAcctError(err?.message || 'Could not load payment accounts.')
      } finally {
        if (!cancelled) setAcctLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Initial row: full grand total, Cash, with the first cash account
  // pre-selected once accounts load.
  const [rows, setRows] = useState([
    { amount: total.toFixed(2), method: 'CASH', reference: '', payment_account_id: '' },
  ])
  const [saving, setSaving] = useState(false)

  // Whenever the accounts list changes, fill in any blank account slots
  // with the best default for the row's method. This handles both the
  // initial load and a brand-new account just created in the modal.
  useEffect(() => {
    if (!accounts.length) return
    setRows((prev) => prev.map((r) =>
      r.payment_account_id
        ? r
        : { ...r, payment_account_id: _defaultAccountForMethod(r.method, accounts) }
    ))
  }, [accounts])

  const update = (i, patch) => setRows((p) => p.map((r, idx) => {
    if (idx !== i) return r
    const next = { ...r, ...patch }
    // If the user changed the method but hasn't manually picked an
    // account yet, jump to the matching default. Don't override an
    // explicit choice.
    if (patch.method && patch.payment_account_id === undefined) {
      next.payment_account_id = _defaultAccountForMethod(patch.method, accounts)
    }
    return next
  }))
  const remove = (i) => setRows((p) => p.filter((_, idx) => idx !== i))
  const add    = () => setRows((p) => [
    ...p,
    {
      amount:             '0.00',
      method:             'CASH',
      reference:          '',
      payment_account_id: _defaultAccountForMethod('CASH', accounts),
    },
  ])

  const openNewAccountFor = (idx) => {
    setActiveRowIdx(idx)
    setShowNewAcct(true)
  }
  const handleNewAccountCreated = (created) => {
    setAccounts((prev) => [created, ...prev])
    // Assign the new account to whichever row triggered the create.
    setRows((prev) => prev.map((r, idx) =>
      idx === activeRowIdx ? { ...r, payment_account_id: String(created.id) } : r
    ))
    setShowNewAcct(false)
  }

  const paying  = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const balance = Math.max(total - paying, 0)
  const change  = Math.max(paying - total, 0)

  const confirm = async () => {
    setSaving(true)
    try { await onConfirm(rows) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="Payment — Multiple methods" size="3xl">
      {acctError && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          {acctError} You can still record payments, but they won&rsquo;t be tied to a payment account.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-4">
        <div className="space-y-3">
          {rows.map((r, idx) => (
            <div key={idx} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                <div className="sm:col-span-3">
                  <Input label="Amount" type="number" min="0" step="0.01"
                         value={r.amount}
                         onChange={(e) => update(idx, { amount: e.target.value })} />
                </div>
                <div className="sm:col-span-3">
                  <Select label="Method" value={r.method}
                          onChange={(e) => update(idx, { method: e.target.value })}>
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="BKASH">bKash</option>
                    <option value="NAGAD">Nagad</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="ADVANCE">Advance Balance</option>
                  </Select>
                </div>
                <div className="sm:col-span-4">
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">Payment account</label>
                  <div className="flex gap-1">
                    <select
                      value={r.method === 'ADVANCE' ? '' : r.payment_account_id}
                      onChange={(e) => update(idx, { payment_account_id: e.target.value })}
                      className="flex-1 h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-100 disabled:text-gray-400"
                      disabled={acctLoading || r.method === 'ADVANCE'}
                    >
                      <option value="">{r.method === 'ADVANCE' ? 'Not required' : (acctLoading ? 'Loading…' : 'None')}</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}{a.account_type ? ` (${a.account_type})` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => openNewAccountFor(idx)}
                      title="Add a new payment account"
                      className="h-10 w-10 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 inline-flex items-center justify-center"
                    >
                      <IconPlus />
                    </button>
                  </div>
                </div>
                <div className="sm:col-span-1 flex justify-end pb-1">
                  {rows.length > 1 && (
                    <button onClick={() => remove(idx)} className="text-gray-400 hover:text-rose-600 p-2">
                      <IconX />
                    </button>
                  )}
                </div>
                <div className="sm:col-span-12">
                  <Input label="Reference (optional)"
                         placeholder="Card auth code / bank ref / cheque no…"
                         value={r.reference}
                         onChange={(e) => update(idx, { reference: e.target.value })} />
                </div>
              </div>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={add} leftIcon={<IconPlus />}>Add Payment Row</Button>
        </div>

        <div className="rounded-lg bg-gradient-to-b from-emerald-500 to-teal-500 text-white p-4 space-y-3">
          <Stat label="Total Items"   value={itemCount} />
          <div className="h-px bg-white/20" />
          <Stat label="Advance Balance" value={fmtMoney(advanceBalance)} />
          <div className="h-px bg-white/20" />
          <Stat label="Total Payable" value={fmtMoney(total)} big />
          <div className="h-px bg-white/20" />
          <Stat label="Total Paying"  value={fmtMoney(paying)} />
          <div className="h-px bg-white/20" />
          <Stat label="Change Return" value={fmtMoney(change)} />
          <div className="h-px bg-white/20" />
          <Stat label="Due"           value={fmtMoney(balance)} />
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={confirm} loading={saving}>Finalize Payment</Button>
      </ModalFooter>

      {showNewAcct && (
        <NewPaymentAccountModal
          onClose={() => setShowNewAcct(false)}
          onCreated={handleNewAccountCreated}
        />
      )}
    </Modal>
  )
}

// Quick-create dialog launched from the "+ New" button next to a row's
// Payment account dropdown. Saves via the real /api/accounting/payment-accounts/
// endpoint so the new row also appears on the Payment Accounts page.
function NewPaymentAccountModal({ onClose, onCreated }) {
  const [name,    setName]    = useState('')
  const [type,    setType]    = useState('CASH')
  const [number,  setNumber]  = useState('')
  const [opening, setOpening] = useState('0')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const submit = async (e) => {
    e?.preventDefault?.()
    setError('')
    if (!name.trim()) { setError('Account name is required.'); return }
    setSaving(true)
    try {
      const created = await createPaymentAccount({
        name:            name.trim(),
        account_type:    type,
        account_number:  number.trim(),
        opening_balance: Number(opening || 0),
        is_active:       true,
      })
      onCreated(created)
    } catch (err) {
      setError(err?.message || 'Could not create the payment account.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Add Payment Account" size="md">
      <form onSubmit={submit} className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <Input
          label="Account name"
          placeholder="e.g. City Bank — Ongko"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
        />
        <Select
          label="Account type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="CASH">Cash balance</option>
          <option value="BANK">Bank balance</option>
          <option value="MFS">Mobile banking (bKash / Nagad …)</option>
          <option value="CARD">Card / Gateway</option>
          <option value="OTHER">Other</option>
        </Select>
        <Input
          label="Account number (optional)"
          placeholder="Bank A/C No., wallet number, etc."
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <Input
          label="Opening balance"
          type="number" min="0" step="0.01"
          value={opening}
          onChange={(e) => setOpening(e.target.value)}
        />
      </form>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Create account</Button>
      </ModalFooter>
    </Modal>
  )
}

function AddExpenseModal({ onClose, locationId, onSaved }) {
  const [form, setForm] = useState({
    location_id:      locationId || '',
    category:         '',
    reference_no:     '',
    expense_date:     new Date().toISOString().slice(0, 10),
    expense_for:      '',          // Business Location FK
    expense_for_name: '',          // resolved branch label sent to API
    tax:          0,
    amount:       '',
    note:         '',
    pay_amount:   '',
    paid_on:      new Date().toISOString().slice(0, 16),
    pay_method:   'Cash',
    pay_account:  '',
    pay_note:     '',
    // Method-specific extras — only sent when the chosen pay_method
    // actually uses them. Backend silently drops unknown keys.
    card_number:         '',
    card_holder_name:    '',
    card_transaction_no: '',
    card_type:           'CREDIT_CARD',
    card_month:          '',
    card_year:           '',
    card_security_code:  '',
    cheque_no:           '',
    bank_account_no:     '',
  })
  const [accounts, setAccounts] = useState([])
  const [locations, setLocations] = useState([])
  // Live ExpenseCategory list (tenant-managed via Settings → Expense
  // Categories). Replaces the previous hardcoded RENT/UTILITIES/…
  // select so any category the tenant adds shows up immediately.
  const [expCategories, setExpCategories] = useState([])
  // User-facing PaymentAccounts (Cash on Hand / City Bank / bKash) —
  // the correct dropdown for "where the money came out of".
  const [paymentAccountsList, setPaymentAccountsList] = useState([])
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  useEffect(() => {
    Promise.all([
      getAccounts({ active: 'true' }).catch(() => []),
      getLocations(true).catch(() => []),
      // Lazy-import the rich API helpers so this modal works even
      // when the host page hasn't already imported them.
      import('../../api/accounting').then((api) => Promise.all([
        api.getExpenseCategories?.({ active: 'true' }).catch(() => []),
        api.getPaymentAccounts?.({ active: 'true' }).catch(() => []),
      ])),
    ]).then(([accts, locs, [cats, pacts]]) => {
      setAccounts(Array.isArray(accts) ? accts : (accts?.results ?? []))
      setLocations(Array.isArray(locs)  ? locs  : (locs?.results  ?? []))
      setExpCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
      setPaymentAccountsList(Array.isArray(pacts) ? pacts : (pacts?.results ?? []))
    })
  }, [])

  const expenseAccts = accounts.filter((a) => a.account_type === 'EXPENSE')

  const set = (k) => (e) => setForm({ ...form, [k]: e.target?.value ?? e })

  const total      = Number(form.amount) || 0
  const taxAmount  = total * (Number(form.tax) || 0) / 100
  const grand      = total + taxAmount
  const paid       = Number(form.pay_amount) || 0
  const paymentDue = Math.max(grand - paid, 0)

  const save = async () => {
    setError('')
    if (!form.location_id)  { setError('Business location is required.'); return }
    if (!total || total<=0) { setError('Total amount must be greater than zero.'); return }
    if (!form.pay_account)  { setError('Payment account is required.'); return }
    // Expense account is now optional — backend picks the first
    // EXPENSE chart account when omitted. Category is also optional
    // since the dropdown gates on the user-managed list.
    const expAcct = expenseAccts[0]

    setSaving(true)
    try {
      // Pick the best reference for this payment method. The Account
      // Book row carries this token so a cashier can audit which
      // cheque/card/transfer the cash went out on later.
      const methodReference =
        (form.pay_method === 'Card' && form.card_transaction_no) ||
        (form.pay_method === 'Cheque' && form.cheque_no) ||
        (form.pay_method === 'Bank Transfer' && form.bank_account_no) ||
        form.reference_no.trim() ||
        ''

      await createExpense({
        category:           form.category,
        amount:             grand.toFixed(2),
        tax_amount:         taxAmount.toFixed(2),
        paid_amount:        paid.toFixed(2),
        // Optional now — backend falls back to the first EXPENSE
        // chart account when omitted. Kept for back-compat.
        expense_account_id: expAcct?.id,
        // payment_account_id is the user-facing PaymentAccount FK
        // (Cash on Hand / City Bank / bKash) — drives WHICH visible
        // account decrements on the List Accounts page. The
        // chart-of-accounts journal entry is resolved server-side.
        payment_account_id: form.pay_account,
        // ExpenseCategory FK if the picked value is a UUID (new flow);
        // otherwise it's a legacy string ("RENT"/"OTHER") sent as
        // `category`.
        ...(form.category && form.category.includes('-') && form.category.length > 20
          ? { expense_category_id: form.category, category: 'OTHER' }
          : { category: form.category || 'OTHER' }),
        description:        form.note.trim(),
        expense_date:       form.expense_date,
        reference_no:       methodReference || form.reference_no.trim(),
        location_id:        form.location_id,
        // expense_for now holds a Business Location id; we send the
        // resolved branch name so the All Expenses list shows it.
        expense_for:        form.expense_for_name || form.expense_for || '',
        // Method-specific extras — backend silently drops keys it
        // doesn't recognise, so this is forward-compatible if the
        // expense schema is widened later.
        payment_method:     form.pay_method,
        ...(form.pay_method === 'Card' && {
          card_number:         form.card_number,
          card_holder_name:    form.card_holder_name,
          card_transaction_no: form.card_transaction_no,
          card_type:           form.card_type,
          card_month:          form.card_month,
          card_year:           form.card_year,
          card_security_code:  form.card_security_code,
        }),
        ...(form.pay_method === 'Cheque'        && { cheque_no:       form.cheque_no }),
        ...(form.pay_method === 'Bank Transfer' && { bank_account_no: form.bank_account_no }),
      })
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save expense.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Add Expense" size="2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Business Location *" value={form.location_id} onChange={set('location_id')}>
            <option value="">Please select</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          {/* Categories now driven by the tenant-managed ExpenseCategory
              list (Settings → Expense Categories). Anything added there
              shows up here on next page-load. */}
          <Select label="Expense Category" value={form.category} onChange={set('category')}>
            <option value="">Please select</option>
            {expCategories.length === 0 && (
              <>
                {/* Fallback legacy options shown only when the tenant
                    hasn't added any categories yet. */}
                <option value="RENT">Rent</option>
                <option value="UTILITIES">Utilities</option>
                <option value="SALARIES">Salaries</option>
                <option value="MARKETING">Marketing</option>
                <option value="SUPPLIES">Supplies</option>
                <option value="TRANSPORT">Transport</option>
                <option value="OTHER">Other</option>
              </>
            )}
            {expCategories
              .filter((c) => !c.parent && !c.parent_id)
              .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Reference No" placeholder="Auto-generated if blank" value={form.reference_no} onChange={set('reference_no')} hint="Leave empty to autogenerate" />
          <Input label="Date *" type="date" value={form.expense_date} onChange={set('expense_date')} />
          {/* Expense For — Business Locations list per spec. */}
          <Select label="Expense for" value={form.expense_for} onChange={(e) => {
            const id = e.target.value
            const branch = locations.find((l) => l.id === id)
            setForm((f) => ({ ...f, expense_for: id, expense_for_name: branch?.name || '' }))
          }}>
            <option value="">None</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Applicable Tax" value={form.tax} onChange={set('tax')}>
            <option value={0}>None</option>
            <option value={5}>VAT 5%</option>
            <option value={7.5}>VAT 7.5%</option>
            <option value={10}>VAT 10%</option>
            <option value={15}>VAT 15%</option>
          </Select>
          <Input label="Total amount *" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} placeholder="0.00" />
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Expense Note</label>
            <textarea rows={2} value={form.note} onChange={set('note')} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Add Payment</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="Amount *" type="number" min="0" step="0.01" value={form.pay_amount} onChange={set('pay_amount')} placeholder="0.00" />
            <Input label="Paid on *" type="datetime-local" value={form.paid_on} onChange={set('paid_on')} />
            <Select label="Payment Method *" value={form.pay_method} onChange={set('pay_method')}>
              <option>Cash</option>
              <option>Bank Transfer</option>
              <option>Card</option>
              <option>Mobile Banking</option>
              <option>Cheque</option>
            </Select>
            {/* Payment Account = user-facing PaymentAccount (Cash on
                Hand / City Bank / bKash). Picking one ensures the
                expense decrements THAT account's balance on the
                List Accounts page. Earlier this listed chart-of-
                accounts rows whose ids the backend treated as
                "missing PaymentAccount", so the balance never moved. */}
            <Select label="Payment Account *" value={form.pay_account} onChange={set('pay_account')}>
              <option value="">Please select</option>
              {paymentAccountsList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.account_type ? ` (${a.account_type})` : ''}
                </option>
              ))}
            </Select>
            {/* CARD-specific fields */}
            {form.pay_method === 'Card' && (
              <>
                <Input label="Card Number" placeholder="Card Number"
                       value={form.card_number}
                       onChange={(e) => setForm({ ...form, card_number: e.target.value.replace(/[^\d ]/g, '') })} />
                <Input label="Card holder name" placeholder="Card holder name"
                       value={form.card_holder_name}
                       onChange={(e) => setForm({ ...form, card_holder_name: e.target.value.replace(/[^A-Za-z\s.'-]/g, '') })} />
                <Input label="Card Transaction No." placeholder="Card Transaction No."
                       value={form.card_transaction_no}
                       onChange={set('card_transaction_no')} />
                <Select label="Card Type" value={form.card_type} onChange={set('card_type')}>
                  <option value="CREDIT_CARD">Credit Card</option>
                  <option value="DEBIT_CARD">Debit Card</option>
                  <option value="PREPAID">Prepaid</option>
                </Select>
                <Input label="Month" placeholder="MM" maxLength={2}
                       value={form.card_month}
                       onChange={(e) => setForm({ ...form, card_month: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
                <Input label="Year" placeholder="YYYY" maxLength={4}
                       value={form.card_year}
                       onChange={(e) => setForm({ ...form, card_year: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                <Input label="Security Code" placeholder="CVV" maxLength={4}
                       value={form.card_security_code}
                       onChange={(e) => setForm({ ...form, card_security_code: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
              </>
            )}

            {/* CHEQUE-specific field */}
            {form.pay_method === 'Cheque' && (
              <Input label="Cheque No." placeholder="Cheque No."
                     value={form.cheque_no}
                     onChange={set('cheque_no')} />
            )}

            {/* BANK TRANSFER-specific field */}
            {form.pay_method === 'Bank Transfer' && (
              <Input label="Bank Account No" placeholder="Bank Account No" inputMode="numeric"
                     value={form.bank_account_no}
                     onChange={(e) => setForm({ ...form, bank_account_no: e.target.value.replace(/[^\d -]/g, '') })} />
            )}

            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Payment Note</label>
              <textarea rows={2} value={form.pay_note} onChange={set('pay_note')} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </div>
          </div>
          <p className="mt-3 text-right text-sm">
            <span className="text-gray-500">Payment due: </span>
            <span className={paymentDue > 0 ? 'text-rose-600 font-semibold' : 'text-emerald-700 font-semibold'}>{fmtMoney(paymentDue)}</span>
          </p>
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}

function ReceiptModal({ sale, customer, location, onClose }) {
  // Print-only InvoiceSlip — the on-screen modal stays as a quick payment
  // confirmation; the actual printed sheet is the tenant-branded design.
  // Pull the customer's overall outstanding so "Customer Total Due"
  // can print under the totals. Skips for walk-in customers.
  const [customerTotalDue, setCustomerTotalDue] = useState(Number(sale?.customer_total_due) || 0)
  useEffect(() => {
    let cancelled = false
    const cid = customer?.id || sale?.customer_id
    if (!cid) { setCustomerTotalDue(0); return }
    getCustomerCreditSummary(cid)
      .then((cs) => {
        if (cancelled) return
        // Backend returns current_due (sum of every FINAL non-VOIDED
        // sale's balance_due). Subtract this receipt's own due so the
        // "Customer Total Due" line shows only OTHER outstanding
        // invoices for the customer.
        const total = Number(cs?.current_due || 0)
        const thisDue = Number(sale?.balance_due || Math.max(0, Number(sale?.total || 0) - Number(sale?.paid ?? sale?.amount_paid ?? 0)))
        setCustomerTotalDue(Math.max(0, total - thisDue))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [customer?.id, sale?.customer_id, sale?.balance_due, sale?.total, sale?.paid, sale?.amount_paid])

  const items = (sale.items || sale.lines || []).map((it, i) => ({
    id:           it.id ?? i,
    product_name: it.product_name || it.name,
    description:  it.product_name || it.name,
    sku:          it.product_sku || it.sku,
    // Per-line note: finalized sale items carry `note`; a cart-shaped
    // fallback keeps its note in `description`.
    note:         it.note ?? it.description ?? '',
    unit_price:   it.unit_price ?? it.price,
    quantity:     it.quantity ?? it.qty,
    line_total:   it.line_total ?? (Number(it.unit_price || it.price || 0) * Number(it.quantity || it.qty || 0)),
  }))
  return (
    <Modal open onClose={onClose} title="Payment successful" size="md">
      <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white p-6 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/20 mb-3">
          <svg className="w-7 h-7" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" /></svg>
        </div>
        <p className="text-sm opacity-90">Total paid</p>
        <p className="text-3xl font-extrabold tracking-tight">{fmtMoney(sale.paid)}</p>
        <p className="mt-1 text-xs opacity-80">via {METHOD_LABEL[sale.method] || sale.method}</p>
      </div>
      <div className="mt-4 text-sm space-y-1">
        <div className="flex justify-between"><span className="text-gray-500">Invoice</span><span className="font-mono font-semibold">{sale.invoice_number || sale.id?.slice(0, 8)}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Customer</span><span>{customer?.name || 'Walk-in'}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Location</span><span>{location?.name || '—'}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Total</span><span className="font-semibold">{fmtMoney(sale.total)}</span></div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={() => window.print()} leftIcon={<IconPrint />}>Print receipt</Button>
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>

      {/* Print-only classic POS invoice (image format). Hidden on screen;
          takes over the page on window.print() via @media print rules. */}
      <PosInvoiceSlip
        mode="print-only"
        invoice={{
          number: sale.invoice_number || (sale.id ? sale.id.toString().slice(0, 8) : '—'),
          date:   sale.finalized_at || sale.created_at || new Date(),
        }}
        customer={{ name: customer?.name || 'Walk-in customer', phone: customer?.phone }}
        items={items.map((it) => ({
          name: it.product_name || it.description, sku: it.sku,
          quantity: it.quantity, unit: it.unit, unit_price: it.unit_price,
          subtotal: it.line_total,
        }))}
        payments={Number(sale.paid ?? sale.amount_paid) > 0
          ? [{ label: 'Advance', amount: sale.paid ?? sale.amount_paid, date: sale.finalized_at || sale.created_at }]
          : []}
        totals={{
          subtotal: sale.subtotal ?? sale.total,
          total:    sale.total,
          paid:     sale.paid ?? sale.amount_paid,
        }}
      />
    </Modal>
  )
}

// Map a full sale (getSale detail) → classic POS invoice props (image format).
function saleToPosInvoiceProps(sale, staffRoster = []) {
  const meta = sale.meta || {}
  const staffId = meta.service_staff ? String(meta.service_staff) : ''
  const agent = (staffRoster.find((s) => String(s.id) === staffId) || {}).label || ''
  return {
    invoice: {
      number: sale.invoice_number || (sale.id ? String(sale.id).slice(0, 8) : '—'),
      date:   sale.finalized_at || sale.created_at || new Date(),
    },
    customer: { name: sale.customer?.name || 'Walk-in customer', phone: sale.customer?.phone },
    agent,
    staff: sale.created_by_name || '',
    items: (sale.items || []).map((it) => ({
      name: it.product_name, sku: it.product_sku,
      quantity: it.quantity, unit: '', unit_price: it.unit_price,
      subtotal: it.total_price ?? Number(it.unit_price || 0) * Number(it.quantity || 0),
    })),
    payments: (sale.sale_payments || []).map((p) => ({
      label: 'Advance', amount: p.amount, date: p.created_at,
    })),
    totals: {
      subtotal: sale.subtotal ?? sale.total_amount,
      total:    sale.total_amount,
      paid:     sale.amount_paid,
    },
  }
}

// Recent-transaction invoice preview + print (classic POS / image format),
// shown on the same page (no navigation to All Sales detail).
function PosInvoicePrintModal({ sale, staffRoster, onClose }) {
  const props = saleToPosInvoiceProps(sale, staffRoster)
  return (
    <Modal open onClose={onClose} title={`Invoice ${props.invoice.number}`} size="3xl">
      <div className="max-h-[72vh] overflow-auto rounded-lg bg-gray-100 p-3">
        <div className="mx-auto bg-white shadow-sm">
          <PosInvoiceSlip {...props} mode="screen" />
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => window.print()} leftIcon={<IconPrint />}>Print</Button>
      </ModalFooter>
      <PosInvoiceSlip {...props} mode="print-only" />
    </Modal>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────
function IconPlus()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg> }
function IconX()          { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg> }
function IconSearch()     { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg> }
// ─────────────────────────────────────────────────────────────────────
// EditCartLineModal — opens when the cashier clicks a product name in
// the POS cart. Lets them override the unit price, set a per-line
// discount (Fixed currency OR Percent) and attach a description
// (IMEI / serial number / cashier note). Close → committed back to
// the parent's cart state via onSave; the new price + discount drive
// the line subtotal everywhere (running totals, payload, invoice).
// No hardcoded products / prices — every value comes from the cart
// row, which itself was hydrated from /api/inventory/products/.
// ─────────────────────────────────────────────────────────────────────
function EditCartLineModal({ line, onClose, onSave }) {
  const [price,         setPrice]         = useState(String(line.price ?? ''))
  const [discountType,  setDiscountType]  = useState(line.discount_type || 'FIXED')
  const [discountValue, setDiscountValue] = useState(String(line.discount_value ?? 0))
  const [description,   setDescription]   = useState(line.description || '')
  const [err,           setErr]           = useState('')

  // Drop the cursor straight into Unit Price (and select it) when the popup
  // opens, so the cashier can immediately type a new price.
  const priceRef = useRef(null)
  useEffect(() => {
    const id = setTimeout(() => { priceRef.current?.focus(); priceRef.current?.select() }, 60)
    return () => clearTimeout(id)
  }, [])

  const submit = () => {
    const p = Number(price)
    const d = Number(discountValue)
    if (!(p >= 0)) { setErr('Unit price must be a number ≥ 0.'); return }
    if (!(d >= 0)) { setErr('Discount amount must be a number ≥ 0.'); return }
    if (discountType === 'FIXED' && d > p) {
      setErr('Fixed discount cannot exceed the unit price.'); return
    }
    if (discountType === 'PERCENT' && d > 100) {
      setErr('Percent discount cannot exceed 100%.'); return
    }
    onSave({
      price:          p,
      discount_type:  discountType,
      discount_value: d,
      description:    description,
    })
  }

  const title = `${line.name || 'Product'}${line.sku ? ` - ${line.sku}` : ''}`
  const lbl = 'block text-[12px] font-medium text-gray-700 mb-1'
  const ipt = 'w-full h-10 rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title={title} size="md">
      <div className="space-y-3">
        {err && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
        )}
        <div>
          <label className={lbl}>Unit Price</label>
          <input ref={priceRef} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className={ipt} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Discount Type</label>
            <select value={discountType} onChange={(e) => setDiscountType(e.target.value)} className={ipt}>
              <option value="FIXED">Fixed</option>
              <option value="PERCENT">Percentage</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Discount Amount</label>
            <input type="number" min="0" step="0.01" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} className={ipt} />
          </div>
        </div>
        <div>
          <label className={lbl}>Note</label>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={`${ipt} h-auto py-2`} />
          <p className="mt-1 text-xs text-gray-500">This note is printed on the invoice under this product (e.g. IMEI, serial number, or other details).</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Update</Button>
      </div>
    </Modal>
  )
}

function IconDraft()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></svg> }
function IconQuote()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9H3l3-3v-6" /></svg> }
function IconPause()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 5v14M15 5v14" /></svg> }
function IconCredit()     { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9 10l5 4M14 10l-5 4" /></svg> }
function IconCard()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20M6 15h4" /></svg> }
function IconStack()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" /></svg> }
function IconCash()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg> }
function IconPrint()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2M7 14h10v7H7z" /></svg> }
function IconList()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg> }
function IconMinusCircle(){ return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /></svg> }
function IconTruck()      { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h13v9H3zM16 9h4l1 3v3h-5z" /><circle cx="6.5" cy="17.5" r="1.5" /><circle cx="17.5" cy="17.5" r="1.5" /></svg> }
function IconRegister()   { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M7 8V5h10v3M7 13h10M9 17h6" /></svg> }
function IconLock()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></svg> }
function IconCalc()       { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2M16 16h0" /></svg> }

// ─────────────────────────────────────────────────────────────────────
// CalculatorModal — pure client-side mini calculator. Supports
// numbers, + − × ÷ %, decimal, clear, backspace, and physical
// keyboard input (digits, operators, Enter, Esc, Backspace). The
// expression is evaluated with a tiny safe-eval parser so we don't
// have to pull in mathjs.
// ─────────────────────────────────────────────────────────────────────
function CalculatorModal({ onClose }) {
  const [expr, setExpr]     = useState('')
  const [result, setResult] = useState('0')
  const [err, setErr]       = useState('')

  // Evaluate without using eval(). Replace × ÷ with * / then run a
  // simple shunting-yard. Pure integer / decimal arithmetic, no
  // identifiers, so it's safe for arbitrary input.
  const evaluate = (raw) => {
    if (!raw) return '0'
    const s = String(raw).replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')
    if (!/^[\d+\-*/.%()]+$/.test(s)) throw new Error('Invalid expression')
    // Reject "%%" or trailing operators
    if (/[+\-*/.%]{2,}/.test(s.replace(/--/g, ''))) {
      // allow unary minus right after an operator, but reject other doubles
    }
    // Token-and-shunt
    const tokens = []
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (/\d|\./.test(c)) {
        let j = i
        while (j < s.length && /[\d.]/.test(s[j])) j++
        tokens.push({ t: 'n', v: parseFloat(s.slice(i, j)) })
        i = j
      } else if ('+-*/%()'.includes(c)) {
        // unary minus → 0 - x
        if (c === '-' && (tokens.length === 0 || (tokens[tokens.length - 1].t === 'o' || tokens[tokens.length - 1].v === '('))) {
          tokens.push({ t: 'n', v: 0 })
        }
        tokens.push({ t: c === '(' || c === ')' ? c : 'o', v: c })
        i++
      } else {
        i++
      }
    }
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 }
    const out = [], ops = []
    for (const tk of tokens) {
      if (tk.t === 'n') out.push(tk)
      else if (tk.t === '(') ops.push(tk)
      else if (tk.t === ')') {
        while (ops.length && ops[ops.length - 1].v !== '(') out.push(ops.pop())
        ops.pop()
      } else {
        while (ops.length && ops[ops.length - 1].v !== '(' && prec[ops[ops.length - 1].v] >= prec[tk.v]) out.push(ops.pop())
        ops.push(tk)
      }
    }
    while (ops.length) out.push(ops.pop())
    const stack = []
    for (const tk of out) {
      if (tk.t === 'n') stack.push(tk.v)
      else {
        const b = stack.pop(), a = stack.pop()
        if (a === undefined || b === undefined) throw new Error('Bad')
        let r = 0
        if (tk.v === '+') r = a + b
        else if (tk.v === '-') r = a - b
        else if (tk.v === '*') r = a * b
        else if (tk.v === '/') { if (b === 0) throw new Error('÷0'); r = a / b }
        else if (tk.v === '%') r = a % b
        stack.push(r)
      }
    }
    const v = stack[0]
    if (v === undefined || Number.isNaN(v) || !Number.isFinite(v)) throw new Error('Bad')
    return String(Math.round(v * 1e10) / 1e10)
  }

  const press = (k) => {
    setErr('')
    if (k === 'C')  { setExpr(''); setResult('0'); return }
    if (k === '⌫') { setExpr((s) => s.slice(0, -1)); return }
    if (k === '=') {
      try { setResult(evaluate(expr)) } catch (e) { setErr('Invalid'); setResult('Error') }
      return
    }
    setExpr((s) => s + k)
  }

  // Live preview as the user types
  useEffect(() => {
    if (!expr) { setResult('0'); return }
    try { setResult(evaluate(expr)) } catch { /* live preview keeps last good value */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr])

  // Keyboard support
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key
      if (/^[\d.]$/.test(k))           { press(k); e.preventDefault() }
      else if ('+-*/%()'.includes(k))  { press(k); e.preventDefault() }
      else if (k === 'Enter' || k === '=') { press('='); e.preventDefault() }
      else if (k === 'Escape')             { press('C'); e.preventDefault() }
      else if (k === 'Backspace')          { press('⌫'); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr])

  const Key = ({ label, onClick, tone = 'default', wide = false }) => {
    const cls = tone === 'op'    ? 'bg-brand-50 text-brand-700 hover:bg-brand-100 border-brand-200'
              : tone === 'eq'    ? 'bg-brand-600 text-white hover:bg-brand-700 border-brand-600'
              : tone === 'clear' ? 'bg-rose-50 text-rose-700 hover:bg-rose-100 border-rose-200'
              : 'bg-white text-gray-800 hover:bg-gray-50 border-gray-200'
    return (
      <button
        type="button"
        onClick={() => press(onClick ?? label)}
        className={`h-12 rounded-md border text-base font-semibold ${cls} ${wide ? 'col-span-2' : ''} active:scale-95 transition`}
      >
        {label}
      </button>
    )
  }

  return (
    <Modal open onClose={onClose} title="Calculator" size="sm">
      <div className="space-y-2">
        {/* Display */}
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="text-xs text-gray-500 min-h-[18px] truncate">{expr || ' '}</div>
          <div className={`text-right text-3xl font-bold tabular-nums ${err ? 'text-rose-600' : 'text-gray-900'}`}>
            {result}
          </div>
        </div>
        {/* Keys — 4-column numpad */}
        <div className="grid grid-cols-4 gap-2">
          <Key label="C"  tone="clear" />
          <Key label="⌫" />
          <Key label="%"  tone="op" />
          <Key label="÷"  tone="op" onClick="/" />

          <Key label="7" /><Key label="8" /><Key label="9" /><Key label="×" tone="op" onClick="*" />
          <Key label="4" /><Key label="5" /><Key label="6" /><Key label="-" tone="op" />
          <Key label="1" /><Key label="2" /><Key label="3" /><Key label="+" tone="op" />
          <Key label="0" wide /><Key label="." /><Key label="=" tone="eq" />
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// CloseRegisterModal — fetches the same details payload as the
// Register Details modal, then adds the counted-cash / card slip /
// cheque inputs + a Closing Note textarea. On submit it POSTs to
// /api/reports/register/close/ which persists a RegisterClosure row.
// The next time anyone opens Register Details, the window resets to
// only the payments AFTER this closure.
// ─────────────────────────────────────────────────────────────────────
function CloseRegisterModal({ locationId, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [counted, setCounted] = useState({ cash: '', card: '', cheque: '' })
  const [note, setNote]   = useState('')
  const [busy, setBusy]   = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    getRegisterDetails(locationId ? { location_id: locationId } : {})
      .then((d) => {
        if (cancelled) return
        setData(d)
        // Pre-fill the counted inputs with the expected values so the
        // common case (drawer balances perfectly) is one-click.
        const cash = d?.payment_methods?.find?.((m) => m.key === 'CASH')?.sell || '0'
        const card = d?.payment_methods?.find?.((m) => m.key === 'CARD')?.sell || '0'
        const bank = d?.payment_methods?.find?.((m) => m.key === 'BANK_TRANSFER')?.sell || '0'
        setCounted({ cash, card, cheque: bank })
      })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load current register.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDT = (s) => s ? new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await closeRegister({
        location_id:    locationId || null,
        counted_cash:   Number(counted.cash)   || 0,
        counted_card:   Number(counted.card)   || 0,
        counted_cheque: Number(counted.cheque) || 0,
        closing_note:   note,
      })
      window.alert('Register closed.')
      onClose?.()
    } catch (e) {
      setErr(e?.message || 'Failed to close register.')
    } finally {
      setBusy(false)
    }
  }

  const title = data
    ? `Current Register ( ${fmtDT(data.open_time)} – ${fmtDT(data.close_time)} )`
    : 'Current Register'

  const ipt = 'w-full h-10 rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  return (
    <Modal open onClose={onClose} title={title} size="2xl">
      {loading ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : err && !data ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>
      ) : !data ? null : (
        <div className="space-y-5 text-sm">
          {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}

          {/* Payment Method table — same shape as Register Details */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-b border-gray-200">
              <thead className="text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 font-semibold">Payment Method</th>
                  <th className="text-right py-2 font-semibold">Sell</th>
                  <th className="text-right py-2 font-semibold">Expense</th>
                </tr>
              </thead>
              <tbody className="text-gray-700">
                {data.payment_methods.map((m) => (
                  <tr key={m.key} className="border-b border-gray-100">
                    <td className="py-1.5">{m.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.sell === '—' ? '—' : `৳ ${fmt(m.sell)}`}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.expense === '—' ? '—' : `৳ ${fmt(m.expense)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals strip */}
          <div className="space-y-1">
            <TotalRow label="Total Sales"    value={`৳ ${fmt(data.totals.total_sales)}`} />
            <TotalRow label="Total Refund"   value={`৳ ${fmt(data.totals.total_refund)}`} tone="rose" />
            <TotalRow label="Total Payment"  value={`৳ ${fmt(data.totals.total_payment)}`} tone="emerald" />
            <TotalRow label="Credit Sales"   value={`৳ ${fmt(data.totals.credit_sales)}`} tone="emerald" />
            <TotalRow label="Total Sales"    value={`৳ ${fmt(data.totals.total_sales)}`} tone="emerald" />
            <TotalRow label="Total Expenses" value={`৳ ${fmt(data.totals.total_expenses)}`} tone="rose" />
          </div>

          {/* Details of products sold */}
          <div>
            <h4 className="font-semibold text-gray-800 mb-2">Details of products sold</h4>
            <table className="w-full text-sm">
              <thead className="text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 font-semibold w-10">#</th>
                  <th className="text-left py-2 font-semibold">Brands</th>
                  <th className="text-right py-2 font-semibold">Quantity</th>
                  <th className="text-right py-2 font-semibold">Total amount</th>
                </tr>
              </thead>
              <tbody>
                {data.products_sold.length === 0 ? (
                  <tr><td colSpan={4} className="py-3 text-center text-gray-400">No sales in this register.</td></tr>
                ) : data.products_sold.map((r, i) => (
                  <tr key={r.brand} className="border-b border-gray-100">
                    <td className="py-1.5 text-gray-500">{i + 1}.</td>
                    <td className="py-1.5">{r.brand}</td>
                    <td className="py-1.5 text-right tabular-nums">{Number(r.qty).toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums">৳ {fmt(r.amount)}</td>
                  </tr>
                ))}
                {data.products_sold.length > 0 && (
                  <tr className="bg-emerald-50 font-semibold">
                    <td className="py-2"></td>
                    <td className="py-2">#</td>
                    <td className="py-2 text-right tabular-nums">{Number(data.products_grand_total.qty).toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">Grand Total: ৳ {fmt(data.products_grand_total.amount)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Counted-cash inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1">Total Cash:</label>
              <input type="number" step="0.01" value={counted.cash}   onChange={(e) => setCounted({ ...counted, cash: e.target.value })}   className={ipt} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1">Total Card Slips:</label>
              <input type="number" step="0.01" value={counted.card}   onChange={(e) => setCounted({ ...counted, card: e.target.value })}   className={ipt} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1">Total cheques:</label>
              <input type="number" step="0.01" value={counted.cheque} onChange={(e) => setCounted({ ...counted, cheque: e.target.value })} className={ipt} />
            </div>
          </div>

          {/* Cash Denominations note (placeholder card matching the
              reference image — full denominations editor lives under
              Settings → Business Settings → POS) */}
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600">
            <div className="font-semibold text-gray-700 mb-1">Cash Denominations</div>
            Add denominations in Settings &rarr; Business Settings &rarr; POS &rarr; Cash Denominations.
          </div>

          {/* Closing Note */}
          <div>
            <label className="block text-[12px] font-medium text-gray-700 mb-1">Closing Note</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Closing Note" className={`${ipt} h-auto py-2`} />
          </div>

          {/* Footer info */}
          <div className="pt-3 border-t border-gray-200 text-sm text-gray-700 space-y-0.5">
            <div><span className="font-semibold">User:</span> {data.user.name}</div>
            <div><span className="font-semibold">Email:</span> {data.user.email || '—'}</div>
            <div><span className="font-semibold">Business Location:</span> {data.location.name || '—'}</div>
          </div>
        </div>
      )}
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={busy} disabled={busy || loading}>Close Register</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// RegisterDetailsModal — opens from the POS top bar; matches the
// reference image. All data is fetched live from
// /api/reports/register/details/ (cashier × location × today). The
// modal renders three sections:
//   1) Payment Method table (Sell | Expense)
//   2) Totals strip (Sales / Refund / Payment / Credit / Expenses)
//   3) Products sold by brand + grand total
//   4) Footer: user, email, location
// ─────────────────────────────────────────────────────────────────────
function RegisterDetailsModal({ locationId, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    getRegisterDetails(locationId ? { location_id: locationId } : {})
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load register details.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDT = (s) => s ? new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
  const printDetails = () => window.print()

  const title = data
    ? `Register Details ( ${fmtDT(data.open_time)} – ${fmtDT(data.close_time)} )`
    : 'Register Details'

  return (
    <Modal open onClose={onClose} title={title} size="2xl">
      {loading ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : err ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>
      ) : !data ? null : (
        <div className="space-y-5 text-sm">
          {/* Payment Method table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-b border-gray-200">
              <thead className="text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 font-semibold">Payment Method</th>
                  <th className="text-right py-2 font-semibold">Sell</th>
                  <th className="text-right py-2 font-semibold">Expense</th>
                </tr>
              </thead>
              <tbody className="text-gray-700">
                {data.payment_methods.map((m) => (
                  <tr key={m.key} className="border-b border-gray-100">
                    <td className="py-1.5">{m.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.sell === '—' ? '—' : `৳ ${fmt(m.sell)}`}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.expense === '—' ? '—' : `৳ ${fmt(m.expense)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals strip */}
          <div className="space-y-1">
            <TotalRow label="Total Sales"    value={`৳ ${fmt(data.totals.total_sales)}`} />
            <TotalRow label="Total Refund"   value={`৳ ${fmt(data.totals.total_refund)}`} tone="rose" />
            <TotalRow label="Total Payment"  value={`৳ ${fmt(data.totals.total_payment)}`} tone="emerald" />
            <TotalRow label="Credit Sales"   value={`৳ ${fmt(data.totals.credit_sales)}`} tone="emerald" />
            <TotalRow label="Total Sales"    value={`৳ ${fmt(data.totals.total_sales)}`} tone="emerald" />
            <TotalRow label="Total Expenses" value={`৳ ${fmt(data.totals.total_expenses)}`} tone="rose" />
          </div>

          {/* Details of products sold */}
          <div>
            <h4 className="font-semibold text-gray-800 mb-2">Details of products sold</h4>
            <table className="w-full text-sm">
              <thead className="text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 font-semibold w-10">#</th>
                  <th className="text-left py-2 font-semibold">Brands</th>
                  <th className="text-right py-2 font-semibold">Quantity</th>
                  <th className="text-right py-2 font-semibold">Total amount</th>
                </tr>
              </thead>
              <tbody>
                {data.products_sold.length === 0 ? (
                  <tr><td colSpan={4} className="py-3 text-center text-gray-400">No sales yet today.</td></tr>
                ) : data.products_sold.map((r, i) => (
                  <tr key={r.brand} className="border-b border-gray-100">
                    <td className="py-1.5 text-gray-500">{i + 1}.</td>
                    <td className="py-1.5">{r.brand}</td>
                    <td className="py-1.5 text-right tabular-nums">{Number(r.qty).toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums">৳ {fmt(r.amount)}</td>
                  </tr>
                ))}
                {data.products_sold.length > 0 && (
                  <tr className="bg-emerald-50 font-semibold">
                    <td className="py-2"></td>
                    <td className="py-2">#</td>
                    <td className="py-2 text-right tabular-nums">{Number(data.products_grand_total.qty).toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">Grand Total: ৳ {fmt(data.products_grand_total.amount)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-gray-200 text-sm text-gray-700 space-y-0.5">
            <div><span className="font-semibold">User:</span> {data.user.name}</div>
            <div><span className="font-semibold">Email:</span> {data.user.email || '—'}</div>
            <div><span className="font-semibold">Business Location:</span> {data.location.name || '—'}</div>
          </div>
        </div>
      )}
      <ModalFooter>
        <Button onClick={printDetails}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </ModalFooter>

      {/* Print-only table-format register sheet (image-style). Hidden on
          screen; takes over the page on window.print(). */}
      {data && <RegisterSlip data={data} mode="print-only" />}
    </Modal>
  )
}
function TotalRow({ label, value, tone }) {
  const bg = tone === 'emerald' ? 'bg-emerald-50' : tone === 'rose' ? 'bg-rose-50' : 'bg-gray-50'
  return (
    <div className={`flex items-center justify-between px-3 py-1.5 rounded ${bg}`}>
      <span className="font-semibold text-gray-700">{label}</span>
      <span className="font-semibold tabular-nums text-gray-800">{value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// RecentTxnModal — Final + Quotation tabs. Lists the most recent
// rows live from /api/sales/pos-sales/ and /api/sales/quotations/.
// Each row has a small action toolbar (View, Delete, Print Invoice)
// — same actions the All Sales page exposes, just in compact form.
// ─────────────────────────────────────────────────────────────────────
function RecentTxnModal({ locationId, onClose, onEdit, onPrintInvoice }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('FINAL')  // 'FINAL' | 'QUOTATION'
  const [final, setFinal] = useState([])
  const [quote, setQuote] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)
    try {
      const baseParams = { limit: 25, ordering: '-created_at' }
      if (locationId) baseParams.location_id = locationId
      const [f, q] = await Promise.all([
        getPosSales({ ...baseParams, status: 'FINAL' }).catch(() => ({ results: [] })),
        getQuotationSales(baseParams).catch(() => ({ results: [] })),
      ])
      setFinal(Array.isArray(f) ? f : (f?.results ?? []))
      setQuote(Array.isArray(q) ? q : (q?.results ?? []))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [locationId])

  const rows = tab === 'FINAL' ? final : quote
  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const onDelete = async (row) => {
    if (!row?.id) return
    if (!window.confirm(`Delete ${row.invoice_no || row.invoice_number || 'this sale'}? This cannot be undone.`)) return
    try {
      await deleteSale(row.id)
      window.alert('Deleted.')
      refresh()
    } catch (e) {
      window.alert(e?.message || 'Failed to delete.')
    }
  }

  return (
    <Modal open onClose={onClose} title="Recent Transactions" size="lg">
      {/* Tabs — only Final + Quotation. Drafts removed per spec
          (the Drafts page itself was deprecated). */}
      <div className="border-b border-gray-200 flex gap-4 mb-3">
        {[
          { key: 'FINAL',     label: '✓ Final',     count: final.length },
          { key: 'QUOTATION', label: '› Quotation', count: quote.length },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={[
              'pb-2 text-sm font-medium border-b-2 transition',
              tab === t.key
                ? 'border-emerald-500 text-emerald-700'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t.label} <span className="ml-1 text-xs text-gray-400">({t.count})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-400">
          No recent {tab === 'FINAL' ? 'final' : 'quotation'} transactions.
        </div>
      ) : (
        <ol className="space-y-1 text-sm">
          {rows.map((r, i) => (
            <li key={r.id} className="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
              <span className="text-gray-400 w-6 tabular-nums">{i + 1}.</span>
              <button
                onClick={() => (onPrintInvoice
                  ? onPrintInvoice(r)
                  : (onClose(), navigate(`/sales/${r.invoice_number || r.invoice_no || r.id}`)))}
                title="View / print invoice"
                className="text-emerald-700 hover:underline font-mono text-xs"
              >
                {r.invoice_no || r.invoice_number || String(r.id).slice(0, 8)}
              </button>
              <span className="text-gray-700 flex-1 truncate">
                ({r.customer_name || 'Walk-In Customer'})
              </span>
              <span className="font-semibold tabular-nums">{fmt(r.total_amount)}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => (onEdit ? onEdit(r) : (onClose(), navigate(`/sales/${r.invoice_number || r.invoice_no || r.id}?edit=1`)))}
                  title="Open in POS"
                  className="text-amber-600 hover:text-amber-700 p-1"
                >
                  ✎
                </button>
                <button
                  onClick={() => onDelete(r)}
                  title="Delete"
                  className="text-rose-600 hover:text-rose-700 p-1"
                >
                  🗑
                </button>
                <button
                  onClick={() => (onPrintInvoice
                    ? onPrintInvoice(r)
                    : window.open(`/sales/${r.invoice_number || r.invoice_no || r.id}?print=1`, '_blank'))}
                  title="Print Invoice"
                  className="text-gray-500 hover:text-gray-700 p-1"
                >
                  🖨
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <ModalFooter>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// ShippingModal — matches the user's reference image. Five fields the
// cashier can fill in before charging; the values are folded into the
// Sale.meta JSON blob by buildPayload so the Shipments page picks
// them up exactly like Add Sale does (no migration needed).
// ─────────────────────────────────────────────────────────────────────
function ShippingModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState({
    shipping_details:  initial?.shipping_details || '',
    shipping_address:  initial?.shipping_address || '',
    shipping_charges:  initial?.shipping_charges || '0',
    shipping_status:   initial?.shipping_status || '',
    delivered_to:      initial?.delivered_to || '',
  })
  const set = (k) => (e) => setForm({ ...form, [k]: e.target?.value ?? e })
  const [err, setErr] = useState('')
  const submit = () => {
    setErr('')
    if (!form.shipping_details.trim()) { setErr('Shipping Details is required.'); return }
    if (Number(form.shipping_charges) < 0) { setErr('Shipping Charges cannot be negative.'); return }
    onSave?.(form)
  }
  const lbl = 'block text-[12px] font-medium text-gray-700 mb-1'
  const ipt = 'w-full h-10 rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
  return (
    <Modal open onClose={onClose} title="Shipping" size="lg">
      <div className="space-y-3">
        {err && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Shipping Details: <span className="text-rose-500">*</span></label>
            <textarea rows={3} value={form.shipping_details} onChange={set('shipping_details')} placeholder="Shipping Details" className={`${ipt} h-auto py-2`} />
          </div>
          <div>
            <label className={lbl}>Shipping Address:</label>
            <textarea rows={3} value={form.shipping_address} onChange={set('shipping_address')} placeholder="Shipping Address" className={`${ipt} h-auto py-2`} />
          </div>
          <div>
            <label className={lbl}>Shipping Charges: <span className="text-rose-500">*</span></label>
            <input type="number" min="0" step="0.01" value={form.shipping_charges} onChange={set('shipping_charges')} className={ipt} />
          </div>
          <div>
            <label className={lbl}>Shipping Status:</label>
            <select value={form.shipping_status} onChange={set('shipping_status')} className={ipt}>
              <option value="">Please Select</option>
              <option value="Ordered">Ordered</option>
              <option value="Packed">Packed</option>
              <option value="Shipped">Shipped</option>
              <option value="Delivered">Delivered</option>
              <option value="Cancelled">Cancelled</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Delivered To:</label>
            <input value={form.delivered_to} onChange={set('delivered_to')} placeholder="Delivered To" className={ipt} />
          </div>
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Update</Button>
      </ModalFooter>
    </Modal>
  )
}
