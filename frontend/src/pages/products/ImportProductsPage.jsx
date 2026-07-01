import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Card from '../../components/ui/Card'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import SummaryCard from '../../components/ui/SummaryCard'
import { downloadTemplate, validateImport, commitImport, analyzeImport } from '../../api/imports'
import ColumnMapperPanel from '../../components/imports/ColumnMapperPanel'

const TEMPLATE_COLUMNS = [
  'name', 'sku', 'barcode', 'unit', 'brand', 'category',
  'cost_price', 'selling_price', 'tax_rate', 'tax_type', 'opening_qty',
]

const DEMO_ROWS = [
  ['1 CM Dispenser Tape',     '246977', '', 'Pieces',  'Generic',     'Tape & Adhesives', '4.58',   '10',  '0', 'exclusive', '36'],
  ['1.5 CM Dispenser Tape',   '249357', '', 'Pieces',  'Generic',     'Tape & Adhesives', '6.88',   '15',  '0', 'exclusive', '7'],
  ['03L Fita Exam File',      '246245', '', 'Pieces',  'House Brand', 'Files & Folders',  '140',    '185', '0', 'exclusive', '4'],
  ['10 No Chipa Tali Khata',  '247215', '', 'Pieces',  'OEM',         'Stationery',       '30',     '50',  '0', 'exclusive', '6'],
  ['Bad Row — empty unit',    'BAD-1',  '', '',        'Generic',     'Stationery',       '10',     '15',  '0', 'exclusive', '0'],
]

export default function ImportProductsPage() {
  const navigate  = useNavigate()
  const fileInput = useRef(null)
  const [fileName, setFileName] = useState('')
  const [rows,     setRows]     = useState([])
  const [importing, setImporting] = useState(false)
  const [batch,    setBatch]    = useState(null)
  const [serverError, setServerError] = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)

  // NEW: column-mapping wizard state. Flow becomes:
  //   1. user drops file → onFile() calls analyzeImport()  → sets `analysis`
  //   2. ColumnMapperPanel renders, user confirms          → sets `mapping`
  //   3. validateImport(file, mapping)                     → sets `batch`
  //   4. user clicks Import                                → commitImport()
  const [analysis, setAnalysis] = useState(null)   // {headers, sample_rows, mapping, row_count}
  const [mapping,  setMapping]  = useState(null)   // final {our_field: source_header_or_null}

  const validateRow = (data) => {
    const [name, , , unit, , , cost, sell] = data
    const errs = []
    if (!name)                                   errs.push('name required')
    if (!unit)                                   errs.push('unit required')
    if (cost && Number(cost) < 0)                errs.push('cost_price ≥ 0')
    if (sell && Number(sell) < 0)                errs.push('selling_price ≥ 0')
    return errs
  }

  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    const start = lines[0].toLowerCase().includes('name') ? 1 : 0
    return lines.slice(start).map((l) => l.split(',').map((c) => c.trim()))
  }

  // Excel (.xlsx / .xls / .xlsm) is a binary workbook — reading it as text
  // gives ZIP/XML garbage. Parse the first sheet with SheetJS into the same
  // 2-D array shape parseCsv returns so the preview table renders correctly.
  const parseXlsx = (arrayBuffer) => {
    const wb = XLSX.read(arrayBuffer, { type: 'array' })
    if (!wb.SheetNames?.length) return []
    const ws = wb.Sheets[wb.SheetNames[0]]
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
      .filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim().length))
    if (!matrix.length) return []
    const start = (matrix[0] || []).join(',').toLowerCase().includes('name') ? 1 : 0
    return matrix.slice(start).map((cells) => cells.map((c) => (c == null ? '' : String(c).trim())))
  }

  const isExcel = (name) => /\.(xlsx|xls|xlsm)$/i.test(name || '')
  const ingestRows = (matrix) =>
    setRows(matrix.map((data) => ({ data, errors: validateRow(data) })))

  const onFile = async (file) => {
    if (!file) return
    setFileName(file.name); setUploadedFile(file); setServerError('')
    setBatch(null); setAnalysis(null); setMapping(null)

    // Local preview parse (best-effort for the preview table — server has
    // its own parser and is the source of truth). Excel needs a binary
    // (ArrayBuffer) read + SheetJS; CSV/TXT is plain text.
    const reader = new FileReader()
    if (isExcel(file.name)) {
      reader.onload = (e) => ingestRows(parseXlsx(e.target.result))
      reader.readAsArrayBuffer(file)
    } else {
      reader.onload = (e) => ingestRows(parseCsv(String(e.target.result || '')))
      reader.readAsText(file)
    }

    // Ask the server to analyse the headers and suggest a mapping.
    // The user reviews / overrides via ColumnMapperPanel before validation.
    try {
      const result = await analyzeImport('product', file)
      setAnalysis(result)
    } catch (err) {
      // Analyze failure isn't fatal — fall back to auto-detect on validate.
      console.warn('Column analysis skipped:', err?.message)
      setServerError(err?.message || 'Could not analyse the file.')
    }
  }

  const handleDrop = (e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }
  const loadDemo  = () => { setFileName('demo-products.csv'); ingestRows(DEMO_ROWS) }
  const reset     = () => {
    setFileName(''); setRows([]); setBatch(null); setUploadedFile(null); setServerError('')
    setAnalysis(null); setMapping(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  // Called when the user clicks "Use this mapping" in the wizard. Sends the
  // confirmed mapping to /validate/ which then runs row-by-row validation.
  const onMappingConfirmed = async (confirmedMapping) => {
    setMapping(confirmedMapping)
    setServerError('')
    try {
      setBatch(await validateImport('product', uploadedFile, confirmedMapping))
    } catch (err) {
      setServerError(err?.message || 'Validation failed.')
    }
  }

  const handleDownloadTemplate = async () => {
    let blob
    try { blob = await downloadTemplate('product') }
    catch {
      const header = TEMPLATE_COLUMNS.join(',')
      const sample = DEMO_ROWS.slice(0, 2).map((r) => r.join(',')).join('\n')
      blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'products-import-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async () => {
    setImporting(true); setServerError('')
    try {
      let workingBatch = batch
      if (!workingBatch && uploadedFile) {
        // If the user clicks Import without going through the mapper
        // wizard, validate with whatever mapping is in state (null →
        // server auto-detects).
        workingBatch = await validateImport('product', uploadedFile, mapping)
        setBatch(workingBatch)
      }
      if (!workingBatch) {
        alert(`No file uploaded — demo only.\nWould import ${stats.valid} valid row(s) and skip ${stats.invalid} invalid.`)
        navigate('/products'); return
      }
      if (workingBatch.status === 'HAS_ERRORS') {
        setServerError(`Server flagged ${workingBatch.error_count} row(s). Fix the file and re-upload.`)
        setImporting(false); return
      }
      const result = await commitImport(workingBatch.id)
      alert(`Imported ${result.committed_rows ?? workingBatch.valid_rows} product(s).`)
      navigate('/products')
    } catch (err) {
      setServerError(err?.message || 'Import failed.'); setImporting(false)
    }
  }

  const stats = useMemo(() => ({
    total:   rows.length,
    valid:   rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) =>  r.errors.length).length,
  }), [rows])

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Import Products from Excel</h1>
            <p className="mt-0.5 text-sm text-indigo-100">Upload a CSV to bulk-create products. Use the template for the correct column order.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDownloadTemplate}>↓ Download Template</Button>
            {/* "Try with demo data" button removed per spec — operators
                shouldn't be one click away from seeding placeholder rows
                into their production tenant DB. */}
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
          <code>tax_type</code> must be <code>inclusive</code> or <code>exclusive</code>. <code>opening_qty</code> seeds initial stock at the default location.
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
            <input ref={fileInput} type="file" accept=".csv,.txt,.xlsx"
                   onChange={(e) => onFile(e.target.files?.[0])} className="hidden" />
          </div>
        </Card>
      ) : analysis && !mapping ? (
        // Mapping wizard step — shown once the server has analysed the
        // headers, before we kick off row-by-row validation. Hidden again
        // after the user confirms.
        <ColumnMapperPanel
          analysis={analysis}
          onConfirm={onMappingConfirmed}
          onCancel={reset}
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <SummaryCard label="Total Rows" value={stats.total} />
            <SummaryCard label="Valid"      value={stats.valid}   color="green" />
            <SummaryCard label="Invalid"    value={stats.invalid} color="red" />
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
                Import {stats.valid > 0 ? stats.valid : ''} product{stats.valid !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        </>
      )}

      {!rows.length && (
        <EmptyState title="No file selected" message="Choose a CSV to preview the rows before import." />
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
