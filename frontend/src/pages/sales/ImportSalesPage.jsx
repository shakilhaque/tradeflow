import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button     from '../../components/ui/Button'
import Card       from '../../components/ui/Card'
import Badge      from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import SummaryCard from '../../components/ui/SummaryCard'
import { downloadTemplate, validateImport, commitImport } from '../../api/imports'

const TEMPLATE_COLUMNS = [
  'invoice_no',     // optional — auto-generated if empty
  'sale_date',      // YYYY-MM-DD
  'customer_name',
  'location',
  'product_sku',
  'quantity',
  'unit_price',
  'discount',
  'tax_rate',
  'payment_method', // CASH / CARD / BANK_TRANSFER
  'notes',
]

const DEMO_ROWS = [
  ['INV-2026-002001', '2026-04-28', 'Karim Traders', 'Main Branch',     'IP15-128',  '1', '145000', '0',    '5', 'CARD',          'Demo row 1'],
  ['INV-2026-002001', '2026-04-28', 'Karim Traders', 'Main Branch',     'APP-2',     '1', '28500',  '500',  '5', 'CARD',          ''           ],
  ['INV-2026-002002', '2026-04-29', 'Walk-in',       'Mirpur Outlet',   'WMS-001',   '3', '2200',   '0',    '5', 'CASH',          'Bulk order' ],
  ['',                '2026-04-30', 'Rahim Hossain', 'Main Branch',     'USBC-1M',   '5', '650',    '0',    '0', 'BANK_TRANSFER', ''           ],
  ['INV-2026-002003', '2026-04-30', 'Fatima Begum',  'Mirpur Outlet',   'SGS24-256', '1', '132000', '2000', '5', 'CARD',          'VIP customer'],
  ['INV-2026-002004', 'invalid',    'Test User',     'Unknown Branch',  'NOPE-999',  '1', '0',      '0',    '0', 'CASH',          'Bad data — should fail'],
]

export default function ImportSalesPage() {
  const navigate  = useNavigate()
  const fileInput = useRef(null)
  const [fileName, setFileName] = useState('')
  const [rows,     setRows]     = useState([])     // [{ data:[...], errors:[...] }]
  const [importing, setImporting] = useState(false)
  const [batch,    setBatch]    = useState(null)   // server validation result, if available
  const [serverError, setServerError] = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)

  // ── Validation ───────────────────────────────────────────────────────────────
  const validateRow = (data) => {
    const [invoice, date, customer, location, sku, qty, price, , tax, method] = data
    const errors = []
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))           errors.push('Invalid sale_date')
    if (!customer)                                             errors.push('customer_name required')
    if (!location)                                             errors.push('location required')
    if (!sku)                                                  errors.push('product_sku required')
    if (!qty || Number(qty) <= 0)                              errors.push('quantity must be > 0')
    if (price === '' || Number(price) <= 0)                    errors.push('unit_price must be > 0')
    if (tax !== '' && (Number(tax) < 0 || Number(tax) > 100))  errors.push('tax_rate 0–100')
    if (method && !['CASH', 'CARD', 'BANK_TRANSFER'].includes(method))
      errors.push('payment_method must be CASH | CARD | BANK_TRANSFER')
    return errors
  }

  // ── CSV parsing (simple, no quoted-comma support — fine for demo) ───────────
  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    // skip header if it starts with a known column name
    const start = lines[0].toLowerCase().includes('sale_date') ? 1 : 0
    return lines.slice(start).map((l) => l.split(',').map((c) => c.trim()))
  }

  const ingestRows = (matrix) => {
    setRows(matrix.map((data) => ({ data, errors: validateRow(data) })))
  }

  // ── Handlers ────────────────────────────────────────────────────────────────
  const onFile = async (file) => {
    if (!file) return
    setFileName(file.name)
    setUploadedFile(file)
    setServerError('')
    setBatch(null)

    // Local preview (always)
    const reader = new FileReader()
    reader.onload = (e) => ingestRows(parseCsv(String(e.target.result || '')))
    reader.readAsText(file)

    // Server-side validate (best-effort — fall back to local-only if API unavailable)
    try {
      const b = await validateImport('order', file)
      setBatch(b)
    } catch (err) {
      // API offline or 404 — local preview still works
      console.warn('Server validation skipped:', err?.message)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    onFile(e.dataTransfer.files?.[0])
  }

  const loadDemo = () => {
    setFileName('demo-data.csv')
    ingestRows(DEMO_ROWS)
  }

  const handleDownloadTemplate = async () => {
    let blob
    try {
      blob = await downloadTemplate('order')
    } catch {
      const header = TEMPLATE_COLUMNS.join(',')
      const sample = DEMO_ROWS.slice(0, 2).map((r) => r.join(',')).join('\n')
      blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href = url
    a.download = 'sales-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const reset = () => {
    setFileName(''); setRows([]); setBatch(null); setUploadedFile(null); setServerError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const handleImport = async () => {
    setImporting(true)
    setServerError('')
    try {
      let workingBatch = batch
      // If we never validated against the server (e.g. demo data) try once now.
      if (!workingBatch && uploadedFile) {
        workingBatch = await validateImport('order', uploadedFile)
        setBatch(workingBatch)
      }
      if (!workingBatch) {
        // No file was uploaded (likely "Try with demo data" pressed) — nothing to commit.
        alert(
          `No file uploaded — demo data only.\nWould import ${stats.valid} valid row(s) ` +
          `and skip ${stats.invalid} invalid row(s).`
        )
        navigate('/sells')
        return
      }
      if (workingBatch.status === 'HAS_ERRORS') {
        setServerError(`Server flagged ${workingBatch.error_count} row(s). Fix the file and re-upload.`)
        setImporting(false)
        return
      }
      const result = await commitImport(workingBatch.id)
      alert(`Imported ${result.committed_rows ?? workingBatch.valid_rows} sale(s).`)
      navigate('/sells')
    } catch (err) {
      setServerError(err?.message || 'Import failed.')
      setImporting(false)
    }
  }

  // ── Stats ────────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:   rows.length,
    valid:   rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) =>  r.errors.length).length,
    revenue: rows
      .filter((r) => !r.errors.length)
      .reduce((s, r) => s + Number(r.data[5] || 0) * Number(r.data[6] || 0), 0),
  }), [rows])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Import Sales from Excel</h1>
          <p className="mt-0.5 text-sm text-emerald-50">
            Upload a CSV file to bulk-create sales. Download the template to see the required columns.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleDownloadTemplate}>↓ Download Template</Button>
          <Button variant="secondary" onClick={loadDemo}>Try with demo data</Button>
        </div>
      </div>

      {/* Required columns guide */}
      <Card>
        <div className="mb-3 text-sm font-semibold text-gray-900">Required columns (in order)</div>
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_COLUMNS.map((c) => (
            <code key={c} className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700">
              {c}
            </code>
          ))}
        </div>
        <div className="mt-3 text-xs text-gray-500">
          Date format: <code>YYYY-MM-DD</code>. Payment method: <code>CASH</code>, <code>CARD</code>, or <code>BANK_TRANSFER</code>.
          Multiple rows with the same <code>invoice_no</code> are grouped into a single sale with multiple line items.
        </div>
      </Card>

      {/* Step 1 — Upload */}
      {!rows.length ? (
        <Card>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center"
          >
            <UploadIcon />
            <div className="font-medium text-gray-900">Drop your CSV file here</div>
            <div className="text-xs text-gray-500">or click to browse from your computer</div>
            <Button onClick={() => fileInput.current?.click()}>Choose file</Button>
            <input
              ref={fileInput} type="file" accept=".csv,.txt"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="hidden"
            />
          </div>
        </Card>
      ) : (
        <>
          {/* Step 2 — Preview */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <SummaryCard label="Total Rows" value={stats.total} />
            <SummaryCard label="Valid"      value={stats.valid}   color="green" />
            <SummaryCard label="Invalid"    value={stats.invalid} color="red" />
            <SummaryCard label="Revenue"    value={`৳ ${stats.revenue.toLocaleString()}`} color="indigo" />
          </div>

          <Card padding="p-0">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <div>
                <div className="font-semibold text-gray-900">Preview</div>
                <div className="font-mono text-xs text-gray-500">{fileName}</div>
              </div>
              <Button variant="secondary" size="sm" onClick={reset}>Clear</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2 w-10">#</th>
                    <th className="px-3 py-2 w-20">Status</th>
                    {TEMPLATE_COLUMNS.map((c) => (
                      <th key={c} className="px-3 py-2 whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r, i) => (
                    <tr key={i} className={r.errors.length ? 'bg-red-50/40' : 'hover:bg-gray-50/60'}>
                      <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2">
                        {r.errors.length ? (
                          <Badge variant="red"   dot>Invalid</Badge>
                        ) : (
                          <Badge variant="green" dot>Valid</Badge>
                        )}
                        {r.errors.length > 0 && (
                          <div className="mt-1 text-[10px] text-red-600">
                            {r.errors.join('; ')}
                          </div>
                        )}
                      </td>
                      {r.data.map((v, j) => (
                        <td key={j} className="px-3 py-2 font-mono text-gray-700">{v || '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {serverError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {serverError}
            </div>
          )}

          {/* Step 3 — Submit */}
          <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-sm text-gray-600">
              {stats.invalid > 0 ? (
                <>
                  <span className="font-semibold text-red-600">{stats.invalid} row{stats.invalid !== 1 ? 's' : ''}</span>{' '}
                  will be skipped due to validation errors.{' '}
                  <span className="font-semibold text-green-700">{stats.valid}</span> will import.
                </>
              ) : (
                <>All <span className="font-semibold text-green-700">{stats.valid}</span> row{stats.valid !== 1 ? 's are' : ' is'} valid and ready to import.</>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={reset}>Cancel</Button>
              <Button loading={importing} disabled={!stats.valid} onClick={handleImport}>
                Import {stats.valid > 0 ? stats.valid : ''} sale{stats.valid !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        </>
      )}

      {!rows.length && (
        <EmptyState
          title="No file selected"
          message='Choose a CSV or click "Try with demo data" to see how the preview looks.'
        />
      )}
    </div>
  )
}

function UploadIcon() {
  return (
    <svg className="h-12 w-12 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12M12 7.5v9" />
    </svg>
  )
}
