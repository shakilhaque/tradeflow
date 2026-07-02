import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import { analyzeImport, validateImport, commitImport, downloadTemplate } from '../../api/imports'
import ColumnMapperPanel from '../../components/imports/ColumnMapperPanel'

/**
 * Import Suppliers from CSV / XLSX.
 *
 * Same three-step flow as Import Products:
 *   1. Upload CSV/XLSX  → analyzeImport returns suggested column mapping
 *   2. ColumnMapperPanel — confirm / override mapping
 *   3. validateImport(file, mapping) + commitImport(batch.id)
 *
 * The column_mapper / cleaners / extras pattern is shared with Products —
 * the only difference is the SYNONYMS_SUPPLIER table and the
 * SupplierImportValidator, both on the backend.
 */

const SUPPLIER_FIELDS = [
  { key: 'name',            label: 'Supplier Name *' },
  { key: 'business_name',   label: 'Business Name' },
  { key: 'contact',         label: 'Contact Person' },
  { key: 'phone',           label: 'Phone / Mobile' },
  { key: 'email',           label: 'Email' },
  { key: 'address',         label: 'Address' },
  { key: 'tax_number',      label: 'Tax / VAT / TIN' },
  { key: 'pay_term_value',  label: 'Pay Term (days)' },
  { key: 'opening_balance', label: 'Opening Balance' },
  { key: 'notes',           label: 'Notes' },
]

export default function ImportSuppliersPage() {
  const navigate     = useNavigate()
  const fileInput    = useRef(null)
  const [fileName,     setFileName]     = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)
  const [analysis,     setAnalysis]     = useState(null)
  const [mapping,      setMapping]      = useState(null)
  const [batch,        setBatch]        = useState(null)
  const [importing,    setImporting]    = useState(false)
  const [serverError,  setServerError]  = useState('')

  const onFile = async (file) => {
    if (!file) return
    setFileName(file.name); setUploadedFile(file)
    setServerError(''); setBatch(null); setAnalysis(null); setMapping(null)
    try {
      const result = await analyzeImport('supplier', file)
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
      setBatch(await validateImport('supplier', uploadedFile, confirmed))
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
      alert(`Imported ${result.committed_rows ?? batch.valid_rows} supplier(s).`)
      navigate('/contacts/suppliers')
    } catch (err) {
      setServerError(err?.message || 'Import failed.')
    } finally {
      setImporting(false)
    }
  }

  const handleDownloadTemplate = async () => {
    let blob
    try { blob = await downloadTemplate('supplier') } catch {
      blob = new Blob([SUPPLIER_FIELDS.map((f) => f.label.replace(' *', '')).join(',') + '\n'], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'suppliers-import-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Import Suppliers from CSV / Excel</h1>
            <p className="mt-0.5 text-sm text-emerald-100">
              Upload your supplier list. The system auto-detects column headers and creates each supplier on commit.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDownloadTemplate}>↓ Download template</Button>
          </div>
        </div>
      </div>

      {serverError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{serverError}</div>
      )}

      {!analysis ? (
        <Card>
          <div
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }}
            onDragOver={(e) => e.preventDefault()}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center"
          >
            <div className="text-3xl">📥</div>
            <div className="font-medium text-gray-900">Drop your supplier file here</div>
            <div className="text-xs text-gray-500">CSV or XLSX — name column is required, everything else optional</div>
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
          fields={SUPPLIER_FIELDS}
          requiredField="name"
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
                    {importing ? 'Importing…' : `Import ${batch.valid_rows} supplier${batch.valid_rows === 1 ? '' : 's'}`}
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
