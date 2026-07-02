import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import {
  createPurchaseReturn, getSuppliers, getPurchases, getPurchase,
  getPurchaseReturn,
} from '../../api/purchases'
import { client, apiCall } from '../../api/client'

// Local helper — there's no dedicated updatePurchaseReturn yet; the
// backend's PurchaseReturnDetailView accepts PATCH on the standard
// detail URL. Keeping the helper inline avoids touching api/purchases.js
// for a single edit-flow caller.
const updatePurchaseReturn = (id, data) =>
  apiCall(() => client.patch(`/api/purchases/returns/${id}/`, data))
import { getProducts, getLocations } from '../../api/products'

const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = (n) => `৳ ${fmt(n)}`

const blankItem = () => ({
  product_id: '', product_name: '', sku: '',
  quantity: '1', unit_cost: '0',
})

export default function AddPurchaseReturnPage() {
  const navigate = useNavigate()
  // Deep-link entry points:
  //   ?purchase_id=<uuid>   → simplified "Add Return" against a parent
  //                            purchase (items pre-loaded from purchase).
  //   ?edit=<return_uuid>   → simplified "Edit Return" — items pre-
  //                            loaded from the return itself + reference
  //                            no + return_date, parent purchase still
  //                            displayed in the orange header. Save
  //                            PATCHes the existing return in place.
  const [searchParams] = useSearchParams()
  const parentPurchaseId = searchParams.get('purchase_id') || ''
  const editReturnId     = searchParams.get('edit') || ''
  const isEditing        = Boolean(editReturnId)
  const [parentPurchase, setParentPurchase] = useState(null)

  const [products,  setProducts]  = useState([])
  const [locations, setLocations] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [purchases, setPurchases] = useState([])

  const [header, setHeader] = useState({
    supplier_id:  '',
    location_id:  '',
    purchase_id:  '',
    reference_no: '',
    return_date:  new Date().toISOString().slice(0, 10),
    notes:        '',
  })
  const [taxRate, setTaxRate] = useState('0')
  const [items, setItems] = useState([])
  const [productQuery, setProductQuery] = useState('')
  const [attachment, setAttachment] = useState(null)

  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState('')

  useEffect(() => {
    (async () => {
      try {
        const [prods, locs, sups] = await Promise.all([
          getProducts({ is_active: 'true' }),
          getLocations(true),
          getSuppliers({ active_only: 'true' }),
        ])
        setProducts(Array.isArray(prods) ? prods : (prods?.results ?? []))
        const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
        setLocations(locArr)
        // Single-branch (free tier) → auto-select the only location.
        if (locArr.length === 1) {
          setForm((f) => ({ ...f, location_id: f.location_id || String(locArr[0].id) }))
        }
        setSuppliers(Array.isArray(sups) ? sups : (sups?.results ?? []))
      } catch { /* ignore */ }
    })()
  }, [])

  // Fetch this supplier's purchases for the parent dropdown
  useEffect(() => {
    if (!header.supplier_id) { setPurchases([]); return }
    (async () => {
      try {
        const res = await getPurchases({ supplier_id: header.supplier_id, limit: 100 })
        setPurchases(res?.results || [])
      } catch { setPurchases([]) }
    })()
  }, [header.supplier_id])

  // ── Edit-mode hydration ─────────────────────────────────────────
  // When ?edit=<return_uuid> is set, fetch the existing return AND
  // its parent purchase (when linked) to drive the simplified UI.
  // Items come from the return so the operator sees exactly the
  // products + quantities they previously saved; the orange "Parent
  // Purchase" header is shown when there's a linked purchase.
  useEffect(() => {
    if (!editReturnId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await getPurchaseReturn(editReturnId)
        if (cancelled || !r) return
        setHeader((h) => ({
          ...h,
          supplier_id:  r.supplier || '',
          location_id:  r.location || '',
          purchase_id:  r.purchase || '',
          reference_no: r.reference_no || '',
          return_date:  (r.return_date || '').slice(0, 10) || h.return_date,
          notes:        r.notes || '',
        }))
        // If linked to a parent purchase, fetch it so the header
        // card renders the same way as the deep-link from All
        // Purchases. Pull purchase_quantity from the parent so the
        // operator sees the original PO amounts; quantity_remaining
        // defaults to the parent qty when present, otherwise to
        // the return qty (zero-prior-returns assumption).
        let parent = null
        if (r.purchase) {
          parent = await getPurchase(r.purchase).catch(() => null)
          if (parent) setParentPurchase(parent)
        }
        const parentByProduct = new Map(
          (parent?.items || []).map((it) => [String(it.product), it])
        )
        const returnLines = Array.isArray(r.items) ? r.items : []
        setItems(returnLines.map((it) => {
          const parentLine = parentByProduct.get(String(it.product))
          const purchaseQty = parentLine ? Number(parentLine.quantity || 0) : Number(it.quantity || 0)
          return {
            product_id:        it.product || '',
            product_name:      it.product_name || '',
            sku:               it.sku || '',
            purchase_quantity: purchaseQty.toFixed(2),
            quantity_remaining: purchaseQty.toFixed(2),
            quantity:          String(Number(it.quantity || 0).toFixed(2)),
            unit_cost:         String(Number(it.unit_cost || 0).toFixed(2)),
          }
        }))
      } catch (e) {
        setError(e?.message || 'Failed to load purchase return.')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editReturnId])

  // ── Parent-purchase deep-link hydration ─────────────────────────
  // When ?purchase_id=<uuid> is set, fetch the parent purchase and
  // pre-fill the form. Items come from the purchase line list —
  // each row exposes Return Quantity input + computed Return
  // Subtotal. Everything is driven by per-tenant DB data; no
  // hardcoded values.
  useEffect(() => {
    if (!parentPurchaseId || isEditing) return
    let cancelled = false
    ;(async () => {
      try {
        const p = await getPurchase(parentPurchaseId)
        if (cancelled || !p) return
        setParentPurchase(p)
        setHeader((h) => ({
          ...h,
          supplier_id:  p.supplier || '',
          location_id:  p.location || '',
          purchase_id:  p.id,
          return_date:  new Date().toISOString().slice(0, 10),
        }))
        const lines = Array.isArray(p.items) ? p.items : []
        setItems(lines.map((it) => ({
          product_id:        it.product || '',
          product_name:      it.product_name || '',
          sku:               it.sku || '',
          // Original purchase line — used by the simplified table
          // to display Unit Price + Purchase Quantity + Quantity
          // Remaining, while the operator types Return Quantity.
          purchase_quantity: String(Number(it.quantity || 0).toFixed(2)),
          // Quantity Remaining = purchase qty − already-returned
          // qty. The backend doesn't ship a per-line returned
          // count yet so we default to the original quantity;
          // the backend's createPurchaseReturn validates anyway.
          quantity_remaining: String(Number(it.quantity || 0).toFixed(2)),
          quantity:          '0',   // Return Quantity (operator input)
          unit_cost:         String(Number(it.unit_cost || 0).toFixed(2)),
        })))
      } catch (e) {
        setError(e?.message || 'Failed to load parent purchase.')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentPurchaseId])

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

  const addProduct = (p) => {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.product_id === p.id)
      if (idx >= 0) {
        return prev.map((it, i) => i === idx ? { ...it, quantity: String(Number(it.quantity || 0) + 1) } : it)
      }
      return [...prev, {
        product_id: p.id,
        product_name: p.name,
        sku: p.sku || '',
        quantity: '1',
        unit_cost: p.cost_price ? String(p.cost_price) : '0',
      }]
    })
    setProductQuery('')
  }

  const updateItem = (idx, patch) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))

  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx))

  const totals = useMemo(() => {
    let subtotal = 0
    items.forEach((it) => { subtotal += Number(it.quantity || 0) * Number(it.unit_cost || 0) })
    const tax = subtotal * (Number(taxRate || 0) / 100)
    return { subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: (subtotal + tax).toFixed(2) }
  }, [items, taxRate])

  const validate = () => {
    if (!header.supplier_id) return 'Select a supplier.'
    if (!header.location_id) return 'Select a business location.'
    // Parent-purchase mode pre-fills every line at quantity=0 — only
    // the rows the operator actually touches get returned, so the
    // "at least one item" rule applies AFTER zero-qty rows are
    // dropped. Standalone mode keeps the original check (any row
    // with qty ≤ 0 is a typo).
    const nonZero = items.filter((it) => Number(it.quantity || 0) > 0)
    if (parentPurchase) {
      if (nonZero.length === 0) return 'Enter a Return Quantity on at least one row.'
      for (const it of nonZero) {
        const remaining = Number(it.quantity_remaining || 0)
        if (remaining > 0 && Number(it.quantity) > remaining) {
          return `Cannot return more than ${remaining} of "${it.product_name}".`
        }
      }
      return ''
    }
    if (items.length === 0)  return 'Add at least one product to return.'
    for (const [i, it] of items.entries()) {
      if (Number(it.quantity) <= 0) return `Row ${i + 1}: quantity must be > 0.`
      if (Number(it.unit_cost) < 0)  return `Row ${i + 1}: unit cost must be ≥ 0.`
    }
    return ''
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setError('')
    const err = validate()
    if (err) { setError(err); return }

    setSubmitting(true)
    try {
      const submitItems = items
        .filter((it) => Number(it.quantity || 0) > 0)
        .map((it) => ({
          product_id:   it.product_id,
          quantity:     Number(it.quantity),
          unit_cost:    Number(it.unit_cost),
          product_name: it.product_name,
          sku:          it.sku,
        }))
      const body = {
        reference_no:  header.reference_no || undefined,
        purchase_id:   header.purchase_id || undefined,
        supplier_id:   header.supplier_id,
        location_id:   header.location_id,
        return_date:   header.return_date,
        notes:         header.notes,
        items:         submitItems,
      }
      if (isEditing) {
        await updatePurchaseReturn(editReturnId, body)
      } else {
        await createPurchaseReturn(body)
      }
      navigate('/purchases/returns')
    } catch (ex) {
      setError(ex?.message || (isEditing ? 'Failed to update purchase return.' : 'Failed to create purchase return.'))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Simplified renderer (Parent Purchase Return) — used for the
  // Add-against-parent deep-link AND the Edit Return action. When
  // editing without a linked parent, we still show the simplified
  // UI but synthesise a parent stub from the supplier/location so
  // the orange header card stays meaningful.
  if (parentPurchase || isEditing) {
    const parentForUI = parentPurchase || {
      reference_no:  '—',
      purchase_date: header.return_date,
      supplier_name: suppliers.find((s) => s.id === header.supplier_id)?.name || '',
      location_name: locations.find((l) => l.id === header.location_id)?.name || '',
    }
    return (
      <ParentPurchaseReturn
        editing={isEditing}
        parent={parentForUI}
        items={items}
        setItems={setItems}
        referenceNo={header.reference_no}
        setReferenceNo={(v) => setHeader({ ...header, reference_no: v })}
        taxRate={taxRate}
        setTaxRate={setTaxRate}
        submitting={submitting}
        error={error}
        onCancel={() => navigate('/purchases/returns')}
        onSubmit={onSubmit}
      />
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-24">
      <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Add Purchase Return</h1>
          <p className="mt-0.5 text-sm text-emerald-50">Record goods returned to a supplier and adjust stock.</p>
        </div>
        <Button variant="secondary" type="button" onClick={() => navigate('/purchases/returns')}>← Back</Button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Header */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <span className="w-1.5 h-5 rounded-full bg-rose-100 text-rose-700" />
          <h2 className="text-sm font-semibold text-gray-900">Return Information</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Select label="Supplier *" value={header.supplier_id}
            onChange={(e) => setHeader({ ...header, supplier_id: e.target.value, purchase_id: '' })}>
            <option value="">Please Select</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>

          <Select label="Business Location *" value={header.location_id}
            onChange={(e) => setHeader({ ...header, location_id: e.target.value })}>
            <option value="">Please Select</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>

          <Input label="Reference No" placeholder="Auto-generate if empty"
            value={header.reference_no}
            onChange={(e) => setHeader({ ...header, reference_no: e.target.value })} />

          <Input label="Return Date *" type="date"
            value={header.return_date}
            onChange={(e) => setHeader({ ...header, return_date: e.target.value })} />

          <Select label="Parent Purchase (optional)" value={header.purchase_id}
            onChange={(e) => setHeader({ ...header, purchase_id: e.target.value })}
            disabled={!header.supplier_id}>
            <option value="">{header.supplier_id ? 'None' : 'Select supplier first'}</option>
            {purchases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.reference_no} — {fmtMoney(p.grand_total)}
              </option>
            ))}
          </Select>

          {/* Attachment */}
          <div className="lg:col-span-3">
            <label className="text-xs font-medium text-gray-700">Attach Document</label>
            <div className="mt-1 flex items-center gap-3">
              <label className="cursor-pointer rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 px-3 py-2 text-sm font-medium border border-rose-200">
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

      {/* Products */}
      <Card padding="p-0">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-5 rounded-full bg-emerald-100 text-emerald-700" />
            <h2 className="text-sm font-semibold text-gray-900">Search Products</h2>
          </div>
          <span className="text-xs text-gray-500">{items.length} item{items.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="px-5 py-4 relative">
          <input
            type="text"
            placeholder="Search products by name, SKU, or barcode..."
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <svg className="absolute left-8 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
          </svg>
          {filteredProducts.length > 0 && (
            <div className="absolute left-5 right-5 mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {filteredProducts.map((p) => (
                <button
                  key={p.id} type="button" onClick={() => addProduct(p)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-brand-50 text-left"
                >
                  <span className="text-gray-900 font-medium">{p.name}</span>
                  <span className="text-xs text-gray-400 font-mono">{p.sku}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gradient-to-r from-rose-50 to-rose-100/60 text-left text-xs font-semibold text-rose-800 uppercase tracking-wide">
                <th className="px-4 py-3 w-10">#</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 w-28">Quantity</th>
                <th className="px-4 py-3 w-32">Unit Price</th>
                <th className="px-4 py-3 w-32 text-right">Subtotal</th>
                <th className="px-4 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">
                    Use the search above to add products to return.
                  </td>
                </tr>
              ) : items.map((it, idx) => {
                const sub = Number(it.quantity || 0) * Number(it.unit_cost || 0)
                return (
                  <tr key={idx}>
                    <td className="px-4 py-2 text-gray-400 text-xs">{idx + 1}</td>
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900">{it.product_name}</div>
                      {it.sku && <div className="text-xs text-gray-400 font-mono">{it.sku}</div>}
                    </td>
                    <td className="px-4 py-2">
                      <input type="number" min="0" step="any" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
                    </td>
                    <td className="px-4 py-2">
                      <input type="number" min="0" step="0.0001" value={it.unit_cost}
                        onChange={(e) => updateItem(idx, { unit_cost: e.target.value })}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200" />
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-gray-900 whitespace-nowrap">
                      {fmtMoney(sub)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <button type="button" onClick={() => removeItem(idx)}
                        className="text-rose-500 hover:text-rose-700" title="Remove">✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Tax + total footer */}
        <div className="px-5 py-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Select label="Purchase Tax" value={taxRate} onChange={(e) => setTaxRate(e.target.value)}>
              <option value="0">None</option>
              <option value="5">5%</option>
              <option value="7.5">7.5%</option>
              <option value="10">10%</option>
              <option value="15">15%</option>
            </Select>
          </div>
          <div className="flex flex-col items-end gap-1 text-sm">
            <Row label="Subtotal" value={fmtMoney(totals.subtotal)} />
            <Row label="Tax"      value={`+ ${fmtMoney(totals.tax)}`} accent="text-emerald-600" />
            <div className="h-px w-48 bg-gray-200 my-1" />
            <Row label="Total Amount" value={fmtMoney(totals.total)} bold accent="text-brand-700" />
          </div>
        </div>
      </Card>

      {/* Notes */}
      <Card>
        <label className="text-xs font-medium text-gray-700">Notes</label>
        <textarea rows={3}
          value={header.notes}
          onChange={(e) => setHeader({ ...header, notes: e.target.value })}
          className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
          placeholder="Reason for return, condition of goods, etc." />
      </Card>

      {/* Sticky bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-[var(--sidebar-w,256px)] z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <div className="px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 justify-between">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <SummaryItem label="Items"     value={items.length} />
            <SummaryItem label="Subtotal"  value={fmtMoney(totals.subtotal)} />
            <SummaryItem label="Tax"       value={`+ ${fmtMoney(totals.tax)}`} accent="text-emerald-600" />
            <SummaryItem label="Total"     value={fmtMoney(totals.total)} accent="text-brand-700 font-bold" />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate('/purchases/returns')}>Cancel</Button>
            <Button type="submit" loading={submitting}>Submit Return</Button>
          </div>
        </div>
      </div>
    </form>
  )
}

function Row({ label, value, bold = false, accent = 'text-gray-900' }) {
  return (
    <div className="flex items-center justify-between gap-6 w-48">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className={`${bold ? 'font-semibold text-base' : ''} ${accent}`}>{value}</span>
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

// ─────────────────────────────────────────────────────────────────────────
// ParentPurchaseReturn — simplified Purchase Return UI rendered when
// the operator deep-linked from All Purchases → Action ▾ → Purchase
// Return. Matches the user's reference image:
//   • Orange "Parent Purchase" banner card with Ref No / Date /
//     Supplier / Business Location pulled from the per-tenant DB.
//   • Reference No input for the return.
//   • Emerald-headed table with one row per purchase line; the
//     operator only types Return Quantity, the Return Subtotal
//     auto-computes from Unit Price × Return Quantity.
//   • Total Return Tax + Return Total footer.
//   • Save button submits the standard createPurchaseReturn body.
// ─────────────────────────────────────────────────────────────────────────
function ParentPurchaseReturn({
  editing = false,
  parent, items, setItems, referenceNo, setReferenceNo,
  taxRate, setTaxRate, submitting, error, onCancel, onSubmit,
}) {
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '—'
  const updateQty = (idx, v) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, quantity: v } : it)))

  const subtotal = items.reduce((s, it) => s + (Number(it.quantity || 0) * Number(it.unit_cost || 0)), 0)
  const tax      = subtotal * (Number(taxRate || 0) / 100)
  const total    = subtotal + tax

  return (
    <form onSubmit={onSubmit} className="space-y-4 pb-10">
      <h1 className="text-xl font-semibold text-gray-900">{editing ? 'Edit Purchase Return' : 'Purchase Return'}</h1>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Parent Purchase banner card */}
      <Card padding="p-0">
        <div className="bg-orange-500 text-white text-center py-2.5 font-semibold text-sm">
          Parent Purchase
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 px-5 py-4 text-sm">
          <div>
            <div className="text-xs text-gray-500 mb-0.5">Reference No:</div>
            <div className="font-medium text-gray-800">{parent.reference_no}</div>
            <div className="text-xs text-gray-500 mt-1">Date: {fmtDate(parent.purchase_date)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">Supplier:</div>
            <div className="font-medium text-gray-800">{parent.supplier_name || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">Business Location:</div>
            <div className="font-medium text-gray-800">{parent.location_name || '—'}</div>
          </div>
        </div>
      </Card>

      {/* Reference No */}
      <Card>
        <label className="text-xs font-medium text-gray-700">Reference No:</label>
        <input
          type="text"
          value={referenceNo}
          onChange={(e) => setReferenceNo(e.target.value)}
          placeholder="Auto-generate if empty"
          className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </Card>

      {/* Items table */}
      <Card padding="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-emerald-500/95 text-left text-[11px] font-semibold text-white uppercase tracking-wider">
                <th className="px-4 py-3 w-10">#</th>
                <th className="px-4 py-3">Product Name</th>
                <th className="px-4 py-3 w-32 text-right">Unit Price</th>
                <th className="px-4 py-3 w-36 text-right">Purchase Quantity</th>
                <th className="px-4 py-3 w-36 text-right">Quantity Remaining</th>
                <th className="px-4 py-3 w-32 text-right">Return Quantity</th>
                <th className="px-4 py-3 w-32 text-right">Return Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No line items on the parent purchase.</td></tr>
              ) : items.map((it, idx) => {
                const sub = Number(it.quantity || 0) * Number(it.unit_cost || 0)
                return (
                  <tr key={idx}>
                    <td className="px-4 py-3 text-gray-500">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{it.product_name || '—'}</div>
                      {it.sku && <div className="text-[11px] font-mono text-gray-400">{it.sku}</div>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(it.unit_cost)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(it.purchase_quantity).toFixed(2)} Pc(s)
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(it.quantity_remaining).toFixed(2)} Pc(s)
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number" min="0" step="0.01"
                        value={it.quantity}
                        onChange={(e) => updateQty(idx, e.target.value)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-right tabular-nums text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900 tabular-nums">
                      {fmtMoney(sub)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {/* Footer — tax left, return total right */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 text-sm">
          <div className="flex items-center gap-2 text-gray-700">
            <span className="font-medium">Total Return Tax:</span>
            <span className="tabular-nums">{fmtMoney(tax)}</span>
            <Select value={taxRate} onChange={(e) => setTaxRate(e.target.value)}>
              <option value="0">None — 0%</option>
              <option value="5">Tax — 5%</option>
              <option value="7.5">Tax — 7.5%</option>
              <option value="10">Tax — 10%</option>
              <option value="15">Tax — 15%</option>
            </Select>
          </div>
          <div className="text-gray-800 font-semibold">
            Return Total: <span className="tabular-nums">{fmtMoney(total)}</span>
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={submitting}>{editing ? 'Update' : 'Save'}</Button>
      </div>
    </form>
  )
}
