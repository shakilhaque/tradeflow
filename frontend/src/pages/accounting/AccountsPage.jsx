import { useCallback, useEffect, useState } from 'react'
import { useForm }    from 'react-hook-form'
import Card           from '../../components/ui/Card'
import Button         from '../../components/ui/Button'
import Badge          from '../../components/ui/Badge'
import Input          from '../../components/ui/Input'
import Select         from '../../components/ui/Select'
import EmptyState     from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { useAuth }    from '../../context/AuthContext'
import { getAccounts, createAccount, updateAccount } from '../../api/accounting'

const fmt  = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtC = (n) => (n < 0 ? `-$${fmt(Math.abs(n))}` : `$${fmt(n)}`)

const TYPES    = ['ASSET','LIABILITY','EQUITY','INCOME','COGS','EXPENSE']
const TYPE_VAR = { ASSET:'green', LIABILITY:'red', EQUITY:'blue', INCOME:'indigo', COGS:'yellow', EXPENSE:'yellow' }

// ── Account form modal ────────────────────────────────────────────────────────

function AccountFormModal({ open, onClose, account, accounts, onSaved }) {
  const isEdit = Boolean(account)
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')

  useEffect(() => {
    if (open) {
      reset(isEdit
        ? { name: account.name, is_active: account.is_active, description: account.description ?? '' }
        : { code: '', name: '', account_type: 'ASSET', parent_id: '', is_contra: false, description: '' }
      )
      setServerError('')
    }
  }, [open, account, isEdit, reset])

  const onSubmit = async (data) => {
    setServerError('')
    try {
      if (isEdit) {
        await updateAccount(account.id, {
          name:        data.name,
          is_active:   data.is_active,
          description: data.description ?? '',
        })
      } else {
        await createAccount({
          code:         data.code.trim(),
          name:         data.name.trim(),
          account_type: data.account_type,
          parent_id:    data.parent_id || null,
          is_contra:    data.is_contra || false,
          description:  data.description || '',
        })
      }
      onSaved?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to save account')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Account' : 'New Account'} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        {!isEdit && (
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Account Code"
              required
              placeholder="e.g. 1100"
              error={errors.code?.message}
              {...register('code', { required: 'Required' })}
            />
            <Select
              label="Type"
              required
              {...register('account_type', { required: 'Required' })}
            >
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>
        )}

        <Input
          label="Account Name"
          required
          placeholder="e.g. Cash on Hand"
          error={errors.name?.message}
          {...register('name', { required: 'Required' })}
        />

        {!isEdit && (
          <>
            <Select label="Parent Account" {...register('parent_id')}>
              <option value="">— None (top-level) —</option>
              {accounts.filter((a) => a.is_active).map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="rounded" {...register('is_contra')} />
              Contra account (reverses normal balance)
            </label>
          </>
        )}

        <Input
          label="Description"
          placeholder="Optional description"
          {...register('description')}
        />

        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" className="rounded" {...register('is_active')} />
            Account is active
          </label>
        )}
      </form>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>
          {isEdit ? 'Save Changes' : 'Create Account'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AccountsPage() {
  const { user }  = useAuth()
  const canManage = user?.permissions?.includes('can_view_profit_loss') ||
                    ['owner', 'admin'].includes(user?.role)

  const [accounts,    setAccounts]    = useState([])
  const [loading,     setLoading]     = useState(true)
  const [filterType,  setFilterType]  = useState('')
  const [filterActive, setFilterActive] = useState('true')
  const [modalOpen,   setModalOpen]   = useState(false)
  const [editAccount, setEditAccount] = useState(null)

  const loadAccounts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAccounts()
      setAccounts(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  // Group by type for display
  const grouped = TYPES.reduce((acc, type) => {
    const items = accounts.filter((a) => {
      if (filterType   && a.account_type !== filterType)  return false
      if (filterActive === 'true'  && !a.is_active)       return false
      if (filterActive === 'false' && a.is_active)        return false
      return a.account_type === type
    })
    if (items.length) acc[type] = items
    return acc
  }, {})

  const openCreate = () => { setEditAccount(null); setModalOpen(true) }
  const openEdit   = (acc) => { setEditAccount(acc); setModalOpen(true) }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Chart of Accounts</h1>
          <p className="mt-0.5 text-sm text-gray-500">General ledger accounts and balances</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <PlusIcon /> New Account
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card padding="p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 bg-white cursor-pointer"
          >
            <option value="">All</option>
            <option value="true">Active only</option>
            <option value="false">Inactive</option>
          </select>
        </div>
      </Card>

      {/* Accounts grouped by type */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      ) : !Object.keys(grouped).length ? (
        <EmptyState
          icon={<DatabaseIcon />}
          title="No accounts found"
          message="Create your first account or adjust filters."
          action={canManage && <Button size="sm" onClick={openCreate}><PlusIcon /> New Account</Button>}
        />
      ) : (
        Object.entries(grouped).map(([type, items]) => (
          <Card key={type} padding="p-0">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 bg-gray-50">
              <Badge variant={TYPE_VAR[type] ?? 'gray'}>{type}</Badge>
              <span className="text-sm text-gray-500">{items.length} account{items.length !== 1 ? 's' : ''}</span>
              <span className="ml-auto text-xs font-semibold text-gray-500">
                Balance: {fmtC(items.reduce((s, a) => s + Number(a.balance || 0), 0))}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    <th className="px-5 py-2">Code</th>
                    <th className="px-5 py-2">Name</th>
                    <th className="px-5 py-2">Normal Balance</th>
                    <th className="px-5 py-2">Parent</th>
                    <th className="px-5 py-2 text-right">Balance</th>
                    <th className="px-5 py-2">Status</th>
                    {canManage && <th className="px-5 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map((acc) => (
                    <tr key={acc.id} className="hover:bg-gray-50/60">
                      <td className="px-5 py-3 font-mono text-xs text-gray-600">{acc.code}</td>
                      <td className="px-5 py-3 font-medium text-gray-900">
                        {acc.name}
                        {acc.is_system && <span className="ml-2 text-xs text-gray-400">(system)</span>}
                        {acc.is_contra && <span className="ml-2 text-xs text-yellow-600">(contra)</span>}
                      </td>
                      <td className="px-5 py-3 text-gray-500 capitalize">{acc.normal_balance?.toLowerCase()}</td>
                      <td className="px-5 py-3 text-gray-500 text-xs">{acc.parent_code ?? '—'}</td>
                      <td className="px-5 py-3 text-right font-mono font-medium text-gray-900">
                        {fmtC(acc.balance)}
                      </td>
                      <td className="px-5 py-3">
                        {acc.is_active
                          ? <Badge variant="green" dot>Active</Badge>
                          : <Badge variant="gray" dot>Inactive</Badge>
                        }
                      </td>
                      {canManage && (
                        <td className="px-5 py-3 text-right">
                          {!acc.is_system && (
                            <button
                              onClick={() => openEdit(acc)}
                              className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      <AccountFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        account={editAccount}
        accounts={accounts}
        onSaved={loadAccounts}
      />
    </div>
  )
}

function PlusIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" /></svg>
}
function DatabaseIcon() {
  return <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
}
