import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import { stockIn, getLocations } from '../../api/inventory'
import { getProducts } from '../../api/products'

/**
 * Import Opening Stock — bulk-set the starting inventory by uploading a
 * CSV (.csv) or Excel (.xlsx / .xls / .xlsm) file. CSV is parsed in-page;
 * Excel is parsed via SheetJS (xlsx npm package) into the same row shape
 * so the downstream validation + upload loop is unchanged.
 *
 * Column order (mirrors the Instructions panel):
 *   1. SKU             (required)
 *   2. Location        (optional — defaults to first business location)
 *   3. Quantity        (required)
 *   4. Unit Cost       (Before Tax, required)
 *   5. Lot Number      (optional)
 *   6. Expiry Date     (optional, mm/dd/yyyy)
 */

const TEMPLATE_HEADERS = [
  'SKU',
  'Location',
  'Quantity',
  'Unit Cost (Before Tax)',
  'Lot Number',
  'Expiry Date',
]
const TEMPLATE_SAMPLE = [
  '246977,Main Location,50,4.58,LOT-001,12/31/2027',
  '246245,,25,140,,',
]

const INSTRUCTIONS = [
  { col: 1, name: 'SKU',                    required: true,  hint: '' },
  { col: 2, name: 'Location',               required: false, hint: 'Name of the business location. If blank, the first location is used.' },
  { col: 3, name: 'Quantity',               required: true,  hint: '' },
  { col: 4, name: 'Unit Cost (Before Tax)', required: true,  hint: '' },
  { col: 5, name: 'Lot Number',             required: false, hint: '' },
  { col: 6, name: 'Expiry Date',            required: false, hint: 'Stock expiry date in business date format mm/dd/yyyy.' },
]

export default function ImportOpeningStockPage() {
  const navigate  = useNavigate()
  const fileInput = useRef(null)
  const [file,     setFile]     = useState(null)
  const [fileName, setFileName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results,  setResults]  = useState(null) // { ok, fail, errors[] }

  const [locations, setLocations] = useState([])
  useEffect(() => {
    getLocations({ active_only: 'true' })
      .then((r) => setLocations(Array.isArray(r) ? r : (r?.results ?? [])))
      .catch(() => {})
  }, [])

  // ── CSV helpers ────────────────────────────────────────────────────────────

  const downloadTemplate = () => {
    const csv = [TEMPLATE_HEADERS.join(',')].concat(TEMPLATE_SAMPLE).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'import-opening-stock-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  // Whether the picked file is a binary Excel workbook (xlsx / xls /
  // xlsm). Used to decide whether to parse with SheetJS (XLSX library)
  // or as plain CSV text. Belt-and-braces — checks the extension AND
  // the first 4 magic bytes so a misnamed `.csv` that's really xlsx
  // is still routed correctly.
  const isExcelFile = async (f) => {
    const name = (f.name || '').toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) return true
    try {
      const buf = new Uint8Array(await f.slice(0, 4).arrayBuffer())
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true
      if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true
    } catch { /* ignore — fall through */ }
    return false
  }

  const onPickFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) { setFile(null); setFileName(''); return }
    setFile(f); setFileName(f.name)
  }

  const parseCsvText = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return []
    const header = lines.shift()  // discard header row
    return lines.map((line, i) => ({
      lineNo: i + 2, // +2 because we skipped header
      cells:  splitCsv(line).map((c) => c.trim()),
    }))
  }

  // Parse an Excel workbook (xlsx / xls / xlsm) into the same
  // `{ lineNo, cells }` row shape parseCsvText returns. Uses SheetJS
  // (xlsx npm package) — first non-empty sheet, sheet_to_json with
  // header:1 gives us a 2-D array we can map identically to CSV.
  const parseExcelArrayBuffer = (ab) => {
    const wb = XLSX.read(ab, { type: 'array' })
    if (!wb.SheetNames?.length) return []
    const ws = wb.Sheets[wb.SheetNames[0]]
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
    if (!matrix.length) return []
    matrix.shift() // discard header row, same as parseCsvText
    return matrix.map((cells, i) => ({
      lineNo: i + 2,
      cells:  cells.map((c) => (c == null ? '' : String(c).trim())),
    }))
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!file) {
      alert('Please choose a CSV or Excel file first.')
      return
    }
    setSubmitting(true)
    setResults(null)
    try {
      // Route by file type — CSV → text parse; Excel → SheetJS array
      // buffer parse. Both branches produce the SAME row shape so the
      // downstream validation loop is unchanged.
      let rows = []
      if (await isExcelFile(file)) {
        const ab = await file.arrayBuffer()
        rows = parseExcelArrayBuffer(ab)
      } else {
        const text = await file.text()
        rows = parseCsvText(text)
      }
      if (!rows.length) {
        setResults({ ok: 0, fail: 0, errors: ['No data rows found in the file.'] })
        return
      }

      // Pre-fetch a SKU → product map (limit to 500 most recent — adjust if needed)
      const productList = await getProducts({ limit: 500 }).catch(() => [])
      const allProducts = Array.isArray(productList) ? productList : (productList?.results ?? [])
      const skuToProduct = new Map(allProducts.map((p) => [String(p.sku || '').trim(), p]))

      const nameToLocation = new Map(locations.map((l) => [String(l.name || '').trim().toLowerCase(), l]))
      const defaultLocation = locations[0]

      let ok = 0, fail = 0
      const errors = []
      for (const r of rows) {
        const [sku, locName, qty, cost] = r.cells
        const problems = []
        const product  = skuToProduct.get((sku || '').trim())
        const location = locName
          ? nameToLocation.get((locName || '').trim().toLowerCase())
          : defaultLocation

        if (!product)              problems.push(`unknown SKU "${sku}"`)
        if (!location)             problems.push(`unknown location "${locName}"`)
        if (!qty || Number(qty) <= 0) problems.push('quantity must be > 0')
        if (cost === '' || cost == null || Number(cost) < 0) problems.push('unit cost required')

        if (problems.length) {
          fail += 1
          errors.push(`Row ${r.lineNo}: ${problems.join(', ')}`)
          continue
        }
        try {
          await stockIn({
            product_id:     product.id,
            location_id:    location.id,
            quantity:       Number(qty),
            unit_cost:      Number(cost),
            reference_type: 'opening_stock',
          })
          ok += 1
        } catch (err) {
          fail += 1
          errors.push(`Row ${r.lineNo} (${product.name}): ${err?.message || 'failed'}`)
        }
      }

      setResults({ ok, fail, errors })
    } catch (err) {
      setResults({ ok: 0, fail: 1, errors: [err?.message || 'Failed to parse the file.'] })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Import Opening Stock</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Bulk-set the starting inventory for products by uploading a <b>CSV</b> or
          <b>Excel</b> file (<code>.csv</code>, <code>.xlsx</code>, <code>.xls</code>).
          Download the template below for the correct columns.
        </p>
      </div>

      {/* ── Upload card ───────────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[16rem]">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
              File to Import
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={onPickFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-navy-800 hover:bg-gray-50"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z" /><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" /></svg>
                Choose file
              </button>
              <span className="text-sm text-gray-600 truncate max-w-[20rem]">
                {fileName || 'No file chosen'}
              </span>
            </div>
          </div>

          <Button onClick={handleSubmit} loading={submitting} disabled={!file || submitting}>
            {submitting ? 'Importing…' : 'Submit'}
          </Button>
        </div>

        <div className="mt-5 pt-4 border-t border-gray-100">
          <Button variant="secondary" onClick={downloadTemplate}>
            <span className="inline-flex items-center gap-2">
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z" /><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" /></svg>
              Download template file
            </span>
          </Button>
        </div>
      </Card>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {results && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold text-navy-800">Import results</h2>
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 px-2.5 py-0.5 text-xs font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {results.ok} successful
              </span>
              {results.fail > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 text-rose-700 px-2.5 py-0.5 text-xs font-semibold">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  {results.fail} failed
                </span>
              )}
            </div>
          </div>
          {results.errors.length > 0 && (
            <ul className="mt-4 max-h-60 overflow-auto rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700 space-y-1">
              {results.errors.slice(0, 100).map((e, i) => <li key={i}>{e}</li>)}
              {results.errors.length > 100 && <li>…and {results.errors.length - 100} more</li>}
            </ul>
          )}
          {results.ok > 0 && (
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setFile(null); setFileName(''); setResults(null); if (fileInput.current) fileInput.current.value = '' }}>
                Import another file
              </Button>
              <Button onClick={() => navigate('/products')}>View Products</Button>
            </div>
          )}
        </Card>
      )}

      {/* ── Instructions ─────────────────────────────────────────────────── */}
      <Card padding="p-0" className="overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-white">
          <h2 className="text-base font-semibold">Instructions</h2>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-700 mb-3">
            <strong>Follow the instructions carefully before importing the file.</strong>
          </p>
          <p className="text-sm text-gray-700 mb-4">
            The columns of the file should be in the following order:
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-2.5 w-32">Column Number</th>
                  <th className="px-4 py-2.5">Column Name</th>
                  <th className="px-4 py-2.5">Instruction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {INSTRUCTIONS.map((row) => (
                  <tr key={row.col}>
                    <td className="px-4 py-3 font-mono text-gray-700">{row.col}</td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-navy-800">{row.name}</span>
                      {' '}
                      <span className={row.required ? 'text-rose-600 text-xs font-semibold' : 'text-gray-400 text-xs font-semibold'}>
                        ({row.required ? 'Required' : 'Optional'})
                      </span>
                      {row.col === 2 && (
                        <p className="mt-0.5 text-xs text-amber-600">If blank first business location will be used</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-sm">{row.hint || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  )
}

/** Simple CSV splitter — handles quoted cells with commas inside. */
function splitCsv(line) {
  const out = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}
