import { forwardRef } from 'react'

/**
 * Select — Iffaa design system. Matches Input look.
 */
const Select = forwardRef(function Select(
  { label, error, required, className = '', children, ...props },
  ref
) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          {...props}
          className={[
            // Compact size — operators repeatedly asked for fields
            // that "felt too big". py-2.5 → py-1.5 with a slightly
            // smaller leading; still tall enough to be tappable on
            // touch screens.
            'w-full appearance-none rounded-md border px-3 py-1.5 pr-9 text-sm leading-snug text-navy-800',
            'transition-colors duration-150 outline-none cursor-pointer bg-white',
            'focus:ring-2 focus:ring-brand-100 focus:border-brand-500',
            error
              ? 'border-rose-300 bg-rose-50 focus:ring-rose-100 focus:border-rose-500'
              : 'border-gray-200 hover:border-gray-300',
          ].join(' ')}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-gray-400">
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </span>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  )
})

export default Select
