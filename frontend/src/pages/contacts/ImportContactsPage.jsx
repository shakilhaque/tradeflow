/**
 * Import Contacts — Contacts → Import Contacts
 *
 * Same 3-step wizard as Products / Suppliers:
 *   1. Upload CSV/XLSX → server analyses headers and suggests a mapping
 *   2. ColumnMapperPanel — operator confirms / overrides the mapping
 *   3. validateImport(file, mapping) → commitImport(batch.id)
 *
 * Instructions card sits at the TOP of the page (collapsible) so the
 * tenant sees the rules before they upload, then has the wizard front
 * and centre instead of squeezed into a column next to a sidebar.
 */
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import {
  analyzeImport, validateImport, commitImport, downloadTemplate,
} from '../../api/imports'
import ColumnMapperPanel from '../../components/imports/ColumnMapperPanel'

const CONTACT_FIELDS = [
  { key: 'contact_type',    label: 'Contact Type' },
  { key: 'prefix',          label: 'Prefix' },
  { key: 'first_name',      label: 'First Name *' },
  { key: 'middle_name',     label: 'Middle Name' },
  { key: 'last_name',       label: 'Last Name' },
  { key: 'business_name',   label: 'Business Name' },
  { key: 'email',           label: 'Email' },
  { key: 'phone',           label: 'Mobile / Phone' },
  { key: 'alternate_phone', label: 'Alternate Contact' },
  { key: 'landline',        label: 'Landline' },
  { key: 'address',         label: 'Address Line 1' },
  { key: 'address_line_2',  label: 'Address Line 2' },
  { key: 'city',            label: 'City' },
  { key: 'state',           label: 'State' },
  { key: 'country',         label: 'Country' },
  { key: 'zip_code',        label: 'ZIP Code' },
  { key: 'tax_number',      label: 'Tax / VAT / TIN' },
  { key: 'pay_term_value',  label: 'Pay Term (days)' },
  { key: 'opening_balance', label: 'Opening Balance' },
  { key: 'credit_limit',    label: 'Credit Limit' },
  { key: 'notes',           label: 'Notes' },
]

export default function ImportContactsPage() {
  const navigate     = useNavigate()
  const fileInput    = useRef(null)
  const [fileName,    setFileName]    = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)
  const [analysis,    setAnalysis]    = useState(null)
  const [mapping,     setMapping]     = useState(null)
  const [batch,       setBatch]       = useState(null)
  const [importing,   setImporting]   = useState(false)
  const [serverError, setServerError] = useState('')
  // Instructions card is OPEN by default — it's at the top of the page
  // and answers "what do I put in each column?" before the operator
  // uploads anything. Collapsible to keep the wizard visible afterwards.
  const [helpOpen,    setHelpOpen]    = useState(true)

  const onFile = async (file) => {
    if (!file) return
    setFileName(file.name); setUploadedFile(file)
    setServerError(''); setBatch(null); setAnalysis(null); setMapping(null)
    try {
      const result = await analyzeImport('contact', file)
      setAnalysis(result)
    } catch (err) {
      setServerError(err?.message || 'Could not analyse the file.')
    }
  }

  const reset = () => {
    setFileName(''); setUploadedFile(null); setAnalysis(null); setMapping(null)
    setBatch(null); setServerError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const onMappingConfirmed = async (confirmed) => {
    setMapping(confirmed); setServerError('')
    try {
      setBatch(await validateImport('contact', uploadedFile, confirmed))
    } catch (err) {
      setServerError(err?.message || 'Validation failed.')
    }
  }

  const handleCommit = async () => {
    if (!batch) return
    setImporting(true); setServerError('')
    try {
      if (batch.status === 'HAS_ERRORS') {
        setServerError(`Server flagged ${batch.error_count} row(s). Fix the file and re-upload.`)
        return
      }
      const result = await commitImport(batch.id)
      alert(`Imported ${result.committed_rows ?? batch.valid_rows} contact(s).`)
      navigate('/contacts/customers')
    } catch (err) {
      setServerError(err?.message || 'Import failed.')
    } finally {
      setImporting(false)
    }
  }

  const handleDownloadTemplate = async () => {
    let blob
    try { blob = await downloadTemplate('contact') } catch {
      blob = new Blob([CONTACT_FIELDS.map((f) => f.label.replace(' *', '')).join(',') + '\n'], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'contacts-import-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Import Contacts from CSV / Excel</h1>
            <p className="mt-0.5 text-sm text-emerald-100">
              Upload a CSV or XLSX. The system auto-detects column headers and creates each contact on commit.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDownloadTemplate}>↓ Download template</Button>
          </div>
        </div>
      </div>

      {/* ── Instructions card at top, collapsible ───────────────────────── */}
      <Card padding="p-0">
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-3 text-left"
        >
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-base">ℹ</span>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Instructions &amp; supported columns</h2>
              <p className="text-xs text-gray-500">Click to {helpOpen ? 'hide' : 'show'} the column reference.</p>
            </div>
          </div>
          <span className="text-gray-400 text-sm">{helpOpen ? '▲' : '▼'}</span>
        </button>

        {helpOpen && (
          <div className="border-t border-gray-100 px-5 py-4 space-y-4">
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
              <li>Either <b>First Name + Last Name</b> OR <b>Business Name</b> is required per row — same rule as the manual Add Contact form.</li>
              <li>
                <b>Contact Type</b> accepts <code>Customer</code> / <code>Supplier</code> / <code>Both</code> (or
                <code> 1</code> / <code>2</code> / <code>3</code>). Default is <code>Customer</code>. When <i>Both</i> or <i>Supplier</i>, a matching Supplier row is also created.
              </li>
              <li>Existing contacts matching <b>name</b> OR <b>phone</b> are skipped — re-uploading is safe.</li>
              <li>Headers don't need to match the names below exactly — the column mapper handles synonyms (e.g. "Mobile Number", "Cell", "Contact Number" all map to <i>Mobile</i>).</li>
              <li>Unknown columns are saved per-row so nothing in the source file is lost.</li>
            </ul>

            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-4 py-2 w-10">#</th>
                    <th className="px-4 py-2">Field</th>
                    <th className="px-4 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {CONTACT_FIELDS.map((f, i) => (
                    <tr key={f.key}>
                      <td className="px-4 py-1.5 text-gray-400">{i + 1}</td>
                      <td className="px-4 py-1.5 font-mono text-gray-800">{f.label}</td>
                      <td className="px-4 py-1.5 text-gray-500">{NOTES[f.key] || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* ── Server error banner ─────────────────────────────────────────── */}
      {serverError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{serverError}</div>
      )}

      {/* ── Wizard ──────────────────────────────────────────────────────── */}
      {!analysis ? (
        <Card>
          <div
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }}
            onDragOver={(e) => e.preventDefault()}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center"
          >
            <div className="text-3xl">📥</div>
            <div className="font-medium text-gray-900">Drop your contacts file here</div>
            <div className="text-xs text-gray-500">CSV or XLSX — first/last name OR business name required, everything else optional</div>
            <Button onClick={() => fileInput.current?.click()}>Choose file</Button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,.xlsx"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="hidden"
            />
            {fileName && <div className="text-xs text-gray-600 mt-2">Selected: <span className="font-mono">{fileName}</span></div>}
          </div>
        </Card>
      ) : !mapping ? (
        <ColumnMapperPanel
          analysis={analysis}
          fields={CONTACT_FIELDS}
          requiredField="first_name"
          onConfirm={onMappingConfirmed}
          onCancel={reset}
        />
      ) : (
        <Card>
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Validation result</h2>
            {!batch ? (
              <div className="text-sm text-gray-500">Validating…</div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="text-xs text-gray-500">Total rows</div>
                    <div className="font-semibold">{batch.total_rows}</div>
                  </div>
                  <div className="rounded-lg bg-emerald-50 px-3 py-2">
                    <div className="text-xs text-emerald-700">Valid</div>
                    <div className="font-semibold text-emerald-700">{batch.valid_rows}</div>
                  </div>
                  <div className="rounded-lg bg-red-50 px-3 py-2">
                    <div className="text-xs text-red-700">With errors</div>
                    <div className="font-semibold text-red-700">{batch.error_count}</div>
                  </div>
                </div>

                {batch.error_count > 0 && (
                  <details className="rounded-lg border border-gray-100 bg-gray-50/40 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-gray-600">
                      View {batch.error_count} error{batch.error_count === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-2 max-h-48 overflow-auto text-xs text-red-700 space-y-1">
                      {batch.errors.map((e, i) => (
                        <li key={i}>Row {e.row}: <span className="font-mono">{e.field}</span> — {e.message}</li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                  <button onClick={reset} className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-300">
                    Cancel
                  </button>
                  <button
                    onClick={handleCommit}
                    disabled={importing || batch.status === 'HAS_ERRORS' || batch.valid_rows === 0}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {importing ? 'Importing…' : `Import ${batch.valid_rows} contact${batch.valid_rows === 1 ? '' : 's'}`}
                  </button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

// Per-field hints shown in the instructions table.
const NOTES = {
  contact_type:    '"Customer" / "Supplier" / "Both" (or 1 / 2 / 3). Default Customer.',
  prefix:          'Mr / Mrs / Miss / Ms / Dr (optional).',
  first_name:      'Required for individuals — unless Business Name is set.',
  middle_name:     'Optional.',
  last_name:       'Required for individuals.',
  business_name:   'Required for companies. Either this OR first+last is needed.',
  email:           'Standard email format.',
  phone:           'Primary mobile. Used for duplicate detection.',
  alternate_phone: 'Secondary phone (optional).',
  landline:        'Office / home phone (optional).',
  address:         'Street address line 1.',
  address_line_2:  'Apt / suite / floor (optional).',
  city:            'City name.',
  state:           'State / province / division.',
  country:         'Country name.',
  zip_code:        'Postal / ZIP code.',
  tax_number:      'VAT / GST / TIN.',
  pay_term_value:  'Integer days (e.g. 30 for Net-30).',
  opening_balance: 'Decimal, defaults to 0.',
  credit_limit:    'Max outstanding allowed for credit sales. 0 = cash-only.',
  notes:           'Free-form internal notes.',
}
