import Sparkline from './Sparkline'

/**
 * KpiCard — Iffaa design system.
 * 4-up grid on dashboards and list pages.
 *
 *   <KpiCard
 *     label="Revenue (MTD)"
 *     value="৳ 1,284,500"
 *     delta={{ pct: 12.4, direction: 'up', label: 'vs last month' }}
 *     sparklineData={[...]}
 *   />
 */
export default function KpiCard({
  label,
  value,
  helper,           // optional secondary line (e.g. "58 today")
  delta,            // { pct, direction: 'up' | 'down', label }
  sparklineData,    // optional number[] for the mini chart
  accent = 'brand', // 'brand' | 'teal' | 'amber' | 'rose'
  className = '',
  loading = false,
}) {
  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-soft p-4 sm:p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3 min-w-0">
        <p className="text-xs font-medium text-gray-500 truncate">{label}</p>
        <button
          type="button"
          className="text-gray-300 hover:text-gray-500 shrink-0"
          aria-label="Card actions"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-2xl sm:text-3xl font-bold text-navy-800 tracking-tight tabular-nums">
          {loading ? <span className="inline-block h-8 w-28 rounded bg-gray-100 animate-pulse" /> : value}
        </p>
        {sparklineData?.length > 0 && (
          <Sparkline data={sparklineData} accent={accent} className="h-10 w-24 shrink-0" />
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        {delta && (
          <span className={[
            'inline-flex items-center gap-0.5 font-semibold',
            delta.direction === 'down' ? 'text-rose-600' : 'text-emerald-600',
          ].join(' ')}>
            {delta.direction === 'down' ? '↓' : '↑'} {Math.abs(delta.pct ?? 0).toFixed(1)}%
          </span>
        )}
        {delta?.label && <span className="text-gray-500">{delta.label}</span>}
        {!delta && helper && <span className="text-gray-500">{helper}</span>}
      </div>
    </div>
  )
}
