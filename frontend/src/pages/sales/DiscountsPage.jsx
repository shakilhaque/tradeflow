import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Button from '../../components/ui/Button'
import Card from '../../components/ui/Card'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import SearchInput from '../../components/ui/SearchInput'
import { createDiscount, deactivateDiscounts, getDiscounts } from '../../api/sales'
import { getLocations, getProducts, getBrands, getCategories } from '../../api/products'
import { useDefaultPageSize } from '../../context/SettingsContext'

const PAGE_SIZES = [10, 25, 50, 100]

export default function DiscountsPage() {
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const defaultPageSize = useDefaultPageSize(25)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [locations, setLocations] = useState([])
  const [locationId, setLocationId] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getDiscounts({
        page,
        limit,
        search: search || undefined,
        location_id: locationId || undefined,
      })
      setRows(data?.results ?? [])
      setCount(data?.count ?? 0)
      setTotalPages(data?.total_pages ?? 1)
      setSelected([])
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, locationId])

  useEffect(() => { loadData().catch(() => setLoading(false)) }, [loadData])
  useEffect(() => {
    getLocations(true).then((d) => setLocations(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
  }, [])

  const toggle = (id) => setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  const toggleAll = () => {
    if (selected.length === rows.length) setSelected([])
    else setSelected(rows.map((r) => r.id))
  }

  const onDeactivateSelected = async () => {
    if (!selected.length) return
    await deactivateDiscounts(selected)
    loadData()
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Discount</h1>
        <p className="mt-0.5 text-sm text-emerald-50">Manage your discounts.</p>
      </div>
      <Card padding="p-4">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-700">All your discounts</p>
          <Button size="sm" onClick={() => setAddOpen(true)}>+ Add</Button>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span>Show</span>
            <select value={limit} onChange={(e) => { setPage(1); setLimit(Number(e.target.value)) }} className="rounded border border-gray-300 px-2 py-1 text-sm">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>entries</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => window.print()}>Export to CSV</Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>Export to Excel</Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>Print</Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>Export to PDF</Button>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <select value={locationId} onChange={(e) => { setPage(1); setLocationId(e.target.value) }} className="rounded border border-gray-300 px-2 py-2 text-sm">
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <div className="w-64">
              <SearchInput value={search} onChange={(v) => { setPage(1); setSearch(v) }} placeholder="Search ..." />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-3 py-3"><input type="checkbox" checked={rows.length > 0 && selected.length === rows.length} onChange={toggleAll} /></th>
                <th className="px-3 py-3">Name</th>
                <th className="px-3 py-3">Starts At</th>
                <th className="px-3 py-3">Ends At</th>
                <th className="px-3 py-3">Discount</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Priority</th>
                <th className="px-3 py-3">Brand</th>
                <th className="px-3 py-3">Category</th>
                <th className="px-3 py-3">Products</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-gray-400">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-gray-400">No data available in table</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-3"><input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="px-3 py-3">{r.name}</td>
                  <td className="px-3 py-3">{new Date(r.starts_at).toLocaleString()}</td>
                  <td className="px-3 py-3">{new Date(r.ends_at).toLocaleString()}</td>
                  <td className="px-3 py-3">
                    {Number(r.discount_amount || 0).toFixed(2)}
                    {r.discount_type === 'PERCENTAGE' ? '%' : ''}
                  </td>
                  <td className="px-3 py-3">{r.discount_type === 'PERCENTAGE' ? 'Percentage' : 'Fixed'}</td>
                  <td className="px-3 py-3">{r.priority}</td>
                  <td className="px-3 py-3">{r.brand || '—'}</td>
                  <td className="px-3 py-3">{r.category || '—'}</td>
                  <td className="px-3 py-3">{r.products_count ?? 0}</td>
                  <td className="px-3 py-3">{r.location_name || 'All'}</td>
                  <td className="px-3 py-3">{r.is_active ? 'Active' : 'Inactive'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={onDeactivateSelected}>Deactivate Selected</Button>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-gray-500">Showing {Math.min((page - 1) * limit + 1, count || 0)} to {Math.min(page * limit, count)} of {count} entries</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      </Card>

      {addOpen && (
        <AddDiscountModal
          locations={locations}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); loadData() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// AddDiscountModal — pixel-faithful to the user's reference design.
// Pulls Brand / Category / Location dropdowns and the Products picker
// from the tenant inventory, posts to /api/sales/discounts/ on Save.
// ─────────────────────────────────────────────────────────────────────
function AddDiscountModal({ locations, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    productQuery: '',
    productIds: [],   // selected product ids (multi)
    brand: '',
    category: '',
    location: '',
    priority: 1,
    discount_type: '',
    discount_amount: '',
    starts_at: '',
    ends_at: '',
    selling_price_group: 'ALL',
    is_active: true,
    customer_groups: false,
  })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target?.value ?? e }))

  // Lookup data for the dropdowns.
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [productResults, setProductResults] = useState([])
  const [productSelected, setProductSelected] = useState([])   // [{id, name, sku}]
  const [showProductList, setShowProductList] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const productBoxRef = useRef(null)

  useEffect(() => {
    getBrands().then((d) => setBrands(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
    getCategories().then((d) => setCategories(Array.isArray(d) ? d : (d?.results ?? []))).catch(() => {})
  }, [])

  // Debounced product search — fires after the FIRST character the
  // cashier types so the dropdown appears immediately. Short debounce
  // (120ms) keeps the network call rate reasonable while feeling
  // instant.
  useEffect(() => {
    const q = (form.productQuery || '').trim()
    if (!q) { setProductResults([]); setShowProductList(false); return }
    const t = setTimeout(async () => {
      try {
        const r = await getProducts({ search: q, limit: 12 })
        const arr = Array.isArray(r) ? r : (r?.results ?? [])
        setProductResults(arr)
        // Always show the dropdown after a successful fetch, even
        // when the list is empty — we render an explicit "No
        // matches" row so the cashier can tell their letter didn't
        // catch anything.
        setShowProductList(true)
      } catch { setProductResults([]); setShowProductList(true) }
    }, 120)
    return () => clearTimeout(t)
  }, [form.productQuery])

  // Close the product results dropdown on outside click.
  useEffect(() => {
    const onClick = (e) => {
      if (!productBoxRef.current) return
      if (!productBoxRef.current.contains(e.target)) setShowProductList(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const addProduct = (p) => {
    setProductSelected((prev) => prev.find((x) => x.id === p.id) ? prev : [...prev, p])
    setForm((f) => ({ ...f, productQuery: '', productIds: [...new Set([...f.productIds, p.id])] }))
    setShowProductList(false)
  }
  const removeProduct = (id) => {
    setProductSelected((prev) => prev.filter((p) => p.id !== id))
    setForm((f) => ({ ...f, productIds: f.productIds.filter((x) => x !== id) }))
  }

  const submit = async () => {
    setError('')
    if (!form.name.trim()) { setError('Name is required.'); return }
    if (!form.location)    { setError('Location is required.'); return }
    if (!form.discount_type) { setError('Discount Type is required.'); return }
    const amt = Number(form.discount_amount)
    if (!amt || amt <= 0) { setError('Discount Amount must be greater than zero.'); return }
    if (form.discount_type === 'PERCENTAGE' && amt > 100) {
      setError('A percentage discount cannot exceed 100%.'); return
    }

    // Sensible defaults: Starts At = now, Ends At = +30 days, so the
    // cashier doesn't have to fill them every time.
    const now = new Date()
    const starts = form.starts_at ? new Date(form.starts_at) : now
    const ends   = form.ends_at   ? new Date(form.ends_at)   : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    setSaving(true)
    try {
      await createDiscount({
        name:                form.name.trim(),
        product_ids:         form.productIds,
        brand:               form.brand || '',
        category:            form.category || '',
        location:            form.location,
        priority:            Number(form.priority) || 1,
        discount_type:       form.discount_type,
        discount_amount:     amt,
        starts_at:           starts.toISOString(),
        ends_at:             ends.toISOString(),
        selling_price_group: form.selling_price_group || 'ALL',
        is_active:           !!form.is_active,
      })
      onCreated?.()
    } catch (e) {
      setError(e?.message || 'Failed to create discount.')
    } finally {
      setSaving(false)
    }
  }

  const ipt = 'h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
  const sel = `${ipt} appearance-none cursor-pointer pr-8 text-emerald-700`
  const lbl = 'block text-sm font-medium text-gray-700 mb-1'

  return (
    <Modal open onClose={onClose} title="Add Discount" size="2xl">
      <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        )}

        {/* Name */}
        <div>
          <label className={lbl}>Name:<span className="text-rose-500">*</span></label>
          <input value={form.name} onChange={set('name')} placeholder="Name" className={ipt} />
        </div>

        {/* Products multi-select with searchable suggestions.
            Single-character searches already trigger because the
            effect debounces on q.trim() not q.length>1. */}
        <div ref={productBoxRef}>
          <label className={lbl}>Products:</label>
          <input
            value={form.productQuery}
            onChange={set('productQuery')}
            onFocus={() => form.productQuery && setShowProductList(true)}
            placeholder="Type a letter — products appear instantly"
            className={ipt}
          />
          {showProductList && (
            <div className="relative">
              <div className="absolute z-30 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-pop max-h-60 overflow-auto">
                {productResults.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500 italic">
                    No products match "{form.productQuery}".
                  </div>
                ) : productResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); addProduct(p) }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-emerald-50"
                  >
                    <span className="font-medium text-gray-900">{p.name}</span>
                    {p.sku ? <span className="ml-2 text-xs text-gray-500">— {p.sku}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
          {productSelected.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {productSelected.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">
                  {p.name}
                  <button type="button" onClick={() => removeProduct(p.id)} className="hover:text-emerald-900">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Brand + Category */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Brand:</label>
            <select value={form.brand} onChange={set('brand')} className={sel}>
              <option value="">Please Select</option>
              {brands.map((b) => <option key={b.id || b.name} value={b.name || b}>{b.name || b}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Category:</label>
            <select value={form.category} onChange={set('category')} className={sel}>
              <option value="">Please Select</option>
              {categories.map((c) => <option key={c.id || c.name} value={c.name || c}>{c.name || c}</option>)}
            </select>
          </div>
        </div>

        {/* Location + Priority */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Location:<span className="text-rose-500">*</span></label>
            <select value={form.location} onChange={set('location')} className={sel}>
              <option value="">Please Select</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>
              Priority:{' '}
              {/* Hover tooltip mirrors the reference UI — a styled
                  panel pops to the right of the info icon explaining
                  how priority is evaluated. */}
              <span className="relative inline-block group align-middle">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-brand-500 text-white text-[10px] font-bold cursor-help">
                  i
                </span>
                <span
                  role="tooltip"
                  className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-6 top-1/2 -translate-y-1/2 z-50 w-72 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-normal text-gray-700 shadow-pop"
                >
                  Discount with higher priority will have higher weightage,
                  however priority will not be considered for exact matches.
                </span>
              </span>
            </label>
            <input type="number" min="1" value={form.priority} onChange={set('priority')} placeholder="Priority" className={ipt} />
          </div>
        </div>

        {/* Discount Type + Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Discount Type:<span className="text-rose-500">*</span></label>
            <select value={form.discount_type} onChange={set('discount_type')} className={sel}>
              <option value="">Please Select</option>
              <option value="FIXED">Fixed</option>
              <option value="PERCENTAGE">Percentage</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Discount Amount:<span className="text-rose-500">*</span></label>
            <input type="number" min="0" step="0.01" value={form.discount_amount} onChange={set('discount_amount')} placeholder="Discount Amount" className={ipt} />
          </div>
        </div>

        {/* Starts / Ends */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Starts At:</label>
            <input type="datetime-local" value={form.starts_at} onChange={set('starts_at')} placeholder="Starts At" className={ipt} />
          </div>
          <div>
            <label className={lbl}>Ends At:</label>
            <input type="datetime-local" value={form.ends_at} onChange={set('ends_at')} placeholder="Ends At" className={ipt} />
          </div>
        </div>

        {/* Selling Price Group */}
        <div>
          <label className={lbl}>Selling Price Group:</label>
          <select value={form.selling_price_group} onChange={set('selling_price_group')} className={sel}>
            <option value="ALL">All</option>
            <option value="DEFAULT">Default Selling Price</option>
          </select>
        </div>

        {/* Customer groups + Is active — high-contrast labels so they
            don't disappear against the modal background. */}
        <div className="flex items-center justify-between gap-4 pt-3 mt-3 border-t border-gray-200">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-900 cursor-pointer">
            <input
              type="checkbox"
              checked={form.customer_groups}
              onChange={(e) => setForm((f) => ({ ...f, customer_groups: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-200"
            />
            Apply in customer groups
          </label>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-900 cursor-pointer">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-200"
            />
            Is active
          </label>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={submit} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}
