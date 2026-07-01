/**
 * Centered auth card layout — used by Login, Set Password pages.
 */
export default function AuthLayout({ children, title, subtitle }) {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-brand-50 via-white to-indigo-50">
      {/* Top bar */}
      <header className="py-5 px-6">
        <Logo />
      </header>

      {/* Card */}
      <main className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="w-full max-w-[420px] animate-fade-in">
          {/* Heading above card */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            {subtitle && (
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">{subtitle}</p>
            )}
          </div>

          {/* Card */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
            {children}
          </div>

          {/* Footer */}
          <p className="mt-6 text-center text-xs text-gray-400">
            &copy; {new Date().getFullYear()} IFFAA Accounting System. All rights reserved.
          </p>
        </div>
      </main>
    </div>
  )
}

function Logo() {
  return (
    <a href="/" className="inline-flex items-center gap-2 group">
      <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shadow-sm
                      group-hover:bg-brand-700 transition-colors">
        <svg className="w-5 h-5 text-white" viewBox="0 0 20 20" fill="currentColor">
          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
        </svg>
      </div>
      <span className="text-base font-semibold text-gray-900">IFFAA Accounting System</span>
    </a>
  )
}
