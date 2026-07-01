import { useCallback, useEffect, useState } from 'react'
import { useForm }    from 'react-hook-form'
import Card           from '../../components/ui/Card'
import Button         from '../../components/ui/Button'
import Badge          from '../../components/ui/Badge'
import Input          from '../../components/ui/Input'
import Select         from '../../components/ui/Select'
import EmptyState     from '../../components/ui/EmptyState'
import { useAuth }    from '../../context/AuthContext'
import { stockIn, getMovements } from '../../api/inventory'
import { getProducts, getLocations } from '../../api/products'

const fmt2 = (n) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── Receive Stock Form ────────────────────────────────────────────────────────

function ReceiveStockForm({ products, locations, onReceived }) {
  const {
    register, handleSubmit, reset,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: {
      product_id: '', location_id: '', quantity: '', unit_cost: '',
      reference_type: 'purchase', supplier: '', invoice_no: '', layer_date: '',
    },
  })
  const [serverError, setServerError] = useState('')
  const [success,     setSuccess]     = useState(false)

  const onSubmit = async (data) => {
    setServerError('')
    setSuccess(false)
    try {
      await stockIn({
        product_id:     data.product_id,
        location_id:    data.location_id,
        quantity:       Number(data.quantity),
        unit_cost:      Number(data.unit_cost),
        reference_type: data.reference_type || 'purchase',
        reference_id:   null,
        layer_date:     data.layer_date || null,
        notes:          [data.supplier, data.invoice_no].filter(Boolean).join(' · ') || '',
      })
      setSuccess(true)
      reset()
      onReceived?.()
    } catch (err) {
      setServerError(err.message || 'Failed to receive stock')
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-gray-900 mb-1">Receive Purchase</h2>
      <p className="text-sm text-gray-500 mb-5">Record incoming stock and create a FIFO cost layer.</p>

      {serverError && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {serverError}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          ✓ Stock received successfully!
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Input
            label="Quantity"
            required
            type="number"
            min="0.001"
            step="any"
            placeholder="0"
            error={errors.quantity?.message}
            {...register('quantity', { required: 'Required', min: { value: 0.001, message: '> 0' } })}
          />
          <Input
            label="Unit Cost ($)"
            required
            type="number"
            min="0"
            step="0.0001"
            placeholder="0.0000"
            error={errors.unit_cost?.message}
            {...register('unit_cost', { required: 'Required', min: { value: 0, message: '≥ 0' } })}
          />
          <Select label="Type" {...register('reference_type')}>
            <option value="purchase">Purchase</option>
            <option value="return">Customer Return</option>
            <option value="opening">Opening Stock</option>
            <option value="adjustment">Adjustment</option>
          </Select>
          <Input
            label="Date Received"
            type="date"
            {...register('layer_date')}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Supplier"
            placeholder="Supplier name (optional)"
            {...register('supplier')}
          />
          <Input
            label="Invoice / PO Number"
            placeholder="INV-001 (optional)"
            {...register('invoice_no')}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={isSubmitting}>
            Receive Stock
          </Button>
        </div>
      </form>
    </Card>
  )
}

// ── Movements table ───────────────────────────────────────────────────────────

const MOVEMENT_VARIANT = {
  IN: 'green', OUT: 'red', TRANSFER: 'blue', ADJUST: 'yellow',
}

function MovementsTable({ movements, loading }) {
  if (loading) return (
    <div className="flex justify-center py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
    </div>
  )

  if (!movements.length) return (
    <EmptyState
      icon={<InboxIcon />}
      title="No purchase movements yet"
      message="Stock-in records will appear here once you receive goods."
    />
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
            <th className="px-4 py-3 text-right">Total Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {movements.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50/60 transition-colors">
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                {new Date(m.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-3">
                <div className="font-medium text-gray-900">{m.product_name}</div>
                <div className="text-xs text-gray-400 font-mono">{m.product_sku}</div>
              </td>
              <td className="px-4 py-3 text-gray-600">{m.location_name}</td>
              <td className="px-4 py-3">
                <Badge variant={MOVEMENT_VARIANT[m.movement_type] ?? 'gray'}>
                  {m.reference_type ?? m.movement_type}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-900">+{fmt2(m.quantity)}</td>
              <td className="px-4 py-3 text-right text-gray-500">${fmt2(m.unit_cost)}</td>
              <td className="px-4 py-3 text-right font-medium text-gray-900">
                ${fmt2(Number(m.quantity) * Number(m.unit_cost))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const { user } = useAuth()
  const canManage = user?.permissions?.includes('inventory.manage') ||
                    ['owner', 'admin', 'manager'].includes(user?.role)

  const [products,  setProducts]  = useState([])
  const [locations, setLocations] = useState([])
  const [movements, setMovements] = useState([])
  const [loading,   setLoading]   = useState(true)

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

  const loadMovements = useCallback(async () => {
    setLoading(true)
    try {
      // Only fetch IN movements
      const data = await getMovements({ movement_type: 'IN', limit: 200 })
      setMovements(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setMovements([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMasterData() }, [loadMasterData])
  useEffect(() => { loadMovements() }, [loadMovements])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Purchases</h1>
        <p className="mt-0.5 text-sm text-gray-500">Receive goods and manage purchase stock</p>
      </div>

      {/* Receive form — only for managers+ */}
      {canManage && (
        <ReceiveStockForm
          products={products}
          locations={locations}
          onReceived={loadMovements}
        />
      )}

      {/* History */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Purchase History</h2>
          <Button variant="secondary" size="sm" onClick={loadMovements}>Refresh</Button>
        </div>
        <Card padding="p-0">
          <MovementsTable movements={movements} loading={loading} />
        </Card>
      </div>
    </div>
  )
}

// ── Icon ──────────────────────────────────────────────────────────────────────

function InboxIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />
    </svg>
  )
}
