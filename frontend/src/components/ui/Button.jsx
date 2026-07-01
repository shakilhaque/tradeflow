/**
 * Button component — Iffaa design system.
 *
 * variant: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
 * size:    'xs' | 'sm' | 'md' | 'lg'
 */
const variants = {
  primary:   'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-soft disabled:bg-brand-300 disabled:shadow-none focus:ring-brand-300',
  secondary: 'bg-white text-navy-700 border border-gray-200 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 focus:ring-brand-300',
  ghost:     'text-brand-700 hover:bg-brand-50 disabled:opacity-50 focus:ring-brand-300',
  danger:    'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800 shadow-soft disabled:bg-rose-300 focus:ring-rose-300',
  subtle:    'bg-gray-100 text-navy-700 hover:bg-gray-200 disabled:opacity-50 focus:ring-gray-300',
}

const sizes = {
  xs: 'px-2.5 py-1 text-xs',
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-[15px]',
}

export default function Button({
  children,
  variant   = 'primary',
  size      = 'md',
  loading   = false,
  fullWidth = false,
  className = '',
  leftIcon,
  rightIcon,
  ...props
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={[
        'inline-flex items-center justify-center gap-2 font-semibold rounded-lg',
        'transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2',
        variants[variant] ?? variants.primary,
        sizes[size] ?? sizes.md,
        fullWidth ? 'w-full' : '',
        loading ? 'cursor-wait' : '',
        className,
      ].join(' ')}
    >
      {loading ? (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : leftIcon ? (
        <span className="inline-flex items-center">{leftIcon}</span>
      ) : null}
      {children}
      {!loading && rightIcon && (
        <span className="inline-flex items-center">{rightIcon}</span>
      )}
    </button>
  )
}
