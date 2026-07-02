import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Card from '../../components/ui/Card'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import SummaryCard from '../../components/ui/SummaryCard'
import { downloadTemplate, validateImport, commitImport } from '../../api/imports'

const TEMPLATE_COLUMNS = ['product_sku', 'location', 'quantity', 'unit_cost', 'reference', 'notes']

const DEMO_ROWS = [
  ['246977', 'Main Branch',   '50', '4.58', 'PO-2026-001', 'Restock'],
  ['249357', 'Main Branch',   '30', '6.88', 'PO-2026-001', 'Restock'],
  ['246245', 'Mirpur Outlet', '10', '140',  'PO-2026-002', ''],
  ['NOPE',   'Main Branch',   '5',  '10',   '',            'Bad SKU — should fail'],
]

export default function ImportStockPage() {
  const navigate  = useNavigate()
  const fileInput = useRef(null)
  const [fileName, setFileName] = useState('')
  const [rows,     setRows]     = useState([])
  const [importing, setImporting] = useState(false)
  const [batch,    setBatch]    = useState(null)
  const [serverError, setServerError] = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)

  const validateRow = (data) => {
    const [sku, location, qty, cost] = data
    const errs = []
    if (!sku)                       errs.push('product_sku required')
    if (!location)                  errs.push('location required')
    if (!qty || Number(qty) <= 0)   errs.push('quantity > 0')
    if (cost === '' || Number(cost) < 0) errs.push('unit_cost ≥ 0')
    return errs
  }

  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    const start = lines[0].toLowerCase().includes('product_sku') ? 1 : 0
    return lines.slice(start).map((l) => l.split(',').map((c) => c.trim()))
  }
  const ingestRows = (matrix) =>
    setRows(matrix.map((data) => ({ data, errors: validateRow(data) })))

  const onFile = async (file) => {
    if (!file) return
    setFileName(file.name); setUploadedFile(file); setServerError(''); setBatch(null)
    const reader = new FileReader()
    reader.onload = (e) => ingestRows(parseCsv(String(e.target.result || '')))
    reader.readAsText(file)
    // Stock import shares the PRODUCT batch type for now (extend backend later).
    try { setBatch(await validateImport('product', file)) }
    catch (err) { console.warn('Server validation skipped:', err?.message) }
  }

  const handleDrop = (e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }
  const loadDemo  = () => { setFileName('demo-stock.csv'); ingestRows(DEMO_ROWS) }
  const reset     = () => {
    setFileName(''); setRows([]); setBatch(null); setUploadedFile(null); setServerError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const handleDownloadTemplate = async () => {
    const header = TEMPLATE_COLUMNS.join(',')
    const sample = DEMO_ROWS.slice(0, 2).map((r) => r.join(',')).join('\n')
    const blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'stock-import-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async () => {
    setImporting(true); setServerError('')
    try {
      if (!batch) {
        alert(`No file uploaded — demo only.\nWould add stock for ${stats.valid} row(s) and skip ${stats.invalid} invalid.`)
        navigate('/products'); return
      }
      if (batch.status === 'HAS_ERRORS') {
        setServerError(`Server flagged ${batch.error_count} row(s). Fix the file and re-upload.`)
        setImporting(false); return
      }
      const result = await commitImport(batch.id)
      alert(`Stock imported for ${result.committed_rows ?? batch.valid_rows} row(s).`)
      navigate('/products')
    } catch (err) {
      setServerError(err?.message || 'Import failed.'); setImporting(false)
    }
  }

  const stats = useMemo(() => ({
    total:   rows.length,
    valid:   rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) =>  r.errors.length).length,
    units:   rows.filter((r) => !r.errors.length).reduce((s, r) => s + Number(r.data[2] || 0), 0),
  }), [rows])

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Import Stock from Excel</h1>
            <p className="mt-0.5 text-sm text-emerald-50">Upload a CSV to top up stock for existing products. Each row creates a new FIFO layer.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDownloadTemplate}>↓ Download Template</Button>
            <Button variant="secondary" onClick={loadDemo}>Try with demo data</Button>
          </div>
        </div>
      </div>

      <Card>
        <div className="mb-3 text-sm font-semibold text-gray-900">Required columns (in order)</div>
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_COLUMNS.map((c) => (
            <code key={c} className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700">{c}</code>
          ))}
        </div>
        <div className="mt-3 text-xs text-gray-500">
          <code>product_sku</code> must already exist. <code>unit_cost</code> is the per-unit FIFO cost. <code>reference</code> is your PO/GRN number for traceability.
        </div>
      </Card>

      {!rows.length ? (
        <Card>
          <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
               className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
            <UploadIcon />
            <div className="font-medium text-gray-900">Drop your CSV file here</div>
            <div className="text-xs text-gray-500">or click to browse from your computer</div>
            <Button onClick={() => fileInput.current?.click()}>Choose file</Button>
            <input ref={fileInput} type="file" accept=".csv,.txt"
                   onChange={(e) => onFile(e.target.files?.[0])} className="hidden" />
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <SummaryCard label="Total Rows" value={stats.total} />
            <SummaryCard label="Valid"      value={stats.valid}   color="green" />
            <SummaryCard label="Invalid"    value={stats.invalid} color="red" />
            <SummaryCard label="Units in"   value={stats.units}   color="indigo" />
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
                    {TEMPLATE_COLUMNS.map((c) => <th key={c} className="px-3 py-2 whitespace-nowrap">{c}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r, i) => (
                    <tr key={i} className={r.errors.length ? 'bg-red-50/40' : 'hover:bg-gray-50/60'}>
                      <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2">
                        {r.errors.length
                          ? <Badge variant="red"   dot>Invalid</Badge>
                          : <Badge variant="green" dot>Valid</Badge>}
                        {r.errors.length > 0 && <div className="mt-1 text-[10px] text-red-600">{r.errors.join('; ')}</div>}
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
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{serverError}</div>
          )}

          <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-sm text-gray-600">
              {stats.invalid > 0
                ? <><span className="font-semibold text-red-600">{stats.invalid}</span> row(s) will be skipped. <span className="font-semibold text-green-700">{stats.valid}</span> will import.</>
                : <>All <span className="font-semibold text-green-700">{stats.valid}</span> row(s) ready to import.</>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={reset}>Cancel</Button>
              <Button loading={importing} disabled={!stats.valid} onClick={handleImport}>
                Add stock for {stats.valid} row{stats.valid !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        </>
      )}

      {!rows.length && (
        <EmptyState title="No file selected" message='Choose a CSV or click "Try with demo data" to preview a stock import.' />
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
