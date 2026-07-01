import MasterDataPage from './MasterDataPage'
import { getCategories, createCategory, updateCategory, deleteCategory } from '../../api/products'

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'

const blankForm = { name: '', code: '', description: '' }

const DEMO = [
  { id: 'demo-c-1', name: 'Stationery',        code: 'STN', description: 'Pens, paper and office supplies' },
  { id: 'demo-c-2', name: 'Tape & Adhesives',  code: 'TAP', description: 'Tapes, glues, adhesives' },
  { id: 'demo-c-3', name: 'Files & Folders',   code: 'FOL', description: 'Document files and folders' },
]

const columns = [
  { key: 'name',        label: 'Category' },
  { key: 'code',        label: 'Category Code' },
  { key: 'description', label: 'Description' },
]

function FormFields({ form, setForm }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Category *</label>
        <input className={inputCls} value={form.name}
               onChange={(e) => setForm({ ...form, name: e.target.value })}
               placeholder="e.g. Stationery" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Category Code</label>
        <input className={inputCls} value={form.code || ''}
               onChange={(e) => setForm({ ...form, code: e.target.value })}
               placeholder="e.g. STN" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Description</label>
        <textarea className={inputCls + ' min-h-[100px]'} value={form.description || ''}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Short description for this category" />
      </div>
    </div>
  )
}

export default function CategoriesPage() {
  return (
    <MasterDataPage
      title="Categories"
      subtitle="Manage your categories"
      columns={columns}
      fetchAll={getCategories}
      create={(p) => createCategory({ name: p.name, code: p.code, description: p.description })}
      update={(id, p) => updateCategory(id, { name: p.name, code: p.code, description: p.description })}
      remove={deleteCategory}
      demoRows={DEMO}
      FormFields={FormFields}
      blankForm={blankForm}
    />
  )
}
