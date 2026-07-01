import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'

/**
 * SearchableSelect — typeahead combobox with a visible filtered dropdown.
 *
 * Better than HTML5 `<datalist>` because:
 *   - The filter is visible (filtered list updates as you type)
 *   - Keyboard navigation (↑ ↓ Enter Escape) works the same on every browser
 *   - We strip disallowed characters at the keystroke level (letters-only
 *     by default — set `allowChars` to override)
 *
 * Designed to be `register()`-compatible:
 *   <SearchableSelect
 *     options={BD_THANAS_FLAT}
 *     placeholder="e.g. Dhanmondi"
 *     {...register('thana', { required: 'Thana is required.', validate: … })}
 *   />
 */

const DEFAULT_BAD_RE = /[^A-Za-z\s.\-']/g

const SearchableSelect = forwardRef(function SearchableSelect({
  options = [],
  className = '',
  onChange,
  onBlur,
  badRe = DEFAULT_BAD_RE,   // characters to strip from input as user types
  emptyLabel = 'No matches — keep typing to add a custom value.',
  name,
  value,
  defaultValue,
  ...rest
}, ref) {
  const [query, setQuery]       = useState(value ?? defaultValue ?? '')
  const [open, setOpen]         = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const wrap = useRef(null)

  // Keep `query` in sync if a parent / react-hook-form resets the value.
  useEffect(() => {
    if (value !== undefined && value !== query) setQuery(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Filter options as the user types. Case-insensitive substring match.
  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase()
    if (!q) return options.slice(0, 50)
    return options
      .filter((o) => o.toLowerCase().includes(q))
      .slice(0, 50)
  }, [options, query])

  // Close dropdown when clicking outside.
  useEffect(() => {
    const handler = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const fireChange = (next) => {
    setQuery(next)
    // react-hook-form's register expects a synthetic change with .target.value
    onChange?.({ target: { name, value: next } })
  }

  const handleInput = (e) => {
    const cleaned = e.target.value.replace(badRe, '')
    fireChange(cleaned)
    setOpen(true)
    setHighlight(-1)
  }

  const handleKey = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      if (highlight >= 0 && filtered[highlight]) {
        e.preventDefault()
        fireChange(filtered[highlight])
        setOpen(false)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={wrap}>
      <input
        ref={ref}
        name={name}
        autoComplete="off"
        value={query}
        onChange={handleInput}
        onFocus={() => setOpen(true)}
        onBlur={(e) => { onBlur?.(e); /* dropdown closes via mousedown handler */ }}
        onKeyDown={handleKey}
        className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${className}`}
        {...rest}
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-lg max-h-72 overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-400">{emptyLabel}</div>
          ) : filtered.map((opt, i) => (
            <button
              key={opt}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                fireChange(opt)
                setOpen(false)
              }}
              className={`block w-full text-left px-4 py-2 text-sm border-b border-gray-50 last:border-0 ${
                i === highlight ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50'
              }`}
            >
              {highlightMatch(opt, query)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

// Tiny highlighter — bolds the matched substring so the user can scan
// the filtered list quickly.
function highlightMatch(text, query) {
  const q = (query || '').trim()
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i === -1) return text
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold text-gray-900">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  )
}

export default SearchableSelect
