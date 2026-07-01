import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtPhone } from '../../utils/phone'

/**
 * CustomerTypeahead — modern customer picker with two-line rows
 * (name bold + phone/email subdued), a Walk-in shortcut at the top,
 * and a fully-styled dropdown that works the same across browsers.
 *
 * Phone numbers are normalised through fmtPhone() so the leading "0"
 * always shows — even when the underlying row was stored as
 * "1633…" instead of "01633…" (Excel import quirk).
 *
 * Props
 *   customers       — array of { id, name, phone?, email?, ... }
 *   value           — current input text
 *   onChange(v)     — fires as the operator types
 *   onPick(customer | null)  — fires on row click; null = Walk-in
 *   placeholder     — input placeholder
 *   showWalkIn      — render "Walk-in customer" row at top (default true)
 *   renderExtra     — optional function(c) → JSX appended to each row
 *                     (used by the POS picker to show credit badges)
 *   inputClassName  — override input styling
 *   panelMaxHeight  — Tailwind className for max-height (default max-h-72)
 */
export default function CustomerTypeahead({
  customers = [],
  value = '',
  onChange,
  onPick,
  placeholder = 'Search customer by name / phone…',
  showWalkIn = true,
  renderExtra,
  inputClassName,
  panelMaxHeight = 'max-h-72',
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  const filtered = useMemo(() => {
    const q = (value || '').trim().toLowerCase()
    if (!q) return customers.slice(0, 25)
    return customers.filter((c) => {
      const hay = `${c.name || ''} ${c.phone || ''} ${c.email || ''}`.toLowerCase()
      return hay.includes(q)
    }).slice(0, 25)
  }, [customers, value])

  useEffect(() => {
    const onClick = (e) => {
      if (!boxRef.current) return
      if (!boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const inputCls = inputClassName || (
    'w-full rounded-lg border border-gray-200 bg-white pl-8 pr-3 py-2 text-sm text-navy-800 ' +
    'placeholder-gray-400 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
  )

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-gray-400">
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9 3a6 6 0 104.47 10.03l3.74 3.74a.75.75 0 101.06-1.06l-3.74-3.74A6 6 0 009 3zm-4.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
          </svg>
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange?.(e.target.value)
            setOpen(true)
            if (!e.target.value) onPick?.(null)
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className={inputCls}
        />
      </div>
      {open && (
        <div className={`absolute z-30 mt-1 w-full ${panelMaxHeight} overflow-auto rounded-lg border border-gray-200 bg-white shadow-pop`}>
          {showWalkIn && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange?.(''); onPick?.(null); setOpen(false) }}
              className="block w-full px-3 py-2 text-left text-xs font-semibold text-gray-500 hover:bg-gray-50 border-b border-gray-100"
            >
              Walk-in customer
            </button>
          )}
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500 italic">
              {(value || '').trim()
                ? `No customers match "${value}".`
                : 'No customers yet — add one from the Contacts page.'}
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onPick?.(c); setOpen(false) }}
                className="block w-full px-3 py-2 text-left hover:bg-emerald-50"
              >
                <div className="text-sm font-medium text-gray-900 truncate">{c.name}</div>
                <div className="text-[11px] text-emerald-700 truncate font-mono">
                  {fmtPhone(c.phone) || '—'}{c.email ? ` · ${c.email}` : ''}
                </div>
                {renderExtra?.(c)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
