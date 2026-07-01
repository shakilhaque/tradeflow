/**
 * NSL-POS logo component — used across auth pages and the app shell.
 *
 *   <Logo />                       icon + wordmark (default)
 *   <Logo variant="icon" />        just the icon mark
 *   <Logo variant="wordmark" />    text-only ("NSL-POS")
 *   <Logo size="sm|md|lg|xl" />    sizing
 *   <Logo onDark />                light/white variant for dark backgrounds
 */

const SIZES = {
  xs: { icon: 'h-6 w-6',   word: 'text-base' },
  sm: { icon: 'h-8 w-8',   word: 'text-lg' },
  md: { icon: 'h-10 w-10', word: 'text-xl' },
  lg: { icon: 'h-12 w-12', word: 'text-3xl' },
  xl: { icon: 'h-16 w-16', word: 'text-5xl' },
  '2xl': { icon: 'h-20 w-20', word: 'text-6xl' },
  '3xl': { icon: 'h-24 w-24', word: 'text-7xl' },
}

export default function Logo({
  variant = 'lockup',
  size    = 'md',
  onDark  = false,
  className = '',
}) {
  const sz = SIZES[size] ?? SIZES.md
  const wordmarkColor = onDark ? 'text-white' : 'text-navy-800'

  const Icon = (
    <img
      src="/nsl-icon.svg"
      alt="NSL-POS"
      className={`${sz.icon} object-contain shrink-0`}
      draggable="false"
    />
  )

  if (variant === 'icon') {
    return <span className={className}>{Icon}</span>
  }

  if (variant === 'wordmark') {
    return (
      <span className={`font-extrabold tracking-tight ${wordmarkColor} ${sz.word} ${className}`}>
        NSL<span className="text-brand-500">·</span>POS
      </span>
    )
  }

  // 'lockup' / 'full' — icon + wordmark
  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {Icon}
      <span className={`font-extrabold tracking-tight ${wordmarkColor} ${sz.word}`}>
        NSL<span className="text-brand-500">·</span>POS
      </span>
    </div>
  )
}
