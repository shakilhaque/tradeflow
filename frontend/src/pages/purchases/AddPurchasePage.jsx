import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { createPurchase, updatePurchase, getPurchase, createSupplier, getSuppliers } from '../../api/purchases'
import { SupplierModal } from '../contacts/SuppliersPage'
import { getProducts, getLocations } from '../../api/products'
import { getPaymentAccounts } from '../../api/accounting'

const PAYMENT_METHODS = [
  { value: 'cash',          label: 'Cash' },
  { value: 'card',          label: 'Card' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'mobile',        label: 'Mobile Money' },
  { value: 'other',         label: 'Other' },
]

const PAY_TERM_UNITS = [
  { value: 'days',   label: 'Days' },
  { value: 'months', label: 'Months' },
]

const blankItem = () => ({
  product_id: '',
  product_name: '',
  sku: '',
  quantity: '1',
  unit_cost: '0.00',
  discount_percent: '0.00',
  tax_rate: '0.00',
  selling_price: '0.00',
})

const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = (n) => `৳ ${fmt(n)}`

// ── Page ────────────────────────────────────────────────────────────────────

export default function AddPurchasePage() {
  const navigate = useNavigate()
  // Edit mode — route is shared between "Add" and "Edit". When the
  // ?edit=<uuid> param is present we fetch the existing purchase
  // and pre-populate the form. The Save action then PATCHes the
  // existing row instead of POSTing a new one. No hardcoded values
  // anywhere — every field comes from the per-tenant DB.
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('edit') || ''
  const isEditing = Boolean(editId)

  const [products,  setProducts]  = useState([])
  const [locations, setLocations] = useState([])
  const [suppliers, setSuppliers] = useState([])

  const [header, setHeader] = useState({
    reference_no:    '',
    supplier_id:     '',
    location_id:     '',
    purchase_date:   new Date().toISOString().slice(0, 10),
    status:          '',
    pay_term_value:  '',
    pay_term_unit:   'days',
    notes:           '',
  })

  const [discountType,   setDiscountType]   = useState('none')   // none | fixed | percent
  const [discountAmount, setDiscountAmount] = useState('0')
  const [taxRate,        setTaxRate]        = useState('0')
  const [shippingDetails, setShippingDetails] = useState('')
  const [shippingCost,    setShippingCost]    = useState('0')
  const [additionalExpenses, setAdditionalExpenses] = useState([])  // [{name, amount}]
  const [attachment, setAttachment] = useState(null)

  const [items, setItems] = useState([blankItem()])
  const [productQuery, setProductQuery] = useState('')

  const [paymentAmount,    setPaymentAmount]    = useState('0')
  const [paymentMethod,    setPaymentMethod]    = useState('cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNote,      setPaymentNote]      = useState('')
  // Method-specific fields — mirror the Add Sale Payment card.
  // Only the bundle relevant to the picked method is rendered;
  // everything posts to Sale.meta via payment_meta so no backend
  // change is needed (PurchaseSerializer ignores unknown fields).
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [cardNumber,        setCardNumber]        = useState('')
  const [cardHolderName,    setCardHolderName]    = useState('')
  const [cardTransactionNo, setCardTransactionNo] = useState('')
  const [cardType,          setCardType]          = useState('CREDIT_CARD')
  const [cardMonth,         setCardMonth]         = useState('')
  const [cardYear,          setCardYear]          = useState('')
  const [cardSecurityCode,  setCardSecurityCode]  = useState('')
  const [bankAccountNo,     setBankAccountNo]     = useState('')
  const [chequeNo,          setChequeNo]          = useState('')
  const [chequeBank,        setChequeBank]        = useState('')
  // Tenant's PaymentAccount rows pulled from the per-tenant DB —
  // used by the Payment Account dropdown so the cashier maps the
  // purchase payment to the right cash box / bank account / MFS
  // wallet.
  const [paymentAccountsList, setPaymentAccountsList] = useState([])

  const [supplierModalOpen, setSupplierModalOpen] = useState(false)
  // Bulk-import line items from a CSV / Excel file. Opens the
  // ImportProductsModal defined at the bottom of this file. The
  // modal returns a list of blankItem-shaped rows that we append
  // to `items`.
  const [importOpen, setImportOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Dedicated state for the insufficient-balance modal so the
  // operator never misses a save block. Holds the raw error from
  // the server when it matches the "Not enough balance" pattern;
  // null when the alert isn't shown.
  const [balanceAlert, setBalanceAlert] = useState(null)
  const [error,      setError]      = useState('')

  // Master data
  const reloadSuppliers = async () => {
    try {
      const sups = await getSuppliers({ active_only: 'true' })
      setSuppliers(Array.isArray(sups) ? sups : (sups?.results ?? []))
    } catch { /* ignore */ }
  }

  // Payment accounts load on their OWN — not bundled with the (potentially
  // slow / large) product catalogue fetch. Bundling them in one Promise.all
  // meant the Payment Account dropdown stayed empty ("None") until the heavy
  // product load finished or failed. No active filter, so the picker lists
  // every account exactly like the List Accounts page.
  useEffect(() => {
    getPaymentAccounts({})
      .then((accts) => setPaymentAccountsList(Array.isArray(accts) ? accts : (accts?.results ?? [])))
      .catch(() => setPaymentAccountsList([]))
  }, [])

  useEffect(() => {
    (async () => {
      try {
        const [prods, locs] = await Promise.all([
          getProducts({ is_active: 'true' }).catch(() => []),
          getLocations(true).catch(() => []),
        ])
        setProducts(Array.isArray(prods) ? prods : (prods?.results ?? []))
        const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
        setLocations(locArr)
        // Single-branch (e.g. free tier) → auto-select the only location so
        // the Business Location field is never left blank.
        if (locArr.length === 1) {
          setForm((f) => ({ ...f, location_id: f.location_id || String(locArr[0].id) }))
        }
      } catch { /* ignore */ }
      reloadSuppliers()
    })()
  }, [])

  // ── Edit-mode hydration — pulls the existing Purchase from the
  // per-tenant DB and pre-fills every form field (header, items,
  // discount, tax, shipping, additional notes). Runs whenever the
  // ?edit=<uuid> param changes so navigating between two edits in
  // the same SPA session swaps the items cleanly (was leaking the
  // previous purchase's items into the new one).
  useEffect(() => {
    if (!editId) return
    let cancelled = false
    // Hard reset BEFORE the fetch — so the user never sees the
    // previous purchase's items briefly while the GET is in flight.
    setItems([])
    setHeader((h) => ({
      ...h,
      reference_no: '', supplier_id: '', location_id: '',
      purchase_date: new Date().toISOString().slice(0, 10),
      status: '', notes: '',
    }))
    setDiscountType('none'); setDiscountAmount('0')
    setShippingCost('0'); setShippingDetails('')
    setAdditionalExpenses([])

    ;(async () => {
      try {
        const p = await getPurchase(editId)
        if (cancelled || !p) return
        setHeader({
          reference_no:  p.reference_no || '',
          supplier_id:   p.supplier || '',
          location_id:   p.location || '',
          purchase_date: (p.purchase_date || '').slice(0, 10),
          status:        p.status || '',
          pay_term_value: '',
          pay_term_unit:  'days',
          notes:          p.notes || '',
        })
        // Replace items with EXACTLY what's on this purchase. If the
        // detail payload has no items (unusual but possible for an
        // empty draft), keep the grid empty rather than reusing a
        // blank starter row, because the user can't tell the
        // difference between "loaded → empty" and "loading".
        const itemsArr = Array.isArray(p.items) ? p.items : []
        if (cancelled) return
        setItems(itemsArr.length ? itemsArr.map((it) => ({
          product_id:       it.product || '',
          product_name:     it.product_name || '',
          sku:              it.sku || '',
          // Quantity always displays as 2 decimals (was rendering
          // as "5.0000" because the API ships DecimalField with
          // decimal_places=4 for line quantities).
          quantity:         to2(it.quantity || 1),
          unit_cost:        to2(it.unit_cost),
          discount_percent: '0.00',
          tax_rate:         to2(it.tax_rate),
          selling_price:    '0.00',
        })) : [blankItem()])
        if (p.discount_amount && Number(p.discount_amount) > 0) {
          setDiscountType('fixed')
          setDiscountAmount(String(p.discount_amount))
        }
        if (p.tax_amount && Number(p.tax_amount) > 0) {
          // tax_amount is stored — keep tax_rate at zero and let the
          // user re-enter if they want. Most tenants treat it as
          // line-level only.
          setTaxRate('0')
        }
        if (p.shipping_cost) setShippingCost(String(p.shipping_cost))
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load purchase for editing.')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  // ── Item helpers ──────────────────────────────────────────────────────────

  const updateItem = (idx, patch) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))

  // Remove the line item at idx. If it's the LAST row, we don't
  // actually delete it (so the grid always has at least one row to
  // pick a product into) — we RESET it back to blank instead. This
  // is the "Cancel selected product" behaviour the user reported
  // as broken: clicking ✕ on the only row should clear it back to
  // the empty-search state, not be a no-op.
  const removeItem = (idx) =>
    setItems((prev) => (prev.length > 1
      ? prev.filter((_, i) => i !== idx)
      : prev.map((it, i) => (i === idx ? blankItem() : it))
    ))

  // Always render decimal-looking numbers from the per-tenant DB
  // (cost_price / tax_rate / selling_price) at exactly 2 decimals
  // when they land in the grid. The DRF serializer can ship values
  // like "0.0000" depending on decimal_places, which the number
  // input then renders verbatim — that's what the user reported
  // as "0.0000 dekhacche, 0.00 hobe".
  const to2 = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n.toFixed(2) : '0.00'
  }

  const addProductToItems = (product) => {
    if (!product) return
    setItems((prev) => {
      const empty = prev.findIndex((i) => !i.product_id)
      const next = {
        product_id: product.id,
        product_name: product.name,
        sku: product.sku || '',
        quantity: '1',
        unit_cost: to2(product.cost_price),
        discount_percent: '0.00',
        tax_rate: to2(product.tax_rate),
        selling_price: to2(product.selling_price),
      }
      if (empty >= 0) return prev.map((it, i) => (i === empty ? next : it))
      return [...prev, next]
    })
    setProductQuery('')
  }

  // ── Computations ──────────────────────────────────────────────────────────

  const lineCalc = (it) => {
    const qty   = Number(it.quantity || 0)
    const cost  = Number(it.unit_cost || 0)
    const dPct  = Number(it.discount_percent || 0)
    const tPct  = Number(it.tax_rate || 0)
    const sell  = Number(it.selling_price || 0)
    const unitAfterDisc = cost * (1 - dPct / 100)
    const unitAfterTax  = unitAfterDisc * (1 + tPct / 100)
    const lineTotal     = unitAfterTax * qty
    const margin        = sell > 0 ? ((sell - unitAfterTax) / sell) * 100 : 0
    const lineDiscount  = (cost * (dPct / 100)) * qty
    const lineTax       = unitAfterDisc * (tPct / 100) * qty
    const lineBase      = unitAfterDisc * qty
    return { unitAfterDisc, unitAfterTax, lineTotal, margin, lineDiscount, lineTax, lineBase }
  }

  const totals = useMemo(() => {
    let totalItems = 0
    let netTotal   = 0           // after item-level discount + tax
    let baseTotal  = 0           // after item-level discount, pre tax
    let itemTax    = 0
    items.forEach((it) => {
      const c = lineCalc(it)
      totalItems += Number(it.quantity || 0)
      netTotal   += c.lineTotal
      baseTotal  += c.lineBase
      itemTax    += c.lineTax
    })

    const discAmt =
      discountType === 'fixed'   ? Number(discountAmount || 0)
    : discountType === 'percent' ? netTotal * (Number(discountAmount || 0) / 100)
    : 0

    const purchaseTax = baseTotal * (Number(taxRate || 0) / 100)
    const shipping    = Number(shippingCost || 0)
    const extras      = additionalExpenses.reduce((s, e) => s + Number(e.amount || 0), 0)
    const grand       = netTotal - discAmt + purchaseTax + shipping + extras

    return {
      totalItems: totalItems.toFixed(2),
      netTotal:   netTotal.toFixed(2),
      itemTax:    itemTax.toFixed(2),
      discAmt:    discAmt.toFixed(2),
      purchaseTax: purchaseTax.toFixed(2),
      shipping:   shipping.toFixed(2),
      extras:     extras.toFixed(2),
      grand:      grand.toFixed(2),
    }
  }, [items, discountType, discountAmount, taxRate, shippingCost, additionalExpenses])

  const paymentDue = Math.max(Number(totals.grand) - Number(paymentAmount || 0), 0)

  const selectedSupplier = suppliers.find((s) => s.id === header.supplier_id)
  const filteredProducts = useMemo(() => {
    if (!productQuery.trim()) return []
    const q = productQuery.trim().toLowerCase()
    return products
      .filter((p) =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [productQuery, products])

  // ── Submit ────────────────────────────────────────────────────────────────

  const validate = () => {
    if (!header.supplier_id) return 'Select a supplier.'
    if (!header.location_id) return 'Select a business location.'
    const filled = items.filter((it) => it.product_id)
    if (filled.length === 0) return 'Add at least one product.'
    for (const [i, it] of filled.entries()) {
      if (Number(it.quantity) <= 0) return `Row ${i + 1}: quantity must be > 0.`
      if (Number(it.unit_cost) < 0)  return `Row ${i + 1}: unit cost must be ≥ 0.`
    }
    if (Number(paymentAmount || 0) > Number(totals.grand) + 0.01) return 'Payment cannot exceed grand total.'
    return ''
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setError('')
    const err = validate()
    if (err) { setError(err); return }

    setSubmitting(true)
    try {
      const noteParts = []
      if (header.notes) noteParts.push(header.notes)
      if (header.pay_term_value) noteParts.push(`Pay term: ${header.pay_term_value} ${header.pay_term_unit}`)
      if (additionalExpenses.length) {
        noteParts.push(`Additional expenses: ${additionalExpenses.map((e) => `${e.name || 'Misc'} ৳${e.amount || 0}`).join(', ')}`)
      }

      const totalShipping = Number(shippingCost || 0) + additionalExpenses.reduce((s, e) => s + Number(e.amount || 0), 0)

      const body = {
        reference_no:     header.reference_no || undefined,
        supplier_id:      header.supplier_id,
        location_id:      header.location_id,
        purchase_date:    header.purchase_date,
        status:           header.status || 'received',
        discount_amount:  Number(totals.discAmt),
        shipping_cost:    totalShipping,
        shipping_details: shippingDetails,
        notes:            noteParts.join(' | '),
        items: items.filter((it) => it.product_id).map((it) => ({
          product_id: it.product_id,
          quantity:   Number(it.quantity),
          unit_cost:  Number(it.unit_cost),
          tax_rate:   Number(it.tax_rate || 0),
          discount:   Number(it.unit_cost || 0) * Number(it.quantity || 0) * (Number(it.discount_percent || 0) / 100),
        })),
      }
      if (Number(paymentAmount || 0) > 0) {
        body.payment_amount    = Number(paymentAmount)
        body.payment_method    = paymentMethod
        body.payment_reference = paymentReference
        body.payment_account_id = paymentAccountId || null
        // Method-specific metadata — saved on the payment row's
        // `meta` JSON blob by the backend serializer. Mirrors the
        // Add Sale Payment card; unknown keys are ignored on
        // tenant DBs that haven't migrated the field yet.
        body.payment_meta = {}
        if (paymentMethod === 'card') {
          body.payment_meta.card_number         = cardNumber
          body.payment_meta.card_holder_name    = cardHolderName
          body.payment_meta.card_transaction_no = cardTransactionNo
          body.payment_meta.card_type           = cardType
          body.payment_meta.card_month          = cardMonth
          body.payment_meta.card_year           = cardYear
          body.payment_meta.card_security_code  = cardSecurityCode
        } else if (paymentMethod === 'bank_transfer') {
          body.payment_meta.bank_account_no = bankAccountNo
        } else if (paymentMethod === 'cheque') {
          body.payment_meta.cheque_no   = chequeNo
          body.payment_meta.cheque_bank = chequeBank
        }
      }

      // In edit mode we PATCH the existing purchase; otherwise POST
      // a new one. The backend viewset's partial_update accepts the
      // same body shape minus items (items are immutable on this
      // viewset — line-item edits go through a separate flow).
      const res = isEditing
        ? await updatePurchase(editId, body)
        : await createPurchase(body)
      navigate('/purchases/list', { state: { created: res?.reference_no } })
    } catch (ex) {
      const msg = ex?.message || 'Failed to create purchase.'
      const fieldErr = ex?.errors?.payment_account_id
      // Insufficient-balance is the only error the operator can
      // act on directly from this page — surface it in a dedicated
      // modal pop-up so they can't miss it. Everything else goes
      // to the inline banner as before.
      if (/not enough balance|insufficient balance/i.test(msg) || /insufficient/i.test(fieldErr || '')) {
        setBalanceAlert({ message: msg, detail: fieldErr || '' })
      } else {
        setError(msg)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-24">
      <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">{isEditing ? 'Edit Purchase' : 'Add Purchase'}</h1>
          <p className="mt-0.5 text-sm text-emerald-50">{isEditing ? 'Update this purchase — header, items, discount, tax, shipping and notes.' : 'Record incoming goods, supplier costs, and payments.'}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" type="button" onClick={() => setImportOpen(true)}>📥 Import Products</Button>
          <Button variant="secondary" type="button" onClick={() => navigate('/purchases/list')}>← Back to list</Button>
        </div>
      </div>

      {importOpen && (
        <ImportProductsModal
          onClose={() => setImportOpen(false)}
          onImported={(rows) => {
            setItems((prev) => {
              // Append every imported row to the existing item list.
              // The blankItem-shaped objects from the modal carry the
              // resolved product_id (from SKU lookup) plus qty/cost/
              // tax/discount the tenant supplied in the file.
              const next = [...prev.filter((it) => it.product_id || it.sku), ...rows]
              return next.length ? next : rows
            })
            setImportOpen(false)
          }}
        />
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── 1. Purchase Information ──────────────────────────────────────── */}
      <Card>
        <SectionTitle title="Purchase Information" accent="indigo" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Supplier with + */}
          <div className="lg:col-span-1">
            <label className="text-xs font-medium text-gray-700">Supplier *</label>
            <div className="mt-1 flex gap-2">
              <select
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-200"
                value={header.supplier_id}
                onChange={(e) => setHeader({ ...header, supplier_id: e.target.value })}
              >
                <option value="">Please Select</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setSupplierModalOpen(true)}
                className="rounded-lg bg-brand-600 hover:bg-brand-700 text-white w-9 h-9 flex items-center justify-center text-lg font-medium shadow-sm"
                title="Add new supplier"
              >+</button>
            </div>
            {selectedSupplier?.address && (
              <p className="mt-1 text-xs text-gray-500"><span className="font-medium">Address:</span> {selectedSupplier.address}</p>
            )}
          </div>

          <Input label="Reference No" placeholder="Auto-generate if empty"
            value={header.reference_no}
            onChange={(e) => setHeader({ ...header, reference_no: e.target.value })} />

          <Input label="Purchase Date *" type="date"
            value={header.purchase_date}
            onChange={(e) => setHeader({ ...header, purchase_date: e.target.value })} />

          <Select label="Purchase Status *"
            value={header.status}
            onChange={(e) => setHeader({ ...header, status: e.target.value })}>
            <option value="">Please Select</option>
            <option value="received">Received</option>
            <option value="partial">Partial</option>
            <option value="draft">Draft (Pending)</option>
            <option value="cancelled">Cancelled</option>
          </Select>

          <Select label="Business Location *"
            value={header.location_id}
            onChange={(e) => setHeader({ ...header, location_id: e.target.value })}>
            <option value="">Please Select</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>

          <div>
            <label className="text-xs font-medium text-gray-700">Pay Term</label>
            <div className="mt-1 flex gap-2">
              <input type="number" min="0" placeholder="0"
                value={header.pay_term_value}
                onChange={(e) => setHeader({ ...header, pay_term_value: e.target.value })}
                className="w-1/2 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
              <select
                value={header.pay_term_unit}
                onChange={(e) => setHeader({ ...header, pay_term_unit: e.target.value })}
                className="w-1/2 rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-200">
                {PAY_TERM_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>
          </div>

          {/* Attach document */}
          <div className="lg:col-span-2">
            <label className="text-xs font-medium text-gray-700">Attach Document</label>
            <div className="mt-1 flex items-center gap-3">
              <label className="cursor-pointer rounded-lg bg-brand-50 hover:bg-brand-100 text-brand-700 px-3 py-2 text-sm font-medium border border-brand-200">
                Choose File
                <input type="file" className="hidden"
                  accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
                  onChange={(e) => setAttachment(e.target.files?.[0] ?? null)} />
              </label>
              <span className="text-xs text-gray-500 truncate">
                {attachment ? attachment.name : 'No file chosen'} · max 5MB · pdf, csv, zip, doc, docx, jpeg, jpg, png
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* ── 2. Products — redesigned with bigger inputs, modern
              alignment, and 2-decimal normalisation on blur so the
              tenant never sees stray trailing zeros (10.0000). ──── */}
      <Card padding="p-0">
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3 justify-between">
          <SectionTitle title="Products" accent="emerald" inline />
          <div className="flex items-center gap-2 flex-1 max-w-2xl min-w-[260px] relative">
            <input
              type="text"
              placeholder="Enter Product name / SKU / Scan barcode"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              className="flex-1 rounded-lg border border-gray-200 pl-10 pr-3 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <svg className="absolute left-3 w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
            {filteredProducts.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-pop overflow-hidden">
                {filteredProducts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addProductToItems(p)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-brand-50 text-left"
                  >
                    <span className="text-gray-900 font-medium">{p.name}</span>
                    <span className="text-xs text-gray-400 font-mono">{p.sku}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => addProductToItems(null) || setItems((p) => [...p, blankItem()])}
            className="inline-flex items-center gap-1 rounded-md bg-brand-50 hover:bg-brand-100 border border-brand-200 px-3 py-1.5 text-xs font-semibold text-brand-700"
          >
            + Add row
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-emerald-500/95 text-left text-[11px] font-semibold text-white uppercase tracking-wider">
                <th className="px-3 py-3 w-10">#</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-5 py-3 w-32 text-right whitespace-nowrap">Quantity</th>
                <th className="px-5 py-3 w-44 text-right whitespace-nowrap">Unit Cost (Pre-Disc)</th>
                <th className="px-5 py-3 w-32 text-right whitespace-nowrap">Discount %</th>
                <th className="px-5 py-3 w-44 text-right whitespace-nowrap">Unit Cost (Pre-Tax)</th>
                <th className="px-5 py-3 w-28 text-right whitespace-nowrap">Tax %</th>
                <th className="px-5 py-3 w-36 text-right whitespace-nowrap">Line Total</th>
                <th className="px-5 py-3 w-28 text-right whitespace-nowrap">Margin %</th>
                <th className="px-5 py-3 w-36 text-right whitespace-nowrap">Selling Price</th>
                <th className="px-3 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it, idx) => {
                const c = lineCalc(it)
                const inputCls = 'w-full rounded-lg border border-gray-200 px-2.5 py-2 text-sm text-right tabular-nums focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50'
                // Normalise to 2-decimals on blur so the cashier
                // never sees "10.0000" — only "10.00". Empty stays
                // empty so the placeholder still reads "0".
                const normalise = (key) => (e) => {
                  const v = e.target.value
                  if (v === '' || v == null) return
                  const n = Number(v)
                  if (!Number.isFinite(n)) return
                  updateItem(idx, { [key]: n.toFixed(2) })
                }
                return (
                  <tr key={idx} className={!it.product_id ? 'bg-gray-50/40' : ''}>
                    <td className="px-3 py-3 text-gray-400 text-xs">{idx + 1}</td>
                    <td className="px-3 py-3">
                      {it.product_id ? (
                        <div>
                          <div className="font-medium text-gray-900">{it.product_name}</div>
                          {it.sku && <div className="text-[11px] text-gray-400 font-mono">{it.sku}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400 italic">Search above to add a product</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <input type="number" min="0" step="1" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        disabled={!it.product_id}
                        className={inputCls} />
                    </td>
                    <td className="px-5 py-3">
                      <input type="number" min="0" step="0.01" value={it.unit_cost}
                        onChange={(e) => updateItem(idx, { unit_cost: e.target.value })}
                        onBlur={normalise('unit_cost')}
                        disabled={!it.product_id}
                        className={inputCls} />
                    </td>
                    <td className="px-5 py-3">
                      <input type="number" min="0" step="0.01" value={it.discount_percent}
                        onChange={(e) => updateItem(idx, { discount_percent: e.target.value })}
                        onBlur={normalise('discount_percent')}
                        disabled={!it.product_id}
                        className={inputCls} />
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700 font-mono tabular-nums">
                      {fmt(c.unitAfterDisc)}
                    </td>
                    <td className="px-5 py-3">
                      <input type="number" min="0" step="0.01" value={it.tax_rate}
                        onChange={(e) => updateItem(idx, { tax_rate: e.target.value })}
                        onBlur={normalise('tax_rate')}
                        disabled={!it.product_id}
                        className={inputCls} />
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900 tabular-nums whitespace-nowrap">
                      {fmtMoney(c.lineTotal)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      <span className={`text-xs font-semibold ${c.margin > 0 ? 'text-emerald-600' : c.margin < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                        {c.margin.toFixed(2)}%
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <input type="number" min="0" step="0.01" value={it.selling_price}
                        onChange={(e) => updateItem(idx, { selling_price: e.target.value })}
                        onBlur={normalise('selling_price')}
                        disabled={!it.product_id}
                        className={inputCls} />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button type="button" onClick={() => removeItem(idx)}
                        className="text-rose-500 hover:text-rose-700 text-lg" title="Remove">✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot className="bg-gray-50 border-t-2 border-gray-200">
              <tr>
                <td colSpan={2} className="px-3 py-3 font-semibold text-gray-700">Total</td>
                <td className="px-5 py-3 text-right font-semibold tabular-nums">{Number(totals.totalItems || 0).toFixed(2)}</td>
                <td colSpan={4}></td>
                <td className="px-5 py-3 text-right font-semibold text-gray-900 tabular-nums">{fmtMoney(totals.netTotal)}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* ── 3. Discount + Tax + Notes ────────────────────────────────────── */}
      <Card>
        <SectionTitle title="Discount, Tax & Notes" accent="violet" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="space-y-4">
            <Select label="Discount Type" value={discountType} onChange={(e) => setDiscountType(e.target.value)}>
              <option value="none">None</option>
              <option value="fixed">Fixed Amount</option>
              <option value="percent">Percentage</option>
            </Select>
            <Input label="Discount Amount" type="number" min="0" step="0.01"
              disabled={discountType === 'none'}
              value={discountAmount}
              onChange={(e) => setDiscountAmount(e.target.value)} />
            <p className="text-sm text-gray-600">Discount: <span className="font-semibold text-rose-600">(−) {fmtMoney(totals.discAmt)}</span></p>
          </div>

          <div className="space-y-4">
            <Select label="Purchase Tax (on subtotal)" value={taxRate} onChange={(e) => setTaxRate(e.target.value)}>
              <option value="0">None</option>
              <option value="5">5%</option>
              <option value="7.5">7.5%</option>
              <option value="10">10%</option>
              <option value="15">15%</option>
              <option value="custom">Custom…</option>
            </Select>
            {taxRate === 'custom' && (
              <Input label="Custom Tax %" type="number" min="0" step="0.01"
                onChange={(e) => setTaxRate(e.target.value)} />
            )}
            <p className="text-sm text-gray-600">Purchase Tax: <span className="font-semibold text-emerald-600">(+) {fmtMoney(totals.purchaseTax)}</span></p>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">Additional Notes</label>
            <textarea rows={5}
              value={header.notes}
              onChange={(e) => setHeader({ ...header, notes: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
              placeholder="Internal notes..." />
          </div>
        </div>
      </Card>

      {/* ── 4. Shipping & Extras ─────────────────────────────────────────── */}
      <Card>
        <SectionTitle title="Shipping & Additional Expenses" accent="amber" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Input label="Shipping Details" placeholder="Courier, tracking, etc."
            value={shippingDetails}
            onChange={(e) => setShippingDetails(e.target.value)} />
          <Input label="Additional Shipping Charges" type="number" min="0" step="0.01"
            value={shippingCost}
            onChange={(e) => setShippingCost(e.target.value)} />
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Additional Expenses</h4>
            <button type="button"
              onClick={() => setAdditionalExpenses((p) => [...p, { name: '', amount: '0' }])}
              className="text-sm text-brand-600 hover:text-brand-700 font-medium">+ Add expense</button>
          </div>
          {additionalExpenses.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No additional expenses added.</p>
          ) : (
            <div className="space-y-2">
              {additionalExpenses.map((e, idx) => (
                <div key={idx} className="flex gap-2">
                  <input type="text" placeholder="Expense name (e.g., Customs)"
                    value={e.name}
                    onChange={(ev) => setAdditionalExpenses((prev) => prev.map((x, i) => i === idx ? { ...x, name: ev.target.value } : x))}
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
                  <input type="number" min="0" step="0.01" placeholder="0.00"
                    value={e.amount}
                    onChange={(ev) => setAdditionalExpenses((prev) => prev.map((x, i) => i === idx ? { ...x, amount: ev.target.value } : x))}
                    className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
                  <button type="button"
                    onClick={() => setAdditionalExpenses((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-rose-500 hover:text-rose-700 px-2">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* ── 5. Payment ───────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle title="Add Payment" accent="rose" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <Input label="Amount" type="number" min="0" step="0.01"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)} />
            <button
              type="button"
              onClick={() => setPaymentAmount(Number(totals.grand || 0).toFixed(2))}
              className="mt-1 text-xs font-medium text-brand-700 hover:underline"
            >
              Use Full Amount
            </button>
          </div>
          <Select label="Payment Method"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>

          {/* Payment Account — always visible. Drives WHICH ledger
              the supplier payment lands in (Cash on Hand, City
              Bank, bKash, etc.). Options pulled live from the
              tenant's PaymentAccount rows. */}
          <Select label="Payment Account"
            value={paymentAccountId}
            onChange={(e) => setPaymentAccountId(e.target.value)}>
            <option value="">None</option>
            {paymentAccountsList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.account_type ? ` (${a.account_type})` : ''}
              </option>
            ))}
          </Select>

          {/* ── CARD-specific fields — mirror the Add Sale card. ── */}
          {paymentMethod === 'card' && (
            <>
              <Input label="Card Number" placeholder="Card Number"
                inputMode="numeric"
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value.replace(/[^\d ]/g, ''))} />
              <Input label="Card holder name" placeholder="Card holder name"
                value={cardHolderName}
                onChange={(e) => setCardHolderName(e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))} />
              <Input label="Card Transaction No." placeholder="Card Transaction No."
                value={cardTransactionNo}
                onChange={(e) => setCardTransactionNo(e.target.value)} />
              <Select label="Card Type"
                value={cardType}
                onChange={(e) => setCardType(e.target.value)}>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="DEBIT_CARD">Debit Card</option>
                <option value="PREPAID">Prepaid</option>
              </Select>
              <Input label="Month" placeholder="MM" inputMode="numeric" maxLength={2}
                value={cardMonth}
                onChange={(e) => setCardMonth(e.target.value.replace(/\D/g, '').slice(0, 2))} />
              <Input label="Year" placeholder="YYYY" inputMode="numeric" maxLength={4}
                value={cardYear}
                onChange={(e) => setCardYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              <Input label="Security Code" placeholder="CVV" inputMode="numeric" maxLength={4}
                value={cardSecurityCode}
                onChange={(e) => setCardSecurityCode(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            </>
          )}

          {/* ── CHEQUE-specific fields ─────────────────────────── */}
          {paymentMethod === 'cheque' && (
            <>
              <Input label="Cheque No." placeholder="Cheque No."
                value={chequeNo}
                onChange={(e) => setChequeNo(e.target.value)} />
              <Input label="Bank Name" placeholder="Bank Name"
                value={chequeBank}
                onChange={(e) => setChequeBank(e.target.value)} />
            </>
          )}

          {/* ── BANK TRANSFER-specific field ───────────────────── */}
          {paymentMethod === 'bank_transfer' && (
            <Input label="Bank Account No" placeholder="Bank Account No"
              inputMode="numeric"
              value={bankAccountNo}
              onChange={(e) => setBankAccountNo(e.target.value.replace(/[^\d -]/g, ''))} />
          )}

          <Input label="Reference / Transaction ID"
            value={paymentReference}
            onChange={(e) => setPaymentReference(e.target.value)} />

          <div className="md:col-span-2 lg:col-span-3">
            <label className="text-xs font-medium text-gray-700">Payment Note</label>
            <textarea rows={2}
              value={paymentNote}
              onChange={(e) => setPaymentNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
              placeholder="Optional notes about this payment" />
          </div>
        </div>
      </Card>

      {/* ── Sticky totals + submit bar ───────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-[var(--sidebar-w,256px)] z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <div className="px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 justify-between">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <SummaryItem label="Items"     value={totals.totalItems} />
            <SummaryItem label="Net"       value={fmtMoney(totals.netTotal)} />
            <SummaryItem label="Discount"  value={`− ${fmtMoney(totals.discAmt)}`} accent="text-rose-600" />
            <SummaryItem label="Tax"       value={`+ ${fmtMoney(totals.purchaseTax)}`} accent="text-emerald-600" />
            <SummaryItem label="Shipping+" value={fmtMoney(Number(totals.shipping) + Number(totals.extras))} />
            <SummaryItem label="Grand Total" value={fmtMoney(totals.grand)} accent="text-brand-700 font-bold" />
            <SummaryItem label="Payment Due" value={fmtMoney(paymentDue)} accent="text-rose-700 font-bold" />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate('/purchases/list')}>Cancel</Button>
            <Button type="submit" loading={submitting}>{isEditing ? 'Update Purchase' : 'Save Purchase'}</Button>
          </div>
        </div>
      </div>

      {/* ── Add Supplier Modal — same full modal as the Suppliers page ───── */}
      <SupplierModal
        open={supplierModalOpen}
        supplier={null}
        onClose={() => setSupplierModalOpen(false)}
        onSaved={(created) => {
          reloadSuppliers().then(() => {
            if (created?.id) setHeader((h) => ({ ...h, supplier_id: created.id }))
          })
          setSupplierModalOpen(false)
        }}
      />

      {/* ── Insufficient Balance Modal ──────────────────────────────────────
          Opens when the backend's PaymentAccount balance guard fires
          on save. Same shape every other modal on the page uses, so
          the operator gets a clear blocking pop-up they can't miss. */}
      {balanceAlert && (
        <Modal open onClose={() => setBalanceAlert(null)} title="Insufficient Balance" size="md">
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <div className="flex-none w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-2xl font-bold">!</div>
              <div className="flex-1">
                <div className="font-semibold text-gray-900 mb-1">Can't record this purchase yet</div>
                <div className="text-gray-700 whitespace-pre-line">{balanceAlert.message}</div>
                {balanceAlert.detail && (
                  <div className="mt-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                    {balanceAlert.detail}
                  </div>
                )}
              </div>
            </div>
            <div className="text-xs text-gray-500 pl-13">
              Top up the account from <b>List Accounts → Deposit</b>, or pick a different
              Payment Account that has enough balance, then try again.
            </div>
          </div>
          <ModalFooter>
            <Button onClick={() => setBalanceAlert(null)}>OK</Button>
          </ModalFooter>
        </Modal>
      )}
    </form>
  )
}

// ── Helper components ──────────────────────────────────────────────────────

function SectionTitle({ title, accent = 'brand', inline = false }) {
  const colors = {
    indigo:  'bg-indigo-100 text-indigo-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    violet:  'bg-violet-100 text-violet-700',
    amber:   'bg-amber-100 text-amber-700',
    rose:    'bg-rose-100 text-rose-700',
    brand:   'bg-brand-100 text-brand-700',
  }
  return (
    <div className={inline ? 'inline-flex items-center gap-2' : 'flex items-center gap-2 mb-4'}>
      <span className={`w-1.5 h-5 rounded-full ${colors[accent]}`} />
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
    </div>
  )
}

function SummaryItem({ label, value, accent = 'text-gray-900' }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
      <span className={`text-sm ${accent}`}>{value}</span>
    </div>
  )
}

function AddSupplierModal({ open, onClose, onCreated }) {
  const [data, setData] = useState({ name: '', contact: '', email: '', phone: '', address: '', tax_number: '' })
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setData({ name: '', contact: '', email: '', phone: '', address: '', tax_number: '' })
      setError('')
    }
  }, [open])

  const submit = async (e) => {
    e.preventDefault()
    if (!data.name.trim()) { setError('Name is required.'); return }
    setBusy(true)
    setError('')
    try {
      const created = await createSupplier({ ...data, is_active: true })
      onCreated?.(created)
    } catch (ex) {
      setError(ex?.message || 'Failed to create supplier.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add new supplier" size="md">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Input label="Name *" value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Contact Person" value={data.contact} onChange={(e) => setData({ ...data, contact: e.target.value })} />
          <Input label="Phone"   value={data.phone}   onChange={(e) => setData({ ...data, phone: e.target.value })} />
          <Input label="Email"   type="email" value={data.email} onChange={(e) => setData({ ...data, email: e.target.value })} />
          <Input label="Tax No." value={data.tax_number} onChange={(e) => setData({ ...data, tax_number: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Address</label>
          <textarea rows={2}
            value={data.address}
            onChange={(e) => setData({ ...data, address: e.target.value })}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save Supplier</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ImportProductsModal — opens from the "Import Products" button at the
// top of Add Purchase. Accepts CSV and Excel (.xlsx / .xls / .xlsm),
// validates each row's SKU against the per-tenant DB, and hands the
// parent a list of blankItem-shaped rows to append to the items grid.
//
// Column order matches the Instructions table the user supplied:
//   1. SKU                      (required)
//   2. Purchase Quantity        (required)
//   3. Unit Cost (Before Disc.) (optional, falls back to product cost)
//   4. Discount Percent         (optional)
//   5. Product Tax              (optional, falls back to product tax_rate)
//   6. Lot Number               (optional)
//   7. MFG Date                 (optional, yyyy-mm-dd)
//   8. EXP Date                 (optional, yyyy-mm-dd)
// ─────────────────────────────────────────────────────────────────────────
function ImportProductsModal({ onClose, onImported }) {
  const fileInputRef = useRef(null)
  const [file, setFile]         = useState(null)
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState('')
  const [dragOver, setDragOver] = useState(false)

  const isExcel = async (f) => {
    const name = (f.name || '').toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) return true
    try {
      const buf = new Uint8Array(await f.slice(0, 4).arrayBuffer())
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true
      if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true
    } catch { /* fall through */ }
    return false
  }

  const splitCsvRow = (line) => {
    const out = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else { inQ = !inQ }
      } else if (c === ',' && !inQ) { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out
  }

  const parseCsvText = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    lines.shift() // discard header row
    return lines.map((line) => splitCsvRow(line).map((c) => c.trim()))
  }

  const parseExcelBuffer = async (ab) => {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(ab, { type: 'array' })
    if (!wb.SheetNames?.length) return []
    const ws = wb.Sheets[wb.SheetNames[0]]
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
    if (!matrix.length) return []
    matrix.shift() // discard header row
    return matrix.map((cells) => cells.map((c) => (c == null ? '' : String(c).trim())))
  }

  const downloadTemplate = () => {
    const headers = ['SKU', 'Purchase Quantity', 'Unit Cost (Before Discount)', 'Discount Percent', 'Product Tax', 'Lot Number', 'MFG Date', 'EXP Date']
    const sample  = ['SKU-001', '10', '50.00', '0', '0', '', '', '']
    const csv = [headers.join(','), sample.join(',')].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'purchase-products-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async () => {
    if (!file) { setErr('Choose a file to import.'); return }
    setBusy(true); setErr('')
    try {
      let cells = []
      if (await isExcel(file)) cells = await parseExcelBuffer(await file.arrayBuffer())
      else                     cells = parseCsvText(await file.text())
      if (!cells.length) { setErr('No data rows found in the file.'); return }

      const list = await getProducts({ limit: 1000 }).catch(() => [])
      const arr  = Array.isArray(list) ? list : (list?.results ?? [])
      const bySku = new Map(arr.map((p) => [String(p.sku || '').trim().toLowerCase(), p]))

      const rows = []
      const errors = []
      cells.forEach((c, i) => {
        const sku = String(c[0] || '').trim()
        if (!sku) { errors.push(`Row ${i + 2}: SKU is required.`); return }
        const product = bySku.get(sku.toLowerCase())
        if (!product) { errors.push(`Row ${i + 2}: unknown SKU "${sku}".`); return }
        const qty = Number(c[1] || 0)
        if (!qty || qty <= 0) { errors.push(`Row ${i + 2}: quantity must be > 0.`); return }
        rows.push({
          product_id:       product.id,
          product_name:     product.name,
          sku:              product.sku || sku,
          quantity:         String(qty),
          unit_cost:        String(c[2] || product.cost_price || 0),
          discount_percent: String(c[3] || 0),
          tax_rate:         String(c[4] || product.tax_rate || 0),
          selling_price:    String(product.selling_price || 0),
          lot_number:       String(c[5] || ''),
          mfg_date:         String(c[6] || ''),
          exp_date:         String(c[7] || ''),
        })
      })

      if (!rows.length) {
        setErr(errors[0] || 'No valid rows to import.')
        return
      }
      if (errors.length) {
        window.alert(`${rows.length} row(s) imported. ${errors.length} skipped:\n\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\n…and ${errors.length - 10} more.` : ''}`)
      }
      onImported?.(rows)
    } catch (e) {
      setErr(e?.message || 'Failed to parse the file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Import Products" size="2xl">
      <div className="space-y-4 text-sm">
        {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{err}</div>}

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">File To Import:</label>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) { setFile(f); setErr('') }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed ${dragOver ? 'border-brand-500 bg-brand-50' : 'border-gray-300 bg-gray-50'} px-4 py-10 text-center text-gray-500`}
          >
            {file ? (
              <span className="text-gray-800 font-medium">{file.name}</span>
            ) : (
              <span>Drop files here to upload</span>
            )}
            <input
              ref={fileInputRef} type="file"
              accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); setErr('') }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={downloadTemplate}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-soft"
        >
          ⬇ Download template file
        </button>

        <div>
          <h4 className="font-semibold text-gray-800 mb-1">Instructions:</h4>
          <p className="text-xs text-gray-600 mb-1">Follow the instructions carefully before importing the file.</p>
          <p className="text-xs text-gray-600 mb-2">The columns of the file should be in the following order:</p>
          <table className="w-full text-xs border border-gray-200">
            <thead className="bg-gray-100 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Column Number</th>
                <th className="px-3 py-2 text-left font-semibold">Column Name</th>
                <th className="px-3 py-2 text-left font-semibold">Instruction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <ImportRow n={1} name="SKU" req />
              <ImportRow n={2} name="Purchase Quantity" req />
              <ImportRow n={3} name="Unit Cost (Before Discount)" />
              <ImportRow n={4} name="Discount Percent" />
              <ImportRow n={5} name="Product Tax" />
              <ImportRow n={6} name="Lot Number" hint={<>Only if Lot number is enabled. You can enable Lot number from <code className="text-rose-500">Business Settings &gt; Purchases &gt; Enable Lot number</code></>} />
              <ImportRow n={7} name="MFG Date" hint={<><span>Only if Product Expiry is enabled. You can enable Product expiry from </span><code className="text-rose-500">Business Settings &gt; Product &gt; Enable Product Expiry</code><div>Format: yyyy-mm-dd; Ex: 2021-11-25</div></>} />
              <ImportRow n={8} name="EXP Date" hint={<><span>Only if Product Expiry is enabled. You can enable Product expiry from </span><code className="text-rose-500">Business Settings &gt; Product &gt; Enable Product Expiry</code><div>Format: yyyy-mm-dd; Ex: 2021-11-25</div></>} />
            </tbody>
          </table>
        </div>
      </div>
      <ModalFooter>
        <Button type="button" onClick={handleImport} loading={busy} disabled={busy || !file}>Import</Button>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

function ImportRow({ n, name, req, hint }) {
  return (
    <tr>
      <td className="px-3 py-2 text-gray-700">{n}</td>
      <td className="px-3 py-2 text-gray-800 font-semibold">
        {name} <span className="text-xs font-normal text-gray-500">({req ? <span className="text-rose-500">Required</span> : 'Optional'})</span>
      </td>
      <td className="px-3 py-2 text-gray-600">{hint || '—'}</td>
    </tr>
  )
}
