import MasterDataPage from './MasterDataPage'
import { getWarranties, createWarranty, updateWarranty, deleteWarranty } from '../../api/products'

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'

const DURATION_UNITS = [
  { value: 'days',   label: 'Days'   },
  { value: 'months', label: 'Months' },
  { value: 'years',  label: 'Years'  },
]

const blankForm = { name: '', description: '', duration_value: 12, duration_unit: 'months' }

const DEMO = [
  { id: 'demo-w-1', name: '1 Year Manufacturer', description: 'Standard 12-month manufacturer warranty', duration_value: 12, duration_unit: 'months', duration_label: '12 Months' },
  { id: 'demo-w-2', name: '2 Year Extended',     description: 'Extended warranty for premium products',  duration_value: 2,  duration_unit: 'years',  duration_label: '2 Years'   },
  { id: 'demo-w-3', name: '30 Day Returns',      description: 'In-store return / exchange period',       duration_value: 30, duration_unit: 'days',   duration_label: '30 Days'   },
]

const normalize = (r) => ({
  ...r,
  duration: r.duration_label || `${r.duration_value} ${cap(r.duration_unit || '')}`,
})

const columns = [
  { key: 'name',        label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'duration',    label: 'Duration' },
]

function FormFields({ form, setForm }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Name *</label>
        <input className={inputCls} value={form.name}
               onChange={(e) => setForm({ ...form, name: e.target.value })}
               placeholder="e.g. 1 Year Manufacturer" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Description</label>
        <textarea className={inputCls + ' min-h-[100px]'} value={form.description || ''}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Optional notes about coverage" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Duration *</label>
          <input type="number" min="1" className={inputCls}
                 value={form.duration_value ?? ''}
                 onChange={(e) => setForm({ ...form, duration_value: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Unit *</label>
          <select className={inputCls} value={form.duration_unit || 'months'}
                  onChange={(e) => setForm({ ...form, duration_unit: e.target.value })}>
            {DURATION_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  )
}

export default function WarrantiesPage() {
  return (
    <MasterDataPage
      title="Warranties"
      subtitle="Manage your product warranties"
      columns={columns}
      fetchAll={getWarranties}
      create={(p) => createWarranty({
        name: p.name, description: p.description,
        duration_value: Number(p.duration_value || 0),
        duration_unit:  p.duration_unit || 'months',
      })}
      update={(id, p) => updateWarranty(id, {
        name: p.name, description: p.description,
        duration_value: Number(p.duration_value || 0),
        duration_unit:  p.duration_unit || 'months',
      })}
      remove={deleteWarranty}
      demoRows={DEMO}
      normalize={normalize}
      FormFields={FormFields}
      blankForm={blankForm}
      exportRow={(r) => [r.name, r.description || '', r.duration]}
    />
  )
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : '' }
