/* Language picker: one sheet, used from the welcome screen and the Profile page.
 *
 * Choosing a language does three things, in this order:
 *   1. `setLocale()` — updates the store, <html lang/dir>, and repaints through
 *      the listener that state.js registered.
 *   2. Persists to localStorage, so the choice survives a reload and applies
 *      before the first paint (see the init block in i18n.js).
 *   3. PATCHes the account when signed in, so the backend's `locale` — which
 *      the reply engine reads — matches what the user sees.
 *
 * Step 3 is allowed to fail: the device keeps the choice and the toast says so.
 * Blocking the UI repaint on a network call would make the switch feel broken.
 *
 * The sheet previews rather than describes. Each row shows one genuine line the
 * companion would say in that language, taken from `/meta` → `locales`, which is
 * generated from the same reply pack the backend speaks from. A picker that only
 * lists endonyms asks the user to guess at the thing they are actually choosing
 * — the companion's voice — so the pitch shows the voice.
 */

import { api } from './api.js';
import { openSheet, toast } from './dom.js';
import { state } from './state.js';
import { t, LANGUAGES, locale, setLocale, dir } from './i18n.js';

/** Endonym + English name + one real line from the companion. */
function sampleFor(code) {
  const meta = state.meta;
  const row = meta && Array.isArray(meta.locales)
    ? meta.locales.find((l) => l.code === code)
    : null;
  return row ? row.opener : '';
}

export function languageSheetMarkup() {
  const current = locale();
  return `<div class="lang-list" role="radiogroup" aria-label="${t('language.title')}">
    ${LANGUAGES.map((lang) => {
      const sample = sampleFor(lang.code);
      return `
      <button class="lang-row" type="button" role="radio" data-lang="${lang.code}"
        aria-checked="${lang.code === current ? 'true' : 'false'}"
        aria-pressed="${lang.code === current ? 'true' : 'false'}">
        <span class="lang-body">
          <span class="lang-line">
            <span class="lang-name" lang="${lang.code}" dir="${lang.dir}">${lang.name}</span>
            <span class="lang-english">${lang.english}</span>
          </span>
          ${sample ? `<span class="lang-sample" lang="${lang.code}" dir="${lang.dir}">“${sample}”</span>` : ''}
        </span>
        <span class="lang-check" aria-hidden="true">✓</span>
      </button>`;
    }).join('')}
  </div>`;
}

/**
 * The sheet used to reload nothing and leave the list as it was — fine when a
 * row was only a name. With a sample line under it, the row has to reflect the
 * new language without a repaint that would also close the sheet, so the
 * selected row is re-marked in place and the sheet closes on the same tap.
 */
export function openLanguageSheet() {
  const close = openSheet({
    title: t('language.title'),
    body: `<p class="sub">${t('language.sub')}</p>${languageSheetMarkup()}`,
    // The note is an honest promise about safety copy; it goes after the sheet
    // actions so ten rows plus Close stay above the fold.
    footer: `<p class="tiny" style="line-height:1.6;color:var(--muted);margin:14px 0 0">${t('language.note')}</p>`,
    actions: [{ label: t('common.close'), kind: 'accent' }],
    onMount: ({ root }) => {
      root.addEventListener('click', async (ev) => {
        const row = ev.target.closest('[data-lang]');
        if (!row) return;
        const code = row.getAttribute('data-lang');
        if (code === locale()) { close(); return; }

        root.querySelectorAll('[data-lang]').forEach((r) => {
          const on = r === row;
          r.setAttribute('aria-checked', String(on));
          r.setAttribute('aria-pressed', String(on));
        });

        setLocale(code);
        const info = LANGUAGES.find((l) => l.code === locale());
        toast(t('language.changed', { language: info ? info.name : code }), 'good');
        close();
        await syncAccountLocale(code);
      });
    },
  });
  return close;
}

/**
 * Write the choice to the account. The backend reads `users.locale` when it
 * composes a reply, so a device-only change would leave the companion speaking
 * the old language.
 */
export async function syncAccountLocale(code) {
  if (!state.me) return true;
  try {
    const res = await api.patch('/settings/locale', { locale: code });
    if (res && res.locale) state.me.locale = res.locale;
    return true;
  } catch (err) {
    toast(t('language.saveFail'), 'error');
    return false;
  }
}

/** Apply a locale that came from the account (after sign-in on a new device). */
export function adoptAccountLocale(meLocale) {
  if (!meLocale) return;
  // A deliberate device choice wins over an older account value.
  let stored = null;
  try { stored = localStorage.getItem('wy_locale'); } catch (e) { stored = null; }
  if (stored) return;
  setLocale(meLocale, { persist: false });
}

export { dir };