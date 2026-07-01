import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import DateRangeField from '../../components/ui/DateRangeField'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getPaymentAccountReport,
  linkPaymentToAccount,
  getPaymentAccounts,
} from '../../api/accounting'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, {
  month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const TYPE_BADGE = {
  Sell:     'bg-emerald-50 text-emerald-700 border-emerald-100',
  Expense:  'bg-rose-50    text-rose-700    border-rose-100',
  Purchase: 'bg-violet-50  text-violet-700  border-violet-100',
}

const ACCOUNT_TYPE_LABEL = {
  CASH:  'Cash',
  BANK:  'Bank',
  MFS:   'MFS',
  CARD:  'Card',
  OTHER: 'Other',
}

export default function PaymentAccountReportPage() {
  const navigate = useNavigate()

  const [accounts, setAccounts] = useState([])
  const [filters,  setFilters]  = useState({
    account_id: '',
    date_from:  `${currentYear}-01-01`,
    date_to:    `${currentYear}-12-31`,
  })
  const [search, setSearch] = useState('')
  const [page,   setPage]   = useState(1)
  const [limit,  setLimit]  = useState(25)

  const [data,    setData]    = useState({ results: [], count: 0, total_pages: 1 })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [linkOpen, setLinkOpen] = useState(null) // row being linked

  useEffect(() => {
    getPaymentAccounts({ active: 'true' })
      .then((r) => setAccounts(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = { page, limit, search: search || undefined }
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v })
      const res = await getPaymentAccountReport(params)
      setData(res || { results: [], count: 0, total_pages: 1 })
    } catch (err) {
      setError(err?.message || 'Failed to load report.')
      setData({ results: [], count: 0, total_pages: 1 })
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters])

  useEffect(() => { load() }, [load])

  // Real-time refresh — poll every 30 seconds so new sale
  // payments, expenses, supplier payments etc. that other operators
  // post show up without anyone hitting reload. Stops when the tab
  // is hidden (saves cycles for idle sessions), re-fires on focus.
  useEffect(() => {
    let id = null
    const start = () => {
      if (id) return
      id = setInterval(() => { if (!document.hidden) load() }, 30000)
    }
    const stop = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.hidden) stop(); else { load(); start() } }
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  const onFilter = (k) => (e) => { setPage(1); setFilters((p) => ({ ...p, [k]: e.target.value })) }
  const reset = () => {
    setFilters({
      account_id: '',
      date_from:  `${currentYear}-01-01`,
      date_to:    `${currentYear}-12-31`,
    }); setSearch(''); setPage(1)
  }

  const onLinked = async () => {
    setLinkOpen(null)
    await load()
  }

  const linkedCount = useMemo(
    () => (data.results || []).filter((r) => r.linked).length,
    [data.results],
  )

  const exportCsv = () => {
    const rows = data.results || []
    if (!rows.length) return
    const head = ['Date', 'Payment Ref No.', 'Invoice No. / Ref. No.', 'Payment Type', 'Amount', 'Account']
    const lines = [head.join(',')].concat(rows.map((r) => [
      fmtDateTime(r.date),
      r.payment_ref || '',
      r.invoice_ref || '',
      r.payment_type || '',
      Number(r.amount || 0).toFixed(2),
      (r.account_name || 'Not linked').replace(/,/g, ' '),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `payment-account-report-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Payment Account Report</h1>
          <p className="mt-0.5 text-sm text-emerald-50">
            Map every recorded payment to one of your cash, bank, or MFS accounts.
          </p>
        </div>
        {/* Manual refresh on top of the auto-poll (30 s) — for when
            the operator just wrote a new payment in another tab and
            wants to verify it without waiting. */}
        <Button variant="secondary" size="sm" onClick={() => load()} loading={loading}>
          ⟳ Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-brand-700">Filters</h2>
          <button onClick={reset} className="text-xs font-medium text-brand-600 hover:text-brand-700">Reset</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Account" value={filters.account_id} onChange={onFilter('account_id')}>
            <option value="">All</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <DateRangeField
            from={filters.date_from}
            to={filters.date_to}
            onChange={(r) => { setPage(1); setFilters((p) => ({ ...p, date_from: r.from, date_to: r.to })) }}
          />
        </div>
      </Card>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white"
            value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>entries</span>
          <span className="ml-3 text-xs text-gray-400">
            {linkedCount} of {data.results.length} on this page linked
          </span>
        </div>
        <div className="flex items-center gap-3">
          <SearchInput
            placeholder="Search ref / invoice / account…"
            value={search}
            onChange={(v) => { setSearch(v); setPage(1) }}
          />
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!data.results?.length}>Export CSV</Button>
        </div>
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : (data.results || []).length === 0 ? (
          <div className="py-12">
            <EmptyState title="No payments to display" message="No payments match the current filters." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Payment Ref No.</th>
                  <th className="px-4 py-3">Invoice No. / Ref. No.</th>
                  <th className="px-4 py-3">Payment Type</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.results.map((r) => (
                  <tr key={r.source_ref} className="hover:bg-gray-50/40 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button
                        onClick={() => setLinkOpen(r)}
                        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-3 py-1 text-xs font-semibold text-white shadow-soft transition"
                      >
                        <IconLink />
                        {r.linked ? 'Change' : 'Link Account'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap text-xs">{fmtDateTime(r.date)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.payment_ref}</td>
                    <td className="px-4 py-3">
                      {r.kind === 'SALE_PAYMENT' && r.invoice_id ? (
                        <button
                          onClick={() => navigate(`/sales/${r.invoice_id}`)}
                          className="font-mono text-xs text-brand-600 hover:underline"
                        >
                          {r.invoice_ref}
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-gray-700">{r.invoice_ref || '—'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[r.payment_type] ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                        {r.payment_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-navy-800">
                      {fmtMoney(r.amount)}
                    </td>
                    <td className="px-4 py-3">
                      {r.linked ? (
                        <div>
                          <p className="text-sm font-medium text-navy-800">{r.account_name}</p>
                          {r.account_type && <p className="text-[10px] text-gray-500">{r.account_type}</p>}
                        </div>
                      ) : (
                        <span className="text-xs italic text-gray-400">Not linked</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!loading && data.count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–
            <strong>{Math.min(page * limit, data.count)}</strong> of <strong>{data.count}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3">{page} / {data.total_pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= data.total_pages} onClick={() => setPage((p) => Math.min(p + 1, data.total_pages))}>Next</Button>
          </div>
        </div>
      )}

      {linkOpen && (
        <LinkAccountModal
          payment={linkOpen}
          accounts={accounts}
          onClose={() => setLinkOpen(null)}
          onSaved={onLinked}
        />
      )}
    </div>
  )
}

function LinkAccountModal({ payment, accounts, onClose, onSaved }) {
  const [accountId, setAccountId] = useState(payment.account_id || (accounts[0]?.id || ''))
  const [note,      setNote]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const save = async () => {
    setError('')
    if (!accountId) { setError('Please pick an account.'); return }
    setSaving(true)
    try {
      await linkPaymentToAccount({
        source_ref:         payment.source_ref,
        source_type:        payment.kind,
        payment_account_id: accountId,
        note:               note.trim(),
      })
      onSaved()
    } catch (err) {
      setError(err?.message || 'Failed to link account.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Link Account — Payment Ref No.: ${payment.payment_ref}`} size="md">
      <div className="space-y-4">
        <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Payment Type</span>
            <span className="font-semibold text-navy-800">{payment.payment_type}</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-gray-500">Amount</span>
            <span className="font-semibold text-navy-800 tabular-nums">{fmtMoney(payment.amount)}</span>
          </div>
          {payment.invoice_ref && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-gray-500">Invoice / Ref.</span>
              <span className="font-mono text-xs text-gray-800">{payment.invoice_ref}</span>
            </div>
          )}
        </div>

        <Select label="Account *" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Select an account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}{a.account_type ? ` — ${ACCOUNT_TYPE_LABEL[a.account_type] || a.account_type}` : ''}
            </option>
          ))}
        </Select>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Note</label>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </div>

        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}

function IconLink() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07L11.5 5.5" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07L12.5 18.5" />
    </svg>
  )
}
