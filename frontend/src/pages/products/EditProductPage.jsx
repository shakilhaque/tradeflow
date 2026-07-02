/**
 * EditProductPage — dedicated edit experience.
 *
 * Replaces the "reuse AddProductPage in edit mode" pattern so editing
 * gets a proper layout: header with product identity & live KPIs, a
 * sectioned details tab, and a Stock & Locations tab where the user can
 * see exactly what's on hand per branch and top it up inline. That last
 * tab is the answer to "I added quantity 500 but it shows Out of stock"
 * — you can confirm whether stock actually exists and add more if not.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import {
  getCategories, getBrands, getUnits, getLocations,
  getProduct, updateProduct, deleteProduct, uploadProductImage, stockIn,
} from '../../api/products'
import { getStockReport, getMovements } from '../../api/inventory'

const TAX_TYPES = [
  { value: 'inclusive', label: 'Inclusive' },
  { value: 'exclusive', label: 'Exclusive' },
]
const TAX_RATES = [
  { value: '0',   label: 'None — 0%' },
  { value: '5',   label: 'Tax — 5%' },
  { value: '7.5', label: 'Tax — 7.5%' },
  { value: '10',  label: 'Tax — 10%' },
  { value: '15',  label: 'Tax — 15%' },
]

const fmtMoney = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtQty = (n, unit) => {
  const v = Number(n || 0)
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ''}`
}

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm ' +
  'placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-400'

export default function EditProductPage() {
  const navigate  = useNavigate()
  const { id }    = useParams()

  // ── Loaded state ─────────────────────────────────────────────────────────
  const [product,    setProduct]    = useState(null)
  const [categories, setCategories] = useState([])
  const [brands,     setBrands]     = useState([])
  const [units,      setUnits]      = useState([])
  const [locations,  setLocations]  = useState([])
  const [stockRows,  setStockRows]  = useState([])     // per-location stock
  const [movements,  setMovements]  = useState([])

  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState('')
  const [info,    setInfo]    = useState('')
  const [saving,  setSaving]  = useState(false)
  const [uploading, setUploading] = useState(false)

  const [tab, setTab] = useState('details')   // details | stock | activity

  // ── Editable form fields (subset of Product) ─────────────────────────────
  const [form, setForm] = useState({
    name: '', sku: '', barcode: '', barcode_type: 'C128',
    unit_id: '', brand_id: '', category_id: '',
    product_type: 'single',
    not_for_selling: false, weight: '',
    description: '', image_url: '',
    tax_rate: '0', tax_type: 'exclusive',
    cost_price: '', selling_price: '',
    is_active: true,
    manage_stock: true,
    alert_qty: '',
    custom_field_1: '', custom_field_2: '',
    custom_field_3: '', custom_field_4: '',
  })

  // ── Add-stock inline form per location ───────────────────────────────────
  const [stockForm, setStockForm] = useState({ location_id: '', quantity: '', unit_cost: '' })
  const [stockBusy, setStockBusy] = useState(false)

  // ── Load all reference data + product ────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const [p, cats, brnds, unts, locs] = await Promise.all([
        getProduct(id),
        getCategories(), getBrands(), getUnits(), getLocations(true),
      ])
      const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
      setProduct(p)
      setCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
      setBrands(Array.isArray(brnds) ? brnds : (brnds?.results ?? []))
      setUnits(Array.isArray(unts) ? unts : (unts?.results ?? []))
      setLocations(locArr)

      // Seed the form from the product
      setForm({
        name: p.name || '',
        sku:  p.sku  || '',
        barcode: p.barcode || '',
        barcode_type: p.barcode_type || 'C128',
        unit_id:    p.unit_id    || p.unit?.id    || '',
        brand_id:   p.brand_id   || p.brand?.id   || '',
        category_id: p.category_id || p.category?.id || '',
        product_type: p.product_type || 'single',
        not_for_selling: !!p.not_for_selling,
        weight:     p.weight ?? '',
        description: p.notes ?? '',
        image_url:  p.image_url || '',
        tax_rate:   p.tax_rate != null ? String(p.tax_rate) : '0',
        tax_type:   p.tax_type || 'exclusive',
        cost_price: p.cost_price != null ? String(p.cost_price) : '',
        selling_price: p.selling_price != null ? String(p.selling_price) : '',
        is_active:  p.is_active !== false,
        manage_stock: (p.meta?.manage_stock ?? true) !== false,
        alert_qty:  p.meta?.alert_qty != null ? String(p.meta.alert_qty) : '',
        custom_field_1: p.meta?.custom_fields?.field_1 || '',
        custom_field_2: p.meta?.custom_fields?.field_2 || '',
        custom_field_3: p.meta?.custom_fields?.field_3 || '',
        custom_field_4: p.meta?.custom_fields?.field_4 || '',
      })
      setStockForm((s) => ({ ...s, location_id: locArr[0]?.id || '' }))
    } catch (e) {
      setErr(e?.message || 'Failed to load product.')
    } finally {
      setLoading(false)
    }
  }, [id])

  const loadStock = useCallback(async () => {
    try {
      const res = await getStockReport({ product_id: id, include_zero: 'true' })
      const arr = Array.isArray(res) ? res : (res?.results ?? res?.rows ?? [])
      setStockRows(arr)
    } catch {
      setStockRows([])
    }
  }, [id])

  const loadActivity = useCallback(async () => {
    try {
      const res = await getMovements({ product_id: id, limit: 50 })
      const arr = Array.isArray(res) ? res : (res?.results ?? [])
      setMovements(arr)
    } catch {
      setMovements([])
    }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'stock')    loadStock() },    [tab, loadStock])
  useEffect(() => { if (tab === 'activity') loadActivity() }, [tab, loadActivity])

  // Real-time view — refetch when the operator returns to this
  // tab/window (e.g. after recording a purchase elsewhere) plus a
  // 30-second poll, so the product details and per-location stock
  // shown here are never stale.
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return
      load()
      if (tab === 'stock') loadStock()
    }
    const id = setInterval(refresh, 30000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [load, loadStock, tab])

  // ── Save details ─────────────────────────────────────────────────────────
  const handleSave = async () => {
    setErr(''); setInfo('')
    if (!form.name.trim()) { setErr('Product name is required.'); return }
    if (!form.unit_id)     { setErr('Please choose a unit.'); return }

    const payload = {
      name: form.name.trim(),
      sku:  form.sku.trim() || undefined,
      barcode: form.barcode.trim() || undefined,
      barcode_type: form.barcode_type,
      unit_id:  form.unit_id,
      brand_id: form.brand_id || null,
      category_id: form.category_id || null,
      product_type: form.product_type,
      not_for_selling: form.not_for_selling,
      weight: form.weight ? Number(form.weight) : null,
      notes:  form.description,
      image_url: form.image_url,
      tax_rate: form.tax_rate ? Number(form.tax_rate) : 0,
      tax_type: form.tax_type,
      cost_price:    form.cost_price    ? Number(form.cost_price)    : 0,
      selling_price: form.selling_price ? Number(form.selling_price) : 0,
      is_active: !!form.is_active,
      meta: {
        ...(product?.meta || {}),
        manage_stock: form.manage_stock,
        alert_qty:    form.alert_qty ? Number(form.alert_qty) : null,
        custom_fields: {
          field_1: form.custom_field_1,
          field_2: form.custom_field_2,
          field_3: form.custom_field_3,
          field_4: form.custom_field_4,
        },
      },
    }

    setSaving(true)
    try {
      await updateProduct(id, payload)
      setInfo('Saved.')
      // refresh so total_stock / is_active KPIs reflect changes
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // ── Image upload ─────────────────────────────────────────────────────────
  const onUpload = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const res = await uploadProductImage(file)
      setForm((f) => ({ ...f, image_url: res?.url || res?.image_url || '' }))
      // Pop-up confirmation — same UX as Add Product so the upload
      // outcome can't be missed. Filename comes from the browser's
      // File object; no hardcoded copy.
      window.alert(`Image uploaded successfully${file.name ? `: ${file.name}` : ''}.`)
    } catch (e) {
      const msg = e?.message || 'Image upload failed.'
      setErr(msg)
      window.alert(`Image upload failed: ${msg}`)
    } finally {
      setUploading(false)
    }
  }

  // ── Add stock (inline) ───────────────────────────────────────────────────
  const onAddStock = async (e) => {
    e?.preventDefault?.()
    setErr(''); setInfo('')
    const qty  = Number(stockForm.quantity || 0)
    const cost = stockForm.unit_cost === '' || stockForm.unit_cost == null
      ? Number(form.cost_price || 0)
      : Number(stockForm.unit_cost)
    if (!stockForm.location_id) { setErr('Pick a location.'); return }
    if (!(qty > 0))             { setErr('Quantity must be greater than 0.'); return }
    setStockBusy(true)
    try {
      await stockIn({
        product_id:  id,
        location_id: stockForm.location_id,
        quantity:    qty,
        unit_cost:   cost,
        reference_type: 'manual',
      })
      setStockForm((s) => ({ ...s, quantity: '', unit_cost: '' }))
      setInfo(`Added ${qty} to stock.`)
      loadStock()
      load()        // refresh header total
    } catch (e2) {
      setErr(e2?.message || 'Failed to add stock.')
    } finally {
      setStockBusy(false)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────
  const onDelete = async () => {
    if (!window.confirm(`Delete "${product?.name}"? It will be hidden from active lists.`)) return
    try {
      await deleteProduct(id)
      navigate('/products')
    } catch (e) {
      setErr(e?.message || 'Failed to delete.')
    }
  }

  const stockTotals = useMemo(() => stockRows.reduce((acc, r) => {
    const q = Number(r.quantity ?? r.on_hand ?? r.current_stock ?? 0)
    const avg = Number(r.avg_unit_cost ?? r.avg_cost ?? r.unit_cost ?? 0)
    const v = Number(r.fifo_value ?? r.inventory_value ?? r.layer_value ?? (q * avg))
    return { qty: acc.qty + q, value: acc.value + v }
  }, { qty: 0, value: 0 }), [stockRows])

  const unitAbbr = product?.unit_abbr || ''

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    )
  }
  if (!product) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
        {err || 'Product not found.'}
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => navigate('/products')}>← Back to list</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-24">
      {/* ── Sticky save bar (bottom) ──────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white/90 px-6 py-3 shadow-lg backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Editing <span className="font-semibold text-slate-800">{product.name}</span>
            {' · '}SKU <span className="font-mono">{product.sku}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/products')}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Header banner ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-sky-500 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/20 ring-1 ring-white/30">
            {product.image_url
              ? <img src={product.image_url} alt={product.name} className="h-16 w-16 object-cover" />
              : <span className="text-xl font-semibold">{(product.name || '?').split(' ').slice(0,2).map((w) => w[0]).join('').toUpperCase()}</span>}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{product.name}</h1>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${product.is_active ? 'bg-emerald-400/20 text-emerald-50 ring-1 ring-emerald-200/40' : 'bg-rose-400/20 text-rose-50 ring-1 ring-rose-200/40'}`}>
                {product.is_active ? 'Active' : 'Inactive'}
              </span>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90 ring-1 ring-white/20">
                {product.product_type || 'single'}
              </span>
            </div>
            <p className="mt-1 text-xs text-indigo-100">
              SKU <span className="font-mono">{product.sku}</span>
              {product.barcode && <> · Barcode <span className="font-mono">{product.barcode}</span></>}
              {product.category_name && <> · {product.category_name}</>}
              {product.brand_name && <> · {product.brand_name}</>}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/products')}>← Back</Button>
            <button onClick={onDelete}
                    className="rounded-lg border border-rose-200/50 bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500/30">
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total stock"     value={fmtQty(product.total_stock, unitAbbr)} accent="indigo" />
        <Kpi label="Stock value"     value={fmtMoney(product.inventory_value)}    accent="sky" />
        <Kpi label="Avg. cost"       value={fmtMoney(product.avg_cost)}           accent="emerald" />
        <Kpi label="Selling price"   value={fmtMoney(product.selling_price)}      accent="amber" />
      </div>

      {info && <Banner kind="info">{info}</Banner>}
      {err  && <Banner kind="error">{err}</Banner>}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-200">
        <nav className="flex gap-6">
          {[
            { id: 'details',  label: 'Details' },
            { id: 'stock',    label: 'Stock & Locations' },
            { id: 'activity', label: 'Activity' },
          ].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
                    className={[
                      '-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                      tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700',
                    ].join(' ')}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── DETAILS tab ──────────────────────────────────────────────────── */}
      {tab === 'details' && (
        <div className="space-y-5">
          <Card>
            <SectionTitle>Basic information</SectionTitle>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Product Name *">
                <input className={inputCls} value={form.name} onChange={set(setForm, 'name')} />
              </Field>
              <Field label="SKU">
                <input className={inputCls} value={form.sku} onChange={set(setForm, 'sku')} />
              </Field>
              <Field label="Barcode">
                <input className={inputCls} value={form.barcode} onChange={set(setForm, 'barcode')} />
              </Field>

              <Field label="Unit *">
                <select className={inputCls} value={form.unit_id} onChange={set(setForm, 'unit_id')}>
                  <option value="">Select units</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}</option>)}
                </select>
              </Field>
              <Field label="Brand">
                <select className={inputCls} value={form.brand_id} onChange={set(setForm, 'brand_id')}>
                  <option value="">Select brand</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Category">
                <select className={inputCls} value={form.category_id} onChange={set(setForm, 'category_id')}>
                  <option value="">Select category</option>
                  {categories.filter((c) => !c.parent_id && !c.parent).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>

              <Field label="Weight">
                <input type="number" min="0" step="0.001" className={inputCls}
                       value={form.weight} onChange={set(setForm, 'weight')} />
              </Field>
              <Field label="Status">
                <select className={inputCls} value={form.is_active ? '1' : '0'}
                        onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === '1' }))}>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </select>
              </Field>
              <Field label="Not for selling">
                <select className={inputCls} value={form.not_for_selling ? '1' : '0'}
                        onChange={(e) => setForm((f) => ({ ...f, not_for_selling: e.target.value === '1' }))}>
                  <option value="0">No</option>
                  <option value="1">Yes</option>
                </select>
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>Pricing & tax</SectionTitle>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Cost price">
                <input type="number" min="0" step="0.0001" className={inputCls}
                       value={form.cost_price} onChange={set(setForm, 'cost_price')} />
              </Field>
              <Field label="Selling price">
                <input type="number" min="0" step="0.0001" className={inputCls}
                       value={form.selling_price} onChange={set(setForm, 'selling_price')} />
              </Field>
              <Field label="Tax rate">
                <select className={inputCls} value={form.tax_rate} onChange={set(setForm, 'tax_rate')}>
                  {TAX_RATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Tax type">
                <select className={inputCls} value={form.tax_type} onChange={set(setForm, 'tax_type')}>
                  {TAX_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>Stock management</SectionTitle>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Manage Stock?">
                <div className="flex items-center gap-3">
                  <button type="button"
                          onClick={() => setForm((f) => ({ ...f, manage_stock: !f.manage_stock }))}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${form.manage_stock ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${form.manage_stock ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                  <span className="text-sm text-slate-600">{form.manage_stock ? 'Track stock levels' : 'Service / non-stocked item'}</span>
                </div>
              </Field>
              <Field label="Alert quantity" hint="Low-stock alert when on-hand falls below this.">
                <input type="number" min="0" step="1" className={inputCls}
                       disabled={!form.manage_stock}
                       value={form.alert_qty} onChange={set(setForm, 'alert_qty')} />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>Image</SectionTitle>
            <div className="flex flex-wrap items-start gap-4">
              <div className="h-32 w-32 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                {form.image_url
                  ? <img src={form.image_url} alt="" className="h-32 w-32 object-cover" />
                  : <div className="flex h-32 w-32 items-center justify-center text-xs text-slate-400">No image</div>}
              </div>
              <div className="space-y-2">
                <input type="file" accept="image/*"
                       onChange={(e) => onUpload(e.target.files?.[0])}
                       className="text-xs text-slate-600" />
                {uploading && <p className="text-xs text-indigo-600">Uploading…</p>}
                {form.image_url && (
                  <button onClick={() => setForm((f) => ({ ...f, image_url: '' }))}
                          className="text-xs text-rose-600 hover:underline">
                    Remove image
                  </button>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Notes & custom fields</SectionTitle>
            <div className="space-y-4">
              <Field label="Description / notes">
                <textarea className={inputCls} rows={3}
                          value={form.description} onChange={set(setForm, 'description')} />
              </Field>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[1, 2, 3, 4].map((n) => (
                  <Field key={n} label={`Custom field ${n}`}>
                    <input className={inputCls}
                           value={form[`custom_field_${n}`]}
                           onChange={set(setForm, `custom_field_${n}`)} />
                  </Field>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── STOCK tab ────────────────────────────────────────────────────── */}
      {tab === 'stock' && (
        <div className="space-y-5">
          <Card>
            <SectionTitle>Add stock</SectionTitle>
            <p className="mb-3 text-xs text-slate-500">
              Creates a new FIFO layer at the cost you specify. Use this when
              receiving stock or to fix opening balances that didn&rsquo;t save.
            </p>
            <form onSubmit={onAddStock} className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="Location *">
                <select className={inputCls} value={stockForm.location_id}
                        onChange={(e) => setStockForm((s) => ({ ...s, location_id: e.target.value }))}>
                  <option value="">— Choose location —</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
              <Field label="Quantity *">
                <input type="number" min="0" step="0.0001" className={inputCls}
                       value={stockForm.quantity}
                       onChange={(e) => setStockForm((s) => ({ ...s, quantity: e.target.value }))} />
              </Field>
              <Field label="Unit cost" hint={`Defaults to cost price (${fmtMoney(form.cost_price)}).`}>
                <input type="number" min="0" step="0.0001" className={inputCls}
                       value={stockForm.unit_cost}
                       onChange={(e) => setStockForm((s) => ({ ...s, unit_cost: e.target.value }))}
                       placeholder={form.cost_price || '0'} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={stockBusy} size="sm">
                  {stockBusy ? 'Adding…' : '+ Add stock'}
                </Button>
              </div>
            </form>
          </Card>

          <Card padding="p-0">
            <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
              Stock by location
            </div>
            {locations.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs text-slate-500">
                No business locations configured yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      <th className="px-5 py-3">Location</th>
                      <th className="px-5 py-3 text-right">On hand</th>
                      <th className="px-5 py-3 text-right">Avg. cost</th>
                      <th className="px-5 py-3 text-right">Stock value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {locations.map((loc) => {
                      const row = stockRows.find((r) =>
                        (r.location_id || r.location?.id) === loc.id
                      ) || {}
                      const qty   = Number(row.quantity ?? row.on_hand ?? row.current_stock ?? 0)
                      const avg   = Number(row.avg_unit_cost ?? row.avg_cost ?? row.unit_cost ?? product.avg_cost ?? 0)
                      const value = qty * avg
                      return (
                        <tr key={loc.id} className="hover:bg-slate-50/60">
                          <td className="px-5 py-3 text-slate-700">{loc.name}</td>
                          <td className={`px-5 py-3 text-right tabular-nums ${qty <= 0 ? 'text-rose-600' : 'text-slate-800'}`}>
                            {qty > 0 ? fmtQty(qty, unitAbbr) : <span className="text-xs font-semibold uppercase">Out</span>}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-slate-600">{fmtMoney(avg)}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-slate-700">{fmtMoney(value)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 text-sm font-semibold text-slate-800">
                      <td className="px-5 py-3 text-right">Total</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmtQty(stockTotals.qty, unitAbbr)}</td>
                      <td className="px-5 py-3" />
                      <td className="px-5 py-3 text-right tabular-nums">{fmtMoney(stockTotals.value)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── ACTIVITY tab ─────────────────────────────────────────────────── */}
      {tab === 'activity' && (
        <Card padding="p-0">
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
            Recent stock movements
          </div>
          {movements.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-slate-500">No movements recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-5 py-3">When</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3 text-right">Quantity</th>
                    <th className="px-5 py-3 text-right">Unit cost</th>
                    <th className="px-5 py-3">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movements.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3 text-xs text-slate-500">{new Date(m.created_at).toLocaleString()}</td>
                      <td className="px-5 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${m.movement_type === 'IN' ? 'bg-emerald-100 text-emerald-700' : m.movement_type === 'OUT' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                          {m.movement_type}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-700">{m.location_name || '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmtQty(m.quantity, unitAbbr)}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-slate-600">{fmtMoney(m.unit_cost)}</td>
                      <td className="px-5 py-3 text-xs text-slate-500">{m.reference_type || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// ─── small helpers ───────────────────────────────────────────────────────
function set(setter, key) {
  return (e) => setter((f) => ({ ...f, [key]: e?.target ? e.target.value : e }))
}

function SectionTitle({ children }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
      <span className="inline-block h-3 w-1 rounded-full bg-indigo-600" />
      {children}
    </h3>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
    </label>
  )
}

function Banner({ kind, children }) {
  const cls = kind === 'error'
    ? 'border-rose-200 bg-rose-50 text-rose-700'
    : 'border-amber-200 bg-amber-50 text-amber-800'
  return <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>
}

function Kpi({ label, value, accent = 'indigo' }) {
  const COLORS = {
    indigo:  'from-indigo-50 to-indigo-100 ring-indigo-200 text-indigo-700',
    sky:     'from-sky-50 to-sky-100 ring-sky-200 text-sky-700',
    emerald: 'from-indigo-50 to-cyan-100 ring-emerald-200 text-emerald-700',
    amber:   'from-amber-50 to-amber-100 ring-amber-200 text-amber-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent]} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
    </div>
  )
}
