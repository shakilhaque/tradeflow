import { useEffect, useRef, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import JsBarcode from 'jsbarcode'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Select from '../../components/ui/Select'
import { useAuth } from '../../context/AuthContext'
import { getProducts, getProduct } from '../../api/products'
import { getPurchase } from '../../api/purchases'
import { getCompanyProfile } from '../../api/companyProfile'

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const LAYOUTS = [
  {
    value: '20-per-sheet', label: '20 Labels per Sheet — 8.5"x11", 4"x1"',
    sheetW: 8.5, sheetH: 11, cols: 2,  rows: 10, labelW: 4,   labelH: 1, unit: 'in',
  },
  {
    value: '30-per-sheet', label: '30 Labels per Sheet — 8.5"x11", 2.625"x1"',
    sheetW: 8.5, sheetH: 11, cols: 3,  rows: 10, labelW: 2.625, labelH: 1, unit: 'in',
  },
  {
    value: '32-per-sheet', label: '32 Labels per Sheet — 8.5"x11", 2"x1.25"',
    sheetW: 8.5, sheetH: 11, cols: 4,  rows: 8,  labelW: 2, labelH: 1.25, unit: 'in',
  },
  {
    value: '40-per-sheet', label: '40 Labels per Sheet — 8.5"x11", 2"x1"',
    sheetW: 8.5, sheetH: 11, cols: 4,  rows: 10, labelW: 2, labelH: 1, unit: 'in',
  },
  {
    value: '50-per-sheet', label: '50 Labels per Sheet — 8.5"x11", 1.5"x1"',
    sheetW: 8.5, sheetH: 11, cols: 5,  rows: 10, labelW: 1.5, labelH: 1, unit: 'in',
  },
  {
    value: 'continuous-roll', label: 'Continuous Rolls — 31.75mm x 25.4mm',
    sheetW: 31.75, sheetH: 25.4, cols: 1, rows: 1, labelW: 31.75, labelH: 25.4, unit: 'mm', gap: 3.18,
  },
]

export default function PrintLabelsPage() {
  const { user } = useAuth()

  // Tenant brand block — single company-name header on every label.
  // Pull from the per-tenant Company Profile (the same source of truth
  // the sidebar / invoice slip uses) so labels are tenant-specific.
  // Falls back to the signup business_name until the tenant fills the
  // profile. Branch is intentionally NOT printed any more — store
  // managers print for their own branch so it was redundant.
  const [companyName, setCompanyName] = useState(user?.business_name || '')

  useEffect(() => {
    let cancelled = false
    getCompanyProfile()
      .then((p) => { if (!cancelled && p?.name) setCompanyName(p.name) })
      .catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [])

  // Search + selected products
  const [search,        setSearch]        = useState('')
  const [results,       setResults]       = useState([])
  const [showResults,   setShowResults]   = useState(false)
  const [searching,     setSearching]     = useState(false)
  const [items,         setItems]         = useState([])
  const searchBoxRef = useRef(null)

  // Sizes for the four fixed lines (company+branch / product name / price /
  // barcode caption). Other toggles (variation, packing date) have been
  // removed per spec — a label now shows ONLY: company+branch, name, price,
  // barcode + scannable code.
  const [sizeBusiness, setSizeBusiness] = useState(20)
  const [sizeName,     setSizeName]     = useState(15)
  const [sizePrice,    setSizePrice]    = useState(17)

  // Barcode layout
  const [layoutValue, setLayoutValue] = useState('continuous-roll')
  const layout = useMemo(() => LAYOUTS.find((l) => l.value === layoutValue) || LAYOUTS[0], [layoutValue])

  // Preview
  const [showPreview, setShowPreview] = useState(false)

  // ── Product search ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!search.trim()) {
      setResults([]); setShowResults(false); return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await getProducts({ search: search.trim(), limit: 10 })
        const list = Array.isArray(res) ? res : (res?.results ?? [])
        setResults(list); setShowResults(true)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    const handler = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setShowResults(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // `overrides` lets the caller pre-seed values on the new row.
  // Used by the ?purchase_id deep-link to copy each purchase
  // item's quantity into the label count so the cashier doesn't
  // have to retype it.
  const addItem = (p, overrides = {}) => {
    setItems((prev) => {
      if (prev.find((it) => it.product_id === p.id)) return prev
      // The printed barcode MUST round-trip through the POS scanner —
      // that means it has to equal Product.barcode or Product.sku
      // exactly. We never fall back to a UUID slice anymore because
      // the scan endpoint only matches barcode/SKU, never IDs.
      // If a product has neither (rare for a label-worthy product),
      // we surface a warning instead of silently printing junk.
      const scanCode = (p.barcode && String(p.barcode).trim()) || (p.sku && String(p.sku).trim()) || ''
      if (!scanCode) {
        alert(
          `"${p.name}" has no barcode or SKU set — printed labels would not scan into POS. ` +
          `Open the product, set a barcode (or SKU), then come back.`,
        )
        return prev
      }
      return [...prev, {
        product_id: p.id,
        name:        p.name,
        sku:         p.sku || '',
        barcode:     scanCode,
        price:       Number(p.price ?? p.selling_price ?? 0),
        labels:      Number(overrides.labels) || 1,
        ...overrides,
      }]
    })
    setSearch(''); setResults([]); setShowResults(false)
  }

  const updateItem = (idx, patch) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx))

  // ── Auto-add the product from ?id=<uuid> (deep-link from the
  //    Products List → Action ▾ → Print Label).
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id         = searchParams.get('id')
    const purchaseId = searchParams.get('purchase_id')
    if (!id && !purchaseId) return
    let cancelled = false

    // Two deep-link entry points:
    //   ?id=<productId>             → single-product (action menu
    //                                  on List Products → Print Label)
    //   ?purchase_id=<purchaseId>   → every line item on the purchase
    //                                  (action menu on All Purchases →
    //                                  Labels). Each item's quantity
    //                                  pre-fills the label count so
    //                                  the tenant rarely has to edit.
    const load = async () => {
      try {
        if (id) {
          const p = await getProduct(id)
          if (!cancelled && p) addItem(p)
          return
        }
        const pu = await getPurchase(purchaseId)
        const items = Array.isArray(pu?.items) ? pu.items : []
        for (const it of items) {
          if (!it.product) continue
          try {
            const prod = await getProduct(it.product)
            if (cancelled) return
            if (prod) {
              // Each item is added once; the label count comes from
              // the purchase quantity so the tenant gets the right
              // number of labels by default.
              addItem(prod, { labels: String(it.quantity || 1) })
            }
          } catch { /* skip invalid */ }
        }
      } catch { /* invalid id → silently ignore */ }
      finally {
        if (!cancelled) {
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            next.delete('id'); next.delete('purchase_id')
            return next
          }, { replace: true })
        }
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalLabels = items.reduce((s, it) => s + (Number(it.labels) || 0), 0)

  const handlePreview = () => {
    if (!totalLabels) {
      alert('Add at least one product and set a label count.')
      return
    }
    setShowPreview(true)
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Print Labels</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Generate barcode labels for products — pick a layout, configure what shows on each label, then preview &amp; print.
        </p>
      </div>

      {/* ── Products card ───────────────────────────────────────────────── */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-white">
          <h2 className="text-base font-semibold">Add products to generate labels</h2>
        </div>

        <div className="p-5 space-y-4">
          {/* Search */}
          <div ref={searchBoxRef} className="relative">
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-brand-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-brand-100">
              <svg className="h-4 w-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3z" clipRule="evenodd" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Enter product name, SKU or barcode to print labels…"
                className="flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
              />
              {searching && <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />}
            </div>

            {showResults && results.length > 0 && (
              <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-pop max-h-72 overflow-auto">
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addItem(p)}
                    className="w-full text-left px-4 py-2.5 hover:bg-brand-50 border-b border-gray-50 last:border-0"
                  >
                    <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                    <div className="text-xs text-gray-500">
                      {p.sku || '—'}{p.barcode ? ` · ${p.barcode}` : ''} {p.price ? `· ${fmtMoney(p.price)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {showResults && !searching && results.length === 0 && search.trim() && (
              <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-pop px-4 py-3 text-sm text-gray-500">
                No matching products.
              </div>
            )}
          </div>

          {/* Items table — kept minimal: product + label count + remove. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-2.5">Products</th>
                  <th className="px-4 py-2.5 w-40">No. of labels</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-sm text-gray-400">
                      No products added. Search above to add.
                    </td>
                  </tr>
                ) : (
                  items.map((it, idx) => (
                    <tr key={`${it.product_id}-${idx}`} className="hover:bg-gray-50/40">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-navy-800">{it.name}</div>
                        <div className="text-xs text-gray-500 font-mono">
                          {it.barcode}{it.sku && it.sku !== it.barcode ? ` · ${it.sku}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <input type="number" min="1" step="1"
                               value={it.labels}
                               onChange={(e) => updateItem(idx, { labels: Number(e.target.value) || 0 })}
                               className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button onClick={() => removeItem(idx)} className="text-rose-500 hover:text-rose-700">
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 011 1v7a1 1 0 102 0V9a1 1 0 112 0v7a1 1 0 102 0V9a1 1 0 112 0v7a3 3 0 01-3 3H8a3 3 0 01-3-3V9a1 1 0 011-1z" clipRule="evenodd" /></svg>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* ── Label content + layout ──────────────────────────────────────── */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-white">
          <h2 className="text-base font-semibold">Label content</h2>
          <p className="text-[11px] text-emerald-50/90 mt-0.5">
            Every label shows: Company + Branch · Product name · Price · Barcode.
          </p>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5 block">Top header</label>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800">
                {companyName || '—'}
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                Pulled from Settings → Company Profile. Update there to change every label.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <FontSize label="Header" value={sizeBusiness} onChange={setSizeBusiness} />
              <FontSize label="Name"   value={sizeName}     onChange={setSizeName} />
              <FontSize label="Price"  value={sizePrice}    onChange={setSizePrice} />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5 block">Barcode setting</label>
            <Select value={layoutValue} onChange={(e) => setLayoutValue(e.target.value)}>
              {LAYOUTS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </Select>
            <p className="mt-1 text-xs text-gray-400">
              {layout.cols} × {layout.rows} = {layout.cols * layout.rows} per sheet · label size {layout.labelW}{layout.unit} × {layout.labelH}{layout.unit}
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handlePreview} disabled={!totalLabels} leftIcon={<IconEye />}>
              Preview ({totalLabels} label{totalLabels === 1 ? '' : 's'})
            </Button>
          </div>
        </div>
      </Card>

      {showPreview && (
        <PreviewModal
          items={items}
          layout={layout}
          options={{
            companyName,
            sizeBusiness, sizeName, sizePrice,
          }}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  )
}

function FontSize({ label, value, onChange }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block">{label} size</label>
      <input
        type="number" min="6" max="48"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
      />
    </div>
  )
}

// ── Preview Modal ──────────────────────────────────────────────────────────

function PreviewModal({ items, layout, options, onClose }) {
  // Expand each line item into N label instances
  const labels = useMemo(() => {
    const out = []
    items.forEach((it) => {
      for (let i = 0; i < (Number(it.labels) || 0); i++) out.push(it)
    })
    return out
  }, [items])

  const print = () => {
    // Build a clean print window with only the labels.
    const html = renderPrintHtml(labels, layout, options)
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) {
      alert('Pop-up blocked. Allow pop-ups for this site to print.')
      return
    }
    win.document.write(html)
    win.document.close()
    // Give the new window a tick to paint, then trigger print
    win.onload = () => {
      win.focus()
      win.print()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-pop my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-navy-800">Label preview</h3>
            <p className="text-xs text-gray-500 mt-0.5">{labels.length} label{labels.length === 1 ? '' : 's'} · {layout.label}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
          </button>
        </div>

        <div className="p-6 max-h-[60vh] overflow-auto bg-gray-50">
          {/* Vertical stack — every label on its own row, matching the
              physical print output. No more multi-column grid that
              looked nothing like the printed roll. */}
          <div className="mx-auto bg-white shadow-md p-3 flex flex-col items-center gap-2 w-fit">
            {labels.map((it, i) => (
              <LabelTile key={i} item={it} layout={layout} options={options} />
            ))}
            {labels.length === 0 && (
              <p className="w-full text-center text-sm text-gray-400 py-10">Nothing to preview.</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={print} leftIcon={<IconPrint />} disabled={!labels.length}>Print</Button>
        </div>
      </div>
    </div>
  )
}

function LabelTile({ item, layout, options }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    try {
      // Always encode the scannable code (already guarded in addItem so
      // we never fall back to a UUID that wouldn't round-trip).
      JsBarcode(ref.current, item.barcode || item.sku, {
        format: 'CODE128',
        displayValue: false,
        margin: 0,
        height: 32,
        width: 1.2,
      })
    } catch (e) {
      // Render nothing if barcode value invalid
    }
  }, [item.barcode])

  const w = layout.unit === 'in' ? `${layout.labelW}in` : `${layout.labelW}mm`
  const h = layout.unit === 'in' ? `${layout.labelH}in` : `${layout.labelH}mm`

  // Tenant brand line: just the company name on top. Branch name has
  // been removed per spec — store managers print labels for their own
  // branch, so identifying the branch on the label was redundant.
  const headerLine = (options.companyName || '').trim()

  return (
    <div
      className="border border-gray-200 px-1 py-1 flex flex-col items-center justify-center text-center"
      style={{ width: w, height: h, minWidth: '120px', minHeight: '70px' }}
    >
      {headerLine && (
        <div className="font-bold leading-tight" style={{ fontSize: options.sizeBusiness * 0.6 + 'px' }}>
          {headerLine}
        </div>
      )}
      <div className="leading-tight" style={{ fontSize: options.sizeName * 0.6 + 'px' }}>
        {item.name}
      </div>
      <div className="leading-tight font-bold" style={{ fontSize: options.sizePrice * 0.6 + 'px' }}>
        Price: {fmtMoney(item.price)}
      </div>
      <svg ref={ref} className="mt-0.5 w-full" />
      {/* Human-readable code under the barcode — matches what the POS
          scan endpoint receives when this label is scanned. */}
      <div className="leading-tight font-mono text-gray-900 font-semibold" style={{ fontSize: '11px' }}>
        {item.barcode}
      </div>
    </div>
  )
}

/** Build a self-contained HTML doc for the print window. */
function renderPrintHtml(labels, layout, options) {
  const unit = layout.unit
  const labelW = `${layout.labelW}${unit}`
  const labelH = `${layout.labelH}${unit}`

  const headerLine = (options.companyName || '').trim()

  // Each label renders exactly four lines: company header, product
  // name, price, barcode + scannable caption. Vertical stack — matches
  // the printed roll output and the on-screen preview tile.
  const labelHtml = labels.map((item) => {
    const svg = barcodeSvg(item.barcode || item.sku)
    return `
      <div class="label">
        ${headerLine ? `<div class="line bold" style="font-size:${options.sizeBusiness * 0.6}px">${escapeHtml(headerLine)}</div>` : ''}
        <div class="line" style="font-size:${options.sizeName * 0.6}px">${escapeHtml(item.name)}</div>
        <div class="line bold" style="font-size:${options.sizePrice * 0.6}px">Price: ৳ ${Number(item.price || 0).toFixed(2)}</div>
        ${svg}
        <div class="line code" style="font-size:11px">${escapeHtml(item.barcode)}</div>
      </div>
    `
  }).join('')

  // Continuous-roll printers feed ONE label per "page". Any top padding or
  // inter-label gap shifts content down so the first physical label(s) come
  // out blank and every label drifts. For the roll we therefore drop the
  // padding/gap and force exactly one label per page.
  const roll = layout.cols === 1 && layout.rows === 1

  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Print Labels</title>
<style>
  @page { size: ${layout.sheetW}${unit} ${layout.sheetH}${unit}; margin: 0; }
  html, body { margin: 0; padding: 0; font-family: Arial, sans-serif; color: #000; }
  /* Labels are stacked vertically — one per row — to match continuous-
     roll printers and to look identical to the on-screen preview. */
  .sheet { display: flex; flex-direction: column; align-items: center; padding: ${roll ? '0' : '3mm'}; gap: ${roll ? '0' : '1mm'}; }
  .label {
    width: ${labelW}; height: ${labelH};
    box-sizing: border-box; padding: 1mm; overflow: hidden;
    page-break-inside: avoid; text-align: center;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    ${roll ? 'page-break-after: always;' : ''}
  }
  ${roll ? '.label:last-child { page-break-after: auto; }' : ''}
  .line { line-height: 1.1; margin: 0; }
  .bold { font-weight: bold; }
  .muted { color: #444; }
  .code { font-family: 'Courier New', monospace; color: #000; font-weight: 700; letter-spacing: 0.06em; }
  .label svg { width: 95%; height: auto; max-height: 40%; }
  @media print {
    .label { border: none; }
  }
</style>
</head>
<body>
  <div class="sheet">${labelHtml}</div>
</body></html>`
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render a CODE-128 SVG string from a value using JsBarcode (server-side-style). */
function barcodeSvg(value) {
  // JsBarcode needs a real <svg> element. Build one in memory.
  const xml = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null)
  const svg = xml.documentElement
  try {
    JsBarcode(svg, String(value || ''), {
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      height: 40,
      width: 1.4,
    })
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return ''
  }
}

function IconEye() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
}
function IconPrint() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2M7 14h10v7H7z" /></svg>
}
