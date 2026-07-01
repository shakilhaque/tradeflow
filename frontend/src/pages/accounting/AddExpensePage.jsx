import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import { getLocations } from '../../api/inventory'
import { getAccounts, createExpense, getExpenseCategories, getPaymentAccounts } from '../../api/accounting'
import { getCustomers } from '../../api/sales'
import { getSuppliers } from '../../api/purchases'
import useUnsavedChangesPrompt from '../../hooks/useUnsavedChangesPrompt'

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Categories are loaded from /api/accounting/expense-categories/
// — the user manages them in Settings → Expense Categories. The
// dropdown auto-refreshes when the cashier returns from that page.

const TAX_OPTIONS = [
  { value: 0,    label: 'None' },
  { value: 5,    label: 'VAT 5%' },
  { value: 7.5,  label: 'VAT 7.5%' },
  { value: 10,   label: 'VAT 10%' },
  { value: 15,   label: 'VAT 15%' },
]

const PAYMENT_METHODS = [
  'Cash', 'Bank Transfer', 'Card', 'Mobile Banking', 'Cheque', 'Other',
]

const RECURRING_UNITS = ['Days', 'Weeks', 'Months', 'Years']

const todayLocalDate = () => new Date().toISOString().slice(0, 10)
const nowLocalIso    = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AddExpensePage() {
  const navigate = useNavigate()

  // ── Top section ──
  const [locationId,   setLocationId]   = useState('')
  const [category,     setCategory]     = useState('')        // ExpenseCategory id (FK)
  const [subCategory,  setSubCategory]  = useState('')        // ExpenseCategory id (child FK)
  const [expCategories, setExpCategories] = useState([])
  const [referenceNo,  setReferenceNo]  = useState('')
  const [expenseDate,  setExpenseDate]  = useState(todayLocalDate())
  const [expenseFor,   setExpenseFor]   = useState('none')   // none | customer | supplier
  const [contactId,    setContactId]    = useState('')
  const [contactName,  setContactName]  = useState('')        // resolved name for save
  const [taxPct,       setTaxPct]       = useState(0)
  const [totalAmount,  setTotalAmount]  = useState('')
  const [note,         setNote]         = useState('')
  const [isRefund,     setIsRefund]     = useState(false)

  // ── Recurring ──
  const [isRecurring,    setIsRecurring]    = useState(false)
  const [recurInterval,  setRecurInterval]  = useState('')
  const [recurUnit,      setRecurUnit]      = useState('Days')
  const [recurCount,     setRecurCount]     = useState('')

  // ── Add Payment ──
  const [payAmount,   setPayAmount]   = useState('0.00')
  const [paidOn,      setPaidOn]      = useState(nowLocalIso())
  const [payMethod,   setPayMethod]   = useState('Cash')
  const [payAccount,  setPayAccount]  = useState('')   // PaymentAccount.id (user-facing)
  const [payNote,     setPayNote]     = useState('')

  // Method-specific extras — all optional per spec.
  const [cardNumber,        setCardNumber]        = useState('')
  const [cardHolderName,    setCardHolderName]    = useState('')
  const [cardTransactionNo, setCardTransactionNo] = useState('')
  const [cardType,          setCardType]          = useState('CREDIT_CARD')
  const [cardMonth,         setCardMonth]         = useState('')
  const [cardYear,          setCardYear]          = useState('')
  const [chequeNo,          setChequeNo]          = useState('')
  const [bankAccountNo,     setBankAccountNo]     = useState('')
  const [attachDocument,    setAttachDocument]    = useState(null)
  // List of real PaymentAccounts (Cash on Hand, City Bank, bKash, …)
  const [paymentAccounts,   setPaymentAccounts]   = useState([])

  // expense account is required by the backend (DR side of the JE).
  // We pre-pick the first EXPENSE-type account from the chart.
  const [expenseAccountId, setExpenseAccountId] = useState('')

  // ── Master data ──
  const [locations,    setLocations]    = useState([])
  const [contacts,     setContacts]     = useState([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [accounts,     setAccounts]     = useState([])

  // ── Submit ──
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  // Warn before leaving when any meaningful field has been filled in.
  useUnsavedChangesPrompt(
    !saving && (
      Boolean(category) || Boolean(subCategory) ||
      Boolean(referenceNo) || Boolean(contactId) || Boolean(contactName) ||
      Boolean(String(totalAmount)) || Boolean(note)
    ),
  )

  // Initial data — locations + accounts + user-managed Expense Categories
  // + user-facing PaymentAccounts.
  useEffect(() => {
    (async () => {
      try {
        const [locs, accts, cats, pacts] = await Promise.all([
          getLocations({ active_only: 'true' }).catch(() => []),
          getAccounts({ active: 'true' }).catch(() => []),
          getExpenseCategories({ active: 'true' }).catch(() => []),
          // Show EVERY payment account the tenant has on the List Accounts
          // page (no active filter) so the picker never silently hides one.
          getPaymentAccounts({}).catch(() => []),
        ])
        const locArr  = Array.isArray(locs)  ? locs  : (locs?.results  ?? [])
        const acctArr = Array.isArray(accts) ? accts : (accts?.results ?? [])
        const catArr  = Array.isArray(cats)  ? cats  : (cats?.results  ?? [])
        const paArr   = Array.isArray(pacts) ? pacts : (pacts?.results ?? [])
        setLocations(locArr)
        setAccounts(acctArr)
        setExpCategories(catArr)
        setPaymentAccounts(paArr)
        // Pre-pick defaults
        const firstExp = acctArr.find((a) => a.account_type === 'EXPENSE')
        if (firstExp)  setExpenseAccountId(firstExp.id)
        // Default Payment Account → first active PaymentAccount.
        if (paArr.length > 0) setPayAccount(paArr[0].id)
        if (locArr.length === 1) setLocationId(locArr[0].id)
      } catch { /* ignore */ }
    })()
  }, [])

  // Sub-categories filter by selected parent.
  const subCategoryOptions = useMemo(
    () => expCategories.filter((c) => c.parent_id === category || c.parent === category),
    [expCategories, category],
  )

  // Contacts (when expenseFor changes)
  useEffect(() => {
    setContactId(''); setContactName(''); setContacts([])
    if (expenseFor === 'none') return
    setContactsLoading(true)
    ;(async () => {
      try {
        const fn = expenseFor === 'customer' ? getCustomers : getSuppliers
        const res = await fn({ active_only: 'true' })
        setContacts(Array.isArray(res) ? res : (res?.results ?? []))
      } catch {
        setContacts([])
      } finally {
        setContactsLoading(false)
      }
    })()
  }, [expenseFor])

  const onContactChange = (e) => {
    const id = e.target.value
    setContactId(id)
    const found = contacts.find((c) => c.id === id)
    setContactName(found ? found.name : '')
  }

  // Derived totals
  const subtotal     = Number(totalAmount) || 0
  const taxAmount    = subtotal * (Number(taxPct) || 0) / 100
  const grand        = subtotal + taxAmount
  const paidNum      = Number(payAmount) || 0
  const paymentDue   = Math.max(grand - paidNum, 0)

  const handleSave = async () => {
    setError('')
    if (!locationId)          { setError('Business location is required.'); return }
    if (!subtotal || subtotal <= 0) { setError('Total amount must be greater than zero.'); return }
    if (!payAccount)          { setError('Payment Account is required.'); return }

    const payload = {
      // The legacy `category` choices column stays for back-compat;
      // the user-managed taxonomy now lives in expense_category_id.
      category:                'OTHER',
      expense_category_id:     category || null,
      expense_sub_category_id: subCategory || null,
      amount:                  grand.toFixed(2),
      payment_account_id:      payAccount,
      description:             note.trim(),
      expense_date:            expenseDate,
      // rich-form extras
      reference_no:   referenceNo.trim(),
      location_id:    locationId,
      tax_amount:     taxAmount.toFixed(2),
      paid_amount:    paidNum.toFixed(2),
      expense_for:    expenseFor === 'none' ? '' : (contactName || ''),
      contact_name:   contactName,
      contact_id:     contactId || null,
      recurring:      isRecurring,
      recurring_details: isRecurring && recurInterval
        ? `Every ${recurInterval} ${recurUnit}${recurCount ? ` × ${recurCount}` : ''}`
        : '',
      // Method-specific extras — all optional.
      payment_method:      payMethod,
      ...(payMethod === 'Card' && {
        card_number:         cardNumber,
        card_holder_name:    cardHolderName,
        card_transaction_no: cardTransactionNo,
        card_type:           cardType,
        card_month:          cardMonth,
        card_year:           cardYear,
      }),
      ...(payMethod === 'Cheque'        && { cheque_no:       chequeNo }),
      ...(payMethod === 'Bank Transfer' && { bank_account_no: bankAccountNo }),
    }

    setSaving(true)
    try {
      await createExpense(payload)
      navigate('/accounting/expenses', { replace: true })
    } catch (err) {
      setError(err?.message || 'Failed to save expense.')
    } finally {
      setSaving(false)
    }
  }

  const expenseAccts = useMemo(
    () => accounts.filter((a) => a.account_type === 'EXPENSE'),
    [accounts],
  )
  const paymentAccts = useMemo(
    () => accounts.filter((a) => a.account_type === 'ASSET' || a.account_type === 'LIABILITY'),
    [accounts],
  )

  return (
    <div className="space-y-5 pb-28">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Record Expense</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Record an operational expense. A balanced journal entry is created automatically.
        </p>
      </div>

      {/* ── Expense Information ──────────────────────────────────────────── */}
      <Card>
        <SectionHeader title="Expense Information" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Select label="Business Location *" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Please select</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Expense Category" value={category} onChange={(e) => { setCategory(e.target.value); setSubCategory('') }}>
            <option value="">Please select</option>
            {expCategories
              .filter((c) => !c.parent && !c.parent_id)
              .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Sub category" value={subCategory} onChange={(e) => setSubCategory(e.target.value)} disabled={!category}>
            <option value="">Please select</option>
            {subCategoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>

          <div>
            <Input
              label="Reference No"
              placeholder="Auto-generated if left blank"
              value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">Leave empty to autogenerate (EP{new Date().getFullYear()}/####)</p>
          </div>
          <Input
            label="Date *"
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
          />
          {/* Expense For — per spec this dropdown lists Business
              Locations (branches), not Customer/Supplier types. We
              still write the chosen branch name into the existing
              `expense_for` column so the All Expenses filter keeps
              working without a schema change. */}
          <Select label="Expense For" value={contactId} onChange={(e) => {
            const id = e.target.value
            setContactId(id)
            const branch = locations.find((l) => l.id === id)
            setContactName(branch ? branch.name : '')
            // Mirror into the existing expenseFor flag so legacy
            // server-side filters that switch on "none" still work.
            setExpenseFor(id ? 'branch' : 'none')
          }}>
            <option value="">None</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>

          <Select label="Applicable Tax" value={taxPct} onChange={(e) => setTaxPct(Number(e.target.value))}>
            {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Input
            label="Total amount *"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
          />
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Expense Note</label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100"
            />
          </div>
          <div className="space-y-3 pt-6">
            <Toggle label="Is refund?" checked={isRefund} onChange={setIsRefund} />
          </div>
        </div>
      </Card>

      {/* ── Recurring ─────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader title="Recurring" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          <Toggle label="Is Recurring?" checked={isRecurring} onChange={setIsRecurring} />
          <div className="md:col-span-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Recurring Interval *</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                placeholder="e.g. 1"
                disabled={!isRecurring}
                value={recurInterval}
                onChange={(e) => setRecurInterval(e.target.value)}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100 disabled:bg-gray-50 disabled:text-gray-400"
              />
              <select
                disabled={!isRecurring}
                value={recurUnit}
                onChange={(e) => setRecurUnit(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-100 disabled:bg-gray-50"
              >
                {RECURRING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Input
              label="No. of Repetitions"
              type="number"
              min="0"
              placeholder="Leave blank for infinite"
              disabled={!isRecurring}
              value={recurCount}
              onChange={(e) => setRecurCount(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">Blank = repeat indefinitely.</p>
          </div>
        </div>
      </Card>

      {/* ── Add Payment ───────────────────────────────────────────────────── */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-white">
          <h3 className="text-base font-semibold">Add Payment</h3>
        </div>
        <div className="p-5 space-y-4">
          {/* Row 1 — Amount · Paid On · Method */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="Amount *" type="number" step="0.01" min="0"
              value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            <Input
              label="Paid on: *" type="datetime-local"
              value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            <Select label="Payment Method: *" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </div>

          {/* Row 2 — Payment Account · Attach Document */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select label="Payment Account:" value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
              <option value="">Please select</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.account_type ? ` (${a.account_type})` : ''}
                </option>
              ))}
            </Select>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Attach Document:</label>
              <input type="file"
                accept=".pdf,.csv,.zip,.doc,.docx,.jpeg,.jpg,.png"
                onChange={(e) => setAttachDocument(e.target.files?.[0] || null)}
                className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200" />
              <p className="mt-1 text-[10px] text-gray-400">Allowed File: .pdf, .csv, .zip, .doc, .docx, .jpeg, .jpg, .png</p>
            </div>
          </div>

          {/* Method-specific rows — rendered in their own grid so the
              file picker above doesn't shift around when the method
              changes. Matches the reference image. */}
          {payMethod === 'Card' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input label="Card Number" placeholder="Card Number"
                value={cardNumber} onChange={(e) => setCardNumber(e.target.value.replace(/[^\d ]/g, ''))} />
              <Input label="Card holder name" placeholder="Card holder name"
                value={cardHolderName} onChange={(e) => setCardHolderName(e.target.value.replace(/[^A-Za-z\s.'-]/g, ''))} />
              <Input label="Card Transaction No." placeholder="Card Transaction No."
                value={cardTransactionNo} onChange={(e) => setCardTransactionNo(e.target.value)} />
              <Select label="Card Type" value={cardType} onChange={(e) => setCardType(e.target.value)}>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="DEBIT_CARD">Debit Card</option>
                <option value="PREPAID">Prepaid</option>
              </Select>
              <Input label="Month" placeholder="Month" maxLength={2}
                value={cardMonth} onChange={(e) => setCardMonth(e.target.value.replace(/\D/g, '').slice(0, 2))} />
              <Input label="Year" placeholder="Year" maxLength={4}
                value={cardYear} onChange={(e) => setCardYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            </div>
          )}
          {payMethod === 'Cheque' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="Cheque No." placeholder="Cheque No."
                value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
            </div>
          )}
          {payMethod === 'Bank Transfer' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="Bank Account No" placeholder="Bank Account No"
                value={bankAccountNo} onChange={(e) => setBankAccountNo(e.target.value.replace(/[^\d -]/g, ''))} inputMode="numeric" />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Payment note:</label>
            <textarea rows={3} value={payNote} onChange={(e) => setPayNote(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100" />
          </div>

          <div className="flex justify-end text-sm">
            <span className="font-semibold text-gray-700">
              Payment Due: <span className={paymentDue > 0 ? 'text-rose-600' : 'text-emerald-600'}>{fmtMoney(paymentDue)}</span>
            </span>
          </div>
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── Sticky bottom action bar ─────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-[var(--sidebar-w,256px)] z-30 border-t border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex max-w-[100rem] items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Subtotal</p>
              <p className="font-semibold text-gray-900">{fmtMoney(subtotal)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Tax</p>
              <p className="font-semibold text-gray-900">{fmtMoney(taxAmount)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Paid</p>
              <p className="font-semibold text-gray-900">{fmtMoney(paidNum)}</p>
            </div>
            <div className="border-l border-gray-200 pl-6">
              <p className="text-xs uppercase tracking-wider text-gray-500">Total Amount</p>
              <p className="text-xl font-bold bg-gradient-to-r from-amber-600 to-rose-600 bg-clip-text text-transparent">
                {fmtMoney(grand)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/accounting/expenses')}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={saving}>
              {saving ? 'Saving…' : 'Save Expense'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ title }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <span className="h-7 w-1 rounded bg-gradient-to-b from-emerald-500 to-teal-500" />
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{title}</h2>
    </div>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="inline-flex items-center gap-3 cursor-pointer select-none">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
          checked ? 'bg-amber-500' : 'bg-gray-200',
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          ].join(' ')}
        />
      </button>
    </label>
  )
}
