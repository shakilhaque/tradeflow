import MasterDataPage from './MasterDataPage'
import Badge from '../../components/ui/Badge'
import { getUnits, createUnit, updateUnit, deleteUnit } from '../../api/products'

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'

const blankForm = { name: '', short_name: '', allow_decimal: false }

const DEMO = [
  { id: 'demo-u-1', name: 'Pieces',   abbreviation: 'Pc(s)', allow_decimal: false },
  { id: 'demo-u-2', name: 'Kilogram', abbreviation: 'kg',    allow_decimal: true  },
  { id: 'demo-u-3', name: 'Litre',    abbreviation: 'L',     allow_decimal: true  },
]

const normalize = (r) => ({
  id: r.id,
  name: r.name,
  short_name: r.abbreviation || r.short_name || '',
  abbreviation: r.abbreviation || r.short_name || '',
  allow_decimal: !!r.allow_decimal,
})

const columns = [
  { key: 'name',          label: 'Name' },
  { key: 'short_name',    label: 'Short name' },
  {
    key: 'allow_decimal', label: 'Allow decimal',
    render: (r) => (r.allow_decimal
      ? <Badge variant="green">Yes</Badge>
      : <Badge variant="gray">No</Badge>),
  },
]

function FormFields({ form, setForm }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Name *</label>
        <input className={inputCls} value={form.name}
               onChange={(e) => setForm({ ...form, name: e.target.value })}
               placeholder="e.g. Kilogram" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Short name *</label>
        <input className={inputCls} value={form.short_name}
               onChange={(e) => setForm({ ...form, short_name: e.target.value })}
               placeholder="e.g. kg" />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={!!form.allow_decimal}
               onChange={(e) => setForm({ ...form, allow_decimal: e.target.checked })} />
        Allow decimal quantities (e.g. 1.5 kg)
      </label>
    </div>
  )
}

export default function UnitsPage() {
  return (
    <MasterDataPage
      title="Units"
      subtitle="Manage your units of measure"
      columns={columns}
      fetchAll={getUnits}
      create={(p) => createUnit({ name: p.name, abbreviation: p.short_name || p.abbreviation, allow_decimal: !!p.allow_decimal })}
      update={(id, p) => updateUnit(id, { name: p.name, abbreviation: p.short_name || p.abbreviation, allow_decimal: !!p.allow_decimal })}
      remove={deleteUnit}
      demoRows={DEMO}
      normalize={normalize}
      FormFields={FormFields}
      blankForm={blankForm}
      exportRow={(r) => [r.name, r.short_name, r.allow_decimal ? 'Yes' : 'No']}
    />
  )
}
