---
name: i18n-language-system
description: How the English/Bangla UI translation system works and how to extend it
metadata:
  type: project
---

The frontend has an app-wide i18n layer (added 2026-06-15) so each tenant can switch the UI between English and Bangla.

- `frontend/src/context/LanguageContext.jsx` — `LanguageProvider` + `useLang()` returning `{ lang, setLang, t, languages }`. Choice persisted in `localStorage` key `app_lang` (shared across tabs), sets `<html lang>`. Provider is mounted in `App.jsx` inside `SettingsProvider`.
- `frontend/src/lib/translations.js` — `translations.bn` dictionary **keyed by the English source string**. `t('English source')` returns Bangla when `lang==='bn'` and the key exists; otherwise falls back to the English source. So untranslated strings never break — they just render in English.
- Language switcher (globe icon, English / বাংলা) lives in the top header: `frontend/src/components/layout/Header.jsx`.

**To translate a string:** wrap it `{t('English text')}` in the component (call `const { t } = useLang()`), then add `'English text': 'বাংলা',` to `translations.bn`. New `t()` calls with no dictionary entry are safe (show English).

Currently wired: Header (breadcrumbs, user menu, role labels), Sidebar (all nav groups/items), DashboardPage (greeting, quick actions, Business Overview, KPI/table headers, charts). Other pages still need `t()` wrapping to localize — extend incrementally.
