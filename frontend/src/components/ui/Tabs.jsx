/**
 * Segmented tabs — Iffaa design system.
 * Used on list-page filter rows (All / Paid / Partial / Unpaid).
 *
 *   <Tabs value={active} onChange={setActive} items={[
 *     { value: 'all',     label: 'All' },
 *     { value: 'paid',    label: 'Paid',    count: 12 },
 *     { value: 'partial', label: 'Partial' },
 *   ]} />
 */
export default function Tabs({ value, onChange, items, size = 'md', className = '' }) {
  const padding = size === 'sm' ? 'px-2.5 py-1' : 'px-3 py-1.5'

  return (
    <div className={`inline-flex rounded-lg bg-gray-100 p-0.5 ${className}`}>
      {items.map((it) => {
        const active = it.value === value
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange?.(it.value)}
            className={[
              'inline-flex items-center gap-1.5 rounded-md text-[13px] font-semibold transition-colors',
              padding,
              active
                ? 'bg-white text-navy-800 shadow-soft'
                : 'text-gray-500 hover:text-navy-800',
            ].join(' ')}
          >
            {it.label}
            {it.count != null && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                active ? 'bg-brand-50 text-brand-700' : 'bg-gray-200 text-gray-600'
              }`}>{it.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
