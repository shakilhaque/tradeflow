import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import { useDefaultPageSize } from '../../context/SettingsContext'
import {
  getProducts, getCategories, getBrands, getUnits, getLocations,
  getProduct, updateProduct, deleteProduct,
  getProductOpeningStock, saveProductOpeningStock,
} from '../../api/products'
import { getStockReport } from '../../api/inventory'
import Modal, { ModalFooter } from '../../components/ui/Modal'

const PAGE_SIZES = [10, 25, 50, 100]

const fmtMoney = (n) =>
  `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STOCK_COLUMNS = [
  { key: 'sku',                label: 'SKU' },
  { key: 'name',               label: 'Product' },
  { key: 'location',           label: 'Location' },
  { key: 'unit_price',         label: 'Unit Price' },
  { key: 'current_stock',      label: 'Current stock' },
  { key: 'stock_value_cost',   label: 'Current Stock Value (By purchase price)' },
  { key: 'stock_value_sale',   label: 'Current Stock Value (By sale price)' },
  { key: 'potential_profit',   label: 'Potential profit' },
  { key: 'units_sold',         label: 'Total unit sold' },
  { key: 'units_transferred',  label: 'Total Unit Transfered' },
  { key: 'units_adjusted',     label: 'Total Unit Adjusted' },
]

const ALL_COLUMNS = [
  { key: 'image',          label: 'Image' },
  { key: 'action',         label: 'Action' },
  { key: 'name',           label: 'Product' },
  { key: 'location',       label: 'Business Location' },
  { key: 'cost_price',     label: 'Unit Purchase Price' },
  { key: 'selling_price',  label: 'Selling Price' },
  { key: 'stock',          label: 'Current Stock' },
  { key: 'product_type',   label: 'Product Type' },
  { key: 'category',       label: 'Category' },
  { key: 'brand',          label: 'Brand' },
  { key: 'warranty',       label: 'Warranty' },
  { key: 'tax',            label: 'Tax' },
  { key: 'sku',            label: 'SKU' },
]

// Demo fallback so the page is testable when backend is offline.
const DEMO_PRODUCTS = [
  { id: 'demo-1', name: '0.5" Transparent Water Tape', sku: '246529',
    selling_price: 15, cost_price: 8, total_stock: 16,
    category_name: 'Tape & Adhesives', brand_name: 'Generic',
    unit_abbr: 'Pc(s)', product_type: 'single', tax_rate: 0, is_active: true },
  { id: 'demo-2', name: '03L Fita Exam File', sku: '246245',
    selling_price: 185, cost_price: 140, total_stock: 4,
    category_name: 'Files & Folders', brand_name: 'House Brand',
    unit_abbr: 'Pc(s)', product_type: 'single', tax_rate: 0, is_active: true },
  { id: 'demo-3', name: '1 CM Dispenser Tape', sku: '246977',
    selling_price: 10, cost_price: 4.58, total_stock: 36,
    category_name: 'Tape & Adhesives', brand_name: 'Generic',
    unit_abbr: 'Pc(s)', product_type: 'single', tax_rate: 0, is_active: true },
  { id: 'demo-4', name: '1.5 CM Dispenser Tape', sku: '249357',
    selling_price: 15, cost_price: 6.88, total_stock: 7,
    category_name: 'Tape & Adhesives', brand_name: 'Generic',
    unit_abbr: 'Pc(s)', product_type: 'single', tax_rate: 0, is_active: true },
  { id: 'demo-5', name: '10 No Chipa Tali Khata', sku: '247215',
    selling_price: 50, cost_price: 30, total_stock: 6,
    category_name: 'Stationery', brand_name: 'OEM',
    unit_abbr: 'Pc(s)', product_type: 'single', tax_rate: 0, is_active: true },
]

function StockPill({ qty, abbr }) {
  if (qty == null) return <span className="text-slate-400">—</span>
  if (qty <= 0) return <Badge variant="red">Out</Badge>
  if (qty <= 5) return <Badge variant="yellow">{qty} {abbr || ''}</Badge>
  return <span className="text-sm font-medium text-slate-800">{Number(qty)} {abbr || ''}</span>
}

function ProductImagePlaceholder({ name }) {
  const initials = String(name || '?').split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-100 to-sky-100 text-xs font-semibold text-indigo-700">
      {initials}
    </div>
  )
}

function ActionMenu({ row, navigate, onOpeningStock, onView, onDelete }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const close = () => setOpen(false)

  // Same brand-blue chip + portal-rendered dropdown as every other
  // list-page Actions menu (AllSales / Shipments / SellReturns /
  // ExpensesList). Portal lifts the menu out of the table's
  // overflow-x-auto wrapper so it never gets clipped.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 180
      const spaceBelow = window.innerHeight - r.bottom
      const top = spaceBelow >= MENU_H ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 176
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setOpen(true)
  }

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
            className="fixed z-[70] w-56 overflow-hidden rounded-lg border border-gray-100 bg-white shadow-pop"
          >
            <button onClick={() => { close(); onView?.(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">👁 View</button>
            <button onClick={() => { close(); navigate(`/products/${row.id}/edit`) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">✏ Edit</button>
            <button onClick={() => { close(); navigate(`/products/${row.id}/stock-history`) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">📊 Product Stock History</button>
            <button onClick={() => { close(); onOpeningStock?.(row) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">📦 Add or Edit Opening Stock</button>
            <button onClick={() => { close(); navigate(`/products/print-labels?id=${row.id}`) }} className="block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50">🏷 Print Label</button>
            <button onClick={() => { close(); onDelete?.(row) }} className="block w-full px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50">🗑 Delete</button>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

export default function ProductsListPage() {
  const navigate = useNavigate()

  // Selected row for the "Add or Edit Opening Stock" modal — set by
  // the ActionMenu, cleared on modal close.
  const [openingStockRow, setOpeningStockRow] = useState(null)
  // Selected row for the View-product modal (Actions → View).
  const [viewRow, setViewRow] = useState(null)
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [brands, setBrands] = useState([])
  const [units, setUnits] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [filters, setFilters] = useState({
    product_type: '',
    category_id: '',
    unit_id: '',
    tax_rate: '',
    brand_id: '',
    location_id: '',
    not_for_selling: false,
  })

  const [page, setPage] = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])
  const [tab, setTab] = useState('all')   // all | stock
  const [visibleCols, setVisibleCols] = useState(() => ALL_COLUMNS.map((c) => c.key))
  const [stockCols, setStockCols] = useState(() => STOCK_COLUMNS.map((c) => c.key))
  const [showCols, setShowCols] = useState(false)

  // ── Bulk-action state ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg,  setBulkMsg]  = useState('')
  const [locModal, setLocModal] = useState(null)   // null | 'add' | 'remove'
  const [locChoice, setLocChoice] = useState('')

  const toggleSelected = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  const clearSelection = () => setSelectedIds(new Set())

  const loadMaster = useCallback(async () => {
    try {
      const [cats, brnds, unts, locs] = await Promise.all([
        getCategories(), getBrands(), getUnits(), getLocations(true),
      ])
      setCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
      setBrands(Array.isArray(brnds) ? brnds : (brnds?.results ?? []))
      setUnits(Array.isArray(unts) ? unts : (unts?.results ?? []))
      // Don't auto-apply a location filter. The backend's location filter
      // only returns products that already have stock history at that
      // location, which silently hides freshly-added products (e.g. ones
      // only on a not-yet-received purchase). The All Products list should
      // show EVERY product; the operator can pick a location explicitly.
      { const _l = Array.isArray(locs) ? locs : (locs?.results ?? []); setLocations(_l) }
    } catch { /* ignore */ }
  }, [])

  const loadProducts = useCallback(async (silent = false) => {
    // Background polls / focus refreshes pass silent=true so the list never
    // flashes the loading skeleton (which scrambled the view mid-read).
    if (!silent) setLoading(true)
    setLoadError('')
    try {
      // Push EVERY filter the operator can see through to the API
      // so the result set (and the Stock Report tab) honour them.
      // Before this commit only search/category/brand were passed
      // → location and unit dropdowns silently did nothing.
      const params = {}
      if (search) params.search = search
      if (filters.category_id)  params.category_id  = filters.category_id
      if (filters.brand_id)     params.brand_id     = filters.brand_id
      if (filters.unit_id)      params.unit_id      = filters.unit_id
      // Location filter ONLY scopes the Stock Report tab. The All Products
      // catalogue must always list every product the tenant owns — the
      // backend's location filter is an inner-join that hides products with
      // no stock history at that branch, which made freshly-imported "Out"
      // products appear on load then vanish on the next fetch. Works for
      // every tenant since it's a shared code path.
      if (filters.location_id && tab === 'stock') params.location_id = filters.location_id
      if (filters.product_type) params.product_type = filters.product_type
      const data = await getProducts(params)
      const arr = Array.isArray(data) ? data : (data?.results ?? [])
      setProducts(arr)
    } catch (err) {
      setProducts(DEMO_PRODUCTS)
      setLoadError(`${err?.message || 'Failed to load products'} — showing demo data so the UI remains testable.`)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [search, filters.category_id, filters.brand_id, filters.unit_id, filters.location_id, filters.product_type, tab])

  useEffect(() => { loadMaster() }, [loadMaster])
  useEffect(() => { loadProducts() }, [loadProducts])

  // Re-fetch the product list when the operator switches to the
  // Stock Report tab — guarantees Current Stock + Units Sold /
  // Transferred / Adjusted reflect every sale, transfer or
  // adjustment that landed since the page first loaded. The backend
  // computes these live from the StockMovement ledger, so this is a
  // single GET with no extra moving parts.
  useEffect(() => {
    if (tab === 'stock') loadProducts()
  }, [tab, loadProducts])

  // Real-time refresh — Current Stock must move when a purchase /
  // sale / transfer lands from another tab or operator. Three
  // triggers, same loader:
  //   1. 30-second polling while the tab is visible.
  //   2. visibilitychange — refetch the instant the operator
  //      returns to this tab (covers the "made a purchase in the
  //      other tab, switched back" flow without waiting 30 s).
  //   3. window focus — same idea for alt-tab between windows.
  useEffect(() => {
    let id = null
    const start = () => { if (id) return; id = setInterval(() => { if (!document.hidden) loadProducts(true) }, 30000) }
    const stop  = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { loadProducts(true); start() } }
    const onFocus = () => { if (!document.hidden) loadProducts(true) }
    start()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadProducts])

  // Client-side filters not supported by the backend yet
  const filteredProducts = useMemo(() => {
    let arr = products
    if (filters.product_type) arr = arr.filter((p) => p.product_type === filters.product_type)
    if (filters.tax_rate) arr = arr.filter((p) => Number(p.tax_rate || 0) === Number(filters.tax_rate))
    if (filters.not_for_selling) arr = arr.filter((p) => p.not_for_selling)
    return arr
  }, [products, filters.product_type, filters.tax_rate, filters.not_for_selling])

  const total = filteredProducts.length
  const totalPages = Math.max(Math.ceil(total / limit), 1)
  const pageStart = (page - 1) * limit
  const visibleRows = filteredProducts.slice(pageStart, pageStart + limit)

  const visibleSet = new Set(visibleCols)
  const show = (key) => visibleSet.has(key)

  // ── Stock Report data ─────────────────────────────────────────────────────
  // When the operator picks a Business Location filter, every row's
  // "Location" column should show THAT location — not whatever
  // location happened to come back first from the API. The cell
  // used to hardcode `locations[0]?.name` which was always the
  // first location alphabetically (the source of the screenshot
  // bug where "Ongko Stationary" filter showed "Ongko Computer").
  const filterLocName = useMemo(() => {
    if (!filters.location_id) return ''
    return locations.find((l) => l.id === filters.location_id)?.name || ''
  }, [filters.location_id, locations])
  const stockRows = useMemo(() => filteredProducts.map((p) => {
    const qty   = Number(p.total_stock || 0)
    const cost  = Number(p.cost_price || 0)
    const sale  = Number(p.selling_price || 0)
    const stockValueCost = qty * cost
    const stockValueSale = qty * sale
    return {
      id: p.id,
      sku: p.sku || '—',
      name: p.name,
      // 1. Prefer whatever the API attaches.
      // 2. Then the active filter's name (matches what the operator
      //    just picked).
      // 3. Then fall back to a hyphen instead of a misleading
      //    first-alphabetical location.
      location: (filterLocName || (Array.isArray(p.location_names) && p.location_names.length ? p.location_names.join(', ') : '—')),
      // Prefer the full Unit.name ("Pieces") over the abbreviation
      // ("pc") on the Stock Report tab — matches what the user
      // expects on the All Products + Stock Report cells. Falls
      // back to the abbreviation only when the unit row has no
      // long name set (legacy data).
      unit: p.unit_name || p.unit_abbr || '',
      unit_price: cost,
      current_stock: qty,
      stock_value_cost: stockValueCost,
      stock_value_sale: stockValueSale,
      potential_profit: stockValueSale - stockValueCost,
      units_sold:        Number(p.units_sold        || 0),
      units_transferred: Number(p.units_transferred || 0),
      units_adjusted:    Number(p.units_adjusted    || 0),
    }
  }), [filteredProducts, locations, filterLocName])

  const stockVisible = stockRows.slice(pageStart, pageStart + limit)
  const stockTotals = useMemo(() => stockRows.reduce((acc, r) => ({
    current_stock:     acc.current_stock     + r.current_stock,
    stock_value_cost:  acc.stock_value_cost  + r.stock_value_cost,
    stock_value_sale:  acc.stock_value_sale  + r.stock_value_sale,
    potential_profit:  acc.potential_profit  + r.potential_profit,
    units_sold:        acc.units_sold        + r.units_sold,
    units_transferred: acc.units_transferred + r.units_transferred,
    units_adjusted:    acc.units_adjusted    + r.units_adjusted,
  }), {
    current_stock: 0, stock_value_cost: 0, stock_value_sale: 0,
    potential_profit: 0, units_sold: 0, units_transferred: 0, units_adjusted: 0,
  }), [stockRows])
  const stockShow = (k) => stockCols.includes(k)

  // ── Exports ───────────────────────────────────────────────────────────────
  const exportStockCsv = () => {
    const cols = STOCK_COLUMNS.filter((c) => stockShow(c.key))
    const head = cols.map((c) => `"${c.label}"`).join(',')
    const body = stockRows.map((r) => cols.map((c) => {
      const v = r[c.key]
      return typeof v === 'number' ? v : `"${String(v ?? '').replace(/"/g, '""')}"`
    }).join(',')).join('\n')
    const blob = new Blob([`${head}\n${body}\n`], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'stock-report.csv'; a.click()
    URL.revokeObjectURL(url)
  }
  const exportStockXls = () => {
    // Simple Excel-compatible CSV with .xls extension — Excel opens it natively.
    const cols = STOCK_COLUMNS.filter((c) => stockShow(c.key))
    const head = cols.map((c) => c.label).join('\t')
    const body = stockRows.map((r) => cols.map((c) => r[c.key] ?? '').join('\t')).join('\n')
    const blob = new Blob([`${head}\n${body}\n`], { type: 'application/vnd.ms-excel' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'stock-report.xls'; a.click()
    URL.revokeObjectURL(url)
  }
  // Clean tabular printable report — used by both the Print and the
  // Export PDF buttons. Opens a NEW window with only the data so the
  // app chrome (filters / sidebar / pagination) doesn't end up in
  // the PDF. The browser's Save-as-PDF target on that popup gives
  // the tenant the actual file.
  const exportStockPdf = () => {
    const cols = STOCK_COLUMNS.filter((c) => stockShow(c.key))
    const win  = window.open('', '_blank', 'width=1400,height=900')
    if (!win) { window.alert('Allow popups to export this report.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const numericKeys = new Set([
      'unit_price', 'current_stock', 'stock_value_cost', 'stock_value_sale',
      'potential_profit', 'units_sold', 'units_transferred', 'units_adjusted',
    ])
    const rowsHtml = stockRows.map((r) => (
      '<tr>' + cols.map((c) => {
        const v = formatCell(c.key, r[c.key])
        return `<td${numericKeys.has(c.key) ? ' class="num"' : ''}>${esc(v)}</td>`
      }).join('') + '</tr>'
    )).join('')
    const totalsCols = cols.map((c) => {
      if (c.key === 'sku' || c.key === 'name' || c.key === 'product') return '<td><b>Total</b></td>'
      if (numericKeys.has(c.key)) return `<td class="num"><b>${esc(formatCell(c.key, stockTotals[c.key] ?? 0))}</b></td>`
      return '<td></td>'
    }).join('')
    const fromTo = filterLocName ? `Location: ${filterLocName}` : 'All locations'
    win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>Stock Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 16mm 10mm; color: #111827; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #f3f4f6; color: #374151; text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
  tbody td { padding: 6px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { background: #ecfdf5; border-top: 2px solid #10b981; }
  .footer { margin-top: 8px; color: #9ca3af; font-size: 10px; text-align: right; }
  @page { size: A4 landscape; margin: 8mm; }
</style></head>
<body>
  <h1>Stock Report</h1>
  <div class="meta">${esc(fromTo)} · Rows: <b>${stockRows.length}</b> · Generated: ${new Date().toLocaleString()}</div>
  <table>
    <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="${cols.length}" style="text-align:center;color:#9ca3af;padding:24px">No rows for the current filters.</td></tr>`}</tbody>
    ${stockRows.length ? `<tfoot><tr>${totalsCols}</tr></tfoot>` : ''}
  </table>
  <div class="footer">Stock Report — generated by the system.</div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100) }</script>
</body></html>`)
    win.document.close()
  }

  // Print/PDF for the All Products tab — clean tabular window with
  // every visible column.
  const printAllProducts = () => {
    // Drop the visual-only columns (Image chip + Action menu); keep
    // everything else the operator can see on screen.
    const cols = ALL_COLUMNS.filter((c) => show(c.key) && c.key !== 'image' && c.key !== 'action')
    const win = window.open('', '_blank', 'width=1400,height=900')
    if (!win) { window.alert('Allow popups to export this report.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const cellFor = (p, key) => {
      switch (key) {
        case 'name':          return `${p.name || ''}${p.unit_abbr ? ` (per ${p.unit_abbr})` : ''}`
        case 'location':      return (filterLocName || (Array.isArray(p.location_names) && p.location_names.length ? p.location_names.join(', ') : '—'))
        case 'cost_price':    return Number(p.cost_price || 0).toFixed(2)
        case 'selling_price': return Number(p.selling_price || 0).toFixed(2)
        case 'stock':         return `${Number(p.total_stock || 0).toFixed(2)} ${p.unit_abbr || ''}`
        case 'product_type':  return (p.product_type || 'single').toString().toUpperCase()
        case 'category':      return p.category_name || '—'
        case 'brand':         return p.brand_name || '—'
        case 'tax':           return `${Number(p.tax_rate || 0).toFixed(2)}%`
        case 'sku':           return p.sku || '—'
        default:              return p[key] ?? '—'
      }
    }
    const numericKeys = new Set(['cost_price', 'selling_price', 'stock', 'tax'])
    const rowsHtml = visibleRows.map((p) => (
      '<tr>' + cols.map((c) => `<td${numericKeys.has(c.key) ? ' class="num"' : ''}>${esc(cellFor(p, c.key))}</td>`).join('') + '</tr>'
    )).join('')
    win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>Products</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 16mm 10mm; color: #111827; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #f3f4f6; color: #374151; text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
  tbody td { padding: 6px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .footer { margin-top: 8px; color: #9ca3af; font-size: 10px; text-align: right; }
  @page { size: A4 landscape; margin: 8mm; }
</style></head>
<body>
  <h1>Products</h1>
  <div class="meta">${esc(filterLocName || 'All locations')} · Rows: <b>${visibleRows.length}</b> · Generated: ${new Date().toLocaleString()}</div>
  <table>
    <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="${cols.length}" style="text-align:center;color:#9ca3af;padding:24px">No rows for the current filters.</td></tr>`}</tbody>
  </table>
  <div class="footer">Products — generated by the system.</div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100) }</script>
</body></html>`)
    win.document.close()
  }

  // ── Bulk-action handlers ──────────────────────────────────────────────────
  const idList = useMemo(() => Array.from(selectedIds), [selectedIds])

  const runBulk = async (label, fn, { reload = true, clear = true } = {}) => {
    if (idList.length === 0) {
      setBulkMsg('Select at least one product first.')
      return
    }
    setBulkBusy(true); setBulkMsg('')
    let ok = 0, fail = 0
    for (const pid of idList) {
      try { await fn(pid); ok += 1 }
      catch { fail += 1 }
    }
    setBulkBusy(false)
    setBulkMsg(`${label}: ${ok} ok${fail ? `, ${fail} failed` : ''}.`)
    if (clear) clearSelection()
    if (reload) loadProducts()
  }

  const bulkDelete = () => {
    if (!window.confirm(`Delete ${idList.length} selected product(s)? They will be hidden from active lists but past sales/purchases keep their reference.`)) return
    runBulk('Deleted', (pid) => deleteProduct(pid))
  }

  // Row-level delete from the Actions menu — was previously a dead
  // button that only closed the dropdown. Soft-deletes on the backend
  // (is_active=false) so past sales/purchases keep their reference.
  const handleDeleteProduct = async (row) => {
    if (!window.confirm(`Delete "${row.name}"? It will be hidden from active lists; past sales/purchases keep their reference.`)) return
    try {
      await deleteProduct(row.id)
      loadProducts()
    } catch (err) {
      window.alert(err?.message || 'Failed to delete product.')
    }
  }
  const bulkDeactivate = () => {
    if (!window.confirm(`Deactivate ${idList.length} selected product(s)?`)) return
    runBulk('Deactivated', (pid) => updateProduct(pid, { is_active: false }))
  }
  const applyLocationChange = async (mode) => {
    if (!locChoice) { setBulkMsg('Pick a location first.'); return }
    setLocModal(null)
    const indexById = new Map(products.map((p) => [p.id, p]))
    await runBulk(mode === 'add' ? 'Added to location' : 'Removed from location', async (pid) => {
      const p = indexById.get(pid) || {}
      const existing = Array.isArray(p.meta?.business_locations) ? p.meta.business_locations : []
      const next = mode === 'add'
        ? Array.from(new Set([...existing, locChoice]))
        : existing.filter((x) => x !== locChoice)
      await updateProduct(pid, { meta: { ...(p.meta || {}), business_locations: next } })
    })
    setLocChoice('')
  }

  const resetFilters = () => {
    setSearch('')
    setFilters({
      product_type: '',
      category_id: '',
      unit_id: '',
      tax_rate: '',
      brand_id: '',
      location_id: '',
      not_for_selling: false,
    })
    setPage(1)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-5 py-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Products</h1>
            <p className="mt-1 text-sm text-emerald-50">Manage your product catalogue</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate('/products/new')}>+ Add Product</Button>
            <Button variant="secondary" onClick={() => navigate('/products/import')}>Import Products</Button>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-200 text-xs font-bold text-amber-800">!</span>
          <span>{loadError}</span>
        </div>
      )}

      {/* Filters */}
      <Card padding="p-4">
        <div className="mb-3 flex items-center justify-between">
          <button type="button" onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <FunnelIcon /> Filters
            <svg className={`h-4 w-4 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          <button onClick={resetFilters} className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
            Reset
          </button>
        </div>
        <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 ${filtersOpen ? '' : 'hidden'}`}>
          <FilterSelect label="Product Type" value={filters.product_type}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, product_type: v })) }}>
            <option value="">All</option>
            <option value="single">Single</option>
            <option value="variable">Variable</option>
            <option value="combo">Combo</option>
          </FilterSelect>

          <FilterSelect label="Category" value={filters.category_id}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, category_id: v })) }}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </FilterSelect>

          <FilterSelect label="Unit" value={filters.unit_id}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, unit_id: v })) }}>
            <option value="">All</option>
            {units.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.abbreviation})</option>)}
          </FilterSelect>

          <FilterSelect label="Tax Rate (%)" value={filters.tax_rate}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, tax_rate: v })) }}>
            <option value="">All</option>
            <option value="0">0%</option>
            <option value="5">5%</option>
            <option value="10">10%</option>
            <option value="15">15%</option>
          </FilterSelect>

          <FilterSelect label="Brand" value={filters.brand_id}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, brand_id: v })) }}>
            <option value="">All</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </FilterSelect>

          <FilterSelect label="Business Location" value={filters.location_id}
            onChange={(v) => { setPage(1); setFilters((f) => ({ ...f, location_id: v })) }}>
            <option value="">All</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </FilterSelect>

          <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={filters.not_for_selling}
              onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, not_for_selling: e.target.checked })) }}
            />
            Not for selling
          </label>
        </div>
      </Card>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="flex gap-6">
          {[
            { id: 'all', label: 'All Products' },
            { id: 'stock', label: 'Stock Report' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                'relative -mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span>Show</span>
          <select
            value={limit}
            onChange={(e) => { setPage(1); setLimit(Number(e.target.value)) }}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>entries</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tab === 'stock' && (
            <>
              <Button variant="secondary" size="sm" onClick={exportStockCsv}>📄 Export CSV</Button>
              {/* Print + Export PDF share the SAME clean-window flow
                  so the printout never includes the app chrome. */}
              <Button variant="secondary" size="sm" onClick={exportStockXls}>📊 Export Excel</Button>
              <Button variant="secondary" size="sm" onClick={exportStockPdf}>🖨 Print</Button>
              <Button variant="secondary" size="sm" onClick={exportStockPdf}>📕 Export PDF</Button>
            </>
          )}
          {tab === 'all' && (
            <Button variant="secondary" size="sm" onClick={printAllProducts}>Print</Button>
          )}
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name or SKU…" />
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setShowCols((p) => !p)}>Column visibility ▾</Button>
            {showCols && (
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
                {(tab === 'stock' ? STOCK_COLUMNS : ALL_COLUMNS).map((col) => {
                  const checked = tab === 'stock' ? stockCols.includes(col.key) : visibleSet.has(col.key)
                  const toggle  = () => tab === 'stock'
                    ? setStockCols((prev) => prev.includes(col.key) ? prev.filter((k) => k !== col.key) : [...prev, col.key])
                    : setVisibleCols((prev) => prev.includes(col.key) ? prev.filter((k) => k !== col.key) : [...prev, col.key])
                  return (
                    <label key={col.key} className="flex items-center gap-2 py-1 text-xs text-slate-700">
                      <input type="checkbox" checked={checked} onChange={toggle} />
                      {col.label}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
          </div>
        ) : tab === 'stock' ? (
          stockRows.length === 0 ? (
            <EmptyState title="No products to report on" message="Add products to see the stock report." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {STOCK_COLUMNS.filter((c) => stockShow(c.key)).map((c) => (
                      <th key={c.key} className="px-4 py-3 align-top">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {stockVisible.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/60">
                      {stockShow('sku') && <td className="px-4 py-3 font-mono text-xs text-slate-500">{r.sku}</td>}
                      {stockShow('name') && (
                        <td className="px-4 py-3">
                          <span className="font-medium text-emerald-700 hover:underline cursor-pointer"
                                onClick={() => navigate(`/products/${r.id}`)}>{r.name}</span>
                        </td>
                      )}
                      {stockShow('location') && <td className="px-4 py-3 text-slate-600">{r.location || '—'}</td>}
                      {stockShow('unit_price') && <td className="px-4 py-3 text-right text-slate-700">{fmtMoney(r.unit_price)}</td>}
                      {stockShow('current_stock') && (
                        <td className="px-4 py-3">
                          {/* Show the real number even when it's 0 —
                              "—" was masking products that ARE in
                              stock (FIFO might have 0 in one location
                              but not be missing data). Format with 2
                              decimals like the rest of the report. */}
                          <span className={Number(r.current_stock) <= 0 ? 'text-rose-600 font-semibold' : 'text-slate-800'}>
                            {Number(r.current_stock).toFixed(2)} {r.unit}
                          </span>
                        </td>
                      )}
                      {stockShow('stock_value_cost') && <td className="px-4 py-3 text-right text-slate-700">{fmtMoney(r.stock_value_cost)}</td>}
                      {stockShow('stock_value_sale') && <td className="px-4 py-3 text-right text-slate-700">{fmtMoney(r.stock_value_sale)}</td>}
                      {stockShow('potential_profit') && (
                        <td className={`px-4 py-3 text-right font-medium ${r.potential_profit >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {fmtMoney(r.potential_profit)}
                        </td>
                      )}
                      {stockShow('units_sold')        && <td className="px-4 py-3 text-slate-700">{Number(r.units_sold).toFixed(2)} {r.unit}</td>}
                      {stockShow('units_transferred') && <td className="px-4 py-3 text-slate-700">{Number(r.units_transferred).toFixed(2)} {r.unit}</td>}
                      {stockShow('units_adjusted')    && <td className="px-4 py-3 text-slate-700">{Number(r.units_adjusted).toFixed(2)} {r.unit}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-100 text-sm font-semibold text-slate-800">
                    {STOCK_COLUMNS.filter((c) => stockShow(c.key)).map((c, i, arr) => {
                      const labelCols = ['sku','name','location','unit_price']
                      const isLastLabel = labelCols.includes(c.key) && (i + 1 === arr.length || !labelCols.includes(arr[i + 1]?.key))
                      if (labelCols.includes(c.key)) {
                        return <td key={c.key} className="px-4 py-3 text-right">{isLastLabel ? 'Total:' : ''}</td>
                      }
                      const v = stockTotals[c.key] ?? 0
                      const isMoney = ['stock_value_cost','stock_value_sale','potential_profit'].includes(c.key)
                      return <td key={c.key} className={`px-4 py-3 ${isMoney ? 'text-right' : ''}`}>
                        {isMoney ? fmtMoney(v) : Number(v).toFixed(2)}
                      </td>
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : visibleRows.length === 0 ? (
          <EmptyState
            title="No products found"
            message="Try adjusting your search or filters, or add a new product."
            action={<Button onClick={() => navigate('/products/new')} size="sm">+ Add Product</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={visibleRows.length > 0 && visibleRows.every((r) => selectedIds.has(r.id))}
                      onChange={(e) => {
                        const next = new Set(selectedIds)
                        if (e.target.checked) visibleRows.forEach((r) => next.add(r.id))
                        else                  visibleRows.forEach((r) => next.delete(r.id))
                        setSelectedIds(next)
                      }}
                    />
                  </th>
                  {ALL_COLUMNS.filter((c) => show(c.key)).map((c) => (
                    <th key={c.key} className="px-4 py-3">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((p) => (
                  <tr key={p.id} className={`hover:bg-slate-50/60 ${selectedIds.has(p.id) ? 'bg-indigo-50/40' : ''}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.id)}
                        onChange={() => toggleSelected(p.id)}
                      />
                    </td>
                    {show('image') && (
                      <td className="px-4 py-3">
                        {p.image_url
                          ? <img src={p.image_url} alt="" className="h-10 w-10 rounded-lg object-cover" />
                          : <ProductImagePlaceholder name={p.name} />}
                      </td>
                    )}
                    {show('action') && <td className="px-4 py-3"><ActionMenu row={p} navigate={navigate} onOpeningStock={(prod) => setOpeningStockRow(prod)} onView={(prod) => setViewRow(prod)} onDelete={(prod) => handleDeleteProduct(prod)} /></td>}
                    {show('name') && (
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        {p.unit_abbr && <div className="text-xs text-slate-400">per {p.unit_abbr}</div>}
                      </td>
                    )}
                    {show('location') && (
                      <td className="px-4 py-3 text-slate-600">
                        {/* Names come live from the backend serializer
                            (`location_names` — derived from
                            ProductStock + FIFOLayer location FKs).
                            When the tenant has picked a specific
                            Business Location filter we surface that
                            one only so the column matches the table
                            scope; otherwise we render every active
                            location the product touches — no
                            hardcoded fallback. */}
                        {Array.isArray(p.location_names) && p.location_names.length > 0
                          ? (filterLocName || p.location_names.join(', '))
                          : (filterLocName || '—')}
                      </td>
                    )}
                    {show('cost_price') && <td className="px-4 py-3 text-right text-slate-700">{fmtMoney(p.cost_price)}</td>}
                    {show('selling_price') && <td className="px-4 py-3 text-right font-medium text-slate-900">{fmtMoney(p.selling_price)}</td>}
                    {show('stock') && <td className="px-4 py-3"><StockPill qty={p.total_stock} abbr={p.unit_name || p.unit_abbr} /></td>}
                    {show('product_type') && (
                      <td className="px-4 py-3">
                        <Badge variant={p.product_type === 'variable' ? 'yellow' : 'gray'}>
                          {(p.product_type || 'single').toUpperCase()}
                        </Badge>
                      </td>
                    )}
                    {show('category') && <td className="px-4 py-3 text-slate-600">{p.category_name || '—'}</td>}
                    {show('brand') && <td className="px-4 py-3 text-slate-600">{p.brand_name || '—'}</td>}
                    {show('warranty') && (
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                        {p.warranty_name
                          ? <>{p.warranty_name}{p.warranty_label ? <span className="text-slate-400"> · {p.warranty_label}</span> : null}</>
                          : '—'}
                      </td>
                    )}
                    {show('tax') && <td className="px-4 py-3 text-slate-600">{p.tax_rate ? `${p.tax_rate}%` : '—'}</td>}
                    {show('sku') && <td className="px-4 py-3 font-mono text-xs text-slate-500">{p.sku || '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
          <div className="text-xs text-slate-500">
            Showing {Math.min(pageStart + 1, total)} to {Math.min(pageStart + limit, total)} of {total} entries
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
            <span className="text-sm text-slate-500">Page {page} of {totalPages}</span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      </Card>

      {/* Bulk-action footer */}
      {tab === 'all' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            {selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : 'Tick rows to bulk-edit.'}
          </span>
          <Button variant="secondary" size="sm"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={bulkDelete}>
            Delete Selected
          </Button>
          <Button variant="secondary" size="sm"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={() => { setLocChoice(''); setLocModal('add') }}>
            Add to location
          </Button>
          <Button variant="secondary" size="sm"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={() => { setLocChoice(''); setLocModal('remove') }}>
            Remove from location
          </Button>
          <Button variant="secondary" size="sm"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={bulkDeactivate}>
            Deactivate Selected
          </Button>
          {selectedIds.size > 0 && (
            <button onClick={clearSelection}
                    className="text-xs font-medium text-slate-500 hover:text-slate-700">
              Clear selection
            </button>
          )}
          {bulkMsg && (
            <span className="ml-auto text-xs text-slate-600">{bulkMsg}</span>
          )}
        </div>
      )}

      {/* Location-picker modal — shared between Add to / Remove from */}
      {locModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">
              {locModal === 'add' ? 'Add to location' : 'Remove from location'}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Apply to {selectedIds.size} selected product{selectedIds.size === 1 ? '' : 's'}.
              {locModal === 'add'
                ? ' The location will be added to each product\'s business-location list.'
                : ' The location will be removed from each product\'s business-location list.'}
            </p>
            <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">Location</label>
            <select value={locChoice}
                    onChange={(e) => setLocChoice(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
              <option value="">— Choose a location —</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setLocModal(null)}>Cancel</Button>
              <Button size="sm" disabled={!locChoice || bulkBusy}
                      onClick={() => applyLocationChange(locModal)}>
                {locModal === 'add' ? 'Add' : 'Remove'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {openingStockRow && (
        <OpeningStockModal
          product={openingStockRow}
          onClose={() => setOpeningStockRow(null)}
        />
      )}

      {viewRow && (
        <ViewProductModal
          row={viewRow}
          onClose={() => setViewRow(null)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ViewProductModal — Actions → View. Fetches the product detail AND the
// per-location stock snapshot fresh from the API every time it opens
// (and re-fetches every 30 s while open), so the figures are live —
// never the possibly-stale list row.
// ─────────────────────────────────────────────────────────────────────────
function ViewProductModal({ row, onClose }) {
  const [product, setProduct]     = useState(null)
  const [stockRows, setStockRows] = useState([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const [p, stock] = await Promise.all([
        getProduct(row.id),
        getStockReport({ product_id: row.id }),
      ])
      setProduct(p)
      setStockRows(Array.isArray(stock?.items) ? stock.items : [])
    } catch (e) {
      setErr(e?.message || 'Failed to load product details.')
    } finally {
      setLoading(false)
    }
  }, [row.id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => clearInterval(id)
  }, [load])

  const p = product || row
  const taxRate  = Number(p.tax_rate || 0)
  const cost     = Number(p.cost_price || 0)
  const sale     = Number(p.selling_price || 0)
  const taxMult  = 1 + taxRate / 100
  // Exclusive tax → Inc = Exc × (1 + rate). Inclusive tax → the stored
  // price already includes tax, so Exc = price / (1 + rate).
  const inclusive = p.tax_type === 'inclusive'
  const costExc = inclusive ? cost / taxMult : cost
  const costInc = inclusive ? cost : cost * taxMult
  const saleExc = inclusive ? sale / taxMult : sale
  const saleInc = inclusive ? sale : sale * taxMult
  const margin  = costExc > 0 ? ((saleExc - costExc) / costExc) * 100 : 0

  const locationNames = stockRows.length
    ? [...new Set(stockRows.map((r) => r.location))].join(', ')
    : (Array.isArray(p.location_names) ? p.location_names.join(', ') : '—')

  const manageStock = (p.meta?.manage_stock ?? true) !== false
  const alertQty    = p.meta?.alert_qty ?? p.reorder_level ?? null

  const fmtQty = (n) => Number(n || 0).toFixed(2)
  const unitLbl = p.unit_name || p.unit_abbr || p.unit || ''

  const handlePrint = () => {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const w = window.open('', '_blank', 'width=1100,height=800')
    if (!w) { window.alert('Allow popups to print.'); return }
    const stockTr = stockRows.map((r) => `<tr>
      <td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(r.location)}</td>
      <td class="num">${fmtMoney(r.unit_price)}</td>
      <td class="num">${fmtQty(r.qty)} ${esc(unitLbl)}</td>
      <td class="num">${fmtMoney(Number(r.qty || 0) * Number(r.unit_price || 0))}</td>
      <td class="num">${fmtQty(r.total_unit_sold)} ${esc(unitLbl)}</td>
      <td class="num">${fmtQty(r.total_unit_transferred)} ${esc(unitLbl)}</td>
      <td class="num">${fmtQty(r.total_unit_adjusted)} ${esc(unitLbl)}</td>
    </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:#9ca3af">No stock rows.</td></tr>'
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)}</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:10mm;font-size:11px}
  h1{font-size:16px;margin:0 0 10px}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 20px;margin-bottom:12px;font-size:11px}
  table{width:100%;border-collapse:collapse;font-size:10px;margin-top:8px}
  th{background:#10b981;color:#fff;text-align:left;padding:5px 7px;border:1px solid #0f9971}
  td{padding:4px 7px;border:1px solid #e5e7eb}
  .num{text-align:right;white-space:nowrap}
  h3{font-size:11px;margin:14px 0 4px}
  @page{size:A4 landscape;margin:8mm}
</style></head><body>
<h1>${esc(p.name)}</h1>
<div class="grid">
  <div><b>SKU:</b> ${esc(p.sku)}</div><div><b>Category:</b> ${esc(p.category_name || '—')}</div><div><b>Applicable Tax:</b> ${taxRate ? taxRate + '%' : 'None'}</div>
  <div><b>Brand:</b> ${esc(p.brand_name || '—')}</div><div><b>Sub category:</b> ${esc(p.subcategory_name || '—')}</div><div><b>Selling Price Tax Type:</b> ${esc(p.tax_type || 'exclusive')}</div>
  <div><b>Unit:</b> ${esc(unitLbl)}</div><div><b>Manage Stock?:</b> ${manageStock ? 'Yes' : 'No'}</div><div><b>Product Type:</b> ${esc(p.product_type || 'single')}</div>
  <div><b>Barcode Type:</b> ${esc(p.barcode_type || 'C128')}</div><div><b>Alert quantity:</b> ${alertQty ?? '—'}</div><div><b>Available in locations:</b> ${esc(locationNames)}</div>
</div>
<table><thead><tr><th>Purchase Price (Exc. tax)</th><th>Purchase Price (Inc. tax)</th><th>x Margin(%)</th><th>Selling Price (Exc. tax)</th><th>Selling Price (Inc. tax)</th></tr></thead>
<tbody><tr><td class="num">${fmtMoney(costExc)}</td><td class="num">${fmtMoney(costInc)}</td><td class="num">${margin.toFixed(2)}</td><td class="num">${fmtMoney(saleExc)}</td><td class="num">${fmtMoney(saleInc)}</td></tr></tbody></table>
<h3>Product Stock Details</h3>
<table><thead><tr><th>SKU</th><th>Product</th><th>Location</th><th>Unit Price</th><th>Current stock</th><th>Current Stock Value</th><th>Total unit sold</th><th>Total Unit Transferred</th><th>Total Unit Adjusted</th></tr></thead>
<tbody>${stockTr}</tbody></table>
<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`)
    w.document.close()
  }

  const Info = ({ k, v }) => (
    <div className="text-xs text-gray-700"><span className="font-semibold text-gray-800">{k}:</span> {v ?? '—'}</div>
  )

  return (
    <Modal open onClose={onClose} title={p.name} size="2xl">
      {loading ? (
        <div className="py-10 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {err && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">{err}</div>}

          {/* Header info — 3 columns + image */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="space-y-1">
              <Info k="SKU" v={p.sku} />
              <Info k="Brand" v={p.brand_name || '—'} />
              <Info k="Unit" v={unitLbl || '—'} />
              <Info k="Barcode Type" v={p.barcode_type || 'C128'} />
              <Info k="Available in locations" v={locationNames} />
            </div>
            <div className="space-y-1">
              <Info k="Category" v={p.category_name || '—'} />
              <Info k="Sub category" v={p.subcategory_name || '—'} />
              <Info k="Manage Stock?" v={manageStock ? 'Yes' : 'No'} />
              <Info k="Alert quantity" v={alertQty ?? '—'} />
            </div>
            <div className="space-y-1">
              <Info k="Expires in" v="Not Applicable" />
              <Info k="Applicable Tax" v={taxRate ? `${taxRate}%` : 'None'} />
              <Info k="Selling Price Tax Type" v={(p.tax_type || 'exclusive').replace(/^./, (c) => c.toUpperCase())} />
              <Info k="Product Type" v={(p.product_type || 'single').replace(/^./, (c) => c.toUpperCase())} />
            </div>
            <div className="flex items-start justify-end">
              {p.image_url ? (
                <img src={p.image_url} alt={p.name} className="h-24 w-24 rounded border border-gray-200 object-cover" />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400">No image</div>
              )}
            </div>
          </div>

          {/* Price table */}
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-emerald-500 text-left text-white">
                  <th className="px-3 py-2 font-semibold">Purchase Price (Exc. tax)</th>
                  <th className="px-3 py-2 font-semibold">Purchase Price (Inc. tax)</th>
                  <th className="px-3 py-2 font-semibold">x Margin(%)</th>
                  <th className="px-3 py-2 font-semibold">Selling Price (Exc. tax)</th>
                  <th className="px-3 py-2 font-semibold">Selling Price (Inc. tax)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-gray-50">
                  <td className="px-3 py-2">{fmtMoney(costExc)}</td>
                  <td className="px-3 py-2">{fmtMoney(costInc)}</td>
                  <td className="px-3 py-2">{margin.toFixed(2)}</td>
                  <td className="px-3 py-2">{fmtMoney(saleExc)}</td>
                  <td className="px-3 py-2">{fmtMoney(saleInc)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Stock details */}
          <div>
            <h4 className="mb-1 text-xs font-bold text-gray-700">Product Stock Details</h4>
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-emerald-500 text-left text-white">
                    <th className="px-3 py-2 font-semibold">SKU</th>
                    <th className="px-3 py-2 font-semibold">Product</th>
                    <th className="px-3 py-2 font-semibold">Location</th>
                    <th className="px-3 py-2 font-semibold">Unit Price</th>
                    <th className="px-3 py-2 font-semibold">Current stock</th>
                    <th className="px-3 py-2 font-semibold">Current Stock Value</th>
                    <th className="px-3 py-2 font-semibold">Total unit sold</th>
                    <th className="px-3 py-2 font-semibold">Total Unit Transferred</th>
                    <th className="px-3 py-2 font-semibold">Total Unit Adjusted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stockRows.length === 0 ? (
                    <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">No stock recorded yet.</td></tr>
                  ) : stockRows.map((r, i) => (
                    <tr key={i} className="bg-gray-50/50">
                      <td className="px-3 py-2">{p.sku}</td>
                      <td className="px-3 py-2">{p.name}</td>
                      <td className="px-3 py-2">{r.location}</td>
                      <td className="px-3 py-2">{fmtMoney(r.unit_price)}</td>
                      <td className="px-3 py-2">{fmtQty(r.qty)} {unitLbl}</td>
                      <td className="px-3 py-2">{fmtMoney(Number(r.qty || 0) * Number(r.unit_price || 0))}</td>
                      <td className="px-3 py-2">{fmtQty(r.total_unit_sold)} {unitLbl}</td>
                      <td className="px-3 py-2">{fmtQty(r.total_unit_transferred)} {unitLbl}</td>
                      <td className="px-3 py-2">{fmtQty(r.total_unit_adjusted)} {unitLbl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <ModalFooter>
        <Button onClick={handlePrint}>🖨 Print</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OpeningStockModal — fetches GET /api/inventory/products/<id>/opening-stock/
// (per-location rows), lets the tenant edit qty / unit_cost / date / note
// per location, then POSTs the rows back. Save calls add_stock_fifo on
// the backend so ProductStock + StockMovement stay in sync.
// ─────────────────────────────────────────────────────────────────────────
function OpeningStockModal({ product, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    getProductOpeningStock(product.id)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load opening stock.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [product.id])

  // Local editable copy of `rows`, mirrored back to data.rows on every
  // keystroke. Quantity / unit_cost / date / note are all editable;
  // location is fixed (one row per active location from the server).
  const updateRow = (idx, patch) => {
    setData((d) => ({ ...d, rows: d.rows.map((r, i) => i === idx ? { ...r, ...patch } : r) }))
  }

  const submit = async () => {
    setSaving(true); setErr('')
    try {
      const rows = (data?.rows || [])
        .filter((r) => Number(r.quantity) > 0)
        .map((r) => ({
          location_id: r.location_id,
          quantity:    String(r.quantity),
          unit_cost:   String(r.unit_cost || 0),
          layer_date:  r.layer_date || null,
        }))
      if (!rows.length) {
        setErr('Enter at least one quantity before saving.')
        setSaving(false)
        return
      }
      const res = await saveProductOpeningStock(product.id, rows)
      if (res?.errors?.length) {
        setErr(res.errors.map((e) => e.error).join(' · '))
      } else {
        window.alert('Opening stock saved.')
        onClose?.()
      }
    } catch (e) {
      setErr(e?.message || 'Failed to save opening stock.')
    } finally {
      setSaving(false)
    }
  }

  const unit = data?.product?.unit || 'Pc(s)'
  const fmtMoney = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <Modal open onClose={onClose} title="Add or Edit Opening Stock" size="3xl">
      {loading ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : err && !data ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>
      ) : !data ? null : (
        <div className="space-y-3 text-sm">
          {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 text-sm">{err}</div>}

          {/* Fixed product header — pulled from the action-menu row */}
          <div className="rounded-md bg-brand-50 border border-brand-100 px-3 py-2">
            <div className="text-xs uppercase tracking-wider text-brand-700">Product</div>
            <div className="font-semibold text-navy-800">
              {data.product.name}{data.product.sku ? ` (${data.product.sku})` : ''}
            </div>
          </div>

          {/* Per-location table — one row per active business location */}
          <div className="overflow-x-auto border border-gray-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-emerald-500 text-white">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Location</th>
                  <th className="px-3 py-2 text-right font-semibold">Quantity Remaining</th>
                  <th className="px-3 py-2 text-right font-semibold">Unit Cost (Before Tax)</th>
                  <th className="px-3 py-2 text-right font-semibold">Subtotal (Before Tax)</th>
                  <th className="px-3 py-2 text-left font-semibold w-44">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map((r, i) => {
                  const subtotal = Number(r.quantity || 0) * Number(r.unit_cost || 0)
                  return (
                    <tr key={r.location_id}>
                      <td className="px-3 py-2 text-gray-700">
                        {r.location_name}{r.location_code ? ` (${r.location_code})` : ''}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <input
                            type="number" min="0" step="0.0001"
                            value={r.quantity}
                            onChange={(e) => updateRow(i, { quantity: e.target.value })}
                            className="h-8 w-28 rounded border border-gray-300 px-2 text-right text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none"
                          />
                          <span className="text-xs text-gray-500 w-12 truncate">{unit}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min="0" step="0.01"
                          value={r.unit_cost}
                          onChange={(e) => updateRow(i, { unit_cost: e.target.value })}
                          className="h-8 w-28 rounded border border-gray-300 px-2 text-right text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none"
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                        {fmtMoney(subtotal)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={r.layer_date ? String(r.layer_date).slice(0, 10) : ''}
                          onChange={(e) => updateRow(i, { layer_date: e.target.value })}
                          className="h-8 w-full rounded border border-gray-300 px-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 outline-none"
                        />
                      </td>
                    </tr>
                  )
                })}
                {data.rows.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">No active business locations.</td></tr>
                )}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td className="px-3 py-2 text-right font-semibold text-gray-700" colSpan={3}>Total Amount (Excl. Tax):</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-800">
                    {fmtMoney(
                      (data.rows || []).reduce((s, r) => s + Number(r.quantity || 0) * Number(r.unit_cost || 0), 0),
                    )}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="text-xs text-gray-500">
            Only rows with a non-zero quantity will be saved. Existing untouched opening-stock layers are updated in place; otherwise a new FIFO cost layer is created.
          </div>
        </div>
      )}
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={submit} loading={saving} disabled={saving || loading}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {children}
      </select>
    </label>
  )
}

function formatCell(key, v) {
  if (v == null || v === '') return '—'
  if (['unit_price','stock_value_cost','stock_value_sale','potential_profit'].includes(key)) {
    return `৳ ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (typeof v === 'number') return v.toLocaleString()
  return String(v)
}

function FunnelIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v.385a3 3 0 01-.879 2.121l-5.482 5.482a1 1 0 00-.293.707v6.034a.75.75 0 01-1.244.564l-2.25-1.99a1.5 1.5 0 01-.506-1.122v-3.486a1 1 0 00-.293-.707L1.879 4.847A3 3 0 011 2.726v-.385a.75.75 0 01.628-.74z" />
    </svg>
  )
}
