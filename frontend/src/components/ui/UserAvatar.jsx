import { useState } from 'react'

/**
 * Renders the user's profile picture if `src` is set, otherwise falls back to
 * a gradient circle with their initials. Used in the Sidebar (footer + workspace
 * card) and the Header user dropdown.
 *
 * Props:
 *   src   — image URL (user.profile_picture). Empty/null → fall back to initials.
 *   name  — display name (initials are derived from this).
 *   size  — Tailwind size class set, e.g. 'sm' | 'md' | 'lg'
 *           sm = 32px (h-8 w-8) — header
 *           md = 36px (h-9 w-9) — sidebar footer
 *           lg = 40px (h-10 w-10) — workspace card
 *   className — extra classes (e.g. ring)
 */
const SIZE = {
  sm: { box: 'w-8 h-8',  text: 'text-[11px]' },
  md: { box: 'w-9 h-9',  text: 'text-xs'      },
  lg: { box: 'w-10 h-10', text: 'text-sm'    },
}

export default function UserAvatar({ src, name, size = 'md', className = '' }) {
  const [errored, setErrored] = useState(false)
  const s = SIZE[size] ?? SIZE.md

  const initials = (name ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  const showImage = Boolean(src) && !errored

  if (showImage) {
    return (
      <img
        src={src}
        alt={name || 'User'}
        onError={() => setErrored(true)}
        className={[
          s.box,
          'shrink-0 rounded-full object-cover ring-1 ring-gray-200 bg-white',
          className,
        ].join(' ')}
      />
    )
  }

  return (
    <div
      className={[
        s.box,
        'shrink-0 rounded-full bg-gradient-to-br from-brand-600 to-brand-800',
        'flex items-center justify-center text-white font-bold',
        s.text,
        className,
      ].join(' ')}
    >
      {initials}
    </div>
  )
}
