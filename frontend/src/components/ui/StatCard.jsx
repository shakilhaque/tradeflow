import Spinner from './Spinner'

/**
 * KPI stat card for the dashboard.
 *
 * Props
 * ─────
 * title        — label above the number
 * value        — the big number / string to display
 * icon         — JSX element (SVG) for the icon
 * iconColor    — Tailwind color class for icon bg: 'bg-brand-100 text-brand-600' etc.
 * trend        — optional { value: '+12%', direction: 'up' | 'down' | 'flat' }
 * loading      — show skeleton
 * suffix       — optional unit string, e.g. 'items', 'orders'
 * onClick      — optional click handler (makes card interactive)
 */
export default function StatCard({
  title,
  value,
  icon,
  iconColor   = 'bg-brand-100 text-brand-600',
  trend,
  loading     = false,
  suffix      = '',
  onClick,
}) {
  const interactive = !!onClick

  return (
    <div
      onClick={onClick}
      className={[
        'bg-white rounded-2xl border border-gray-100 shadow-sm p-5',
        'flex items-start justify-between gap-4',
        interactive ? 'cursor-pointer hover:shadow-md hover:border-brand-200 transition-all duration-200' : '',
      ].join(' ')}
    >
      {/* Left — text */}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
          {title}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 mt-2">
            <div className="h-7 w-24 bg-gray-100 rounded animate-pulse" />
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-2xl font-bold text-gray-900 leading-none">{value ?? '—'}</span>
            {suffix && (
              <span className="text-sm text-gray-400 font-normal">{suffix}</span>
            )}
          </div>
        )}

        {trend && !loading && (
          <p className={`mt-1.5 text-xs font-medium flex items-center gap-1 ${
            trend.direction === 'up'   ? 'text-green-600' :
            trend.direction === 'down' ? 'text-red-500'   : 'text-gray-400'
          }`}>
            {trend.direction === 'up'   && <ArrowUp />}
            {trend.direction === 'down' && <ArrowDown />}
            {trend.value}
            <span className="font-normal text-gray-400">vs yesterday</span>
          </p>
        )}
      </div>

      {/* Right — icon */}
      <div className={`rounded-xl p-3 shrink-0 ${iconColor}`}>
        {icon}
      </div>
    </div>
  )
}

function ArrowUp() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
    </svg>
  )
}

function ArrowDown() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clipRule="evenodd" />
    </svg>
  )
}
