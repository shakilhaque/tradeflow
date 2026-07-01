import { forwardRef, useState } from 'react'

/**
 * Password input with a show/hide (eye) toggle. Drop-in replacement for a
 * <input type="password" .../> — spreads every prop (react-hook-form
 * register, value/onChange, placeholder, className…) and just manages the
 * masked/visible state itself. Adds right padding for the toggle button.
 */
function EyeIcon({ off }) {
  return off ? (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 104.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0112 5c7 0 10 7 10 7a13.16 13.16 0 01-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 002 12s3 7 10 7a9.74 9.74 0 005.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

// forwardRef so react-hook-form's {...register()} can attach its ref to the
// real <input>. Without it the field value isn't tracked and validation
// (e.g. "Password is required") fails even after the user types.
const PasswordInput = forwardRef(function PasswordInput(
  { className = '', wrapperClassName = '', ...props }, ref,
) {
  const [show, setShow] = useState(false)
  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        ref={ref}
        {...props}
        type={show ? 'text' : 'password'}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
      >
        <EyeIcon off={show} />
      </button>
    </div>
  )
})

export default PasswordInput
