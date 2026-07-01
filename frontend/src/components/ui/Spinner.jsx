/**
 * Full-page or inline loading spinner.
 * size: 'sm' | 'md' | 'lg'
 */
const sizes = {
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-2',
  lg: 'h-12 w-12 border-4',
}

export default function Spinner({ size = 'md', className = '' }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={[
        'rounded-full border-brand-200 border-t-brand-600 animate-spin',
        sizes[size],
        className,
      ].join(' ')}
    />
  )
}

/**
 * Full-screen overlay spinner — used for page-level loading.
 */
export function PageSpinner() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm z-50">
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" />
        <p className="text-sm text-gray-500 font-medium">Loading…</p>
      </div>
    </div>
  )
}
