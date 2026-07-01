/**
 * Alert banner — success | error | warning | info
 */
const styles = {
  error:   { wrap: 'bg-red-50 border-red-200 text-red-800',   icon: 'text-red-500' },
  success: { wrap: 'bg-green-50 border-green-200 text-green-800', icon: 'text-green-500' },
  warning: { wrap: 'bg-amber-50 border-amber-200 text-amber-800', icon: 'text-amber-500' },
  info:    { wrap: 'bg-blue-50 border-blue-200 text-blue-800',  icon: 'text-blue-500' },
}

export default function Alert({ type = 'error', title, children, className = '' }) {
  const s = styles[type]

  return (
    <div
      role="alert"
      className={`flex gap-3 rounded-lg border p-4 text-sm animate-fade-in ${s.wrap} ${className}`}
    >
      <span className={`mt-0.5 shrink-0 ${s.icon}`}>
        <Icon type={type} />
      </span>
      <div className="min-w-0">
        {title && <p className="font-semibold mb-0.5">{title}</p>}
        <div className="leading-relaxed">{children}</div>
      </div>
    </div>
  )
}

function Icon({ type }) {
  if (type === 'success') return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  )
  if (type === 'warning') return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
  )
  // error / info
  return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  )
}
