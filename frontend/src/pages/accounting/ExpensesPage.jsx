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
import { getExpenses, createExpense, getAccounts } from '../../api/accounting'

const today  = () => new Date().toISOString().slice(0, 10)
const fmt    = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtC   = (n) => `$${fmt(n)}`

const CATEGORIES = ['RENT','UTILITIES','SALARIES','MARKETING','SUPPLIES','TRANSPORT','OTHER']
const CAT_VARIANT = {
  RENT:'blue', UTILITIES:'yellow', SALARIES:'indigo',
  MARKETING:'green', SUPPLIES:'gray', TRANSPORT:'blue', OTHER:'gray',
}

// ── Create Expense modal ──────────────────────────────────────────────────────

function CreateExpenseModal({ open, onClose, accounts, onCreated }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')

  // Split accounts into expense-type and asset/liability (payment) accounts
  const expenseAccounts = accounts.filter((a) =>
    ['EXPENSE', 'COGS'].includes(a.account_type) && a.is_active
  )
  const paymentAccounts = accounts.filter((a) =>
    ['ASSET', 'LIABILITY'].includes(a.account_type) && a.is_active
  )

  useEffect(() => {
    if (open) {
      reset({ category: 'OTHER', amount: '', expense_account_id: '', payment_account_id: '', description: '', expense_date: today() })
      setServerError('')
    }
  }, [open, reset])

  const onSubmit = async (data) => {
    setServerError('')
    try {
      await createExpense({
        category:           data.category,
        amount:             Number(data.amount),
        expense_account_id: data.expense_account_id,
        payment_account_id: data.payment_account_id,
        description:        data.description || '',
        expense_date:       data.expense_date || today(),
      })
      onCreated?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to save expense')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record Expense" size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Category"
            required
            error={errors.category?.message}
            {...register('category', { required: 'Required' })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
            ))}
          </Select>
          <Input
            label="Amount ($)"
            required
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            error={errors.amount?.message}
            {...register('amount', { required: 'Required', min: { value: 0.01, message: '> 0' } })}
          />
        </div>

        <Select
          label="Expense Account"
          required
          error={errors.expense_account_id?.message}
          {...register('expense_account_id', { required: 'Required' })}
        >
          <option value="">— Select account —</option>
          {expenseAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </Select>

        <Select
          label="Payment Account (Paid From)"
          required
          error={errors.payment_account_id?.message}
          {...register('payment_account_id', { required: 'Required' })}
        >
          <option value="">— Select account —</option>
          {paymentAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
          ))}
        </Select>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Date"
            type="date"
            {...register('expense_date')}
          />
          <Input
            label="Description"
            placeholder="Optional notes"
            {...register('description')}
          />
        </div>
      </form>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>Save Expense</Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const { user }  = useAuth()
  const canManage = user?.permissions?.includes('can_record_expense') ||
                    ['owner', 'admin', 'manager'].includes(user?.role)

  const [expenses,    setExpenses]    = useState([])
  const [accounts,    setAccounts]    = useState([])
  const [loading,     setLoading]     = useState(true)
  const [filterCat,   setFilterCat]   = useState('')
  const [dateFrom,    setDateFrom]    = useState('')
  const [dateTo,      setDateTo]      = useState('')
  const [modalOpen,   setModalOpen]   = useState(false)

  const loadAccounts = useCallback(async () => {
    try {
      const data = await getAccounts()
      setAccounts(Array.isArray(data) ? data : (data?.results ?? []))
    } catch { /* ignore */ }
  }, [])

  const loadExpenses = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (filterCat) params.category  = filterCat
      if (dateFrom)  params.date_from = dateFrom
      if (dateTo)    params.date_to   = dateTo
      const data = await getExpenses(params)
      setExpenses(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setExpenses([])
    } finally {
      setLoading(false)
    }
  }, [filterCat, dateFrom, dateTo])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { loadExpenses() }, [loadExpenses])

  const total = expenses.reduce((s, e) => s + Number(e.amount || 0), 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Expenses</h1>
          <p className="mt-0.5 text-sm text-gray-500">Track and record business expenses</p>
        </div>
        {canManage && (
          <Button onClick={() => setModalOpen(true)}>
            <PlusIcon /> Record Expense
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card padding="p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={filterCat}
            onChange={(e) => setFilterCat(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500 bg-white cursor-pointer"
          >
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500"
          />
          <span className="text-gray-400 text-sm">→</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none
                       focus:ring-2 focus:ring-brand-500"
          />
          <Button variant="secondary" size="sm" onClick={loadExpenses}>Refresh</Button>
        </div>
      </Card>

      {/* Table */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : !expenses.length ? (
          <EmptyState
            icon={<WalletIcon />}
            title="No expenses found"
            message="Record your first expense to get started."
            action={canManage && <Button size="sm" onClick={() => setModalOpen(true)}><PlusIcon /> Record Expense</Button>}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Category</th>
                    <th className="px-5 py-3">Description</th>
                    <th className="px-5 py-3">Expense Account</th>
                    <th className="px-5 py-3">Paid From</th>
                    <th className="px-5 py-3">JE #</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {expenses.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50/60">
                      <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{e.expense_date}</td>
                      <td className="px-5 py-3">
                        <Badge variant={CAT_VARIANT[e.category] ?? 'gray'}>{e.category}</Badge>
                      </td>
                      <td className="px-5 py-3 text-gray-600 max-w-xs truncate">{e.description || '—'}</td>
                      <td className="px-5 py-3 text-gray-600">{e.expense_account_name}</td>
                      <td className="px-5 py-3 text-gray-600">{e.payment_account_name}</td>
                      <td className="px-5 py-3 text-xs font-mono text-gray-400">{e.journal_entry_number ?? '—'}</td>
                      <td className="px-5 py-3 text-right font-semibold text-gray-900">{fmtC(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                    <td colSpan={6} className="px-5 py-3 text-gray-700">Total</td>
                    <td className="px-5 py-3 text-right text-gray-900">{fmtC(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Card>

      <CreateExpenseModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        accounts={accounts}
        onCreated={loadExpenses}
      />
    </div>
  )
}

function PlusIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" /></svg>
}
function WalletIcon() {
  return <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" /></svg>
}
