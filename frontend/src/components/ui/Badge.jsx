/**
 * Badge / chip — Iffaa design system.
 * Subtle status labels with optional leading dot.
 *
 * variant: 'gray' | 'green' | 'yellow' | 'red' | 'blue' | 'indigo' | 'teal'
 */
const variants = {
  gray:   'bg-gray-100 text-gray-700',
  green:  'bg-emerald-50 text-emerald-700',
  yellow: 'bg-amber-50 text-amber-700',
  red:    'bg-rose-50 text-rose-700',
  blue:   'bg-brand-50 text-brand-700',
  indigo: 'bg-indigo-50 text-indigo-700',
  teal:   'bg-teal-50 text-teal-700',
}

const dotColors = {
  gray:   'bg-gray-400',
  green:  'bg-emerald-500',
  yellow: 'bg-amber-500',
  red:    'bg-rose-500',
  blue:   'bg-brand-500',
  indigo: 'bg-indigo-500',
  teal:   'bg-teal-500',
}

export default function Badge({ children, variant = 'gray', dot = false, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${variants[variant] ?? variants.gray} ${className}`}
    >
      {dot && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[variant] ?? dotColors.gray}`} />
      )}
      {children}
    </span>
  )
}

/** Notification count bubble — shown on the bell icon. */
export function NotifBubble({ count }) {
  if (!count) return null
  return (
    <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center
                     rounded-full bg-rose-500 text-white text-[9px] font-bold leading-none px-1 ring-2 ring-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}
