import { useEffect, useRef, useState } from 'react'

/**
 * SearchInput — Iffaa design system.
 *
 * Behavior:
 *  • Calls `onChange(event)` with a synthetic event-like object so pages
 *    that do `e => setSearch(e.target.value)` keep working.
 *  • Optional debounce.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  debounce = 300,
  className = '',
  ...rest
}) {
  const [local, setLocal] = useState(value ?? '')
  const timer = useRef(null)

  useEffect(() => { setLocal(value ?? '') }, [value])

  // Pass the plain string value through. Callers that need an event-like
  // object should adapt at the call site.
  const emit = (v) => onChange?.(v)

  const handleChange = (e) => {
    const v = e.target.value
    setLocal(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => emit(v), debounce)
  }

  const clear = () => {
    setLocal('')
    clearTimeout(timer.current)
    emit('')
  }

  return (
    <div className={`relative ${className}`}>
      <span className="absolute inset-y-0 left-3 flex items-center text-gray-400 pointer-events-none">
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
        </svg>
      </span>
      <input
        type="search"
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        {...rest}
        className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-8 py-2 text-sm
                   text-navy-800 placeholder-gray-400 outline-none transition-colors
                   hover:border-gray-300 focus:ring-2 focus:ring-brand-100 focus:border-brand-500"
      />
      {local && (
        <button
          type="button"
          onClick={clear}
          className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      )}
    </div>
  )
}
