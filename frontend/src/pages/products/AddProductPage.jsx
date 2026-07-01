import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import {
  getCategories, getBrands, getUnits, getLocations, getWarranties,
  createProduct, getProduct, getProducts, updateProduct, uploadProductImage,
  stockIn,
} from '../../api/products'
import { useSettings } from '../../context/SettingsContext'
import useUnsavedChangesPrompt from '../../hooks/useUnsavedChangesPrompt'

const TAX_TYPES = [
  { value: 'inclusive', label: 'Inclusive' },
  { value: 'exclusive', label: 'Exclusive' },
]

const BARCODE_TYPES = [
  { value: 'C128', label: 'Code 128 (C128)' },
  { value: 'C39',  label: 'Code 39 (C39)' },
  { value: 'EAN13',label: 'EAN-13' },
  { value: 'EAN8', label: 'EAN-8' },
  { value: 'UPCA', label: 'UPC-A' },
  { value: 'UPCE', label: 'UPC-E' },
]

// Generic "Tax — N%" rather than "VAT — N%" — Iffaa is sold to
// businesses across multiple jurisdictions, not just BD VAT-only
// shops. The rate values themselves stay the same (0 / 5 / 7.5 /
// 10 / 15) since those are the BD-Iffaa-tenant defaults; tenants
// who need a custom rate can type a non-standard number into the
// existing Custom field on the form, which still posts to
// product.tax_rate.
const TAX_RATES = [
  { value: '0',   label: 'None — 0%' },
  { value: '5',   label: 'Tax — 5%' },
  { value: '7.5', label: 'Tax — 7.5%' },
  { value: '10',  label: 'Tax — 10%' },
  { value: '15',  label: 'Tax — 15%' },
]

const blankForm = {
  name: '',
  sku: '',
  generate_barcode: false,
  barcode: '',
  barcode_type: 'C128',
  unit_id: '',
  brand_id: '',
  category_id: '',
  sub_category_id: '',
  warranty_id: '',
  product_type: 'single',
  manage_stock: true,
  alert_qty: '',
  not_for_selling: false,
  weight: '',
  description: '',
  image_url: '',
  brochure_url: '',
  custom_field_1: '',
  custom_field_2: '',
  custom_field_3: '',
  custom_field_4: '',
  tax_rate: '0',
  tax_type: 'exclusive',
  cost_price: '',
  cost_price_inc: '',
  margin_pct: '40',
  selling_price: '',
  business_locations: [],   // [location_id, ...]
  // ── Variable-product variations ─────────────────────────────────────────
  // When product_type === 'variable', the simple single-row pricing fields
  // above are hidden and these variation rows are surfaced instead.
  variation_type: '',
  variations: [],   // [{ sku, value, exc_tax, inc_tax, margin, selling, image_url }]
  // ── Combo-product components ────────────────────────────────────────────
  // When product_type === 'combo', the simple single-row pricing fields are
  // hidden and these component rows + a combo margin/selling are surfaced.
  combo_items: [],  // [{ component_id, component_name, component_sku, cost_price, quantity }]
  combo_margin_pct: '40',
  combo_selling:    '',
  // ── Quick opening quantity (Basic info shortcut) ────────────────────────
  // Single number that seeds the first business location with this many
  // units when the product is created. The detailed Opening Stock card
  // below still wins if the user fills in per-location rows.
  opening_quantity: '',
  // ── Opening stock (only used when creating a new managed-stock product)
  // ───────────────────────────────────────────────────────────────────────
  // One row per location the user wants to seed quantity into. Rows with
  // qty 0 are skipped on save. unit_cost falls back to the product's cost
  // price when blank so a single FIFO layer is always created at the right
  // cost basis.
  opening_stocks: [],   // [{ location_id, quantity, unit_cost }]
}

// Common variation-type presets — the dropdown also accepts a free-text
// 'Custom…' so each tenant can name their own scheme.
const VARIATION_TYPE_OPTIONS = [
  { value: '',         label: 'Please select' },
  { value: 'Color',    label: 'Color' },
  { value: 'Size',     label: 'Size' },
  { value: 'Material', label: 'Material' },
  { value: 'Style',    label: 'Style' },
  { value: 'Flavor',   label: 'Flavor' },
  { value: 'Custom',   label: 'Custom…' },
]

const PRODUCT_TYPE_OPTIONS = [
  { value: 'single',   label: 'Single' },
  { value: 'variable', label: 'Variable' },
  { value: 'combo',    label: 'Combo' },
]

const emptyVariation = () => ({
  sku:        '',
  value:      '',
  exc_tax:    '',
  inc_tax:    '',
  margin:     '40',
  selling:    '',
  image_url:  '',
})

const emptyComboItem = (product) => ({
  component_id:   product?.id   || '',
  component_name: product?.name || '',
  component_sku:  product?.sku  || '',
  cost_price:     product != null
    ? String(product.cost_price ?? product.purchase_price ?? 0)
    : '0',
  quantity: '1',
})

export default function AddProductPage() {
  const navigate = useNavigate()
  const { id }   = useParams()
  const editing  = Boolean(id)
  const settings = useSettings()

  const [form, setForm]       = useState(blankForm)
  const [categories, setCategories] = useState([])
  const [brands, setBrands]   = useState([])
  const [units, setUnits]     = useState([])
  const [warranties, setWarranties] = useState([])
  const [locations, setLocations] = useState([])
  // Combo component search state — local to this page, debounced live search.
  const [comboSearch,       setComboSearch]       = useState('')
  const [comboSearchResults, setComboSearchResults] = useState([])
  const [comboSearchLoading, setComboSearchLoading] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')
  const [info, setInfo]       = useState('')

  // Warn before tab close / nav while editing a product. Compares
  // form against blankForm — any non-default field flips it on.
  useUnsavedChangesPrompt(
    !saving && Object.keys(blankForm).some((k) => {
      const v = form[k]; const d = blankForm[k]
      if (Array.isArray(v)) return v.length > 0
      if (v && typeof v === 'object') return JSON.stringify(v) !== JSON.stringify(d)
      return v !== d && v !== '' && v != null
    }),
  )
  const [uploading, setUploading] = useState(false)
  // Browser-supplied metadata for the most-recent picked file:
  //   { name: "iffaa.jpeg", sizeKB: "97.61" }
  // Lives next to image_url so the preview card can show "name (XX KB)"
  // without faking either value. Cleared on Remove.
  const [imageMeta, setImageMeta] = useState(null)
  const fileInputRef = useRef(null)

  // ── Master data ──────────────────────────────────────────────────────────────
  const loadMaster = useCallback(async () => {
    try {
      const [cats, brnds, unts, locs, warrs] = await Promise.all([
        getCategories(), getBrands(), getUnits(), getLocations(true),
        getWarranties().catch(() => []),
      ])
      setCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
      setBrands(Array.isArray(brnds) ? brnds : (brnds?.results ?? []))
      setUnits(Array.isArray(unts) ? unts : (unts?.results ?? []))
      setWarranties(Array.isArray(warrs) ? warrs : (warrs?.results ?? []))
      const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
      setLocations(locArr)
      // Single-branch (free tier) → make the product available at the only
      // branch by default so Business Location is pre-selected.
      if (locArr.length === 1) {
        setForm((f) => (f.business_locations?.length
          ? f
          : { ...f, business_locations: [String(locArr[0].id)] }))
      }
    } catch (e) {
      setInfo('Backend offline — showing demo dropdowns. Form will still save when API is reachable.')
      setCategories([
        { id: 'demo-cat-1', name: 'Stationery' },
        { id: 'demo-cat-2', name: 'Tape & Adhesives' },
        { id: 'demo-cat-3', name: 'Files & Folders' },
      ])
      setBrands([
        { id: 'demo-brand-1', name: 'Generic' },
        { id: 'demo-brand-2', name: 'House Brand' },
        { id: 'demo-brand-3', name: 'OEM' },
      ])
      setUnits([
        { id: 'demo-unit-1', name: 'Pieces',  abbreviation: 'Pc(s)' },
        { id: 'demo-unit-2', name: 'Kilogram',abbreviation: 'kg'    },
        { id: 'demo-unit-3', name: 'Box',     abbreviation: 'box'   },
      ])
      setLocations([
        { id: 'demo-loc-1', name: 'Main Branch'  },
        { id: 'demo-loc-2', name: 'Mirpur Outlet'},
      ])
    }
  }, [])

  useEffect(() => { loadMaster() }, [loadMaster])

  // ── Pre-fill from Settings → Product when creating a new product ─────
  useEffect(() => {
    if (editing) return
    const defaultUnit = settings.str('product.default_unit', '')
    const defaultTax  = String(settings.num('tax.default_rate', 0))
    setForm((f) => ({
      ...f,
      unit_id:   f.unit_id   || defaultUnit,
      // Only seed tax if the user hasn't already touched the picker.
      tax_rate:  (f.tax_rate === '0' || !f.tax_rate) ? defaultTax : f.tax_rate,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, editing])

  // ── Combo component search (debounced 250ms) ────────────────────────────────
  // Only runs when the user is on the Combo product type so we don't waste
  // API calls in the common case.
  useEffect(() => {
    if (form.product_type !== 'combo') return
    const q = comboSearch.trim()
    if (q.length < 2) { setComboSearchResults([]); return }
    const t = setTimeout(async () => {
      setComboSearchLoading(true)
      try {
        const res = await getProducts({ search: q, limit: 15 })
        const list = Array.isArray(res) ? res : (res?.results ?? [])
        setComboSearchResults(list.filter((p) => p.id !== id))   // never self-reference
      } catch {
        setComboSearchResults([])
      } finally {
        setComboSearchLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [comboSearch, form.product_type, id])

  // ── Edit mode: hydrate ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!editing) return
    let cancelled = false
    ;(async () => {
      try {
        const p = await getProduct(id)
        if (cancelled || !p) return
        setForm((f) => ({
          ...f,
          name: p.name || '',
          sku:  p.sku  || '',
          barcode: p.barcode || '',
          barcode_type: p.barcode_type || 'C128',
          unit_id:    p.unit_id    || p.unit?.id    || '',
          brand_id:   p.brand_id   || p.brand?.id   || '',
          category_id: p.category_id || p.category?.id || '',
          warranty_id: p.warranty || p.warranty_id || '',
          product_type: p.product_type || 'single',
          not_for_selling: !!p.not_for_selling,
          weight:     p.weight ?? '',
          description: p.notes ?? '',
          image_url:  p.image_url || '',
          tax_rate:   p.tax_rate != null ? String(p.tax_rate) : '0',
          tax_type:   p.tax_type || 'exclusive',
          cost_price: p.cost_price != null ? String(p.cost_price) : '',
          selling_price: p.selling_price != null ? String(p.selling_price) : '',
          // Alert quantity from the real column, falling back to the legacy
          // meta.alert_qty so older products still show their value on edit.
          alert_qty: (p.reorder_level != null && Number(p.reorder_level) > 0)
            ? String(p.reorder_level)
            : (p.meta?.alert_qty != null ? String(p.meta.alert_qty) : ''),
          // Rehydrate variations from the new relational table. The Inc-tax
          // column is recomputed from Exc + tax_rate so we don't have to
          // round-trip it.
          variation_type: p.variation_type || (p.meta && p.meta.variation_type) || '',
          variations: Array.isArray(p.variations) && p.variations.length
            ? p.variations.map((v) => {
                const exc  = v.cost_price    != null ? String(v.cost_price)    : ''
                const sell = v.selling_price != null ? String(v.selling_price) : ''
                const rate = Number(p.tax_rate || 0)
                const inc  = exc === '' ? '' : (Number(exc) * (1 + rate / 100)).toFixed(2)
                const c = Number(exc), s = Number(sell)
                const margin = (Number.isFinite(c) && c > 0 && Number.isFinite(s))
                  ? (((s / c) - 1) * 100).toFixed(2) : '40'
                return {
                  sku:       v.sku   || '',
                  value:     v.value || '',
                  exc_tax:   exc,
                  inc_tax:   inc === '' ? '' : String(inc),
                  margin,
                  selling:   sell,
                  image_url: v.image_url || '',
                }
              })
            : [],
          combo_items: Array.isArray(p.combo_items)
            ? p.combo_items.map((c) => ({
                component_id:   c.component_id,
                component_name: c.component_name,
                component_sku:  c.component_sku,
                cost_price:     c.component_cost != null ? String(c.component_cost) : '0',
                // Coerce to an integer string — combo component quantities
                // are whole units, never fractions. Legacy rows that may have
                // been saved with a decimal portion get floored on load.
                quantity:       String(Math.max(1, Math.floor(Number(c.quantity) || 1))),
              }))
            : [],
          combo_margin_pct: '40',
          combo_selling:    p.product_type === 'combo' && p.selling_price != null
            ? String(p.selling_price) : '',
        }))
      } catch (e) {
        setErr('Failed to load product for editing.')
      }
    })()
    return () => { cancelled = true }
  }, [editing, id])

  // Tax rate as a number — used by every pricing helper below. Declared
  // up front so the variation-row helpers (which also need it) can rely on it.
  const taxRateNum = Number(form.tax_rate || 0)

  // ── Auto-derive selling price from cost + margin% ───────────────────────────
  // Formula:  selling = cost × (1 + margin/100)
  // Reverse:  margin  = (selling / cost − 1) × 100
  const recalcSelling = (cost, margin) => {
    const c = Number(cost), m = Number(margin)
    if (!Number.isFinite(c) || c <= 0) return ''
    if (!Number.isFinite(m)) return ''
    return (c + (c * m) / 100).toFixed(2)
  }
  const recalcMargin = (cost, selling) => {
    const c = Number(cost), s = Number(selling)
    if (!Number.isFinite(c) || c <= 0) return ''
    if (!Number.isFinite(s)) return ''
    return (((s / c) - 1) * 100).toFixed(2)
  }

  const onCostChange = (v) => {
    setForm((f) => ({
      ...f,
      cost_price: v,
      selling_price: f.margin_pct ? recalcSelling(v, f.margin_pct) : f.selling_price,
    }))
  }

  const onMarginChange = (v) => {
    setForm((f) => ({
      ...f,
      margin_pct: v,
      selling_price: f.cost_price ? recalcSelling(f.cost_price, v) : f.selling_price,
    }))
  }

  // When the user types into Selling Price directly, back-fill the Margin %
  // so all three fields stay in sync (cost → margin → selling).
  const onSellingChange = (v) => {
    setForm((f) => ({
      ...f,
      selling_price: v,
      margin_pct: f.cost_price ? recalcMargin(f.cost_price, v) : f.margin_pct,
    }))
  }

  // ── Variable-product variation row handlers ────────────────────────────────
  const updateVariation = (idx, patch) => {
    setForm((f) => ({
      ...f,
      variations: f.variations.map((row, i) => i === idx ? { ...row, ...patch } : row),
    }))
  }

  const addVariationRow = () => {
    setForm((f) => ({ ...f, variations: [...f.variations, emptyVariation()] }))
  }

  const removeVariationRow = (idx) => {
    setForm((f) => ({ ...f, variations: f.variations.filter((_, i) => i !== idx) }))
  }

  // Pricing logic per variation row — mirrors the single-row handlers.
  const onVariationExcChange = (idx, v) => {
    const exc = v === '' ? '' : Number(v)
    const inc = exc === '' ? '' : (exc * (1 + taxRateNum / 100)).toFixed(2)
    setForm((f) => {
      const row = f.variations[idx] || emptyVariation()
      const sell = row.margin && v ? recalcSelling(v, row.margin) : row.selling
      return {
        ...f,
        variations: f.variations.map((r, i) =>
          i === idx ? { ...r, exc_tax: v, inc_tax: inc === '' ? '' : String(inc), selling: sell } : r
        ),
      }
    })
  }
  const onVariationIncChange = (idx, v) => {
    const inc = v === '' ? '' : Number(v)
    const exc = inc === '' ? '' : (inc / (1 + taxRateNum / 100)).toFixed(2)
    setForm((f) => {
      const row = f.variations[idx] || emptyVariation()
      const sell = row.margin && exc !== '' ? recalcSelling(String(exc), row.margin) : row.selling
      return {
        ...f,
        variations: f.variations.map((r, i) =>
          i === idx ? { ...r, inc_tax: v, exc_tax: exc === '' ? '' : String(exc), selling: sell } : r
        ),
      }
    })
  }
  const onVariationMarginChange = (idx, v) => {
    setForm((f) => {
      const row = f.variations[idx] || emptyVariation()
      const sell = row.exc_tax ? recalcSelling(row.exc_tax, v) : row.selling
      return {
        ...f,
        variations: f.variations.map((r, i) =>
          i === idx ? { ...r, margin: v, selling: sell } : r
        ),
      }
    })
  }
  const onVariationSellingChange = (idx, v) => {
    setForm((f) => {
      const row = f.variations[idx] || emptyVariation()
      const margin = row.exc_tax ? recalcMargin(row.exc_tax, v) : row.margin
      return {
        ...f,
        variations: f.variations.map((r, i) =>
          i === idx ? { ...r, selling: v, margin } : r
        ),
      }
    })
  }

  // When the user switches to 'variable' for the first time, seed one empty
  // variation row so the table doesn't appear blank.
  const onProductTypeChange = (v) => {
    setForm((f) => ({
      ...f,
      product_type: v,
      variations: v === 'variable' && f.variations.length === 0
        ? [emptyVariation()]
        : f.variations,
    }))
  }

  // ── Combo-product helpers ──────────────────────────────────────────────
  const addComboItem = (product) => {
    if (!product) return
    setForm((f) => {
      // Skip duplicates — the same component can't appear twice in a combo
      // (matches the DB unique constraint).
      if (f.combo_items.some((r) => r.component_id === product.id)) return f
      const next = [...f.combo_items, emptyComboItem(product)]
      const netTotal = next.reduce(
        (s, r) => s + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
      )
      const m = Number(f.combo_margin_pct || 0)
      const sell = (netTotal * (1 + m / 100)).toFixed(2)
      return { ...f, combo_items: next, combo_selling: sell }
    })
  }

  const updateComboItem = (idx, patch) => {
    setForm((f) => {
      const next = f.combo_items.map((r, i) => i === idx ? { ...r, ...patch } : r)
      const netTotal = next.reduce(
        (s, r) => s + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
      )
      const m = Number(f.combo_margin_pct || 0)
      const sell = (netTotal * (1 + m / 100)).toFixed(2)
      return { ...f, combo_items: next, combo_selling: sell }
    })
  }

  const removeComboItem = (idx) => {
    setForm((f) => {
      const next = f.combo_items.filter((_, i) => i !== idx)
      const netTotal = next.reduce(
        (s, r) => s + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
      )
      const m = Number(f.combo_margin_pct || 0)
      const sell = (netTotal * (1 + m / 100)).toFixed(2)
      return { ...f, combo_items: next, combo_selling: sell }
    })
  }

  // Combo margin/selling stay in sync the same way the single-product math does.
  const comboNetTotal = () => form.combo_items.reduce(
    (s, r) => s + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
  )
  const onComboMarginChange = (v) => {
    const m = Number(v || 0)
    const sell = (comboNetTotal() * (1 + m / 100)).toFixed(2)
    setForm((f) => ({ ...f, combo_margin_pct: v, combo_selling: sell }))
  }
  const onComboSellingChange = (v) => {
    const s = Number(v || 0)
    setForm((f) => {
      const net = f.combo_items.reduce(
        (sum, r) => sum + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
      )
      const m = net > 0 ? (((s / net) - 1) * 100).toFixed(2) : f.combo_margin_pct
      return { ...f, combo_selling: v, combo_margin_pct: m }
    })
  }

  // ── Tax-aware purchase price helpers ───────────────────────────────────────
  // Inc.tax = Exc.tax × (1 + tax_rate/100)  (taxRateNum already defined above)

  const onPurchaseExcChange = (v) => {
    const exc = v === '' ? '' : Number(v)
    const inc = exc === '' ? '' : (exc * (1 + taxRateNum / 100)).toFixed(2)
    setForm((f) => ({
      ...f,
      cost_price: v,
      cost_price_inc: inc === '' ? '' : String(inc),
      selling_price: f.margin_pct && v ? recalcSelling(v, f.margin_pct) : f.selling_price,
    }))
  }

  const onPurchaseIncChange = (v) => {
    const inc = v === '' ? '' : Number(v)
    const exc = inc === '' ? '' : (inc / (1 + taxRateNum / 100)).toFixed(2)
    setForm((f) => ({
      ...f,
      cost_price_inc: v,
      cost_price: exc === '' ? '' : String(exc),
      selling_price: f.margin_pct && exc !== '' ? recalcSelling(String(exc), f.margin_pct) : f.selling_price,
    }))
  }

  // ── Image upload to backend (S3 if configured, /media fallback) ────────────
  const onPickImage = async (file) => {
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setErr('Image exceeds 5 MB.')
      window.alert('Image upload failed: the file exceeds the 5 MB limit.')
      return
    }
    setUploading(true); setErr('')
    try {
      const res = await uploadProductImage(file)
      setForm((f) => ({ ...f, image_url: res?.url || '' }))
      setImageMeta({
        name:   file.name || '',
        sizeKB: file.size ? (file.size / 1024).toFixed(2) : '',
      })
      setInfo('Image uploaded.')
      // Pop-up confirmation — the user explicitly asked for one so
      // the upload outcome can't be missed. Filename comes from the
      // browser-supplied File object so there's no hardcoded copy.
      window.alert(`Image uploaded successfully${file.name ? `: ${file.name}` : ''}.`)
    } catch (e) {
      const msg = e?.message || 'Upload failed. Check AWS credentials or backend logs.'
      setErr(msg)
      window.alert(`Image upload failed: ${msg}`)
    } finally {
      setUploading(false)
    }
  }

  // Per-variation image upload — mirrors onPickImage but writes the URL onto
  // the specific row instead of the top-level product.
  const onPickVariationImage = async (idx, file) => {
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setErr('Variation image exceeds 5 MB.')
      window.alert('Variation image upload failed: the file exceeds the 5 MB limit.')
      return
    }
    setUploading(true); setErr('')
    try {
      const res = await uploadProductImage(file)
      updateVariation(idx, { image_url: res?.url || '' })
      window.alert(`Variation image uploaded successfully${file.name ? `: ${file.name}` : ''}.`)
    } catch (e) {
      const msg = e?.message || 'Upload failed for variation image.'
      setErr(msg)
      window.alert(`Variation image upload failed: ${msg}`)
    } finally {
      setUploading(false)
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  const validate = () => {
    if (!form.name.trim()) return 'Product name is required.'
    if (!form.unit_id)     return 'Please choose a unit.'
    if (form.cost_price && Number(form.cost_price) < 0)       return 'Cost price cannot be negative.'
    if (form.selling_price && Number(form.selling_price) < 0) return 'Selling price cannot be negative.'
    return ''
  }

  const handleSave = async (closeAfter = true) => {
    setErr(''); setInfo('')
    const v = validate()
    if (v) { setErr(v); return }

    // Honor the SKU prefix from Settings → Product when the user lets
    // the SKU auto-generate. We don't override a SKU the user typed.
    const skuPrefix = settings.str('product.sku_prefix', '')
    const typedSku  = form.sku.trim()
    const finalSku  = typedSku
      ? typedSku
      : (skuPrefix ? `${skuPrefix}${skuPrefix.endsWith('-') ? '' : '-'}${Date.now().toString(36).toUpperCase()}` : undefined)

    const payload = {
      name: form.name.trim(),
      sku:  finalSku,
      barcode: form.barcode.trim() || undefined,
      generate_barcode: !form.barcode && form.generate_barcode,
      barcode_type: form.barcode_type,
      unit_id:  form.unit_id,
      brand_id: form.brand_id || null,
      category_id: form.category_id || null,
      warranty_id: form.warranty_id || null,
      product_type: form.product_type,
      not_for_selling: form.not_for_selling,
      weight: form.weight ? Number(form.weight) : null,
      notes:  form.description,
      image_url: form.image_url,
      tax_rate: form.tax_rate ? Number(form.tax_rate) : 0,
      tax_type: form.tax_type,
      cost_price:    form.cost_price    ? Number(form.cost_price)    : 0,
      selling_price: form.selling_price ? Number(form.selling_price) : 0,
      // Alert / reorder quantity persisted to the real Product.reorder_level
      // column (the low-stock report filters on it). Previously this only
      // lived in meta.alert_qty, so reorder_level stayed 0 and the dashboard
      // Product Stock Alert never fired.
      reorder_level: form.alert_qty ? Number(form.alert_qty) : 0,
      meta: {
        custom_fields: {
          field_1: form.custom_field_1,
          field_2: form.custom_field_2,
          field_3: form.custom_field_3,
          field_4: form.custom_field_4,
        },
        manage_stock:  form.manage_stock,
        alert_qty:     form.alert_qty ? Number(form.alert_qty) : null,
        business_locations: form.business_locations,
        brochure_url:  form.brochure_url,
      },
      // ── Variations are first-class now (one Variation row per variant)
      // The backend creates / replaces them based on these fields.
      variation_type: form.product_type === 'variable' ? form.variation_type : '',
      variations:     form.product_type === 'variable'
        ? form.variations.map((v) => ({
            value:         v.value,
            sku:           v.sku,
            cost_price:    v.exc_tax    ? Number(v.exc_tax)    : 0,
            selling_price: v.selling    ? Number(v.selling)    : 0,
            image_url:     v.image_url  || '',
          }))
        : [],
      // ── Combo components (first-class ComboItem table) ─────────────────
      combo_items: form.product_type === 'combo'
        ? form.combo_items.map((c) => ({
            component_id: c.component_id,
            // Whole-unit quantities only — combos can't include
            // fractional units like 1.5 pens.
            quantity: Math.max(1, Math.floor(Number(c.quantity) || 1)),
          }))
        : [],
    }

    // For combo products, the user-set Selling Price (Margin × NetTotal)
    // is the canonical price. Override the single-product 'selling_price'
    // payload field so the parent product carries the combo's total.
    if (form.product_type === 'combo') {
      payload.selling_price = form.combo_selling ? Number(form.combo_selling) : 0
      payload.cost_price    = form.combo_items.reduce(
        (s, r) => s + (Number(r.cost_price) || 0) * (Number(r.quantity) || 0), 0,
      )
    }

    setSaving(true)
    try {
      let saved
      if (editing) {
        saved = await updateProduct(id, payload)
      } else {
        saved = await createProduct(payload)
      }

      // ── Seed opening stock (create-only, managed-stock only) ────────────
      // We let the product save succeed even if a single FIFO layer call
      // fails — the user can always add stock later via Add Stock.
      if (!editing && form.manage_stock) {
        const fallbackCost = Number(payload.cost_price || 0)
        const rows = (form.opening_stocks || [])
          .map((r) => ({
            location_id: r.location_id,
            quantity:    Number(r.quantity || 0),
            unit_cost:   r.unit_cost === '' || r.unit_cost == null
              ? fallbackCost
              : Number(r.unit_cost),
          }))
          .filter((r) => r.location_id && r.quantity > 0)

        // (The quick "Quantity" shortcut from Basic information was
        // removed — opening stock is seeded only via the Opening
        // Stock card rows / import flow.)
        const productId = saved?.id || saved?.product_id
        if (!productId) {
          setErr('Product saved but the server did not return an ID — skipping opening-stock seed. Please add stock from the Edit Product page.')
        } else {
          const failures = []
          for (const row of rows) {
            try {
              await stockIn({
                product_id:     productId,
                location_id:    row.location_id,
                quantity:       row.quantity,
                unit_cost:      row.unit_cost,
                reference_type: 'opening',
              })
            } catch (stockErr) {
              const locName = (locations.find((l) => l.id === row.location_id) || {}).name || row.location_id
              failures.push(`${locName}: ${stockErr?.message || stockErr}`)
            }
          }
          if (failures.length) {
            // Keep the user on this page so they can read the error and act.
            setErr(`Product saved, but opening stock failed for: ${failures.join('; ')}. Open the product's Edit page to add stock manually.`)
            setSaving(false)
            return
          }
        }
      }

      if (closeAfter) navigate('/products')
      else {
        setForm(blankForm)
        setInfo('Product saved. Form cleared for next entry.')
        // Jump back to the top so the operator starts the next entry from
        // the Name field instead of staying scrolled at the buttons. The app
        // scrolls inside <main>, not the window, so scroll that container.
        const sc = document.querySelector('main')
        if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' })
        else window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    } catch (e) {
      // Build a clear, structured message instead of axios's generic
      // "Network Error" so the operator can act on it. Surfaces:
      //   • HTTP status + status text (when the request reached the
      //     server)
      //   • Field-by-field validation errors from payload.errors
      //   • A specific hint when the request never left the browser
      //     (most common cause: dev server down, CORS misconfig, or
      //     payload too large)
      const detail = formatSaveError(e, form)
      setErr(detail.banner)
      window.alert(detail.popup)
    } finally {
      setSaving(false)
    }
  }

  // Stand-alone helper kept inside the component so it can read the
  // form payload (useful for the "your image URL might be too long"
  // hint). Returns { banner, popup } strings ready to render.
  function formatSaveError(e, formSnap) {
    const lines = []
    const status = e?.status
    const fieldErrors = e?.errors
    const baseMsg = e?.message || 'Failed to save product.'

    if (status) {
      lines.push(`HTTP ${status} — ${baseMsg}`)
    } else if (/network error/i.test(baseMsg)) {
      // Axios sets this when there's no response at all.
      lines.push('Could not reach the server. Likely causes:')
      lines.push('• Backend (gunicorn / runserver) is down — check it is running on port 8000.')
      lines.push('• Reverse proxy (nginx) timed out — review the upstream logs.')
      lines.push('• Browser blocked the request (CORS) — verify CORS_ALLOWED_ORIGINS in backend/config/settings.py includes this origin.')
      lines.push('• The uploaded image URL is too long for the request — try a shorter file name.')
    } else {
      lines.push(baseMsg)
    }

    if (fieldErrors && typeof fieldErrors === 'object') {
      const flat = Object.entries(fieldErrors)
        .map(([k, v]) => `• ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
        .join('\n')
      if (flat) lines.push('\nField errors:\n' + flat)
    }

    // Quick hint if a freshly-uploaded image URL came back empty —
    // that means the upload silently failed and the save would
    // never have a image to attach. (No hardcoding — read from the
    // current form.)
    if (formSnap?.image_url === '' && formSnap?.name && lines.length === 1) {
      lines.push('Tip: if you tried to upload an image, the URL did not stick. Try uploading again before saving.')
    }

    const popup = `Failed to save product:\n\n${lines.join('\n')}`
    const banner = `${lines[0]}${fieldErrors ? ' — see pop-up for details.' : ''}`
    return { banner, popup }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const toggleLocation = (lid) =>
    setForm((f) => ({
      ...f,
      business_locations: f.business_locations.includes(lid)
        ? f.business_locations.filter((x) => x !== lid)
        : [...f.business_locations, lid],
    }))

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }))

  const subcategories = useMemo(
    () => categories.filter((c) => String(c.parent_id || c.parent || '') === String(form.category_id)),
    [categories, form.category_id]
  )

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header — modern indigo/sky gradient */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">{editing ? 'Edit Product' : 'Add New Product'}</h1>
            <p className="mt-0.5 text-sm text-indigo-100">
              {editing ? 'Update the product details and save your changes.' : 'Fill out the details below to add a product to your catalogue.'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/products')}>← Back to list</Button>
          </div>
        </div>
      </div>

      {info && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{info}</div>
      )}
      {err && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{err}</div>
      )}

      {/* ── Section: Basic info ─────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Basic information</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Product Name *">
            <input className={inputCls} value={form.name} onChange={set('name')}
                   placeholder="e.g. 1 CM Dispenser Tape" />
          </Field>
          <Field label="SKU" hint="Leave blank to auto-generate.">
            <input className={inputCls} value={form.sku} onChange={set('sku')}
                   placeholder="auto" />
          </Field>
          <Field label="Barcode Type">
            <select className={inputCls} value={form.barcode_type} onChange={set('barcode_type')}>
              {BARCODE_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>

          <Field label="Unit *">
            <select className={inputCls} value={form.unit_id} onChange={set('unit_id')}>
              <option value="">Select units</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}</option>)}
            </select>
          </Field>
          {settings.bool('product.enable_brands') && (
            <Field label="Brand">
              <select className={inputCls} value={form.brand_id} onChange={set('brand_id')}>
                <option value="">Select brand</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          {settings.bool('product.enable_categories') && (
            <Field label="Category">
              <select className={inputCls} value={form.category_id} onChange={set('category_id')}>
                <option value="">Select category</option>
                {categories.filter((c) => !c.parent_id && !c.parent).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          )}

          {settings.bool('product.enable_categories') && settings.bool('product.enable_sub_categories') && (
            <Field label="Sub-category">
              <select className={inputCls} value={form.sub_category_id} onChange={set('sub_category_id')}
                      disabled={!subcategories.length}>
                <option value="">Select sub-category</option>
                {subcategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Barcode (optional)">
            <input className={inputCls} value={form.barcode} onChange={set('barcode')}
                   placeholder="Scan or type" />
          </Field>
          <Field label="Weight">
            <input type="number" min="0" step="0.001" className={inputCls}
                   value={form.weight} onChange={set('weight')} placeholder="e.g. 0.250" />
          </Field>
          <Field label="Warranty" hint="Add warranties under Products → Warranties.">
            <select className={inputCls} value={form.warranty_id} onChange={set('warranty_id')}>
              <option value="">No warranty</option>
              {warranties.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}{w.duration_label ? ` (${w.duration_label})` : ''}
                </option>
              ))}
            </select>
          </Field>
          {/* Quantity shortcut removed per user request — opening stock
              is seeded via the Opening Stock card / Import Opening
              Stock flow instead, and services (Manage Stock off)
              never need a quantity at all. */}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-6 text-sm">
          <label className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={form.generate_barcode}
                   onChange={(e) => setForm({ ...form, generate_barcode: e.target.checked })} />
            Auto-generate barcode if blank
          </label>
          <label className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={form.not_for_selling}
                   onChange={(e) => setForm({ ...form, not_for_selling: e.target.checked })} />
            Not for selling
          </label>
        </div>
      </Card>

      {/* The duplicate 'Product Type' card (Single | Variable radio) was
          removed — the canonical Product Type selector is the dropdown
          rendered below the Tax section above (supports Single / Variable
          / Combo). */}

      {/* ── Section: Business Locations ─────────────────────────────────────── */}
      <Card>
        <SectionTitle>Business Locations</SectionTitle>
        <p className="mb-3 text-xs text-slate-500">Choose which branches will stock this product. Leave empty to make it available everywhere.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {locations.map((loc) => {
            const checked = form.business_locations.includes(loc.id)
            return (
              <label key={loc.id}
                     className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${checked ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleLocation(loc.id)} />
                {loc.name}
              </label>
            )
          })}
          {!locations.length && (
            <div className="text-xs text-slate-400">No locations available.</div>
          )}
        </div>
      </Card>

      {/* ── Section: Stock management ───────────────────────────────────────── */}
      <Card>
        <SectionTitle>Stock management</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Manage Stock?">
            <div className="flex items-center gap-3">
              <button type="button"
                      onClick={() => setForm({ ...form, manage_stock: !form.manage_stock })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${form.manage_stock ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${form.manage_stock ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <span className="text-sm text-slate-600">{form.manage_stock ? 'Track stock levels' : 'Service / non-stocked item'}</span>
            </div>
          </Field>
          <Field label="Alert quantity" hint="Low-stock alert when on-hand falls below this.">
            <input type="number" min="0" step="1" className={inputCls}
                   disabled={!form.manage_stock}
                   value={form.alert_qty} onChange={set('alert_qty')}
                   placeholder="e.g. 5" />
          </Field>
        </div>
      </Card>

      {/* ── Section: Opening stock (create-only) ─────────────────────────── */}
      {!editing && form.manage_stock && (
        <Card>
          <SectionTitle>Opening stock</SectionTitle>
          <p className="mb-3 text-xs text-slate-500">
            Optional. Seed how much of this product is already on hand at
            each location. Unit cost defaults to the product&rsquo;s Purchase
            (Exc. tax) price above when left blank. Skip a row to skip that
            location. You can always add more stock later from Add Stock.
          </p>

          {locations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
              No business locations configured yet — add one in Settings &rarr; Business Locations.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 w-2/5">Location</th>
                    <th className="px-3 py-2">Opening quantity</th>
                    <th className="px-3 py-2">Unit cost (overrides Purchase Exc. tax)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {locations.map((loc) => {
                    const row = (form.opening_stocks || []).find((r) => r.location_id === loc.id) || {}
                    const updateRow = (patch) => {
                      setForm((f) => {
                        const list = Array.isArray(f.opening_stocks) ? [...f.opening_stocks] : []
                        const idx  = list.findIndex((r) => r.location_id === loc.id)
                        if (idx === -1) list.push({ location_id: loc.id, quantity: '', unit_cost: '', ...patch })
                        else            list[idx] = { ...list[idx], ...patch }
                        return { ...f, opening_stocks: list }
                      })
                    }
                    return (
                      <tr key={loc.id} className="hover:bg-slate-50/60">
                        <td className="px-3 py-2 text-slate-700">{loc.name}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min="0" step="0.0001"
                            className={inputCls}
                            value={row.quantity ?? ''}
                            onChange={(e) => updateRow({ quantity: e.target.value })}
                            placeholder="0"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min="0" step="0.0001"
                            className={inputCls}
                            value={row.unit_cost ?? ''}
                            onChange={(e) => updateRow({ unit_cost: e.target.value })}
                            placeholder={form.cost_price || '0.00'}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── Section: Tax ──────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Tax</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Applicable tax" hint="Tax that applies to this product (used for Inc./Exc. tax conversion below).">
            <select className={inputCls} value={form.tax_rate} onChange={(e) => {
              const v = e.target.value
              const r = Number(v || 0)
              setForm((f) => ({
                ...f,
                tax_rate: v,
                cost_price_inc: f.cost_price ? (Number(f.cost_price) * (1 + r/100)).toFixed(2) : f.cost_price_inc,
              }))
            }}>
              {TAX_RATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Selling price tax type">
            <select className={inputCls} value={form.tax_type} onChange={set('tax_type')}>
              {TAX_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>

        {/* ── Product Type — placed BELOW tax per the reference screenshot ── */}
        <div className="mt-4">
          <Field
            label="Product Type *"
            hint="Single: one SKU, one price. Variable: multiple variants (e.g. by colour or size), each with its own SKU / pricing / image."
          >
            <select
              className={inputCls}
              value={form.product_type}
              onChange={(e) => onProductTypeChange(e.target.value)}
            >
              {PRODUCT_TYPE_OPTIONS.map((t) =>
                <option key={t.value} value={t.value}>{t.label}</option>
              )}
            </select>
          </Field>
        </div>
      </Card>

      {/* ── Section: Variations — only when product_type = 'variable' ───── */}
      {form.product_type === 'variable' && (
        <Card padding="p-0">
          <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Add Variation</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Pick a variation type, then list each variant with its own
                SKU, price and image. Pricing rules (Exc/Inc tax, Margin, Selling
                Price) work per row the same way they do for single products.
              </p>
            </div>
            <button
              type="button"
              onClick={addVariationRow}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <PlusIcon /> Add row
            </button>
          </div>

          <div className="px-5 py-4 border-b border-gray-100">
            <Field label="Variation type">
              <select
                className={inputCls}
                value={form.variation_type}
                onChange={set('variation_type')}
              >
                {VARIATION_TYPE_OPTIONS.map((o) =>
                  <option key={o.value} value={o.value}>{o.label}</option>
                )}
              </select>
            </Field>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-emerald-600 text-white text-left text-[11px] font-semibold uppercase tracking-wider">
                  <th className="px-3 py-2.5">SKU</th>
                  <th className="px-3 py-2.5">Value</th>
                  <th className="px-3 py-2.5">Purchase Exc. tax</th>
                  <th className="px-3 py-2.5">Purchase Inc. tax</th>
                  <th className="px-3 py-2.5">× Margin (%)</th>
                  <th className="px-3 py-2.5">Selling Exc. tax</th>
                  <th className="px-3 py-2.5">Image</th>
                  <th className="px-3 py-2.5 text-center w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {form.variations.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-6 text-center text-sm text-gray-400">
                      Click <span className="font-semibold text-emerald-700">+ Add row</span> to start adding variants.
                    </td>
                  </tr>
                )}
                {form.variations.map((v, idx) => (
                  <tr key={idx} className="hover:bg-emerald-50/30">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        className={inputCls}
                        value={v.sku}
                        onChange={(e) => updateVariation(idx, { sku: e.target.value })}
                        placeholder="Auto if blank"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        className={inputCls}
                        value={v.value}
                        onChange={(e) => updateVariation(idx, { value: e.target.value })}
                        placeholder={form.variation_type ? `${form.variation_type}…` : 'Value'}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min="0" step="0.01" className={inputCls}
                        value={v.exc_tax}
                        onChange={(e) => onVariationExcChange(idx, e.target.value)}
                        placeholder="Exc. tax"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min="0" step="0.01" className={inputCls}
                        value={v.inc_tax}
                        onChange={(e) => onVariationIncChange(idx, e.target.value)}
                        placeholder="Inc. tax"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min="0" step="0.01" className={inputCls}
                        value={v.margin}
                        onChange={(e) => onVariationMarginChange(idx, e.target.value)}
                        placeholder="40.00"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min="0" step="0.01" className={inputCls + ' bg-emerald-50'}
                        value={v.selling}
                        onChange={(e) => onVariationSellingChange(idx, e.target.value)}
                        placeholder="Exc. tax"
                      />
                    </td>
                    <td className="px-3 py-2">
                      {v.image_url ? (
                        <div className="flex items-center gap-2">
                          <img src={v.image_url} alt="" className="h-10 w-10 rounded object-cover ring-1 ring-gray-200" />
                          <button
                            type="button"
                            onClick={() => updateVariation(idx, { image_url: '' })}
                            className="text-[11px] text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => onPickVariationImage(idx, e.target.files?.[0])}
                          className="text-xs"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeVariationRow(idx)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-500 text-white hover:bg-red-600"
                        title="Remove row"
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-[11px] text-gray-400 border-t border-gray-100">
            Variation data is saved alongside the product in <span className="font-mono">meta.variations</span>.
            Dedicated relational storage (one Variation row per variant) is on the roadmap — existing rows will
            be migrated automatically.
          </p>
        </Card>
      )}

      {/* ── Section: Combo Components — only when product_type = 'combo' ── */}
      {form.product_type === 'combo' && (
        <Card padding="p-0">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-base font-semibold text-gray-900">Combo components</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Search and add the products that make up this combo. The Net Total is
              the sum of (each component's purchase price × quantity); the Selling
              Price is auto-suggested from Net Total × (1 + Margin %), but you can
              type any value to override and the margin will back-calculate.
            </p>
          </div>

          {/* Product search ───────────────────────────────────────────── */}
          <div className="px-5 py-4 border-b border-gray-100 relative">
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100">
              <SearchIcon />
              <input
                type="text"
                value={comboSearch}
                onChange={(e) => setComboSearch(e.target.value)}
                placeholder="Enter Product name / SKU / Scan bar code"
                className="flex-1 bg-transparent text-sm outline-none"
              />
              {comboSearchLoading && (
                <span className="text-[11px] text-gray-400">Searching…</span>
              )}
            </div>
            {comboSearchResults.length > 0 && (
              <div className="absolute left-5 right-5 mt-1 z-20 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                {comboSearchResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { addComboItem(p); setComboSearch(''); setComboSearchResults([]) }}
                    className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-emerald-50"
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-900">{p.name}</div>
                      <div className="text-[11px] text-gray-400">
                        {p.sku ? `SKU ${p.sku}` : ''}
                        {p.brand_name ? ` · ${p.brand_name}` : ''}
                      </div>
                    </div>
                    <div className="text-xs text-emerald-700 font-semibold">
                      ৳ {Number(p.cost_price || p.purchase_price || 0).toFixed(2)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Component table ─────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-emerald-600 text-white text-left text-[11px] font-semibold uppercase tracking-wider">
                  <th className="px-3 py-2.5">Product Name</th>
                  <th className="px-3 py-2.5 w-32">Quantity</th>
                  <th className="px-3 py-2.5 w-48">Purchase Price (Exc. Tax)</th>
                  <th className="px-3 py-2.5 w-40 text-right">Total (Exc. Tax)</th>
                  <th className="px-3 py-2.5 w-12 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {form.combo_items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-sm text-gray-400">
                      Use the search above to add component products.
                    </td>
                  </tr>
                )}
                {form.combo_items.map((row, idx) => {
                  const lineTotal = (Number(row.cost_price) || 0) * (Number(row.quantity) || 0)
                  return (
                    <tr key={row.component_id} className="hover:bg-emerald-50/30">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{row.component_name}</div>
                        {row.component_sku && (
                          <div className="text-[11px] text-gray-400 font-mono">{row.component_sku}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min="1" step="1" className={inputCls}
                          value={row.quantity}
                          onChange={(e) => {
                            // Integer-only — strip any decimal point the user
                            // tries to type / paste.
                            const v = e.target.value.replace(/[^0-9]/g, '')
                            updateComboItem(idx, { quantity: v })
                          }}
                          onKeyDown={(e) => {
                            // Block 'e', '.', '-', '+' entirely so number
                            // inputs can't accept scientific or decimal forms.
                            if (['e', 'E', '.', '+', '-'].includes(e.key)) {
                              e.preventDefault()
                            }
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min="0" step="0.01" className={inputCls}
                          value={row.cost_price}
                          onChange={(e) => updateComboItem(idx, { cost_price: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">
                        ৳ {lineTotal.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => removeComboItem(idx)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-500 text-white hover:bg-red-600"
                          title="Remove component"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-emerald-200 bg-emerald-50/60 text-sm font-semibold text-emerald-900">
                  <td className="px-3 py-3" colSpan={3}>
                    <span className="text-xs uppercase tracking-wider">Net total amount</span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-base font-bold">
                    ৳ {comboNetTotal().toFixed(2)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Margin + Selling price ─────────────────────────────────── */}
          <div className="px-5 py-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="× Margin (%)" hint="Selling = Net Total × (1 + Margin/100)">
              <input
                type="number" min="0" step="0.01" className={inputCls}
                value={form.combo_margin_pct}
                onChange={(e) => onComboMarginChange(e.target.value)}
                placeholder="40.00"
              />
            </Field>
            <Field label="Selling Price (Exc. Tax)" hint="Type a value to override; Margin will back-calculate.">
              <input
                type="number" min="0" step="0.01" className={inputCls + ' bg-emerald-50'}
                value={form.combo_selling}
                onChange={(e) => onComboSellingChange(e.target.value)}
                placeholder="0.00"
              />
            </Field>
          </div>
        </Card>
      )}

      {/* ── Section: Pricing & image (matches reference screenshot) ────────── */}
      {form.product_type === 'single' && (
      <Card padding="p-0">
        <div className="grid grid-cols-1 md:grid-cols-4">
          {/* Purchase Price */}
          <div className="md:col-span-2 border-b border-emerald-100 md:border-b-0 md:border-r">
            <PricingHeader>Purchase Price</PricingHeader>
            <div className="grid grid-cols-2 gap-3 p-4">
              <Field label="Exc. tax: *">
                <input type="number" min="0" step="0.01" className={inputCls}
                       value={form.cost_price}
                       onChange={(e) => onPurchaseExcChange(e.target.value)}
                       placeholder="Exc. tax" />
              </Field>
              <Field label="Inc. tax: *">
                <input type="number" min="0" step="0.01" className={inputCls}
                       value={form.cost_price_inc}
                       onChange={(e) => onPurchaseIncChange(e.target.value)}
                       placeholder="Inc. tax" />
              </Field>
            </div>
          </div>

          {/* Margin — single-cell column that has to vertically line
              up with the two-input Purchase Price block and the
              single-input Selling Price block to its right. The empty
              label collapsed to 0 height, which made the Margin
              input float a row higher than its siblings. Give the
              field an explicit "Margin %:" label so all three inputs
              share a baseline. */}
          <div className="border-b border-emerald-100 md:border-b-0 md:border-r">
            <PricingHeader>
              <span className="inline-flex items-center gap-1">
                x Margin(%) <InfoDot title="Margin = (Selling − Purchase) ÷ Purchase × 100" />
              </span>
            </PricingHeader>
            <div className="p-4">
              <Field label="Margin %:">
                <input type="number" min="0" step="0.01" className={inputCls}
                       value={form.margin_pct} onChange={(e) => onMarginChange(e.target.value)}
                       placeholder="40.00" />
              </Field>
            </div>
          </div>

          {/* Selling Price */}
          <div className="border-b border-emerald-100 md:border-b-0">
            <PricingHeader>Selling Price</PricingHeader>
            <div className="p-4">
              <Field label="Exc. Tax:">
                <input type="number" min="0" step="0.01" className={inputCls + ' bg-emerald-50'}
                       value={form.selling_price} onChange={(e) => onSellingChange(e.target.value)}
                       placeholder="Exc. tax" />
              </Field>
            </div>
          </div>
        </div>

        {/* Product image — matches the reference: a single centered
            preview card with the file name + size below the image,
            then a Browse / Remove control row, then the hints. The
            old layout floated a small 24-px thumbnail to the right
            which the user said "dekhte khrp dekhay". File name + size
            come from the browser-supplied File object so there is
            no hardcoded copy. */}
        <div className="border-t border-emerald-100">
          <PricingHeader>Product image</PricingHeader>
          <div className="p-4">
            <label className="mb-2 block text-xs font-medium text-slate-700">Product image:</label>

            {/* Compact, fixed-width preview frame top-right (per user
                spec). max-w-md keeps the box around ~28rem so it
                feels like the right-hand panel in the reference image
                rather than spanning the whole row. */}
            {form.image_url ? (
              /* Uploaded state — fixed-width preview card. */
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 mx-auto md:mx-0 md:mr-auto max-w-md">
                <div className="flex flex-col items-center">
                  <img
                    src={form.image_url}
                    alt={imageMeta?.name || 'product preview'}
                    className="max-h-56 w-auto rounded-md border border-slate-200 bg-white object-contain shadow-soft"
                  />
                  <div className="mt-3 flex flex-col items-center text-xs">
                    <a
                      href={form.image_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-rose-500 hover:text-rose-600 hover:underline truncate max-w-[24rem]"
                    >
                      {imageMeta?.name || (form.image_url.split('/').pop() || 'image')}
                    </a>
                    {imageMeta?.sizeKB && (
                      <span className="text-slate-500">({imageMeta.sizeKB} KB)</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Empty state — same drop hint area as the reference,
                 also constrained to the right-rail width so it
                 doesn't stretch full-bleed. */
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500 mx-auto md:mx-0 md:mr-auto max-w-md">
                No image yet — click <b>Browse</b> below to upload.
              </div>
            )}

            {/* Browse / Remove row + hidden file input — same
                max-w-md envelope so the whole image block reads as
                a single right-rail card. */}
            <div className="mt-3 mx-auto md:mx-0 md:mr-auto max-w-md flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-600 truncate max-w-[10rem]">
                {imageMeta?.name || (form.image_url ? (form.image_url.split('/').pop() || '') : '')}
              </div>
              <div className="flex items-center gap-2">
                {form.image_url && (
                  <button
                    type="button"
                    onClick={() => { setForm((f) => ({ ...f, image_url: '' })); setImageMeta(null) }}
                    className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                  >
                    🗑 Remove
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white shadow-soft"
                >
                  📁 {uploading ? 'Uploading…' : 'Browse...'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onPickImage(e.target.files?.[0])}
                />
              </div>
            </div>

            <div className="mt-2 mx-auto md:mx-0 md:mr-auto max-w-md text-[11px] text-slate-400">Max File size: 5MB</div>
            <div className="mx-auto md:mx-0 md:mr-auto max-w-md text-[11px] text-slate-400">Aspect ratio should be 1:1</div>
          </div>
        </div>
      </Card>
      )}

      {/* ── Section: Description & extra media ──────────────────────────────── */}
      <Card>
        <SectionTitle>Description & brochure</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Product description">
            <textarea className={inputCls + ' min-h-[120px]'}
                      value={form.description} onChange={set('description')}
                      placeholder="Short description shown on invoices and catalogues" />
          </Field>
          <Field label="Brochure URL (PDF)">
            <input className={inputCls} value={form.brochure_url} onChange={set('brochure_url')}
                   placeholder="https://..." />
          </Field>
        </div>
      </Card>

      {/* Custom fields section removed per spec — the four free-text
          slots weren't being used by any tenant and added noise to
          the form. The state keys + payload fields below stay for
          backwards compatibility (always blank). */}

      {/* ── Footer actions ─────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-5">
        <Button variant="secondary" onClick={() => navigate('/products')}>Cancel</Button>
        <Button variant="secondary" loading={saving} onClick={() => handleSave(false)}>Save & add another</Button>
        <Button loading={saving} onClick={() => handleSave(true)}>{editing ? 'Update product' : 'Save product'}</Button>
      </div>
    </div>
  )
}

// ── Local UI helpers ───────────────────────────────────────────────────────────
const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-400'

function SectionTitle({ children }) {
  return (
    <div className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-2">
      <span className="h-4 w-1 rounded-full bg-gradient-to-b from-indigo-500 to-sky-500" />
      <h2 className="text-sm font-semibold tracking-wide text-slate-800">{children}</h2>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">{label}</label>
      {children}
      {hint && <div className="mt-1 text-[11px] text-slate-400">{hint}</div>}
    </div>
  )
}

// TypeRadio helper removed along with the duplicate 'Product Type' card.

function PricingHeader({ children }) {
  return (
    <div className="bg-emerald-500 px-4 py-2 text-sm font-semibold text-white">{children}</div>
  )
}

function InfoDot({ title }) {
  return (
    <span title={title} className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-sky-500 text-[10px] font-bold text-white">i</span>
  )
}

function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3zM4.5 9a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
    </svg>
  )
}
