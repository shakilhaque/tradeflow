import { forwardRef } from 'react'

/**
 * BdPhoneInput — fixed "+88" prefix + 11-digit BD national number.
 *
 * - Prefix is a non-editable label, not part of the value.
 * - Input only accepts digits, max 11 chars (01XXXXXXXXX).
 * - Pastes are sanitised: country-code (88) is stripped if pasted.
 *
 * Designed for react-hook-form. Use it like a plain <input>:
 *     <BdPhoneInput {...register('phone', { ... })} />
 */
const BdPhoneInput = forwardRef(function BdPhoneInput({
  className = '',
  onChange,
  onPaste,
  ...rest
}, ref) {
  const handleChange = (e) => {
    // Strip non-digits, accept up to 11 chars. If user pasted with the
    // country code (e.g. "8801712345678" or "+8801712345678"), strip it.
    let digits = e.target.value.replace(/\D/g, '')
    if (digits.startsWith('880') && digits.length === 13) digits = '0' + digits.slice(3)
    if (digits.length > 11) digits = digits.slice(0, 11)
    e.target.value = digits
    onChange?.(e)
  }

  return (
    <div className={`flex items-stretch rounded-lg border border-gray-200 bg-white focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 ${className}`}>
      <span className="inline-flex items-center px-3 text-sm font-medium text-gray-600 bg-gray-50 rounded-l-lg border-r border-gray-200 select-none">
        +88
      </span>
      <input
        ref={ref}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        maxLength={11}
        placeholder="01XXXXXXXXX"
        onChange={handleChange}
        onPaste={onPaste}
        className="flex-1 min-w-0 rounded-r-lg bg-transparent px-3 py-2 text-sm outline-none placeholder:text-gray-400"
        {...rest}
      />
    </div>
  )
})

export default BdPhoneInput

// Shared regex for the same pattern react-hook-form's validate rule uses.
// Public so callers can reuse it.
export const BD_PHONE_PATTERN = /^01[0-9]{9}$/
export const validateBdPhone = (v) =>
  BD_PHONE_PATTERN.test((v || '').trim())
    || 'Enter a valid Bangladesh mobile (01XXXXXXXXX, 11 digits).'
export const validateBdPhoneOptional = (v) => {
  if (!v || !v.trim()) return true
  return validateBdPhone(v)
}

// Letters-only validators — used by name/business/thana/district fields
// so the frontend rejects digits/special chars before the server has to.
export const LETTERS_PATTERN = /^[A-Za-z][A-Za-z\s.\-']*[A-Za-z.]$/
export const BUSINESS_PATTERN = /^[A-Za-z][A-Za-z\s.\-'&,]*[A-Za-z.,]$/
export const validateLettersOnly = (label = 'This field') => (v) => {
  const t = (v || '').trim()
  if (!t) return `${label} is required.`
  return LETTERS_PATTERN.test(t) || `${label} must contain only letters and spaces.`
}
export const validateBusinessName = (v) => {
  const t = (v || '').trim()
  if (!t) return 'Business name is required.'
  return BUSINESS_PATTERN.test(t) || 'Use letters, spaces, &, ., -, \' or , (no digits).'
}


/**
 * stripAtKeystroke — replace any character that isn't allowed by `pattern`.
 *
 * Used as a wrapper around react-hook-form's `register().onChange`. This
 * intercepts EACH keystroke and rewrites e.target.value to only contain
 * permitted characters. Net effect: the digit / special char never even
 * appears in the input — much better UX than rejecting on submit.
 *
 * Letters: `/[^A-Za-z\s.\-']/g`
 * Business: `/[^A-Za-z\s.\-'&,]/g`
 */
export function stripAtKeystroke(reg, badRe) {
  return {
    ...reg,
    onChange: (e) => {
      const cleaned = e.target.value.replace(badRe, '')
      if (cleaned !== e.target.value) e.target.value = cleaned
      reg.onChange?.(e)
    },
  }
}

// Pre-baked regexes for the two name kinds.
export const NON_LETTERS_RE  = /[^A-Za-z\s.\-']/g
export const NON_BUSINESS_RE = /[^A-Za-z\s.\-'&,]/g
