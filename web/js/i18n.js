/* Localisation runtime: locale store, `t()` lookup, live language switching.
 *
 * Every screen template is a pure function of the state, so switching language
 * only has to change the store and re-run the router's render — there is no
 * per-node text bookkeeping and no reload. `setLocale()` does exactly that
 * hand-off: it updates the store, the <html lang/dir> attributes and any
 * registered listeners (state.js registers `renderApp`).
 */

import en from './i18n/en.js';
import zh from './i18n/zh.js';
import zhTW from './i18n/zh-TW.js';
import ja from './i18n/ja.js';
import ko from './i18n/ko.js';
import es from './i18n/es.js';
import fr from './i18n/fr.js';
import de from './i18n/de.js';
import pt from './i18n/pt.js';
import ar from './i18n/ar.js';

const DICTS = { en, zh, 'zh-TW': zhTW, ja, ko, es, fr, de, pt, ar };

/**
 * `name` is the endonym — what a speaker of that language calls it. A language
 * picker that lists "Chinese" to someone who reads 中文 is a picker they cannot
 * use. `english` is only for the secondary line.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', english: 'English', dir: 'ltr' },
  { code: 'zh', name: '简体中文', english: 'Chinese (Simplified)', dir: 'ltr' },
  { code: 'zh-TW', name: '繁體中文', english: 'Chinese (Traditional)', dir: 'ltr' },
  { code: 'ja', name: '日本語', english: 'Japanese', dir: 'ltr' },
  { code: 'ko', name: '한국어', english: 'Korean', dir: 'ltr' },
  { code: 'es', name: 'Español', english: 'Spanish', dir: 'ltr' },
  { code: 'fr', name: 'Français', english: 'French', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', english: 'German', dir: 'ltr' },
  { code: 'pt', name: 'Português', english: 'Portuguese', dir: 'ltr' },
  { code: 'ar', name: 'العربية', english: 'Arabic', dir: 'rtl' },
];

const STORAGE_KEY = 'wy_locale';
const DEFAULT = 'en';

export function isSupported(code) {
  return LANGUAGES.some((l) => l.code === code);
}

/** Normalise tags like `zh-CN`, `pt-BR`, `en-GB` onto a supported locale. */
export function normalise(code) {
  const tag = String(code || '').replace('_', '-');
  if (isSupported(tag)) return tag;
  const low = tag.toLowerCase();
  if (low.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(low) ? 'zh-TW' : 'zh';
  }
  const base = low.split('-')[0];
  return isSupported(base) ? base : DEFAULT;
}

let current = DEFAULT;
const listeners = new Set();

export function locale() { return current; }

export function languageInfo(code) {
  const c = code || current;
  return LANGUAGES.find((l) => l.code === c) || LANGUAGES[0];
}

export function dir(code) { return languageInfo(code).dir; }

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

function applyDocument(code) {
  const info = languageInfo(code);
  const root = document.documentElement;
  if (root) {
    root.setAttribute('lang', code);
    root.setAttribute('dir', info.dir);
  }
}

/**
 * Read the saved choice once, at module load, so the very first paint is
 * already in the right language instead of flashing English.
 *
 * The static HTML (boot spinner, noscript) is English; these two functions let
 * app.js re-label the boot screen and translate server-side error codes before
 * the first route renders.
 *
 * With nothing stored, the device's own language decides — `navigator.languages`
 * is the full, ordered preference list, and the first entry this build supports
 * wins. Starting an app in English for someone whose phone is set to 日本語 and
 * offering no switch on the way in is the failure this avoids; the welcome
 * screen's chip is the visible way back out.
 *
 * Nothing is written to localStorage here: "never chosen" and "chose English"
 * are different states, and only the latter should outrank the account's locale
 * later (see language.js `adoptAccountLocale`).
 */
(function init() {
  const saved = readStored();
  if (saved && isSupported(saved)) {
    current = saved;
  } else {
    const prefs = [].concat(navigator.languages || [], navigator.language || [])
      .map((tag) => String(tag || '').trim()).filter(Boolean);
    if (prefs.length) current = normalise(prefs[0]);
  }
  applyDocument(current);
})();

/** Swap the static boot text (and page title) into the active language. */
export function paintBootText() {
  const boot = document.getElementById('boot');
  if (boot) {
    const line = boot.querySelector('p');
    if (line) line.textContent = t('common.loading');
  }
  document.title = t('app.title');
}

/**
 * Translate a backend error into the user's language.
 *
 * The API answers with `{ code, message }`; only `code` is stable, so the
 * dictionary keys `apiError.<CODE>` and the server's English message is the
 * fallback for codes this build does not know yet.
 *
 * `HTTP_<status>` is what api.js synthesises when the body was not our JSON
 * envelope (a proxy error page, a gateway timeout). There is one key per
 * status in the dictionary, but any unlisted status still has to read as
 * something — so every `HTTP_*` falls back to the generic key rather than to
 * the English "Something went wrong."
 */
export function apiErrorText(err) {
  const code = err && err.code;
  if (code) {
    const key = `apiError.${code}`;
    const dict = DICTS[current] || {};
    if (dict[key] != null || en[key] != null) return t(key);
    if (/^HTTP_\d+$/.test(code)) return t('apiError.HTTP_GENERIC');
  }
  return (err && err.message) || t('state.somethingWrong');
}

export function setLocale(code, { persist = true, silent = false } = {}) {
  const next = isSupported(code) ? code : DEFAULT;
  const changed = next !== current;
  current = next;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* private mode */ }
  }
  applyDocument(next);
  if (changed && !silent) listeners.forEach((fn) => { try { fn(next); } catch (e) { /* keep going */ } });
  return next;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  ));
}

function lookup(dict, key, vars) {
  if (!dict) return undefined;
  // Plural forms: `key.one` / `key.other`, selected by Intl.PluralRules.
  if (vars && typeof vars.count === 'number') {
    let category = 'other';
    try { category = new Intl.PluralRules(current).select(vars.count); } catch (e) { /* fallback */ }
    if (dict[`${key}.${category}`] != null) return dict[`${key}.${category}`];
    if (category !== 'other' && dict[`${key}.other`] != null) return dict[`${key}.other`];
    if (dict[`${key}.one`] != null && vars.count === 1) return dict[`${key}.one`];
  }
  return dict[key];
}

/**
 * Translate `key`. Missing keys fall back to English, then to the key itself —
 * a half-translated locale degrades to English rather than blank buttons.
 */
export function t(key, vars) {
  const dict = DICTS[current] || {};
  let value = lookup(dict, key, vars);
  if (value == null) value = lookup(en, key, vars);
  if (value == null) return key;
  return interpolate(String(value), vars);
}

/**
 * Translate `key`, but fall back to `fallback` (server-provided text) when the
 * key is absent from both dictionaries. Used for content the backend owns —
 * shop items, rooms, activities — where a new server row must not render as a
 * raw key.
 */
export function tf(key, fallback, vars) {
  const dict = DICTS[current] || {};
  let value = lookup(dict, key, vars);
  if (value == null) value = lookup(en, key, vars);
  if (value == null) return fallback == null ? key : fallback;
  return interpolate(String(value), vars);
}

/** Locale-aware date/time formatting used by dom.js helpers. */
export function intlLocale() {
  return current === 'zh' ? 'zh-CN'
    : current === 'zh-TW' ? 'zh-TW'
    : current === 'pt' ? 'pt-BR'
    : current;
}

/** Exposed for the key-parity test. */
export function dictionary(code) { return DICTS[code] || {}; }
export function availableLocales() { return LANGUAGES.map((l) => l.code); }
export { DICTS };