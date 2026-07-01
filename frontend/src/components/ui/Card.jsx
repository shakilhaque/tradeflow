/**
 * Card container — Iffaa design system.
 * White surface, subtle border, soft shadow, rounded-xl.
 */
// Compact default padding — operators repeatedly noted that Add Sale
// and list pages felt oversized. Old default was 'p-5 sm:p-6'.
export default function Card({ children, className = '', padding = 'p-4 sm:p-5' }) {
  return (
    <div className={`bg-white rounded-xl shadow-soft border border-gray-200 ${padding} ${className}`}>
      {children}
    </div>
  )
}

export function CardHeader({ title, subtitle, action, className = '' }) {
  return (
    <div className={`flex items-start justify-between gap-4 mb-4 ${className}`}>
      <div className="min-w-0">
        {title && <h2 className="text-base font-bold text-navy-800">{title}</h2>}
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
