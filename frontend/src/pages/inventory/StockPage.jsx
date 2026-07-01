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
import { getStockReport, getMovements, stockIn, stockTransfer } from '../../api/inventory'
import { getProducts, getLocations } from '../../api/products'

const fmt = (n, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

const fmtCurrency = (n) => (n == null ? '—' : `$${fmt(n)}`)

// ── Stock-In modal ────────────────────────────────────────────────────────────

function StockInModal({ open, onClose, products, locations, onDone }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')

  useEffect(() => {
    if (open) {
      reset({ product_id: '', location_id: '', quantity: '', unit_cost: '', reference_type: 'purchase', reference_id: '', layer_date: '' })
      setServerError('')
    }
  }, [open, reset])

  const onSubmit = async (data) => {
    setServerError('')
    try {
      await stockIn({
        product_id:     data.product_id,
        location_id:    data.location_id,
        quantity:       Number(data.quantity),
        unit_cost:      Number(data.unit_cost),
        reference_type: data.reference_type || 'purchase',
        reference_id:   data.reference_id || null,
        layer_date:     data.layer_date || null,
      })
      onDone?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to record stock')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Receive Stock (Stock-In)" size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <Select
          label="Product"
          required
          error={errors.product_id?.message}
          {...register('product_id', { required: 'Select a product' })}
        >
          <option value="">— Select product —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} {p.sku ? `(${p.sku})` : ''}</option>
          ))}
        </Select>

        <Select
          label="Location / Warehouse"
          required
          error={errors.location_id?.message}
          {...register('location_id', { required: 'Select a location' })}
        >
          <option value="">— Select location —</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name} {l.code ? `[${l.code}]` : ''}</option>
          ))}
        </Select>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Quantity"
            required
            type="number"
            min="0.001"
            step="any"
            placeholder="0"
            error={errors.quantity?.message}
            {...register('quantity', { required: 'Required', min: { value: 0.001, message: 'Must be > 0' } })}
          />
          <Input
            label="Unit Cost ($)"
            required
            type="number"
            min="0"
            step="0.0001"
            placeholder="0.00"
            error={errors.unit_cost?.message}
            {...register('unit_cost', { required: 'Required', min: { value: 0, message: 'Must be ≥ 0' } })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select label="Reference Type" {...register('reference_type')}>
            <option value="purchase">Purchase</option>
            <option value="return">Return</option>
            <option value="adjustment">Adjustment</option>
            <option value="opening">Opening Stock</option>
          </Select>
          <Input
            label="Date Received"
            type="date"
            {...register('layer_date')}
          />
        </div>
      </form>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>
          Record Stock-In
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Stock Transfer modal ──────────────────────────────────────────────────────

function StockTransferModal({ open, onClose, products, locations, onDone }) {
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')
  const fromLoc = watch('from_location_id')

  useEffect(() => {
    if (open) {
      reset({ product_id: '', from_location_id: '', to_location_id: '', quantity: '', notes: '' })
      setServerError('')
    }
  }, [open, reset])

  const onSubmit = async (data) => {
    setServerError('')
    if (data.from_location_id === data.to_location_id) {
      setServerError('Source and destination locations must be different')
      return
    }
    try {
      await stockTransfer({
        product_id:       data.product_id,
        from_location_id: data.from_location_id,
        to_location_id:   data.to_location_id,
        quantity:         Number(data.quantity),
        notes:            data.notes || '',
      })
      onDone?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to transfer stock')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Transfer Stock" size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <Select
          label="Product"
          required
          error={errors.product_id?.message}
          {...register('product_id', { required: 'Select a product' })}
        >
          <option value="">— Select product —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} {p.sku ? `(${p.sku})` : ''}</option>
          ))}
        </Select>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="From Location"
            required
            error={errors.from_location_id?.message}
            {...register('from_location_id', { required: 'Required' })}
          >
            <option value="">— Source —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
          <Select
            label="To Location"
            required
            error={errors.to_location_id?.message}
            {...register('to_location_id', { required: 'Required' })}
          >
            <option value="">— Destination —</option>
            {locations.filter((l) => l.id !== fromLoc).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </div>

        <Input
          label="Quantity"
          required
          type="number"
          min="0.001"
          step="any"
          placeholder="0"
          error={errors.quantity?.message}
          {...register('quantity', { required: 'Required', min: { value: 0.001, message: 'Must be > 0' } })}
        />

        <Input
          label="Notes"
          placeholder="Reason for transfer (optional)"
          {...register('notes')}
        />
      </form>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>
          Transfer Stock
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Movements tab ─────────────────────────────────────────────────────────────

const MOVEMENT_COLORS = {
  IN:       'green',
  OUT:      'red',
  TRANSFER: 'blue',
  ADJUST:   'yellow',
}

function MovementsTab({ movements, loading }) {
  if (loading) return (
    <div className="flex justify-center py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
    </div>
  )

  if (!movements.length) return (
    <EmptyState icon={<ListIcon />} title="No movements found" message="Stock movements will appear here." />
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Location</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Unit Cost</th>
            <th className="px-4 py-3">Reference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {movements.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50/60 transition-colors">
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                {new Date(m.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-3">
                <div className="font-medium text-gray-900">{m.product_name}</div>
                <div className="text-xs text-gray-400 font-mono">{m.product_sku}</div>
              </td>
              <td className="px-4 py-3 text-gray-600">{m.location_name}</td>
              <td className="px-4 py-3">
                <Badge variant={MOVEMENT_COLORS[m.movement_type] ?? 'gray'}>
                  {m.movement_type}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right font-mono font-medium text-gray-900">
                {m.movement_type === 'OUT' ? '-' : '+'}{fmt(m.quantity, 0)}
              </td>
              <td className="px-4 py-3 text-right text-gray-500">{fmtCurrency(m.unit_cost)}</td>
              <td className="px-4 py-3 text-gray-500 text-xs">{m.reference_type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { user } = useAuth()
  const canManage = user?.permissions?.includes('inventory.manage') ||
                    ['owner', 'admin', 'manager'].includes(user?.role)

  const [tab,         setTab]       = useState('stock')   // 'stock' | 'movements'
  const [stockRows,   setStockRows] = useState([])
  const [movements,   setMovements] = useState([])
  const [products,    setProducts]  = useState([])
  const [locations,   setLocations] = useState([])
  const [loading,     setLoading]   = useState(true)
  const [filterLoc,   setFilterLoc] = useState('')
  const [filterProduct, setFilterProduct] = useState('')
  const [includeZero, setIncludeZero] = useState(false)
  const [stockInOpen, setStockInOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)

  const loadMasterData = useCallback(async () => {
    try {
      const [prods, locs] = await Promise.all([
        getProducts({ is_active: 'true' }),
        getLocations(true),
      ])
      setProducts(Array.isArray(prods) ? prods : (prods?.results ?? []))
      setLocations(Array.isArray(locs) ? locs : (locs?.results ?? []))
    } catch { /* ignore */ }
  }, [])

  const loadStock = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (filterLoc)     params.location_id = filterLoc
      if (filterProduct) params.product_id  = filterProduct
      if (includeZero)   params.include_zero = 'true'
      const data = await getStockReport(params)
      setStockRows(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setStockRows([])
    } finally {
      setLoading(false)
    }
  }, [filterLoc, filterProduct, includeZero])

  const loadMovements = useCallback(async () => {
    setLoading(true)
    try {
      const params = { limit: 200 }
      if (filterLoc)     params.location_id = filterLoc
      if (filterProduct) params.product_id  = filterProduct
      const data = await getMovements(params)
      setMovements(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setMovements([])
    } finally {
      setLoading(false)
    }
  }, [filterLoc, filterProduct])

  useEffect(() => { loadMasterData() }, [loadMasterData])

  useEffect(() => {
    if (tab === 'stock') loadStock()
    else loadMovements()
  }, [tab, loadStock, loadMovements])

  const onOperationDone = () => {
    if (tab === 'stock') loadStock()
    else loadMovements()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Stock Levels</h1>
          <p className="mt-0.5 text-sm text-gray-500">Monitor on-hand inventory and record movements</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTransferOpen(true)}>
              <TransferIcon /> Transfer
            </Button>
            <Button onClick={() => setStockInOpen(true)}>
              <PlusIcon /> Stock-In
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <Card padding="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={filterProduct}
            onChange={(e) => setFilterProduct(e.target.value)}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={filterLoc}
            onChange={(e) => setFilterLoc(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          {tab === 'stock' && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={includeZero}
                onChange={(e) => setIncludeZero(e.target.checked)}
                className="rounded"
              />
              Show zero-stock
            </label>
          )}
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {['stock', 'movements'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              tab === t
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t === 'stock' ? 'Stock On-Hand' : 'Movement History'}
          </button>
        ))}
      </div>

      {/* Content */}
      <Card padding="p-0">
        {tab === 'stock' ? (
          loading ? (
            <div className="flex justify-center py-16">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            </div>
          ) : stockRows.length === 0 ? (
            <EmptyState
              icon={<WarehouseIcon />}
              title="No stock found"
              message="Adjust filters or record stock-in to see inventory levels."
              action={canManage && <Button onClick={() => setStockInOpen(true)} size="sm"><PlusIcon /> Stock-In</Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3 text-right">Qty on Hand</th>
                    <th className="px-4 py-3 text-right">Last Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {stockRows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{r.product_name}</div>
                        <div className="text-xs text-gray-400 font-mono">{r.product_sku}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.location_name}
                        {r.location_code && (
                          <span className="ml-1.5 text-xs text-gray-400">[{r.location_code}]</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={[
                          'font-semibold',
                          r.quantity <= 0 ? 'text-red-600' : r.quantity <= 5 ? 'text-yellow-600' : 'text-gray-900',
                        ].join(' ')}>
                          {fmt(r.quantity, 0)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-400 text-xs">
                        {new Date(r.updated_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <MovementsTab movements={movements} loading={loading} />
        )}
      </Card>

      {/* Modals */}
      <StockInModal
        open={stockInOpen}
        onClose={() => setStockInOpen(false)}
        products={products}
        locations={locations}
        onDone={onOperationDone}
      />
      <StockTransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        products={products}
        locations={locations}
        onDone={onOperationDone}
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

function TransferIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M13.2 2.24a.75.75 0 00.04 1.06l2.1 1.95H6.75a.75.75 0 000 1.5h8.59l-2.1 1.95a.75.75 0 101.02 1.1l3.5-3.25a.75.75 0 000-1.1l-3.5-3.25a.75.75 0 00-1.06.04zm-6.4 8a.75.75 0 00-1.06-.04l-3.5 3.25a.75.75 0 000 1.1l3.5 3.25a.75.75 0 101.02-1.1l-2.1-1.95h8.59a.75.75 0 000-1.5H4.66l2.1-1.95a.75.75 0 00.04-1.06z" clipRule="evenodd" />
    </svg>
  )
}

function WarehouseIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 21v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21m0 0h4.5V3.545M12.75 21h7.5V10.75M2.25 21h1.5m18 0h-18M2.25 9l4.5-1.636M18.75 3l-1.5.545m0 6.205l3 1m1.5.5-1.5-.5M6.75 7.364V3h-3v18m3-13.636l10.5-3.819" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  )
}
