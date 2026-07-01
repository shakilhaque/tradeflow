/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * Brand palette — Iffaa design system.
         * The brand mark uses a navy/blue → teal gradient. Primary actions and
         * the active sidebar state use blue-600 (#2563EB). The full token map
         * below mirrors Tailwind's blue scale so every shade pairs cleanly.
         */
        /**
         * `brand` is the app-wide ACCENT token (primary buttons, links,
         * focus rings, active states). It's driven by CSS variables that the
         * Settings → System "Theme color" picker writes onto <html> via
         * SettingsContext, so changing the theme re-colours the whole app.
         * Fallbacks (emerald = the default green) keep it working before the
         * JS runs and in the static build.
         */
        brand: {
          50:  'rgb(var(--theme-50-rgb,  236 253 245) / <alpha-value>)',
          100: 'rgb(var(--theme-100-rgb, 209 250 229) / <alpha-value>)',
          200: 'rgb(var(--theme-200-rgb, 167 243 208) / <alpha-value>)',
          300: 'rgb(var(--theme-300-rgb, 110 231 183) / <alpha-value>)',
          400: 'rgb(var(--theme-400-rgb, 52 211 153) / <alpha-value>)',
          500: 'rgb(var(--theme-500-rgb, 16 185 129) / <alpha-value>)',
          600: 'rgb(var(--theme-600-rgb, 5 150 105) / <alpha-value>)',
          700: 'rgb(var(--theme-700-rgb, 4 120 87) / <alpha-value>)',
          800: 'rgb(var(--theme-800-rgb, 6 95 70) / <alpha-value>)',
          900: 'rgb(var(--theme-900-rgb, 6 78 59) / <alpha-value>)',
          950: 'rgb(var(--theme-950-rgb, 2 44 34) / <alpha-value>)',
        },
        // Navy used by the wordmark + headings on light surfaces.
        navy: {
          50:  '#f1f5f9',
          100: '#e2e8f0',
          200: '#cbd5e1',
          300: '#94a3b8',
          400: '#64748b',
          500: '#475569',
          600: '#334155',
          700: '#1e293b',
          800: '#0f172a',
          900: '#0b1120',
        },
        // Tagline / "Your Faith, Our Tech" green from the logo.
        teal: {
          50:  '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        // Background surface tokens used app-wide.
        surface: {
          DEFAULT: '#ffffff',
          subtle:  '#f9fafb',  // page background
          muted:   '#f4f4f5',  // header/footer/strip background
          border:  '#e5e7eb',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        // PDF uses generous rounded corners on cards (rounded-xl) and pill
        // buttons (rounded-md / rounded-full).
        card: '0.875rem', // 14px
      },
      boxShadow: {
        // Subtle elevation matching the design — almost flat with a soft glow.
        soft:  '0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 1px 3px 0 rgba(15, 23, 42, 0.06)',
        card:  '0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 2px 8px -2px rgba(15, 23, 42, 0.06)',
        pop:   '0 8px 24px -8px rgba(15, 23, 42, 0.12), 0 2px 4px -2px rgba(15, 23, 42, 0.06)',
      },
      animation: {
        'spin-slow': 'spin 1.5s linear infinite',
        'fade-in':   'fadeIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
