import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * DateRangePresetPicker — a single date-range input with a preset
 * dropdown (Today / Yesterday / Last 7 Days / Last 30 Days / This
 * Month / Last Month / This month last year / This Year / Last Year
 * / Current financial year / Last financial year / Custom Range).
 *
 * Per tenant fiscal year:
 *   The "financial year" presets default to July → June (Bangladesh).
 *   Pass `fiscalStartMonth={N}` (1–12) to override per tenant.
 *
 * Props
 *   from, to       — current ISO date strings ("YYYY-MM-DD") or ""
 *   onChange({ from, to }) — called when the operator picks a preset
 *                            or types into the Custom Range inputs
 *   fiscalStartMonth — 1..12 (default 7)
 *
 * Purely visual; the parent owns the dates and the API call.
 */
const PRESETS = [
  { key: 'today',         label: 'Today' },
  { key: 'yesterday',     label: 'Yesterday' },
  { key: 'last_7',        label: 'Last 7 Days' },
  { key: 'last_30',       label: 'Last 30 Days' },
  { key: 'this_month',    label: 'This Month' },
  { key: 'last_month',    label: 'Last Month' },
  { key: 'this_month_ly', label: 'This month last year' },
  { key: 'this_year',     label: 'This Year' },
  { key: 'last_year',     label: 'Last Year' },
  { key: 'fy_current',    label: 'Current financial year' },
  { key: 'fy_last',       label: 'Last financial year' },
  { key: 'custom',        label: 'Custom Range' },
]

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fmtRange = (from, to) => {
  if (!from && !to) return ''
  const f = (s) => {
    if (!s) return ''
    const [y, m, d] = s.split('-')
    return `${m}/${d}/${y}`
  }
  return `${f(from)} – ${f(to)}`
}

function computeRange(key, fiscalStartMonth = 7) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based
  const d = now.getDate()
  let from, to
  switch (key) {
    case 'today':
      from = to = iso(now); break
    case 'yesterday': {
      const x = new Date(y, m, d - 1)
      from = to = iso(x); break
    }
    case 'last_7':
      from = iso(new Date(y, m, d - 6))
      to   = iso(now); break
    case 'last_30':
      from = iso(new Date(y, m, d - 29))
      to   = iso(now); break
    case 'this_month':
      from = iso(new Date(y, m, 1))
      to   = iso(new Date(y, m + 1, 0)); break
    case 'last_month':
      from = iso(new Date(y, m - 1, 1))
      to   = iso(new Date(y, m, 0)); break
    case 'this_month_ly':
      from = iso(new Date(y - 1, m, 1))
      to   = iso(new Date(y - 1, m + 1, 0)); break
    case 'this_year':
      from = iso(new Date(y, 0, 1))
      to   = iso(new Date(y, 11, 31)); break
    case 'last_year':
      from = iso(new Date(y - 1, 0, 1))
      to   = iso(new Date(y - 1, 11, 31)); break
    case 'fy_current': {
      // Financial year: starts on fiscalStartMonth-1 (zero-based).
      const fyStart = fiscalStartMonth - 1
      const startYear = m >= fyStart ? y : y - 1
      from = iso(new Date(startYear, fyStart, 1))
      to   = iso(new Date(startYear + 1, fyStart, 0))
      break
    }
    case 'fy_last': {
      const fyStart = fiscalStartMonth - 1
      const startYear = m >= fyStart ? y - 1 : y - 2
      from = iso(new Date(startYear, fyStart, 1))
      to   = iso(new Date(startYear + 1, fyStart, 0))
      break
    }
    default:
      return null
  }
  return { from, to }
}

export default function DateRangePresetPicker({ from = '', to = '', onChange, fiscalStartMonth = 7, className = '' }) {
  const [open, setOpen] = useState(false)
  const [pos,  setPos]  = useState({ top: 0, left: 0 })
  const [mode, setMode] = useState('preset') // 'preset' | 'custom'
  const btnRef = useRef(null)

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 380
      const spaceBelow = window.innerHeight - r.bottom
      const top = spaceBelow >= MENU_H ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 220
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setMode('preset')
    setOpen(true)
  }
  const close = () => setOpen(false)

  // Close on outside click handled by the backdrop.
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])

  const pick = (key) => {
    if (key === 'custom') { setMode('custom'); return }
    const r = computeRange(key, fiscalStartMonth)
    if (r) { onChange?.(r); close() }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        className={`h-8 w-full rounded-md border border-gray-200 bg-white px-2.5 text-left text-xs text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 ${className}`}
      >
        {from || to ? fmtRange(from, to) : 'Date range…'}
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-[80] cursor-default"
          />
          <div
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[90] w-[220px] rounded-lg border border-gray-200 bg-white shadow-pop overflow-hidden"
          >
            {mode === 'preset' ? (
              <ul className="max-h-[380px] overflow-auto py-1 text-sm">
                {PRESETS.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      onClick={() => pick(p.key)}
                      className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-emerald-50"
                    >
                      {p.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2 p-3">
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">From</label>
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => onChange?.({ from: e.target.value, to })}
                    className="h-8 w-full rounded-md border border-gray-200 px-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">To</label>
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => onChange?.({ from, to: e.target.value })}
                    className="h-8 w-full rounded-md border border-gray-200 px-2 text-xs"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setMode('preset')} className="text-xs text-gray-500 hover:text-gray-700">← Presets</button>
                  <button type="button" onClick={close} className="text-xs font-semibold text-brand-600 hover:text-brand-700">Apply</button>
                </div>
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
