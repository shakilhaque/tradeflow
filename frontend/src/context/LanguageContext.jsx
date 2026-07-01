/**
 * LanguageContext — app-wide UI language (English / Bangla).
 *
 * The selected language is persisted in localStorage so it survives reloads
 * and is shared across tabs of the same browser. Every tenant can switch from
 * the language picker in the top header.
 *
 * Consumers call `useLang()` and use `t('English source')` to translate a
 * string. Unknown strings (or English mode) fall back to the source text, so
 * partial coverage never breaks the UI.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react'

import { translations } from '../lib/translations'

const LangCtx = createContext(null)

const STORAGE_KEY = 'app_lang'
export const SUPPORTED_LANGS = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'bn', label: 'Bangla',  native: 'বাংলা' },
]
const CODES = SUPPORTED_LANGS.map((l) => l.code)

function readInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && CODES.includes(saved)) return saved
  } catch { /* private mode etc. */ }
  return 'en'
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readInitial)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((code) => {
    if (CODES.includes(code)) setLangState(code)
  }, [])

  const t = useCallback((source, fallback) => {
    if (lang === 'en') return fallback ?? source
    const dict = translations[lang] || {}
    return dict[source] ?? fallback ?? source
  }, [lang])

  const value = useMemo(
    () => ({ lang, setLang, t, languages: SUPPORTED_LANGS }),
    [lang, setLang, t],
  )

  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>
}

export function useLang() {
  const ctx = useContext(LangCtx)
  if (!ctx) {
    // Render-outside-provider safety (e.g. isolated tests): no-op English.
    return { lang: 'en', setLang: () => {}, t: (s, fb) => fb ?? s, languages: SUPPORTED_LANGS }
  }
  return ctx
}
