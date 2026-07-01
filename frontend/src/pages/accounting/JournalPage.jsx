import { useCallback, useEffect, useState } from 'react'
import { useForm, useFieldArray } from 'react-hook-form'
import Card           from '../../components/ui/Card'
import Button         from '../../components/ui/Button'
import Badge          from '../../components/ui/Badge'
import Input          from '../../components/ui/Input'
import Select         from '../../components/ui/Select'
import EmptyState     from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { useAuth }    from '../../context/AuthContext'
import { getJournalEntries, createJournalEntry, getAccounts } from '../../api/accounting'

const today = () => new Date().toISOString().slice(0, 10)
const fmt   = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtC  = (n) => `$${fmt(n)}`

// ── Create Journal Entry modal ─────────────────────────────────────────────────

function CreateJEModal({ open, onClose, accounts, onCreated }) {
  const {
    register, handleSubmit, control, reset, watch,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: {
      description: '',
      date: today(),
      lines: [
        { account_id: '', debit: '', credit: '', description: '' },
        { account_id: '', debit: '', credit: '', description: '' },
      ],
    },
  })
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' })
  const [serverError, setServerError] = useState('')

  const lines    = watch('lines')
  const totalDr  = lines.reduce((s, l) => s + (Number(l.debit)  || 0), 0)
  const totalCr  = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
  const balanced = Math.abs(totalDr - totalCr) < 0.001

  useEffect(() => {
    if (open) {
      reset({
        description: '',
        date: today(),
        lines: [
          { account_id: '', debit: '', credit: '', description: '' },
          { account_id: '', debit: '', credit: '', description: '' },
        ],
      })
      setServerError('')
    }
  }, [open, reset])

  const onSubmit = async (data) => {
    setServerError('')
    if (!balanced) { setServerError('Debits must equal credits'); return }
    try {
      await createJournalEntry({
        description: data.description,
        date:        data.date || today(),
        lines: data.lines
          .filter((l) => l.account_id)
          .map((l) => ({
            account_id:  l.account_id,
            debit:       Number(l.debit)  || 0,
            credit:      Number(l.credit) || 0,
            description: l.description   || '',
          })),
      })
      onCreated?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to save journal entry')
    }
  }

  const activeAccounts = accounts.filter((a) => a.is_active)

  return (
    <Modal open={open} onClose={onClose} title="Manual Journal Entry" size="3xl">
      <div className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Description"
            required
            placeholder="Purpose of this journal entry"
            error={errors.description?.message}
            {...register('description', { required: 'Required' })}
          />
          <Input label="Date" type="date" {...register('date')} />
        </div>

        {/* Lines */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700">Journal Lines</label>
            <button
              type="button"
              onClick={() => append({ account_id: '', debit: '', credit: '', description: '' })}
              className="text-xs text-brand-600 hover:text-brand-700 font-medium"
            >
              + Add line
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2 w-2/5">Account</th>
                  <th className="px-3 py-2 w-1/6 text-right">Debit</th>
                  <th className="px-3 py-2 w-1/6 text-right">Credit</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {fields.map((field, i) => (
                  <tr key={field.id}>
                    <td className="px-2 py-1.5">
                      <select
                        {...register(`lines.${i}.account_id`)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700
                                   outline-none focus:ring-1 focus:ring-brand-400 bg-white"
                      >
                        <option value="">— Select —</option>
                        {activeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        {...register(`lines.${i}.debit`)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-right
                                   outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        {...register(`lines.${i}.credit`)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-right
                                   outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        placeholder="Optional"
                        {...register(`lines.${i}.description`)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs
                                   outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {fields.length > 2 && (
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50 text-xs font-semibold">
                  <td className="px-3 py-2 text-gray-600">Totals</td>
                  <td className="px-3 py-2 text-right text-gray-900">{fmtC(totalDr)}</td>
                  <td className="px-3 py-2 text-right text-gray-900">{fmtC(totalCr)}</td>
                  <td colSpan={2} className="px-3 py-2">
                    {balanced
                      ? <span className="text-green-600">✓ Balanced</span>
                      : <span className="text-red-500">✗ Difference: {fmtC(Math.abs(totalDr - totalCr))}</span>
                    }
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} disabled={!balanced} onClick={handleSubmit(onSubmit)}>
          Post Entry
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Journal entry detail expander ─────────────────────────────────────────────

function JERow({ je }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr
        className="hover:bg-gray-50/60 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-5 py-3 text-gray-500 whitespace-nowrap font-mono text-xs">{je.entry_number}</td>
        <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{je.date}</td>
        <td className="px-5 py-3 text-gray-700 max-w-xs truncate">{je.description}</td>
        <td className="px-5 py-3">
          <Badge variant={je.reference_type === 'MANUAL' ? 'indigo' : 'gray'}>{je.reference_type}</Badge>
        </td>
        <td className="px-5 py-3 text-right font-medium text-gray-900">{`$${Number(je.total_debit || 0).toFixed(2)}`}</td>
        <td className="px-5 py-3 text-right font-medium text-gray-900">{`$${Number(je.total_credit || 0).toFixed(2)}`}</td>
        <td className="px-5 py-3">
          {je.is_balanced
            ? <Badge variant="green">Balanced</Badge>
            : <Badge variant="red">Unbalanced</Badge>
          }
        </td>
        <td className="px-5 py-3 text-gray-400 text-xs">{expanded ? '▲' : '▼'}</td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50/40">
          <td colSpan={8} className="px-8 py-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 uppercase tracking-wide font-semibold">
                  <th className="pb-1 pr-4">Account</th>
                  <th className="pb-1 pr-4">Description</th>
                  <th className="pb-1 text-right pr-4">Debit</th>
                  <th className="pb-1 text-right">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(je.lines ?? []).map((line) => (
                  <tr key={line.id}>
                    <td className="py-1 pr-4 text-gray-700">{line.account_code} {line.account_name}</td>
                    <td className="py-1 pr-4 text-gray-500">{line.description || '—'}</td>
                    <td className="py-1 pr-4 text-right font-mono">{Number(line.debit)  > 0 ? `$${Number(line.debit).toFixed(2)}`  : '—'}</td>
                    <td className="py-1 text-right font-mono">{Number(line.credit) > 0 ? `$${Number(line.credit).toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function JournalPage() {
  const { user }  = useAuth()
  const canManage = user?.permissions?.includes('can_view_profit_loss') ||
                    ['owner', 'admin'].includes(user?.role)

  const [entries,   setEntries]   = useState([])
  const [accounts,  setAccounts]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [dateFrom,  setDateFrom]  = useState('')
  const [dateTo,    setDateTo]    = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const loadAccounts = useCallback(async () => {
    try {
      const data = await getAccounts()
      setAccounts(Array.isArray(data) ? data : (data?.results ?? []))
    } catch { /* ignore */ }
  }, [])

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (dateFrom) params.date_from = dateFrom
      if (dateTo)   params.date_to   = dateTo
      const data = await getJournalEntries(params)
      setEntries(Array.isArray(data) ? data : (data?.results ?? []))
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { loadEntries()  }, [loadEntries])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Journal Entries</h1>
          <p className="mt-0.5 text-sm text-gray-500">All posted accounting journal entries</p>
        </div>
        {canManage && (
          <Button onClick={() => setModalOpen(true)}>
            <PlusIcon /> Manual Entry
          </Button>
        )}
      </div>

      <Card padding="p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-brand-500" />
          <span className="text-gray-400 text-sm">→</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-brand-500" />
          <Button variant="secondary" size="sm" onClick={loadEntries}>Refresh</Button>
        </div>
      </Card>

      <Card padding="p-0">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : !entries.length ? (
          <EmptyState icon={<BookIcon />} title="No journal entries" message="Entries are created automatically by sales, expenses, and stock movements." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-5 py-3">Entry #</th>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Description</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3 text-right">Debit</th>
                  <th className="px-5 py-3 text-right">Credit</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {entries.map((je) => <JERow key={je.id} je={je} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateJEModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        accounts={accounts}
        onCreated={loadEntries}
      />
    </div>
  )
}

function PlusIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" /></svg>
}
function BookIcon() {
  return <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>
}
