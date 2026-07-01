import { forwardRef, useState } from 'react'

/**
 * Input — Iffaa design system.
 * Uppercase micro-label above the field, soft border, blue focus ring.
 */
const Input = forwardRef(function Input(
  {
    label,
    error,
    hint,
    type      = 'text',
    className = '',
    required,
    leftIcon,
    ...props
  },
  ref
) {
  const [showPwd, setShowPwd] = useState(false)
  const isPassword = type === 'password'
  const inputType  = isPassword ? (showPwd ? 'text' : 'password') : type

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </label>
      )}

      <div className="relative">
        {leftIcon && (
          <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400 pointer-events-none">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          type={inputType}
          {...props}
          className={[
            // Compact size — operators repeatedly asked for fields
            // that "felt too big". py-2.5 → py-1.5 with a slightly
            // smaller leading; still tall enough to be tappable on
            // touch screens.
            'w-full rounded-md border bg-white px-3 py-1.5 text-sm leading-snug text-navy-800 placeholder-gray-400',
            'transition-colors duration-150 outline-none',
            'focus:ring-2 focus:ring-brand-100 focus:border-brand-500',
            error
              ? 'border-rose-300 bg-rose-50 focus:ring-rose-100 focus:border-rose-500'
              : 'border-gray-200 hover:border-gray-300',
            leftIcon ? 'pl-10' : '',
            isPassword ? 'pr-10' : '',
          ].join(' ')}
        />

        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPwd((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
          >
            {showPwd ? <EyeOff /> : <EyeOn />}
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-rose-600 flex items-center gap-1">
          <ExclamationIcon />
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-gray-400">{hint}</p>
      )}
    </div>
  )
})

export default Input

function EyeOn() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 3C5 3 1.73 7.11 1.05 10c.68 2.89 3.95 7 8.95 7s8.27-4.11 8.95-7C18.27 7.11 15 3 10 3zm0 12a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" />
    </svg>
  )
}
function EyeOff() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a11.085 11.085 0 003.04-3.205 1.172 1.172 0 000-1.51C17.73 7.111 14 3 10 3A9.853 9.853 0 004.516 4.975L3.28 2.22zM10 5a5 5 0 014.242 7.628l-1.476-1.476A3 3 0 106.848 7.152L5.372 5.677A7.858 7.858 0 0110 5z" clipRule="evenodd" />
      <path d="M10.848 13.97a3 3 0 01-3.818-3.818l3.818 3.818zM2.335 11.73A9.8 9.8 0 005.81 14.46l1.42-1.42a7.79 7.79 0 01-3.116-2.27.172.172 0 010-.16 9.48 9.48 0 011.05-1.32L3.71 7.848A11.17 11.17 0 002.335 10.22a1.172 1.172 0 000 1.51z" />
    </svg>
  )
}
function ExclamationIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  )
}
