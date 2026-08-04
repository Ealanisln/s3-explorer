// i18n runtime: language detection, `t()` lookup + interpolation, and the
// static-HTML translation pass (`applyStaticTranslations`).
//
// Language resolution order:
//   1. localStorage['s3x-lang'] (explicit user choice, persisted)
//   2. navigator.language → `es*` maps to 'es', anything else to 'en'
//
// Dictionaries are typed against MsgKey (derived from es.ts), so both
// languages are guaranteed to carry identical key sets at compile time.
//
// Note for module authors: strings rendered dynamically (grid rows, open
// menus, toasts already on screen) are NOT re-translated on language switch —
// they pick up the new language on their next render. Static HTML annotated
// with data-i18n* attributes IS re-applied immediately by setLang().

import { es, type MsgKey } from './es.js';
import { en } from './en.js';

export type { MsgKey };
export type Lang = 'es' | 'en';

export const LANG_STORAGE_KEY = 's3x-lang';

const DICTS: Record<Lang, Record<MsgKey, string>> = { es, en };

// Pure resolver, exported for unit tests: given the stored preference and
// the navigator language, decide the effective language.
export function resolveLang(stored: string | null, navigatorLang: string | undefined): Lang {
  if (stored === 'es' || stored === 'en') return stored;
  const nav = (navigatorLang || '').toLowerCase();
  return nav.startsWith('es') ? 'es' : 'en';
}

function detectLang(): Lang {
  let stored: string | null = null;
  try {
    stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_STORAGE_KEY) : null;
  } catch { /* localStorage may be blocked */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language : undefined;
  return resolveLang(stored, nav);
}

let currentLang: Lang = detectLang();

export function getLang(): Lang {
  return currentLang;
}

// Interpolate `{name}` placeholders. Params not present in the template are
// ignored; placeholders without a param are left as-is (visible in dev).
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match));
}

// Translate a key in the current language. Unknown keys (only reachable via
// a cast — MsgKey typing prevents them statically) return the key itself so
// the failure is visible instead of silent.
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLang];
  const template = dict[key] ?? es[key] ?? key;
  return interpolate(template, params);
}

// Map a server error payload ({ code, message }) to a localized message.
// Known machine codes translate via the dictionary; unknown codes (or
// payloads without a code, e.g. rate-limit 429s and zod BAD_REQUEST field
// errors) fall back to the server-provided Spanish message untouched.
const SERVER_ERROR_CODES = new Set<string>([
  'NO_SESSION', 'USER_INVALID', 'TOTP_REQUIRED', 'PASSWORD_CHANGE_REQUIRED',
  'TOKEN_INVALID', 'TOKEN_SCOPE', 'TOKEN_LIMIT', 'BREACHED',
  'ALREADY_ENROLLED', 'BAD_CONNECTION_ID',
]);

export function localizeServerError(payload: { code?: string; message?: string }, fallback?: string): string {
  if (payload.code && SERVER_ERROR_CODES.has(payload.code)) {
    return t(`serverError.${payload.code}` as MsgKey);
  }
  return payload.message || fallback || t('common.error');
}

// ── Static HTML translation ─────────────────────────────────────────────────

// Walk data-i18n* annotations under `root` and apply the current language.
// Variants:
//   data-i18n            → textContent
//   data-i18n-html       → innerHTML (trusted dictionary strings only)
//   data-i18n-placeholder / data-i18n-title / data-i18n-aria-label → attribute
export function applyStaticTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as MsgKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml as MsgKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder as MsgKey));
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as MsgKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel as MsgKey));
  });
}

type LangListener = (lang: Lang) => void;
const listeners: LangListener[] = [];

// Modules with dynamic-but-persistent chrome (e.g. the theme/lang buttons)
// can subscribe to re-render on language switch.
export function onLangChange(fn: LangListener): void {
  listeners.push(fn);
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    applyStaticTranslations(document);
  }
  for (const fn of listeners) fn(lang);
}

// ES/EN control in the sidebar footer, next to the theme toggle and matching
// its .btn-icon pattern. Switching re-applies static translations at once;
// dynamically rendered content (grid rows, open menus, toasts already shown)
// picks up the new language on its next render — acceptable by design.
export function initLangToggle(): void {
  const btn = document.getElementById('btn-lang');
  if (!btn) return;
  const paint = (): void => {
    btn.textContent = currentLang.toUpperCase();
    btn.title = t('lang.toggle');
  };
  btn.onclick = (): void => setLang(currentLang === 'es' ? 'en' : 'es');
  onLangChange(paint);
  paint();
}
