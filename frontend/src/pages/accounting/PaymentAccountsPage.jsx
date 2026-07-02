import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getPaymentAccounts,
  createPaymentAccount,
  updatePaymentAccount,
  deletePaymentAccount,
  getPaymentAccountTransactions,
  depositToPaymentAccount,
  transferBetweenPaymentAccounts,
} from '../../api/accounting'

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const TYPE_LABEL = {
  CASH:  'Cash Balance',
  BANK:  'Bank Balance',
  MFS:   'Mobile Banking',
  CARD:  'Card / Gateway',
  OTHER: 'Other',
}

const TYPE_BADGE = {
  CASH:  'bg-emerald-50  text-emerald-700  border-emerald-100',
  BANK:  'bg-brand-50    text-brand-700    border-brand-100',
  MFS:   'bg-violet-50   text-violet-700   border-violet-100',
  CARD:  'bg-amber-50    text-amber-700    border-amber-100',
  OTHER: 'bg-gray-100    text-gray-700     border-gray-200',
}

export default function PaymentAccountsPage() {
  const [tab,     setTab]     = useState('accounts')   // 'accounts' | 'types'
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [search,  setSearch]  = useState('')
  const [activeFilter, setActiveFilter] = useState('active')   // 'active' | 'inactive' | 'all'

  const [modalOpen,    setModalOpen]    = useState(false)
  const [editing,      setEditing]      = useState(null)
  const [deletingId,   setDeletingId]   = useState(null)

  // Action modals — only one open at a time, holds the row being acted on.
  const [bookFor,      setBookFor]      = useState(null)  // PaymentAccount row
  const [depositFor,   setDepositFor]   = useState(null)
  const [transferFor,  setTransferFor]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = {}
      if (activeFilter === 'active')   params.active = 'true'
      if (activeFilter === 'inactive') params.active = 'false'
      const res = await getPaymentAccounts(params)
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
    } catch (err) {
      setError(err?.message || 'Failed to load payment accounts.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [activeFilter])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      (r.name || '').toLowerCase().includes(q)
      || (r.account_number || '').toLowerCase().includes(q)
      || (r.account_type_display || '').toLowerCase().includes(q)
      || (r.note || '').toLowerCase().includes(q),
    )
  }, [rows, search])

  const totalBalance = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.balance || r.opening_balance || 0), 0),
    [filtered],
  )

  const openAdd = () => {
    setEditing(null)
    setModalOpen(true)
  }
  const openEdit = (row) => {
    setEditing(row)
    setModalOpen(true)
  }
  const onSaved = async () => {
    setModalOpen(false); setEditing(null)
    await load()
  }

  const handleDelete = async (row) => {
    if (!confirm(`Delete "${row.name}"? This cannot be undone.`)) return
    setDeletingId(row.id)
    try {
      await deletePaymentAccount(row.id)
      await load()
    } catch (err) {
      alert(err?.message || 'Failed to delete payment account.')
    } finally {
      setDeletingId(null)
    }
  }

  // Aggregate by account type for the "Account Types" tab.
  const typeBuckets = useMemo(() => {
    const byType = {}
    for (const r of rows) {
      const k = r.account_type || 'OTHER'
      if (!byType[k]) byType[k] = { type: k, count: 0, balance: 0, sample: [] }
      byType[k].count   += 1
      byType[k].balance += Number(r.balance || 0)
      if (byType[k].sample.length < 3) byType[k].sample.push(r.name)
    }
    return Object.values(byType).sort((a, b) => b.balance - a.balance)
  }, [rows])

  return (
    <div className="space-y-5">
      {/* ── Heading banner ───────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Payment Accounts</h1>
          <p className="text-xs text-emerald-50 mt-0.5">
            Manage cash boxes, bank accounts and mobile-banking wallets where POS payments land.
          </p>
        </div>
        <div className="text-right text-white">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-80">Combined balance</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums">{fmtMoney(totalBalance)}</p>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          {[
            { id: 'accounts', label: 'Accounts',      count: rows.length },
            { id: 'types',    label: 'Account Types', count: typeBuckets.length },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                '-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                tab === t.id
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700',
              ].join(' ')}
            >
              {t.label}
              <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                {t.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* ── Account Types tab body ───────────────────────────────────────── */}
      {tab === 'types' && (
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <p className="mb-4 text-xs text-gray-500">
            Roll-up by type — useful for a quick "where is my money?" snapshot.
          </p>
          {typeBuckets.length === 0 ? (
            <p className="text-sm text-gray-400">No accounts to summarise yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {typeBuckets.map((b) => (
                <div key={b.type} className="rounded-xl border border-gray-100 bg-gray-50/40 p-4">
                  <div className="flex items-center justify-between">
                    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[b.type] ?? TYPE_BADGE.OTHER}`}>
                      {TYPE_LABEL[b.type] || b.type}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-gray-400">
                      {b.count} acct{b.count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-3 text-2xl font-bold tabular-nums text-gray-900">{fmtMoney(b.balance)}</p>
                  <p className="mt-1 text-[11px] text-gray-500 truncate">
                    {b.sample.join(' · ')}
                    {b.count > b.sample.length ? ` +${b.count - b.sample.length} more` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Toolbar — only shown on the Accounts tab */}
      {tab === 'accounts' && (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            className="!gap-0"
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </Select>
          <SearchInput
            placeholder="Search name / account number / note…"
            value={search}
            onChange={setSearch}
          />
        </div>
        <Button onClick={openAdd} leftIcon={<IconPlus />}>Add Account</Button>
      </div>
      )}

      {tab === 'accounts' && (
      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12">
            <EmptyState
              title="No payment accounts yet"
              message='Click "Add Account" to register a cash box, bank account, or MFS wallet.'
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Account Type</th>
                  <th className="px-4 py-3">Sub Type</th>
                  <th className="px-4 py-3">Account Number</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3">Account Details</th>
                  <th className="px-4 py-3">Added By</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-navy-800">{r.name}</div>
                      {!r.is_active && <div className="text-[10px] uppercase tracking-wider text-gray-400">Inactive</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[r.account_type] ?? TYPE_BADGE.OTHER}`}>
                        {TYPE_LABEL[r.account_type] || r.account_type_display || r.account_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.sub_type || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.account_number || '—'}</td>
                    <td className="px-4 py-3 text-gray-600 max-w-[14rem] truncate" title={r.note}>{r.note || '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-navy-800 whitespace-nowrap tabular-nums">{fmtMoney(r.balance)}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {(r.details || []).filter((d) => d?.label || d?.value).length === 0 ? (
                        '—'
                      ) : (
                        <ul className="space-y-0.5">
                          {(r.details || []).slice(0, 3).map((d, i) => (
                            <li key={i}><span className="text-gray-400">{d.label || '—'}:</span> {d.value || ''}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.added_by_name || '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <ActionMenu
                        onEdit={() => openEdit(r)}
                        onBook={() => setBookFor(r)}
                        onTransfer={() => setTransferFor(r)}
                        onDeposit={() => setDepositFor(r)}
                        onDelete={() => handleDelete(r)}
                        deleting={deletingId === r.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 text-sm font-semibold border-t border-gray-200">
                  <td className="px-4 py-3 text-gray-700" colSpan={5}>Total:</td>
                  <td className="px-4 py-3 text-right text-navy-800 tabular-nums">{fmtMoney(totalBalance)}</td>
                  <td className="px-4 py-3" colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      )}

      {modalOpen && (
        <AccountModal
          editing={editing}
          onClose={() => { setModalOpen(false); setEditing(null) }}
          onSaved={onSaved}
        />
      )}
      {bookFor && (
        <AccountBookModal
          account={bookFor}
          onClose={() => setBookFor(null)}
        />
      )}
      {depositFor && (
        <DepositModal
          account={depositFor}
          onClose={() => setDepositFor(null)}
          onSaved={async () => { setDepositFor(null); await load() }}
        />
      )}
      {transferFor && (
        <TransferModal
          fromAccount={transferFor}
          accounts={rows}
          onClose={() => setTransferFor(null)}
          onSaved={async () => { setTransferFor(null); await load() }}
        />
      )}
    </div>
  )
}

// ── Action link (compact colored button for the action column) ───────────────

function ActionLink({ color = 'brand', onClick, icon, children, disabled }) {
  const colors = {
    brand:   'bg-brand-600    hover:bg-brand-700',
    amber:   'bg-amber-500    hover:bg-amber-600',
    emerald: 'bg-emerald-500  hover:bg-emerald-600',
    violet:  'bg-violet-500   hover:bg-violet-600',
    rose:    'bg-rose-500     hover:bg-rose-600',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-white shadow-soft transition',
        colors[color] ?? colors.brand,
        disabled ? 'opacity-60 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {icon && <span className="w-3 h-3">{icon}</span>}
      {children}
    </button>
  )
}

// ── Actions dropdown (collapses the row's actions into one menu) ──────────────

function ActionMenu({ onEdit, onBook, onTransfer, onDeposit, onDelete, deleting }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  const run = (fn) => { setOpen(false); fn() }
  const item = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition'

  return (
    <div className="relative inline-block text-left" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-soft transition hover:bg-brand-700"
      >
        Actions
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-pop">
          <button type="button" className={`${item} text-gray-700 hover:bg-brand-50`}    onClick={() => run(onEdit)}>    <span className="w-3.5 h-3.5 text-brand-600"><IconEdit /></span>Edit</button>
          <button type="button" className={`${item} text-gray-700 hover:bg-amber-50`}    onClick={() => run(onBook)}>    <span className="w-3.5 h-3.5 text-amber-500"><IconBook /></span>Account Book</button>
          <button type="button" className={`${item} text-gray-700 hover:bg-emerald-50`}  onClick={() => run(onTransfer)}><span className="w-3.5 h-3.5 text-emerald-500"><IconTransfer /></span>Fund Transfer</button>
          <button type="button" className={`${item} text-gray-700 hover:bg-violet-50`}   onClick={() => run(onDeposit)}> <span className="w-3.5 h-3.5 text-violet-500"><IconDownload /></span>Deposit</button>
          <div className="my-1 border-t border-gray-100" />
          <button type="button" disabled={deleting} className={`${item} text-rose-600 hover:bg-rose-50 ${deleting ? 'opacity-60 cursor-not-allowed' : ''}`} onClick={() => run(onDelete)}>
            <span className="w-3.5 h-3.5 text-rose-500"><IconTrash /></span>{deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Add / Edit modal ────────────────────────────────────────────────────────

function AccountModal({ editing, onClose, onSaved }) {
  const [form, setForm] = useState(() => editing ? {
    name:            editing.name || '',
    account_number:  editing.account_number || '',
    account_type:    editing.account_type || 'CASH',
    sub_type:        editing.sub_type || '',
    opening_balance: editing.opening_balance ?? 0,
    note:            editing.note || '',
    details:         (editing.details && editing.details.length ? editing.details : Array(6).fill({ label: '', value: '' })).slice(0, 6),
  } : {
    name:            '',
    account_number:  '',
    account_type:    'CASH',
    sub_type:        '',
    opening_balance: 0,
    note:            '',
    details:         Array.from({ length: 6 }, () => ({ label: '', value: '' })),
  })

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const updateDetail = (i, patch) => {
    setForm((p) => {
      const next = [...p.details]
      next[i] = { ...next[i], ...patch }
      return { ...p, details: next }
    })
  }

  const save = async () => {
    setError('')
    if (!form.name.trim())           { setError('Name is required.'); return }
    if (!form.account_number.trim() && form.account_type !== 'CASH') {
      setError('Account number is required for non-cash accounts.'); return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        name:           form.name.trim(),
        account_number: form.account_number.trim(),
        sub_type:       (form.sub_type || '').trim(),
        details:        form.details.filter((d) => (d.label || '').trim() || (d.value || '').trim()),
      }
      if (editing) {
        await updatePaymentAccount(editing.id, payload)
      } else {
        await createPaymentAccount(payload)
      }
      onSaved()
    } catch (err) {
      setError(extractError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit Account' : 'Add Account'} size="lg">
      <div className="space-y-4">
        <Input label="Name *" placeholder="e.g. City Bank — Operating"
               value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

        <Input label="Account Number *" placeholder="e.g. 1263803656001"
               value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Account Type *" value={form.account_type}
                  onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
            <option value="CASH">Cash Balance</option>
            <option value="BANK">Bank Balance</option>
            <option value="MFS">Mobile Banking (bKash / Nagad)</option>
            <option value="CARD">Card / Gateway</option>
            <option value="OTHER">Other</option>
          </Select>
          <Input label="Sub Type / Bank Name"
                 placeholder="e.g. Operating, Salary, bKash Merchant"
                 value={form.sub_type} onChange={(e) => setForm({ ...form, sub_type: e.target.value })} />
        </div>

        <Input label="Opening Balance" type="number" min="0" step="0.01"
               value={form.opening_balance}
               onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} />

        {/* Account details — Label/Value pairs */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Account Details</p>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <span>Label</span><span>Value</span>
            </div>
            {form.details.map((row, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <input
                  className="h-9 rounded-lg border border-gray-200 px-3 text-sm"
                  placeholder="Branch / IFSC / Routing…"
                  value={row.label || ''}
                  onChange={(e) => updateDetail(i, { label: e.target.value })}
                />
                <input
                  className="h-9 rounded-lg border border-gray-200 px-3 text-sm"
                  placeholder="Value"
                  value={row.value || ''}
                  onChange={(e) => updateDetail(i, { value: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Note</label>
          <textarea rows={3} value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">{error}</div>}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}

function extractError(err) {
  const fieldErrors = err?.errors
  if (fieldErrors && typeof fieldErrors === 'object') {
    return Object.entries(fieldErrors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
  }
  return err?.message || 'Operation failed.'
}

// ── Account Book modal ──────────────────────────────────────────────────────

const KIND_VARIANT = {
  DEPOSIT:      { bg: 'bg-emerald-50  text-emerald-700  border-emerald-100',  label: 'Deposit' },
  WITHDRAWAL:   { bg: 'bg-rose-50     text-rose-700     border-rose-100',     label: 'Withdrawal' },
  TRANSFER_IN:  { bg: 'bg-teal-50     text-teal-700     border-teal-100',     label: 'Transfer In' },
  TRANSFER_OUT: { bg: 'bg-amber-50    text-amber-700    border-amber-100',    label: 'Transfer Out' },
  SALE:         { bg: 'bg-brand-50    text-brand-700    border-brand-100',    label: 'Sale Payment' },
  EXPENSE:      { bg: 'bg-violet-50   text-violet-700   border-violet-100',   label: 'Expense' },
  ADJUSTMENT:   { bg: 'bg-gray-100    text-gray-700     border-gray-200',     label: 'Adjustment' },
}

function AccountBookModal({ account, onClose }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = {}
      if (dateFrom) params.date_from = dateFrom
      if (dateTo)   params.date_to   = dateTo
      const res = await getPaymentAccountTransactions(account.id, params)
      setData(res)
    } catch (err) {
      setError(err?.message || 'Failed to load account book.')
    } finally {
      setLoading(false)
    }
  }, [account.id, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const transactions = data?.transactions || []
  const opening      = Number(data?.opening_balance || 0)
  const closing      = Number(data?.closing_balance || 0)
  const totalIn      = transactions.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0)
  const totalOut     = transactions.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Math.abs(Number(t.amount)), 0)

  return (
    <Modal open onClose={onClose} title={`Account Book — ${account.name}`} size="3xl">
      <div className="space-y-4">
        {/* Summary strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryStat label="Opening"     value={fmtMoney(opening)} accent="brand" />
          <SummaryStat label="Credits (+)" value={fmtMoney(totalIn)} accent="emerald" />
          <SummaryStat label="Debits (−)"  value={fmtMoney(totalOut)} accent="rose" />
          <SummaryStat label="Closing"     value={fmtMoney(closing)} accent={closing >= 0 ? 'brand' : 'amber'} />
        </div>

        {/* Date filters */}
        <div className="flex flex-wrap items-end gap-3">
          <Input label="From" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-40" />
          <Input label="To"   type="date" value={dateTo}   onChange={(e) => setDateTo(e.target.value)}   className="w-40" />
          {(dateFrom || dateTo) && (
            <Button variant="secondary" size="sm" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear</Button>
          )}
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        {/* Ledger */}
        <div className="rounded-lg border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">No transactions for this period.</div>
          ) : (
            <div className="overflow-x-auto max-h-[55vh]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80 sticky top-0">
                  <tr className="text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Kind</th>
                    <th className="px-4 py-2.5">Reference</th>
                    <th className="px-4 py-2.5">Note</th>
                    <th className="px-4 py-2.5 text-right">Credit</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 bg-white">
                  {transactions.map((t) => {
                    const v = KIND_VARIANT[t.kind] || KIND_VARIANT.ADJUSTMENT
                    const amt = Number(t.amount)
                    return (
                      <tr key={t.id} className="hover:bg-gray-50/40">
                        <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
                          {new Date(t.transaction_date).toLocaleDateString()}<br />
                          <span className="text-[10px] text-gray-400">{new Date(t.transaction_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${v.bg}`}>{v.label}</span>
                          {t.counter_account_name && <div className="mt-0.5 text-[10px] text-gray-500">↔ {t.counter_account_name}</div>}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-600">{t.reference || '—'}</td>
                        <td className="px-4 py-2 text-gray-600 max-w-[14rem] truncate" title={t.note}>{t.note || '—'}</td>
                        <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
                          {amt > 0 ? <span className="text-emerald-700 font-semibold">{fmtMoney(amt)}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
                          {amt < 0 ? <span className="text-rose-600 font-semibold">{fmtMoney(Math.abs(amt))}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums font-semibold text-navy-800">
                          {fmtMoney(t.running_balance)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t border-gray-200 text-sm font-semibold">
                    <td className="px-4 py-2.5 text-gray-700" colSpan={4}>Total</td>
                    <td className="px-4 py-2.5 text-right text-emerald-700 tabular-nums">{fmtMoney(totalIn)}</td>
                    <td className="px-4 py-2.5 text-right text-rose-600 tabular-nums">{fmtMoney(totalOut)}</td>
                    <td className="px-4 py-2.5 text-right text-navy-800 tabular-nums">{fmtMoney(closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="secondary" onClick={() => window.print()}>Print</Button>
      </ModalFooter>
    </Modal>
  )
}

function SummaryStat({ label, value, accent = 'brand' }) {
  const tones = {
    brand:   'border-brand-100   text-brand-700',
    emerald: 'border-emerald-100 text-emerald-700',
    rose:    'border-rose-100    text-rose-700',
    amber:   'border-amber-100   text-amber-700',
  }
  return (
    <div className={`rounded-lg border bg-white p-3 ${tones[accent] ?? tones.brand}`}>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums">{value}</p>
    </div>
  )
}

// ── Deposit / Withdrawal modal ──────────────────────────────────────────────

function DepositModal({ account, onClose, onSaved }) {
  const [kind,      setKind]      = useState('DEPOSIT')
  const [amount,    setAmount]    = useState('')
  const [reference, setReference] = useState('')
  const [note,      setNote]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const save = async () => {
    setError('')
    const amt = Number(amount)
    if (!amt || amt <= 0) { setError('Amount must be greater than zero.'); return }
    setSaving(true)
    try {
      await depositToPaymentAccount(account.id, {
        amount: amt.toFixed(2),
        reference: reference.trim(),
        note: note.trim(),
        kind,
      })
      onSaved()
    } catch (err) {
      setError(extractError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Deposit / Adjust — ${account.name}`} size="md">
      <div className="space-y-4">
        <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
          <p className="text-xs text-gray-500">Current balance</p>
          <p className="text-xl font-bold text-navy-800 tabular-nums">{fmtMoney(account.balance)}</p>
        </div>

        <Select label="Type *" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="DEPOSIT">Deposit (money in)</option>
          <option value="WITHDRAWAL">Withdrawal (money out)</option>
          <option value="ADJUSTMENT">Adjustment (other)</option>
        </Select>

        <Input label="Amount *" type="number" min="0.01" step="0.01"
               value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />

        <Input label="Reference" placeholder="Cheque no, txn id, slip no…"
               value={reference} onChange={(e) => setReference(e.target.value)} />

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Note</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">{error}</div>}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Fund Transfer modal ─────────────────────────────────────────────────────

function TransferModal({ fromAccount, accounts, onClose, onSaved }) {
  const others = accounts.filter((a) => a.id !== fromAccount.id && a.is_active)
  const [toId,      setToId]      = useState(others[0]?.id || '')
  const [amount,    setAmount]    = useState('')
  const [reference, setReference] = useState('')
  const [note,      setNote]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const dst = accounts.find((a) => a.id === toId)

  const save = async () => {
    setError('')
    if (!toId) { setError('Pick a destination account.'); return }
    const amt = Number(amount)
    if (!amt || amt <= 0) { setError('Amount must be greater than zero.'); return }
    setSaving(true)
    try {
      await transferBetweenPaymentAccounts({
        from_account_id: fromAccount.id,
        to_account_id:   toId,
        amount:    amt.toFixed(2),
        reference: reference.trim(),
        note:      note.trim(),
      })
      onSaved()
    } catch (err) {
      setError(extractError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Fund Transfer" size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="rounded-lg border border-rose-100 bg-rose-50 p-3">
            <p className="text-[10px] uppercase tracking-wider text-rose-600">From</p>
            <p className="font-bold text-navy-800">{fromAccount.name}</p>
            <p className="text-xs text-gray-500">Balance: <span className="font-semibold tabular-nums">{fmtMoney(fromAccount.balance)}</span></p>
          </div>
          <div className="flex items-center justify-center text-gray-400">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </div>
          <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
            <p className="text-[10px] uppercase tracking-wider text-emerald-700">To</p>
            <Select value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Select account</option>
              {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            {dst && (
              <p className="mt-1 text-xs text-gray-500">Balance: <span className="font-semibold tabular-nums">{fmtMoney(dst.balance)}</span></p>
            )}
          </div>
        </div>

        <Input label="Amount *" type="number" min="0.01" step="0.01"
               value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />

        <Input label="Reference" placeholder="Slip no, txn id, cheque no…"
               value={reference} onChange={(e) => setReference(e.target.value)} />

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Note</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    placeholder={`Fund transfer ${fromAccount.name} → ${dst?.name || '…'}`} />
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">{error}</div>}

        <p className="text-xs text-gray-400">
          A balanced pair of ledger entries (Transfer Out / Transfer In) will be created automatically.
        </p>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Transfer</Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────

function IconPlus()     { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg> }
function IconEdit()     { return <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" /></svg> }
function IconBook()     { return <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h7a3 3 0 013 3v13a2 2 0 00-2-2H4V4z" /><path d="M20 4h-7a3 3 0 00-3 3v13a2 2 0 012-2h8V4z" /></svg> }
function IconTransfer() { return <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M7 7h10v10" /></svg> }
function IconDownload() { return <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg> }
function IconTrash()    { return <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg> }
