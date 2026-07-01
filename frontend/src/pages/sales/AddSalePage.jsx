import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Card, { CardHeader } from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import { getProducts, getLocations } from '../../api/products'
import { createAdvancedSale, createCustomer, getCustomers, getSale, getCustomerCreditSummary } from '../../api/sales'
import { getPaymentAccounts } from '../../api/accounting'
import { getCompanyProfile } from '../../api/companyProfile'
import { getUsers } from '../../api/users'
import InvoiceSlip from '../../components/invoice/InvoiceSlip'
import { showToast } from '../../lib/toast.jsx'
import useUnsavedChangesPrompt from '../../hooks/useUnsavedChangesPrompt'
import CustomerTypeahead from '../../components/form/CustomerTypeahead'
import OutOfStockModal from '../../components/OutOfStockModal'
import { useAuth } from '../../context/AuthContext'

const money = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
let keyCounter = 0
const nextKey = () => ++keyCounter

export default function AddSalePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  // Quotation mode — when reached via /sales/add-quotation the page
  // saves as a QUOTATION (not a FINAL sale). Quotations don't take
  // payment or deduct stock; they live ONLY on the List Quotation
  // page until the owner finalises them.
  const isQuotation = location.pathname.includes('add-quotation')
  const [products, setProducts] = useState([])
  const [locations, setLocations] = useState([])
  const [customers, setCustomers] = useState([])
  // Service-staff dropdown — populated from the tenant's real users
  // (/api/users/). The previous build had a hardcoded array of one
  // tenant's staff names baked into the source code, which leaked to
  // every other tenant. Now each tenant only sees its own people.
  // Raw roster from /api/users/. The owner sees the whole team in the
  // Service Staff dropdown; every sub-user (admin/manager/cashier) only
  // ever sees — and is auto-assigned to — themselves. Role + identity
  // come straight from the logged-in user (DB-backed); nothing hardcoded.
  const [staffRoster, setStaffRoster] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Out-of-stock pop-up payload — { message, shortfalls } | null.
  const [stockAlert, setStockAlert] = useState(null)
  // When the backend says the tenant DB isn't ready yet, we want a friendly
  // "workspace is being prepared" banner instead of the generic red error.
  const [tenantNotReady, setTenantNotReady] = useState(false)
  const [query, setQuery] = useState('')
  const [barcode, setBarcode] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [cart, setCart] = useState([])

  const [form, setForm] = useState({
    location_id: '',
    customer_id: '',
    // Single Pay Term — operator types any number into pay_term_value
    // and picks DAYS or MONTHS in pay_term_unit. Backend still wants a
    // flat day count; we convert at submit time.
    pay_term_value: '',
    pay_term_unit: '',
    sale_date: new Date().toISOString().slice(0, 16),
    status: isQuotation ? 'QUOTATION' : 'FINAL',
    invoice_no: '',
    invoice_scheme: 'DEFAULT',
    service_staff: '',
    table_ref: '',
    source: 'POS',
    notes: '',
    sell_note: '',
    discount_type: 'FIXED',
    discount_value: 0,
    order_tax: 0,
    shipping_details: '',
    shipping_address: '',
    shipping_charges: 0,
    shipping_status: '',
    delivered_to: '',
    payment_amount: 0,
    payment_method: 'CASH',
    payment_account: '',
    payment_note: '',
    payment_account_id: '',
    // Card-specific fields (shown only when payment_method=CARD)
    card_number: '',
    card_holder_name: '',
    card_transaction_no: '',
    card_type: 'CREDIT_CARD',
    card_month: '',
    card_year: '',
    card_security_code: '',
    // Bank-transfer-specific field (shown only when payment_method=BANK_TRANSFER)
    bank_account_no: '',
  })

  // Tenant's real Payment Accounts (Cash on Hand, Bank, Mobile wallets, etc.)
  // Replaces the previous hard-coded ['None','Cash on Hand', ...] array.
  // Loaded once on mount; the dropdown filters by method server-side
  // doesn't yet exist so we just show all active accounts and let the
  // cashier pick the relevant one.
  const [paymentAccountsList, setPaymentAccountsList] = useState([])
  useEffect(() => {
    let cancelled = false
    getPaymentAccounts({ active: 'true' })
      .then((res) => {
        if (cancelled) return
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        setPaymentAccountsList(arr)
      })
      .catch(() => { /* leave empty — Select will just show "None" */ })
    return () => { cancelled = true }
  }, [])

  // Company profile drives the tenant-branded invoice printed by the
  // "Save and print" button below — same slip used by AllSales /
  // SaleDetailPage / POS receipt so the design stays consistent.
  const [companyProfile, setCompanyProfile] = useState(null)
  useEffect(() => {
    let cancelled = false
    getCompanyProfile()
      .then((p) => { if (!cancelled) setCompanyProfile(p || {}) })
      .catch(() => { if (!cancelled) setCompanyProfile({}) })
    return () => { cancelled = true }
  }, [])

  // Holds the freshly-created sale that "Save and print" triggers a
  // hidden InvoiceSlip render for. Cleared after the print dialog closes.
  const [printSale, setPrintSale] = useState(null)

  // Product-search popover. Earlier the dropdown stayed open when the
  // user clicked anywhere else on the page; the click-outside ref +
  // listener below close it cleanly.
  const [showSearchResults, setShowSearchResults] = useState(false)
  const searchBoxRef = useRef(null)
  useEffect(() => {
    const onDocClick = (e) => {
      if (!searchBoxRef.current) return
      if (!searchBoxRef.current.contains(e.target)) setShowSearchResults(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])
  const [attachDocument, setAttachDocument] = useState(null)
  const [shippingDocument, setShippingDocument] = useState(null)

  // Pay term unit options come from a tenant-overridable SystemSetting
  // (sales.pay_term_units) when present, otherwise the standard pair.
  // No hardcoded numeric arrays — the operator now types whatever
  // value they want into the field.
  const [payTermUnitOptions, setPayTermUnitOptions] = useState([
    { value: 'DAYS', label: 'Days' },
    { value: 'MONTHS', label: 'Months' },
  ])
  const invoiceSchemes = ['DEFAULT', 'Retail', 'Wholesale', 'Restaurant']
  const tableOptions = ['None', 'Table 1', 'Table 2', 'Table 3', 'VIP Table']

  const [expenses, setExpenses] = useState([{ id: nextKey(), name: '', amount: 0 }])

  useEffect(() => {
    // Locations are a tiny list — fetch them first and reveal the form
    // immediately, so the page isn't stuck on "Loading Add Sale…" while the
    // (potentially large) product + customer catalogues download.
    getLocations(true)
      .then((locs) => {
        const l = Array.isArray(locs) ? locs : (locs?.results || [])
        setLocations(l)
        if (l[0]?.id) setForm((f) => ({ ...f, location_id: f.location_id || l[0].id }))
      })
      .catch((err) => {
        if (err?.status === 503 && err?.errors?.code === 'tenant_not_ready') {
          setTenantNotReady(true)
        }
      })
      .finally(() => setLoading(false))

    // Products + customers load in the BACKGROUND — the search pickers and
    // barcode scan fill in as soon as they arrive without blocking the form.
    getProducts({ is_active: 'true', light: 'true' })
      .then((prods) => setProducts(Array.isArray(prods) ? prods : (prods?.results || [])))
      .catch((err) => {
        if (!(err?.status === 503 && err?.errors?.code === 'tenant_not_ready')) {
          setError('Failed loading products')
        }
      })
    getCustomers({ active_only: 'true' })
      .then((custs) => setCustomers(Array.isArray(custs) ? custs : (custs?.results || [])))
      .catch(() => { /* customer picker just stays empty */ })
  }, [])

  // Pull real tenant users for the Service Staff dropdown. Active users
  // only (suspended accounts shouldn't be assignable). Best-effort: if
  // /api/users/ 403s (sub-user without can_manage_settings), the dropdown
  // just stays at "Select service staff".
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getUsers()
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        const opts = arr
          .filter((u) => u.is_active !== false && u.status !== 'suspended')
          .map((u) => ({
            id:    String(u.id),
            label: u.name || u.username || u.email || String(u.id).slice(0, 8),
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
        if (!cancelled) setStaffRoster(opts)
      } catch { /* leave the dropdown empty — see comment above */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Tenant-overridable Pay Term unit list. Reads
  // SystemSetting "sales.pay_term_units" — supports either a JSON
  // array of {value,label} pairs OR a comma-separated string
  // ("Days,Months,Weeks"). Defaults to Days/Months when the setting
  // is missing so a fresh tenant still sees a working dropdown.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { getSetting } = await import('../../api/settings')
        const res = await getSetting('sales.pay_term_units')
        const raw = res?.value ?? res
        let parsed = null
        if (Array.isArray(raw)) parsed = raw
        else if (typeof raw === 'string') {
          try { parsed = JSON.parse(raw) } catch {
            parsed = raw.split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        if (!parsed?.length) return
        const opts = parsed.map((item) => {
          if (typeof item === 'string') {
            const v = item.toUpperCase().replace(/\s+/g, '_')
            return { value: v, label: item }
          }
          return { value: String(item.value).toUpperCase(), label: item.label || item.value }
        })
        if (!cancelled && opts.length) setPayTermUnitOptions(opts)
      } catch { /* default Days/Months stays */ }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const statusFromPath = (
      location.pathname === '/sales/add-draft' ? 'DRAFT'
        : location.pathname === '/sales/add-quotation' ? 'QUOTATION'
          : location.pathname === '/sales/add' ? 'FINAL'
            : ''
    )
    const statusFromQuery = (searchParams.get('status') || '').toUpperCase()
    const nextStatus = statusFromPath || statusFromQuery
    if (['DRAFT', 'FINAL', 'QUOTATION', 'PROFORMA'].includes(nextStatus)) {
      setField('status', nextStatus)
    }
  }, [location.pathname, searchParams])

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q)
    )
  }, [products, query])

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q))
  }, [customers, customerSearch])
  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === form.customer_id) || null,
    [customers, form.customer_id]
  )

  const setField = (name, value) => setForm((f) => ({ ...f, [name]: value }))
  const updateCart = (k, patch) => setCart((prev) => prev.map((r) => (r._k === k ? { ...r, ...patch } : r)))
  const removeCart = (k) => setCart((prev) => prev.filter((r) => r._k !== k))
  const addExpenseRow = () => setExpenses((r) => [...r, { id: nextKey(), name: '', amount: 0 }])
  const updateExpense = (id, patch) => setExpenses((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const removeExpense = (id) => setExpenses((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.id !== id)))

  // Only the tenant OWNER may attribute a sale to any team member. Every
  // sub-user (admin / manager / cashier) sees only themselves and is
  // locked to their own name. Derived (not baked into the fetch) so it
  // re-resolves the moment the logged-in user hydrates from storage.
  const isOwner = user?.role === 'owner'
  const visibleStaffOptions = useMemo(() => {
    if (isOwner || !user?.id) return staffRoster
    const me = staffRoster.find((o) => o.id === String(user.id))
    return me ? [me] : []
  }, [staffRoster, isOwner, user?.id])

  // Sub-users are auto-assigned to themselves.
  useEffect(() => {
    if (!isOwner && user?.id) setField('service_staff', String(user.id))
  }, [isOwner, user?.id])

  const addToCart = (p) => {
    // Snapshot the live on-hand value from the product list so the
    // cart row can warn the cashier when qty climbs above what's
    // actually in stock. Mirrors the POS guard so behaviour is
    // identical across both add-sale entry points.
    const onHand = Number(p.total_stock ?? p.stock ?? p.on_hand ?? 0)
    const tracksStock = (p.manage_stock ?? p.meta?.manage_stock ?? true) !== false && p.product_type !== 'service'
    // Quotations don't deduct stock until finalised, so they may
    // quote out-of-stock items. FINAL sales hard-stop here with the
    // pop-up — stock can never go negative.
    if (!isQuotation && tracksStock && onHand <= 0) {
      setStockAlert({
        message: `"${p.name}" is out of stock at this location (0 available). Restock it before selling.`,
        shortfalls: [{ product_name: p.name, requested: 1, available: onHand, shortfall: 1 }],
      })
      return
    }
    setCart((prev) => {
      const existing = prev.find((r) => r.product_id === p.id)
      if (existing) {
        // Bumping qty past the on-hand snapshot also pops the alert.
        if (!isQuotation && tracksStock && existing.quantity + 1 > onHand) {
          setStockAlert({
            message: `Not enough stock of "${p.name}" — only ${onHand} available.`,
            shortfalls: [{ product_name: p.name, requested: existing.quantity + 1, available: onHand }],
          })
          return prev
        }
        return prev.map((r) => (r._k === existing._k ? { ...r, quantity: r.quantity + 1 } : r))
      }
      return [...prev, {
        _k: nextKey(),
        product_id: p.id,
        name: p.name,
        sku: p.sku || '',
        quantity: 1,
        unit_price: Number(p.selling_price) || 0,
        item_discount: 0,
        available: onHand,
        // Services (manage_stock off) sell freely — the row-level
        // "Only X available" warning skips them via this flag.
        tracks_stock: tracksStock,
      }]
    })
  }

  const onBarcodeEnter = (e) => {
    if (e.key !== 'Enter') return
    const matched = products.find((p) => String(p.barcode || '').trim() === barcode.trim())
    if (matched) addToCart(matched)
    setBarcode('')
  }

  const subtotal = useMemo(() => cart.reduce((s, i) => s + (Number(i.unit_price) - Number(i.item_discount || 0)) * Number(i.quantity), 0), [cart])
  const discountAmt = useMemo(() => (form.discount_type === 'PERCENTAGE'
    ? Math.max(0, (subtotal * Number(form.discount_value || 0)) / 100)
    : Math.max(0, Number(form.discount_value || 0))), [form.discount_type, form.discount_value, subtotal])
  const taxable = Math.max(0, subtotal - discountAmt)
  const taxAmt = (taxable * Number(form.order_tax || 0)) / 100
  const extraAmt = expenses.reduce((s, e) => s + Number(e.amount || 0), 0)
  const grandTotal = taxable + taxAmt + Number(form.shipping_charges || 0) + extraAmt
  const paid = Number(form.payment_amount || 0)
  const due = Math.max(0, grandTotal - paid)

  // Block accidental tab close / refresh / nav while a sale is being
  // composed. The browser pops the "Changes that you made may not be
  // saved." dialog once `dirty` is true; `saving` flips it off so the
  // post-save redirect doesn't trigger the prompt.
  const dirty = !saving && (
    cart.length > 0 ||
    (form.notes && form.notes.trim()) ||
    (form.sell_note && form.sell_note.trim()) ||
    (form.shipping_details && form.shipping_details.trim()) ||
    (form.shipping_address && form.shipping_address.trim()) ||
    (form.invoice_no && form.invoice_no.trim())
  )
  useUnsavedChangesPrompt(dirty)

  useEffect(() => {
    if (form.status !== 'FINAL') return
    const current = Number(form.payment_amount || 0)
    // Auto-fill when entering FINAL mode or when payable changes and field is empty.
    if (current <= 0) {
      setField('payment_amount', Number(grandTotal || 0).toFixed(2))
    }
  }, [form.status, grandTotal])

  const quickCreateCustomer = async () => {
    const name = window.prompt('Customer name')
    if (!name) return
    const phone = window.prompt('Phone (optional)') || ''
    try {
      const c = await createCustomer({ name, phone })
      setCustomers((prev) => [c, ...prev])
      setField('customer_id', c.id)
    } catch {
      setError('Failed to add customer')
    }
  }

  // Returns a list of human-readable problems. Empty array means OK.
  // Used by submit() to throw a popup BEFORE we hit the network.
  const validateForm = ({ effectiveStatus }) => {
    const probs = []
    if (!form.location_id) probs.push('Business location is required.')
    if (cart.length === 0) probs.push('Add at least one product to the cart.')
    // Per-row validations so the cashier knows exactly which line is wrong.
    cart.forEach((r, i) => {
      if (!r.quantity || Number(r.quantity) <= 0) {
        probs.push(`Row ${i + 1}: quantity must be greater than zero.`)
      }
      if (Number(r.unit_price) < 0) {
        probs.push(`Row ${i + 1}: unit price cannot be negative.`)
      }
      // Stock-out guard — mirrors the POS behaviour. Quotations and
      // drafts don't deduct stock so we let them through; only FINAL
      // sales (which trigger FIFO) need to respect on-hand. Services
      // (tracks_stock false) have no inventory and always pass.
      if (
        effectiveStatus === 'FINAL' &&
        r.tracks_stock !== false &&
        Number(r.quantity) > Number(r.available || 0)
      ) {
        probs.push(
          `${r.name || `Row ${i + 1}`}: only ${Number(r.available || 0).toFixed(2)} available — reduce the quantity or restock first.`,
        )
      }
    })
    const paymentAmount = Number(form.payment_amount || 0)
    const payable = Number(grandTotal || 0)
    if (paymentAmount > payable) {
      probs.push(`Payment amount cannot exceed final payable (৳ ${money(payable)}).`)
    }
    // Final sales need a payment method picked when a payment is being recorded.
    if (effectiveStatus === 'FINAL' && paymentAmount > 0 && !form.payment_method) {
      probs.push('Payment method is required when collecting payment.')
    }
    // Card / Bank Transfer / Mobile Wallet extras are OPTIONAL per
    // operator spec — the cashier can save the sale even when the
    // method-specific fields are left blank. The values are sent
    // through when filled (audit reference) but never block save.
    return probs
  }

  const submit = async ({ forceStatus, printAfterSave = false } = {}) => {
    // In quotation mode every save is a QUOTATION regardless of the
    // (hidden) status picker.
    if (isQuotation) forceStatus = 'QUOTATION'
    const effectiveStatus = forceStatus || form.status
    const problems = validateForm({ effectiveStatus })
    if (problems.length > 0) {
      // Specific popup with every blocker spelled out — the user asked
      // for the message to surface in a dialog instead of the small
      // banner at the top.
      window.alert(
        problems.length === 1
          ? problems[0]
          : `Please fix the following before saving:\n\n• ${problems.join('\n• ')}`,
      )
      // Also reflect the first issue in the inline banner for
      // continuity if the operator dismisses the alert.
      setError(problems[0])
      return
    }
    const paymentAmount = Number(form.payment_amount || 0)
    setError('')
    setSaving(true)
    try {
      const payload = {
        location_id: form.location_id,
        customer_id: form.customer_id || null,
        // Single field on screen → flatten to a day count for the
        // backend. 1 month = 30 days (same convention the old
        // dual-field code used).
        pay_term_days: (() => {
          const v = Number(form.pay_term_value || 0)
          return form.pay_term_unit === 'MONTHS' ? v * 30 : v
        })(),
        // Raw value + unit so the sale remembers "30 days" / "2 months".
        pay_term_value: form.pay_term_value === '' ? null : Number(form.pay_term_value),
        pay_term_period: form.pay_term_unit === 'MONTHS' ? 'months' : form.pay_term_unit === 'DAYS' ? 'days' : '',
        sale_date: new Date(form.sale_date).toISOString(),
        status: forceStatus || form.status,
        invoice_no: form.invoice_no || null,
        invoice_scheme: form.invoice_scheme,
        service_staff: form.service_staff,
        table_ref: form.table_ref,
        source: form.source,
        items: cart.map((c) => ({
          product_id: c.product_id,
          quantity: Number(c.quantity),
          unit_price: Number(c.unit_price),
          item_discount: Number(c.item_discount || 0),
        })),
        discount_type: form.discount_type,
        discount_value: Number(form.discount_value || 0),
        order_tax: Number(form.order_tax || 0),
        shipping_details: form.shipping_details,
        shipping_address: form.shipping_address,
        shipping_charges: Number(form.shipping_charges || 0),
        shipping_status: form.shipping_status,
        delivered_to: form.delivered_to,
        additional_expenses: expenses
          .filter((e) => e.name && Number(e.amount || 0) > 0)
          .map((e) => ({ name: e.name, amount: Number(e.amount || 0) })),
        payment: paymentAmount > 0
          ? {
              amount:             Number(paymentAmount.toFixed(2)),
              method:             form.payment_method,
              // payment_account_id is the real FK — drives which
              // Account Book ledger the amount lands in. We keep the
              // legacy `payment_account` (free-text label) for backward
              // compatibility with the existing serializer.
              payment_account:    form.payment_account_id || '',
              payment_account_id: form.payment_account_id || null,
              note:               form.payment_note,
              // Method-specific extras. Backend ignores fields that
              // don't apply to the chosen method.
              ...(form.payment_method === 'CARD' && {
                card_number:         form.card_number,
                card_holder_name:    form.card_holder_name,
                card_transaction_no: form.card_transaction_no,
                card_type:           form.card_type,
                card_month:          form.card_month,
                card_year:           form.card_year,
                card_security_code:  form.card_security_code,
                reference:           form.card_transaction_no,
              }),
              ...(form.payment_method === 'BANK_TRANSFER' && {
                bank_account_no: form.bank_account_no,
                reference:       form.bank_account_no,
              }),
            }
          : null,
        notes: form.notes,
        sell_note: form.sell_note,
        attach_document_name: attachDocument?.name || '',
        shipping_documents: shippingDocument?.name ? [shippingDocument.name] : [],
      }
      const sale = await createAdvancedSale(payload)
      // Sale-specific confirmation toast (skipped for quotations/drafts —
      // those aren't a recorded sale).
      if (!isQuotation && (forceStatus || form.status) === 'FINAL') {
        const inv = sale.invoice_number || (sale.id ? String(sale.id).slice(0, 8) : '')
        showToast({ title: 'Sale recorded', message: inv ? `Invoice #${inv} saved.` : 'Invoice saved.' })
      }
      // Quotations always land on the List Quotation page — never on
      // the sale-detail / All Sales view. A finalised sale goes to its
      // detail page as before.
      const destination = isQuotation
        ? '/sales/quotations'
        : `/sales/${sale.invoice_number || sale.id}`
      if (printAfterSave) {
        // Load the fully-hydrated sale (items + totals + customer +
        // location) so the InvoiceSlip has everything it needs. The
        // create-sale response sometimes ships a thinner shape.
        let full = sale
        try { full = await getSale(sale.id) } catch { /* keep summary */ }
        // Pull the customer's overall outstanding so the invoice can
        // print BOTH "Due (this invoice)" and "Customer Total Due".
        let customer_total_due = 0
        const custId = full?.customer?.id || full?.customer_id
        if (custId) {
          try {
            const cs = await getCustomerCreditSummary(custId)
            // Backend returns { current_due, net_due, ... } flat at
            // the top level. current_due = sum of every FINAL
            // non-VOIDED sale's outstanding balance for this customer
            // (includes the one we just created), so subtract its
            // own balance_due to show only the OTHER unpaid sales as
            // "Customer Total Due" alongside "Due (this invoice)".
            const total = Number(cs?.current_due || 0)
            const thisDue = Number(full?.balance_due || 0)
            customer_total_due = Math.max(0, total - thisDue)
          } catch { /* leave at 0 if the endpoint hiccups */ }
        }
        setPrintSale({ ...full, _customer_total_due: customer_total_due })
        // Wait one paint frame so the print-only slip is in the DOM,
        // fire window.print(), then clear + navigate.
        setTimeout(() => {
          window.print()
          setTimeout(() => {
            setPrintSale(null)
            navigate(destination)
          }, 300)
        }, 80)
      } else {
        navigate(destination)
      }
    } catch (e) {
      // The standard envelope nests the flags under payload.data;
      // older builds had them at the top level — accept both.
      const pd409 = e?.payload?.data || e?.payload || {}
      if (e?.status === 409 && (pd409.back_order_required || pd409.out_of_stock)) {
        // Server-side stock guard fired — show the out-of-stock
        // pop-up with the per-product shortfall table instead of a
        // bare window.alert.
        setError(e.message || 'Insufficient stock.')
        setStockAlert({
          message: e.message || 'Not enough stock to complete this sale.',
          shortfalls: pd409.shortfalls || [],
        })
      } else {
        // Surface the server's reason in a popup (and the inline
        // banner) so it can't be missed. DRF sends {detail: "..."}
        // or a per-field error map.
        const fe = e?.errors || e?.payload || {}
        let detail = fe?.detail || e?.message || 'Failed to create sale'
        if (typeof fe === 'object' && fe && !fe.detail) {
          const parts = []
          for (const [k, v] of Object.entries(fe)) {
            if (k === 'detail' || k === 'status' || k === 'data') continue
            parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          }
          if (parts.length) detail = `${detail}\n\n• ${parts.join('\n• ')}`
        }
        setError(typeof detail === 'string' ? detail.split('\n')[0] : 'Failed to create sale')
        window.alert(detail)
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="py-16 text-center text-gray-500">Loading Add Sale...</div>

  return (
    <div className="space-y-4 pb-24 addsale-compact">
      {/* Page-scoped compact form sizing — every Add Sale field
          shrinks in one place so we don't have to touch 20+
          Input/Select call sites. We use !important on every
          property so chained Tailwind utilities can't outvote us. */}
      <style>{`
        .addsale-compact input:not([type=checkbox]):not([type=radio]):not([type=file]),
        .addsale-compact select {
          height: 30px !important;
          min-height: 30px !important;
          padding: 2px 8px !important;
          font-size: 12px !important;
          line-height: 1.1 !important;
          border-radius: 6px !important;
        }
        .addsale-compact textarea {
          min-height: 50px !important;
          padding: 6px 8px !important;
          font-size: 12px !important;
          line-height: 1.3 !important;
          border-radius: 6px !important;
        }
        .addsale-compact label {
          font-size: 10px !important;
          margin-bottom: 2px !important;
          letter-spacing: 0.04em;
        }
        .addsale-compact input[type=file] {
          padding: 3px !important;
          font-size: 11px !important;
        }
        /* Leading-icon left padding — the general input rule above forces
           padding:2px 8px, which would push the text UNDER the magnifying
           glass. These selectors carry higher specificity than that rule
           (extra class + the same :not() chain) so icon inputs keep clear
           of the icon (e.g. the Customer "Walk-in" placeholder). */
        .addsale-compact input.pl-8:not([type=checkbox]):not([type=radio]):not([type=file]) {
          padding-left: 34px !important;
        }
        .addsale-compact input.pl-10:not([type=checkbox]):not([type=radio]):not([type=file]) {
          padding-left: 38px !important;
        }
        /* Tighter gutters everywhere on this page */
        .addsale-compact .grid { gap: 8px !important; }
        .addsale-compact .gap-4 { gap: 8px !important; }
        .addsale-compact .space-y-5 > * + * { margin-top: 12px !important; }
        /* Cards shrink their padding so totals fit in less vertical space */
        .addsale-compact .p-5 { padding: 12px !important; }
        .addsale-compact .p-4 { padding: 10px !important; }
        /* Section gap between Input wrapper rows */
        .addsale-compact .gap-1\\.5 { gap: 2px !important; }
        /* Date input clock icon shouldn't overflow at the smaller height */
        .addsale-compact input[type=datetime-local],
        .addsale-compact input[type=date] { padding-right: 4px !important; }
      `}</style>
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            {form.status === 'DRAFT' ? 'Add Draft' : form.status === 'QUOTATION' ? 'Add Quotation' : 'Add Sale'}
          </h1>
          <p className="text-sm text-emerald-50">Create draft/final sale with clear sections and live totals.</p>
        </div>
      </div>

      {tenantNotReady && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-200 text-xs font-bold text-blue-800">i</span>
          <div className="flex-1">
            <p className="font-semibold">Your workspace is being prepared</p>
            <p className="text-xs mt-0.5">
              Products, locations and customers will be available as soon as your tenant
              database finishes setting up. Refresh in a moment.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      )}
      {error && !tenantNotReady && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="space-y-5 w-full">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Basic Info" />
            {/* 4 columns on wide screens so each field caps at ~280px
                instead of stretching across half the page. Falls back
                to 2 cols on tablet, 1 col on phones. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Select label="Business Location" value={form.location_id} onChange={(e) => setField('location_id', e.target.value)}>
                <option value="">Select location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
              {/* Customer — shared typeahead component, also used by
                  AllSales / Shipments / Sell Returns. Phone numbers
                  are normalised through fmtPhone() inside the
                  component so the leading "0" always shows. */}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1 block">Customer</label>
                <CustomerTypeahead
                  customers={customers}
                  value={customerSearch}
                  onChange={(v) => setCustomerSearch(v)}
                  onPick={(c) => {
                    if (c) {
                      setCustomerSearch(c.name)
                      setField('customer_id', c.id)
                    } else {
                      setCustomerSearch('')
                      setField('customer_id', '')
                    }
                  }}
                  placeholder="Walk-in — type a name or phone"
                />
              </div>
              {/* Pay Term — one field, two inputs: a free numeric input
                  for the value + a unit dropdown (Days / Months). No
                  hardcoded ranges — the operator can type any number
                  ("45", "120", whatever). Unit options come from the
                  tenant-overridable list. */}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1 block">Pay Term</label>
                <div className="grid grid-cols-[1fr_140px] gap-2">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Pay term"
                    value={form.pay_term_value}
                    onChange={(e) => setField('pay_term_value', e.target.value)}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-navy-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  />
                  <select
                    value={form.pay_term_unit}
                    onChange={(e) => setField('pay_term_unit', e.target.value)}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-navy-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="">Please Select</option>
                    {payTermUnitOptions.map((u) => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <Input label="Sale Date" type="datetime-local" value={form.sale_date} onChange={(e) => setField('sale_date', e.target.value)} />
              {/* Status picker hidden in quotation mode — every save is
                  a QUOTATION there. */}
              {!isQuotation ? (
                <Select label="Status" value={form.status} onChange={(e) => setField('status', e.target.value)}>
                  <option value="DRAFT">Draft</option>
                  <option value="FINAL">Final</option>
                  <option value="QUOTATION">Quotation</option>
                  <option value="PROFORMA">Proforma</option>
                </Select>
              ) : (
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1 block">Status</label>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700">Quotation</div>
                </div>
              )}
              <Input label="Invoice No" placeholder="Auto if empty" value={form.invoice_no} onChange={(e) => setField('invoice_no', e.target.value)} />
              <p className="-mt-2 text-xs text-gray-400">Keep blank to auto generate.</p>
              <Select label="Invoice Scheme" value={form.invoice_scheme} onChange={(e) => setField('invoice_scheme', e.target.value)}>
                {invoiceSchemes.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Select label="Service Staff" value={form.service_staff} onChange={(e) => setField('service_staff', e.target.value)} disabled={!isOwner}>
                {isOwner && <option value="">Select service staff</option>}
                {visibleStaffOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </Select>
              <Select label="Table" value={form.table_ref} onChange={(e) => setField('table_ref', e.target.value)}>
                {tableOptions.map((t) => <option key={t} value={t === 'None' ? '' : t}>{t}</option>)}
              </Select>
              <div className="md:col-span-2">
                <Input
                  label="Attach Document"
                  type="file"
                  accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
                  onChange={(e) => setAttachDocument(e.target.files?.[0] || null)}
                  hint="Max File size: 5MB | Allowed File: .pdf, .csv, .zip, .doc, .docx, .jpeg, .jpg, .png"
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Product Adding" subtitle="Search by name, SKU, or barcode and build cart." />
            {/* Click-outside-aware wrapper. mousedown on anything
                outside this div closes the search dropdown so the
                filter buttons / form behind it become clickable
                again. */}
            <div ref={searchBoxRef}>
              {/* "+ Add" quick-pick button removed per spec — operators
                  add a product by typing the search and clicking the
                  result, or by scanning a barcode (which still auto-adds
                  via onBarcodeEnter). The dedicated button felt
                  redundant. */}
              <div className="grid md:grid-cols-[1fr_180px] gap-2 mb-2 items-end">
                <SearchInput
                  value={query}
                  onChange={(v) => { setQuery(v); setShowSearchResults(!!v) }}
                  onFocus={() => { if (query) setShowSearchResults(true) }}
                  placeholder="Enter Product name / SKU / Scan bar code"
                />
                <Input placeholder="Scan barcode + Enter" value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={onBarcodeEnter} />
              </div>
              {showSearchResults && query && filteredProducts.length > 0 && (
                <div className="relative">
                  <div className="absolute z-30 w-full mb-4 max-h-40 overflow-auto rounded-xl border border-gray-200 bg-white shadow-pop">
                    {filteredProducts.slice(0, 8).map((p) => (
                      <button
                        key={p.id}
                        // Clear the query + close the dropdown on pick so it
                        // doesn't linger or re-open when the box is clicked
                        // again.
                        onMouseDown={(e) => { e.preventDefault(); addToCart(p); setQuery(''); setShowSearchResults(false) }}
                        className="flex w-full items-center justify-between border-b border-gray-100 px-3 py-2 text-left text-sm hover:bg-gray-50 last:border-0"
                      >
                        <span>{p.name} <span className="text-xs text-gray-400">({p.sku || p.barcode || 'No code'})</span></span>
                        <span className="font-medium">৳ {money(p.selling_price)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-left">Quantity</th>
                    <th className="px-3 py-2 text-left">Unit Price</th>
                    <th className="px-3 py-2 text-left">Discount</th>
                    <th className="px-3 py-2 text-left">Subtotal</th>
                    <th className="px-3 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.length === 0 && (
                    <tr><td className="px-3 py-6 text-center text-gray-400" colSpan={6}>No items yet</td></tr>
                  )}
                  {cart.map((r) => {
                    const over = r.tracks_stock !== false && Number(r.quantity) > Number(r.available || 0)
                    return (
                      <tr key={r._k} className="border-t border-gray-100">
                        <td className="px-3 py-2">{r.name}</td>
                        <td className="px-3 py-2 w-32">
                          <Input type="number" min="1" value={r.quantity} onChange={(e) => updateCart(r._k, { quantity: Number(e.target.value || 1) })} />
                          {/* Same stock-out guard as POS — when qty
                              exceeds the on-hand snapshot taken on
                              addToCart, show the available count in
                              red below the input. */}
                          {over && (
                            <div className="mt-1 text-[11px] font-semibold text-rose-600">
                              Only {Number(r.available || 0).toFixed(2)} available
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 w-40"><Input type="number" min="0" step="0.01" value={r.unit_price} onChange={(e) => updateCart(r._k, { unit_price: Number(e.target.value || 0) })} /></td>
                        <td className="px-3 py-2 w-40"><Input type="number" min="0" step="0.01" value={r.item_discount} onChange={(e) => updateCart(r._k, { item_discount: Number(e.target.value || 0) })} /></td>
                        <td className="px-3 py-2">৳ {money((r.unit_price - r.item_discount) * r.quantity)}</td>
                        <td className="px-3 py-2"><button className="text-red-600 hover:underline" onClick={() => removeCart(r._k)}>Remove</button></td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-gray-50 text-xs text-gray-700">
                    <td className="px-3 py-2 text-right" colSpan={6}>
                      Items: {cart.reduce((s, r) => s + Number(r.quantity || 0), 0).toFixed(2)} &nbsp; | &nbsp; Total: ৳ {money(subtotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Discount & Tax" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Select label="Discount Type" value={form.discount_type} onChange={(e) => setField('discount_type', e.target.value)}>
                <option value="FIXED">Fixed</option>
                <option value="PERCENTAGE">Percentage</option>
              </Select>
              <Input label="Discount" type="number" min="0" step="0.01" value={form.discount_value} onChange={(e) => setField('discount_value', e.target.value)} />
              <Input label="Order Tax (%)" type="number" min="0" step="0.01" value={form.order_tax} onChange={(e) => setField('order_tax', e.target.value)} />
            </div>
            <div className="mt-4">
              <Input label="Sell Note" value={form.sell_note} onChange={(e) => setField('sell_note', e.target.value)} placeholder="Add internal sell note..." />
            </div>
          </Card>

          <Card>
            <CardHeader title="Shipping" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Input label="Shipping Details" value={form.shipping_details} onChange={(e) => setField('shipping_details', e.target.value)} />
              <Input label="Shipping Charges" type="number" min="0" step="0.01" value={form.shipping_charges} onChange={(e) => setField('shipping_charges', e.target.value)} />
              <Input label="Shipping Address" value={form.shipping_address} onChange={(e) => setField('shipping_address', e.target.value)} />
              <Select label="Shipping Status" value={form.shipping_status} onChange={(e) => setField('shipping_status', e.target.value)}>
                <option value="">Please Select</option>
                <option value="Ordered">Ordered</option>
                <option value="Packed">Packed</option>
                <option value="Shipped">Shipped</option>
                <option value="Delivered">Delivered</option>
                <option value="Cancelled">Cancelled</option>
              </Select>
              <Input label="Delivered To" value={form.delivered_to} onChange={(e) => setField('delivered_to', e.target.value)} />
              <div className="md:col-span-2">
                <Input
                  label="Shipping Document"
                  type="file"
                  accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
                  onChange={(e) => setShippingDocument(e.target.files?.[0] || null)}
                  hint="Max File size: 5MB | Allowed File: .pdf, .csv, .zip, .doc, .docx, .jpeg, .jpg, .png"
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Additional Expenses" />
            <div className="space-y-3">
              {expenses.map((e) => (
                <div key={e.id} className="grid grid-cols-[1fr_160px_auto] gap-3 items-end">
                  <Input label="Expense Name" value={e.name} onChange={(v) => updateExpense(e.id, { name: v.target.value })} />
                  <Input label="Amount" type="number" min="0" step="0.01" value={e.amount} onChange={(v) => updateExpense(e.id, { amount: Number(v.target.value || 0) })} />
                  <Button variant="secondary" onClick={() => removeExpense(e.id)}>Remove</Button>
                </div>
              ))}
              <Button variant="secondary" onClick={addExpenseRow}>+ Add additional expenses ▾</Button>
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">
                Total Payable: ৳ {money(grandTotal)}
              </div>
            </div>
          </Card>

          {form.status === 'FINAL' && (
            <Card>
              <CardHeader title="Payment" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Advance Balance" readOnly value={`৳ ${money(grandTotal)}`} />
                <div>
                  <Input label="Amount *" type="number" min="0" step="0.01" value={form.payment_amount} onChange={(e) => setField('payment_amount', e.target.value)} />
                  <button
                    type="button"
                    onClick={() => setField('payment_amount', Number(grandTotal || 0).toFixed(2))}
                    className="mt-1 text-xs font-medium text-brand-700 hover:underline"
                  >
                    Use Full Amount
                  </button>
                </div>
                <Select label="Payment Method *" value={form.payment_method} onChange={(e) => setField('payment_method', e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                  <option value="MOBILE">Mobile Wallet</option>
                </Select>

                {/* Payment Account — always visible. Drives WHICH ledger
                    the amount lands in on the Account Book / List
                    Accounts page. Lists the tenant's real PaymentAccount
                    rows (Cash on Hand, City Bank, bKash, etc.). */}
                <div className="md:col-span-3">
                  <Select label="Payment Account" value={form.payment_account_id} onChange={(e) => setField('payment_account_id', e.target.value)}>
                    <option value="">None</option>
                    {paymentAccountsList.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.account_type ? ` (${a.account_type})` : ''}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* ── CARD-specific fields ───────────────────────────── */}
                {form.payment_method === 'CARD' && (
                  <>
                    <Input
                      label="Card Number"
                      placeholder="Card Number"
                      inputMode="numeric"
                      value={form.card_number}
                      onChange={(e) => setField('card_number', e.target.value.replace(/[^\d ]/g, ''))}
                    />
                    <Input
                      label="Card holder name"
                      placeholder="Card holder name"
                      value={form.card_holder_name}
                      onChange={(e) => setField('card_holder_name', e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))}
                    />
                    <Input
                      label="Card Transaction No."
                      placeholder="Card Transaction No."
                      value={form.card_transaction_no}
                      onChange={(e) => setField('card_transaction_no', e.target.value)}
                    />
                    <Select label="Card Type" value={form.card_type} onChange={(e) => setField('card_type', e.target.value)}>
                      <option value="CREDIT_CARD">Credit Card</option>
                      <option value="DEBIT_CARD">Debit Card</option>
                      <option value="PREPAID">Prepaid</option>
                    </Select>
                    <Input
                      label="Month"
                      placeholder="MM"
                      inputMode="numeric"
                      maxLength={2}
                      value={form.card_month}
                      onChange={(e) => setField('card_month', e.target.value.replace(/\D/g, '').slice(0, 2))}
                    />
                    <Input
                      label="Year"
                      placeholder="YYYY"
                      inputMode="numeric"
                      maxLength={4}
                      value={form.card_year}
                      onChange={(e) => setField('card_year', e.target.value.replace(/\D/g, '').slice(0, 4))}
                    />
                    <Input
                      label="Security Code"
                      placeholder="CVV"
                      inputMode="numeric"
                      maxLength={4}
                      value={form.card_security_code}
                      onChange={(e) => setField('card_security_code', e.target.value.replace(/\D/g, '').slice(0, 4))}
                    />
                  </>
                )}

                {/* ── BANK TRANSFER-specific field ───────────────────── */}
                {form.payment_method === 'BANK_TRANSFER' && (
                  <div className="md:col-span-3">
                    <Input
                      label="Bank Account No"
                      placeholder="Bank Account No"
                      inputMode="numeric"
                      value={form.bank_account_no}
                      onChange={(e) => setField('bank_account_no', e.target.value.replace(/[^\d -]/g, ''))}
                    />
                  </div>
                )}

                {/* Payment note — visible for every method */}
                <div className="md:col-span-3">
                  <label className="text-sm font-medium text-gray-700">Payment Note</label>
                  <textarea
                    value={form.payment_note}
                    onChange={(e) => setField('payment_note', e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 transition-colors duration-150 outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    placeholder="Write payment reference/note..."
                  />
                </div>
                <div className="md:col-span-3">
                  <Input label="Notes" value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
                </div>
              </div>
            </Card>
          )}
        </div>

        <TotalSummaryCard
          itemsCount={cart.reduce((s, it) => s + Number(it.qty || 0), 0)}
          uniqueItems={cart.length}
          subtotal={subtotal}
          discount={discountAmt}
          tax={taxAmt}
          shipping={Number(form.shipping_charges || 0)}
          extra={extraAmt}
          grandTotal={grandTotal}
          paid={paid}
          due={due}
        />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="secondary" className="min-w-[110px]" loading={saving} onClick={() => submit()}>
            Save
          </Button>
          {/* Save Draft button removed — Add Sale always goes through the
              main Save / Save and print path. The form's status field still
              flips to DRAFT/FINAL based on the picker above, so the same
              workflow is reachable without a dedicated button. */}
          <Button className="min-w-[140px]" loading={saving} onClick={() => submit({ printAfterSave: true })}>
            Save and print
          </Button>
        </div>
      </Card>

      {/* Out-of-stock pop-up — fires on add-to-cart of a 0-stock
          product and on the server's 409 stock guard at save time. */}
      <OutOfStockModal data={stockAlert} onClose={() => setStockAlert(null)} />

      {/* Print-only tenant-branded slip. Hidden on screen; @media print
          rules in InvoiceSlip's scoped CSS make it the only visible
          element when window.print() fires after "Save and print". */}
      {printSale && (
        <InvoiceSlip
          mode="print-only"
          company={companyProfile}
          docType={isQuotation ? 'QUOTATION' : 'INVOICE'}
          invoice={{
            number:   printSale.invoice_number || '—',
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
            id:          it.id,
            description: it.product_name,
            sku:         it.product_sku,
            unit_price:  it.unit_price,
            quantity:    it.quantity,
            line_total:  it.line_total,
          }))}
          totals={{
            subtotal:   printSale.subtotal,
            discount:   printSale.discount,
            tax_amount: printSale.tax_amount,
            tax_rate:   printSale.tax_rate,
            total:      printSale.total_amount,
            paid:       printSale.amount_paid,
            balance_due: printSale.balance_due,
            customer_total_due: printSale._customer_total_due,
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Total Summary card — modern, animated, status-aware
// ─────────────────────────────────────────────────────────────────────────

function TotalSummaryCard({
  itemsCount, uniqueItems, subtotal, discount, tax, shipping, extra,
  grandTotal, paid, due,
}) {
  const empty = !uniqueItems
  const status = paid <= 0
    ? 'DUE'
    : paid >= grandTotal
      ? 'PAID'
      : 'PARTIAL'
  const STATUS_THEME = {
    PAID:    { pill: 'bg-emerald-100 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500',
               banner: 'from-emerald-500 to-green-600' },
    PARTIAL: { pill: 'bg-amber-100 text-amber-800 ring-amber-200',       dot: 'bg-amber-500',
               banner: 'from-amber-500 to-orange-500' },
    DUE:     { pill: 'bg-rose-100 text-rose-700 ring-rose-200',          dot: 'bg-rose-500',
               banner: 'from-rose-500 to-pink-600' },
  }
  const theme = STATUS_THEME[status]
  const payProgress = grandTotal > 0 ? Math.min(100, (paid / grandTotal) * 100) : 0

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
      {/* ── Hero banner with grand total ─────────────────────────────── */}
      <div className={`bg-gradient-to-r ${theme.banner} px-6 py-5 text-white`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-80">Total Summary</p>
            <p className="mt-1 text-[11px] opacity-90">
              {empty
                ? 'Add at least one product to the cart.'
                : `${itemsCount} unit${itemsCount === 1 ? '' : 's'} across ${uniqueItems} line item${uniqueItems === 1 ? '' : 's'}`}
            </p>
          </div>
          <SummaryStatusPill status={status} theme={theme} />
        </div>
        <div className="mt-4 flex items-baseline gap-1">
          <span className="text-xs font-semibold opacity-80">৳</span>
          <span className="text-3xl font-extrabold tabular-nums leading-none">
            {money(grandTotal)}
          </span>
        </div>
        {grandTotal > 0 && (
          <>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white/90 transition-all duration-500 ease-out"
                style={{ width: `${payProgress}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] opacity-90 tabular-nums">
              <span>Paid: ৳ {money(paid)}</span>
              <span>{payProgress.toFixed(0)}%</span>
              <span>Due: ৳ {money(due)}</span>
            </div>
          </>
        )}
      </div>

      {/* ── Line-item breakdown ──────────────────────────────────────── */}
      <div className="divide-y divide-gray-50">
        <SummaryLine
          label="Items"
          value={`${itemsCount} units · ${uniqueItems} lines`}
          icon={<TagIcon />}
        />
        <SummaryLine
          label="Subtotal"
          value={`৳ ${money(subtotal)}`}
          icon={<CartIcon />}
        />
        {discount > 0 && (
          <SummaryLine
            label="Discount"
            value={`− ৳ ${money(discount)}`}
            valueClass="text-emerald-700 font-semibold"
            icon={<DiscountIcon />}
          />
        )}
        {tax > 0 && (
          <SummaryLine
            label="Tax"
            value={`+ ৳ ${money(tax)}`}
            valueClass="text-sky-700 font-semibold"
            icon={<TaxIcon />}
          />
        )}
        {shipping > 0 && (
          <SummaryLine
            label="Shipping"
            value={`+ ৳ ${money(shipping)}`}
            valueClass="text-indigo-700 font-semibold"
            icon={<TruckIcon />}
          />
        )}
        {extra > 0 && (
          <SummaryLine
            label="Additional expense"
            value={`+ ৳ ${money(extra)}`}
            valueClass="text-violet-700 font-semibold"
            icon={<PlusBoxIcon />}
          />
        )}

        {/* ── Grand total row ─────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 bg-gray-50/60">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gray-900 text-[10px] font-bold text-white">৳</span>
            <span className="text-sm font-semibold text-gray-900">Final payable</span>
          </div>
          <span className="text-lg font-extrabold text-gray-900 tabular-nums">৳ {money(grandTotal)}</span>
        </div>

        {/* ── Balance due (only if there's any) ────────────────────── */}
        <div className="flex items-center justify-between px-6 py-3 bg-rose-50/30">
          <span className="text-xs font-semibold uppercase tracking-wider text-rose-700">Balance due</span>
          <span className={`text-base font-bold tabular-nums ${due > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
            ৳ {money(due)}
          </span>
        </div>
      </div>
    </div>
  )
}

function SummaryStatusPill({ status, theme }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] ring-1 ring-white/40 ${theme.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`} />
      {status}
    </span>
  )
}

function SummaryLine({ label, value, valueClass = 'text-gray-800', icon }) {
  return (
    <div className="flex items-center justify-between px-6 py-2.5 text-sm hover:bg-gray-50/40 transition-colors">
      <span className="flex items-center gap-2 text-gray-600">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-500">{icon}</span>
        {label}
      </span>
      <span className={`tabular-nums ${valueClass}`}>{value}</span>
    </div>
  )
}

// ─── small icons for the summary lines ─────────────────────────────────
function TagIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2.5 5A2.5 2.5 0 015 2.5h4.586a2.5 2.5 0 011.768.732l6.586 6.586a2.5 2.5 0 010 3.536l-4.586 4.586a2.5 2.5 0 01-3.536 0L3.232 11.354A2.5 2.5 0 012.5 9.586V5zM7 7a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>)
}
function CartIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M3 3h2l.6 3M5.6 6h11.4l-1.6 7H7.2L5.6 6zM7 17a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm9 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>)
}
function DiscountIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M13.78 6.22a.75.75 0 010 1.06L7.06 14.06a.75.75 0 11-1.06-1.06l6.72-6.78a.75.75 0 011.06 0zM7 7a1 1 0 11-2 0 1 1 0 012 0zm8 6a1 1 0 11-2 0 1 1 0 012 0z" clipRule="evenodd" /></svg>)
}
function TaxIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a1 1 0 011 1v1.05A6.002 6.002 0 0115.95 9H17a1 1 0 110 2h-1.05A6.002 6.002 0 0110 16.95V18a1 1 0 11-2 0v-1.05A6.002 6.002 0 014.05 11H3a1 1 0 110-2h1.05A6.002 6.002 0 0110 4.05V3a1 1 0 01-1-1z" /></svg>)
}
function TruckIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M9 3a1 1 0 00-1 1v8a1 1 0 001 1h.5a1.5 1.5 0 003 0H14a1 1 0 001-1V8h2a1 1 0 00.8-.4l2-2.667A1 1 0 0019 3H9z" /><circle cx="6" cy="13" r="2" /></svg>)
}
function PlusBoxIcon() {
  return (<svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 5a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm7 2a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 0110 7z" clipRule="evenodd" /></svg>)
}

// CustomerTypeahead inline definition removed — now imported from
// components/form/CustomerTypeahead so AllSales / ShipmentsPage /
// SellReturnsPage all share the same modern picker (with phone
// leading-zero normalisation via fmtPhone()).
