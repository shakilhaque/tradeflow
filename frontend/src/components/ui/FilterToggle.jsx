/**
 * FilterToggle — clickable "Filters" header with a funnel icon + chevron that
 * collapses/expands the filter body. Drop it in place of the existing
 * "Filters" heading and gate the filter body with the `open` flag.
 *
 *   const [filtersOpen, setFiltersOpen] = useState(true)
 *   <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen(v => !v)} />
 *   <div className={filtersOpen ? '' : 'hidden'}> …filters… </div>
 */
export default function FilterToggle({ open, onToggle, title = 'Filters', accent = 'emerald' }) {
  const tone = accent === 'brand' ? 'text-brand-700' : 'text-emerald-700'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center justify-between gap-2 ${tone} ${open ? 'mb-4' : ''}`}
    >
      <span className="flex items-center gap-2">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M2.628 3.5A1 1 0 013.5 3h13a1 1 0 01.832 1.555L12 12.303V16a1 1 0 01-.553.894l-2 1A1 1 0 018 17v-4.697L2.668 4.555A1 1 0 012.628 3.5z" clipRule="evenodd" />
        </svg>
        <span className="text-sm font-semibold uppercase tracking-wider">{title}</span>
      </span>
      <svg
        className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
        viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
      >
        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
      </svg>
    </button>
  )
}
