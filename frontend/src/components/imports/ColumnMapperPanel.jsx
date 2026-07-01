import { useEffect, useState } from 'react'

/**
 * ColumnMapperPanel
 *
 * Lets the operator review and override the auto-detected
 * source-header → our-field mapping before kicking off validation.
 *
 * Props:
 *   analysis    {headers, row_count, sample_rows, mapping: {matches, extras}}
 *   onConfirm   (mapping)  — called with the final {our_field: source_header_or_null} dict
 *   onCancel    ()         — reset / pick a different file
 *
 * Confidence visual:
 *   exact     ✓ green
 *   substring ◐ amber
 *   fuzzy     ◌ blue (with score)
 *   none      ☐ grey ("not mapped — falls into extras")
 *
 * Skipped fields land their source header in `extras` automatically on
 * the server side (any header not chosen as a source for any field is
 * stashed in extras).
 */

// Default labels/order match the PRODUCT import — callers can override
// with their own `fields` prop (e.g. ImportSuppliersPage passes the
// supplier-side label set).
const DEFAULT_FIELDS = [
  { key: 'name',          label: 'Product Name *' },
  { key: 'sku',           label: 'SKU' },
  { key: 'barcode',       label: 'Barcode' },
  { key: 'category',      label: 'Category' },
  { key: 'brand',         label: 'Brand' },
  { key: 'unit',          label: 'Unit' },
  { key: 'unit_cost',     label: 'Unit Cost' },
  { key: 'selling_price', label: 'Selling Price' },
  { key: 'opening_qty',   label: 'Opening Quantity' },
  { key: 'reorder_level', label: 'Reorder Level' },
  { key: 'location',      label: 'Location' },
  { key: 'stock_date',    label: 'Stock Date' },
  { key: 'warranty_days', label: 'Warranty (days)' },
  { key: 'notes',         label: 'Notes' },
]

const KIND_BADGE = {
  exact:     { dot: 'bg-green-500',  text: 'exact match',     tone: 'text-green-700' },
  substring: { dot: 'bg-amber-400',  text: 'substring',       tone: 'text-amber-700' },
  fuzzy:     { dot: 'bg-blue-400',   text: 'fuzzy',           tone: 'text-blue-700' },
  none:      { dot: 'bg-gray-300',   text: 'not detected',    tone: 'text-gray-500' },
}

export default function ColumnMapperPanel({
  analysis, onConfirm, onCancel,
  // List of {key, label} for the rows in the mapping table. Pass your
  // own to control which fields the wizard supports. Default matches
  // the PRODUCT import — used by the legacy ImportProductsPage call site.
  fields = DEFAULT_FIELDS,
  // Required field whose mapping gates the "Use this mapping" button.
  // Defaults to 'name' — works for both products and suppliers.
  requiredField = 'name',
}) {
  const headers = analysis?.headers || []
  const matches = analysis?.mapping?.matches || {}
  const detectedExtras = analysis?.mapping?.extras || []

  const fieldKeys = fields.map((f) => f.key)

  // Local override map — starts from server suggestion, user can edit any cell.
  // Shape: {our_field: source_header_or_null}
  const [mapping, setMapping] = useState(() => {
    const init = {}
    for (const k of fieldKeys) init[k] = matches[k]?.source_header ?? null
    return init
  })

  useEffect(() => {
    const init = {}
    for (const k of fieldKeys) init[k] = matches[k]?.source_header ?? null
    setMapping(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis])

  const claimed = new Set(Object.values(mapping).filter(Boolean))
  const extras  = headers.filter((h) => h && !claimed.has(h))

  const requiredMapped = !!mapping[requiredField]

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900">Map your columns</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          Detected {headers.length} column{headers.length === 1 ? '' : 's'} in your file (
          {analysis?.row_count ?? 0} row{analysis?.row_count === 1 ? '' : 's'}).
          Confirm or change how each column maps to a product field. Unmapped
          columns will be saved as <span className="font-mono">extras</span>.
        </p>
      </div>

      <div className="px-5 py-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100">
              <th className="py-2 pr-4">Product field</th>
              <th className="py-2 pr-4">Maps to column</th>
              <th className="py-2 pr-4">Detection</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {fields.map((f) => {
              const field = f.key
              const fm = matches[field] || { match_kind: 'none', confidence: 0 }
              const kind = mapping[field] ? fm.match_kind : 'none'
              const badge = KIND_BADGE[kind] || KIND_BADGE.none
              return (
                <tr key={field}>
                  <td className="py-2 pr-4 font-medium text-gray-800">
                    {f.label}
                  </td>
                  <td className="py-2 pr-4">
                    <select
                      value={mapping[field] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [field]: e.target.value || null }))
                      }
                      className="w-full max-w-xs rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-300"
                    >
                      <option value="">— skip / put in extras —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                      <span className={badge.tone}>
                        {badge.text}
                        {kind === 'fuzzy' && fm.confidence ? ` (${Math.round(fm.confidence * 100)}%)` : ''}
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Extras preview */}
      {extras.length > 0 && (
        <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-3">
          <p className="text-xs font-semibold text-gray-600">
            {extras.length} column{extras.length === 1 ? '' : 's'} will be saved as extras
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extras.map((h) => (
              <span key={h} className="rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs font-mono text-gray-700">
                {h}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          ← Choose a different file
        </button>
        <button
          type="button"
          onClick={() => onConfirm(mapping)}
          disabled={!requiredMapped}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          title={requiredMapped ? '' : `Map a column to ${fields.find((f) => f.key === requiredField)?.label || requiredField} first.`}
        >
          Use this mapping →
        </button>
      </div>
    </div>
  )
}
