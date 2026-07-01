import { useCallback, useEffect, useState } from 'react'
import { useForm }       from 'react-hook-form'
import Card              from '../../components/ui/Card'
import Button            from '../../components/ui/Button'
import Badge             from '../../components/ui/Badge'
import Input             from '../../components/ui/Input'
import Select            from '../../components/ui/Select'
import SearchInput       from '../../components/ui/SearchInput'
import EmptyState        from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { useAuth }       from '../../context/AuthContext'
import {
  getProducts, getProduct, createProduct, updateProduct,
  getCategories, getBrands, getUnits, getLocations,
} from '../../api/products'
import { stockIn } from '../../api/inventory'

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n, decimals = 2) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

const fmtCurrency = (n) => (n == null ? '—' : `$${fmt(n)}`)

// ── Product form modal ────────────────────────────────────────────────────────

function ProductFormModal({ open, onClose, productId, categories, brands, units, locations, onSaved }) {
  const isEdit = Boolean(productId)
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')
  const generateBarcode = watch('generate_barcode')

  // Load existing product when editing
  useEffect(() => {
    if (!open) return
    if (isEdit) {
      getProduct(productId)
        .then((p) => reset({
          name:             p.name,
          sku:              p.sku ?? '',
          barcode:          p.barcode ?? '',
          generate_barcode: false,
          category_id:      p.category ?? '',
          brand_id:         p.brand ?? '',
          unit_id:          p.unit ?? '',
          selling_price:    p.selling_price,
          warranty_days:    p.warranty_days ?? 0,
          notes:            p.notes ?? '',
          is_active:        p.is_active,
          stock_location_id: '',
          stock_qty: '',
          stock_unit_cost: '',
        }))
        .catch(() => {})
    } else {
      reset({
        name: '', sku: '', barcode: '', generate_barcode: false,
        category_id: '', brand_id: '', unit_id: '',
        selling_price: '', warranty_days: 0, notes: '', is_active: true,
        stock_location_id: '',
        stock_qty: '',
        stock_unit_cost: '',
      })
    }
    setServerError('')
  }, [open, productId, isEdit, reset])

  const onSubmit = async (data) => {
    setServerError('')
    try {
      if (Number(data.stock_qty) > 0 && !data.stock_location_id) {
        setServerError('Select a stock location when stock quantity is provided.')
        return
      }
      const payload = {
        name:          data.name.trim(),
        unit_id:       data.unit_id || null,
        selling_price: data.selling_price || 0,
        category_id:   data.category_id || null,
        brand_id:      data.brand_id || null,
        sku:           data.sku.trim() || null,
        barcode:       data.generate_barcode ? null : (data.barcode.trim() || null),
        generate_barcode: data.generate_barcode,
        warranty_days: Number(data.warranty_days) || 0,
        notes:         data.notes ?? '',
      }
      if (isEdit) {
        await updateProduct(productId, { ...payload, is_active: data.is_active })
      } else {
        const created = await createProduct(payload)
        if (Number(data.stock_qty) > 0) {
          await stockIn({
            product_id: created.id,
            location_id: data.stock_location_id,
            quantity: Number(data.stock_qty),
            unit_cost: Number(data.stock_unit_cost || 0),
            reference_type: isEdit ? 'product_edit' : 'opening_stock',
          })
        }
      }
      // Edit mode stock add
      if (isEdit && Number(data.stock_qty) > 0) {
        await stockIn({
          product_id: productId,
          location_id: data.stock_location_id,
          quantity: Number(data.stock_qty),
          unit_cost: Number(data.stock_unit_cost || 0),
          reference_type: 'product_edit',
        })
      }
      onSaved?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to save product')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Product' : 'New Product'} size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <Input
          label="Product Name"
          required
          placeholder="e.g. Samsung Galaxy A54"
          error={errors.name?.message}
          {...register('name', { required: 'Name is required' })}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="SKU"
            placeholder="Optional — auto-generated if blank"
            error={errors.sku?.message}
            {...register('sku')}
          />
          <div>
            <Input
              label="Barcode"
              placeholder="EAN / UPC / custom"
              disabled={generateBarcode}
              error={errors.barcode?.message}
              {...register('barcode')}
            />
            <label className="mt-1.5 flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" className="rounded" {...register('generate_barcode')} />
              Auto-generate barcode
            </label>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Select
            label="Category"
            {...register('category_id')}
          >
            <option value="">— None —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Select
            label="Brand"
            {...register('brand_id')}
          >
            <option value="">— None —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
          <Select
            label="Unit"
            {...register('unit_id')}
          >
            <option value="">— None —</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.abbreviation})</option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Selling Price"
            required
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            error={errors.selling_price?.message}
            {...register('selling_price', { required: 'Price is required', min: { value: 0, message: 'Must be ≥ 0' } })}
          />
          <Input
            label="Warranty (days)"
            type="number"
            min="0"
            placeholder="0"
            {...register('warranty_days', { min: 0 })}
          />
        </div>

        <Input
          label="Notes"
          placeholder="Optional notes about this product"
          {...register('notes')}
        />

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
          <p className="mb-2 text-sm font-semibold text-gray-800">
            {isEdit ? 'Update Stock' : 'Opening Stock'}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Select label="Location" {...register('stock_location_id')}>
              <option value="">— Select location —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
            <Input
              label={isEdit ? 'Add Qty' : 'Opening Qty'}
              type="number"
              min="0"
              step="0.0001"
              placeholder="0"
              {...register('stock_qty')}
            />
            <Input
              label="Unit Cost"
              type="number"
              min="0"
              step="0.000001"
              placeholder="0.00"
              {...register('stock_unit_cost')}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {isEdit
              ? 'Set Add Qty > 0 to add more stock for this product.'
              : 'Optional: add opening stock while creating product.'}
          </p>
        </div>

        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" className="rounded" {...register('is_active')} />
            Product is active (visible in POS)
          </label>
        )}
      </form>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>
          {isEdit ? 'Save Changes' : 'Create Product'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

function ActiveBadge({ active }) {
  return active
    ? <Badge variant="green" dot>Active</Badge>
    : <Badge variant="gray" dot>Inactive</Badge>
}

// ── Stock level badge ─────────────────────────────────────────────────────────

function StockBadge({ qty }) {
  if (qty == null) return <span className="text-gray-400">—</span>
  if (qty <= 0)    return <Badge variant="red">{qty}</Badge>
  if (qty <= 5)    return <Badge variant="yellow">{qty}</Badge>
  return <span className="text-sm font-medium text-gray-800">{qty}</span>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const { user } = useAuth()
  const canManage = user?.permissions?.includes('inventory.manage') ||
                    ['owner', 'admin'].includes(user?.role)

  const [products,    setProducts]    = useState([])
  const [categories,  setCategories]  = useState([])
  const [brands,      setBrands]      = useState([])
  const [units,       setUnits]       = useState([])
  const [locations,   setLocations]   = useState([])
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')
  const [filterCat,   setFilterCat]   = useState('')
  const [filterActive, setFilterActive] = useState('true')
  const [modalOpen,   setModalOpen]   = useState(false)
  const [editId,      setEditId]      = useState(null)

  const loadMasterData = useCallback(async () => {
    try {
      const [cats, brnds, unts, locs] = await Promise.all([
        getCategories(), getBrands(), getUnits(), getLocations(true),
      ])
      setCategories(Array.isArray(cats) ? cats : (cats?.results ?? []))
      setBrands(Array.isArray(brnds) ? brnds : (brnds?.results ?? []))
      setUnits(Array.isArray(unts) ? unts : (unts?.results ?? []))
      setLocations(Array.isArray(locs) ? locs : (locs?.results ?? []))
    } catch { /* ignore */ }
  }, [])

  const loadProducts = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (search)       params.search      = search
      if (filterCat)    params.category_id = filterCat
      if (filterActive) params.is_active   = filterActive
      const data = await getProducts(params)
      setProducts(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setProducts([])
    } finally {
      setLoading(false)
    }
  }, [search, filterCat, filterActive])

  useEffect(() => { loadMasterData() }, [loadMasterData])
  useEffect(() => { loadProducts() },  [loadProducts])

  const openCreate = () => { setEditId(null); setModalOpen(true) }
  const openEdit   = (id) => { setEditId(id); setModalOpen(true) }
  const onSaved    = () => loadProducts()

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Products</h1>
          <p className="mt-0.5 text-sm text-gray-500">Manage your product catalogue</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <PlusIcon /> New Product
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card padding="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by name, SKU, or barcode…"
            className="flex-1"
          />
          <select
            value={filterCat}
            onChange={(e) => setFilterCat(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Status</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </div>
      </Card>

      {/* Table */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : products.length === 0 ? (
          <EmptyState
            icon={<BoxIcon />}
            title="No products found"
            message="Try adjusting your search or filters, or create a new product."
            action={canManage && <Button onClick={openCreate} size="sm"><PlusIcon /> New Product</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Brand</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3 text-right">Avg Cost</th>
                  <th className="px-4 py-3">Status</th>
                  {canManage && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {products.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{p.name}</div>
                      {p.unit_abbr && (
                        <div className="text-xs text-gray-400">per {p.unit_abbr}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.sku ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{p.category_name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{p.brand_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{fmtCurrency(p.selling_price)}</td>
                    <td className="px-4 py-3 text-right"><StockBadge qty={p.total_stock} /></td>
                    <td className="px-4 py-3 text-right text-gray-500">{fmtCurrency(p.avg_cost)}</td>
                    <td className="px-4 py-3"><ActiveBadge active={p.is_active} /></td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openEdit(p.id)}
                          className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Result count */}
      {!loading && products.length > 0 && (
        <p className="text-xs text-gray-400 text-right">{products.length} product{products.length !== 1 ? 's' : ''}</p>
      )}

      {/* Create / Edit modal */}
      <ProductFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        productId={editId}
        categories={categories}
        brands={brands}
        units={units}
        locations={locations}
        onSaved={onSaved}
      />
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
    </svg>
  )
}
