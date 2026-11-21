/* Tiny DOM helpers: html`` tagged template, toasts, sheets, formatting. */

import { t, intlLocale } from './i18n.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Safe-by-default template: every interpolation is HTML-escaped unless wrapped in raw(). */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += value(values[i]);
  }
  return out;
}

/**
 * Join nested `html` fragments into markup.
 *
 * A tagged template is flattened by the language: `${items.map(...)}` arrives
 * as an array, and a template nested inside another one arrives as its final
 * string. Neither carries a marker, so they must be treated as markup — every
 * other value is escaped as text. Never pass raw user input through here.
 */
function value(v) {
  if (v == null || v === false || v === true) return '';
  if (v && v.__raw) return v.value;
  if (Array.isArray(v)) return v.map(value).join('');
  if (typeof v === 'string') return v;
  return esc(v);
}

export function raw(value) { return { __raw: true, value: String(value == null ? '' : value) }; }

/**
 * Join already-safe fragments.
 *
 * Each part is usually the result of `raw()`, so it must be unwrapped rather
 * than stringified — `String({__raw:true,value:'…'})` is `[object Object]`.
 */
export function join(parts) { return raw(parts.filter(Boolean).map(value).join('')); }

export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

export function on(root, type, sel, handler) {
  root.addEventListener(type, (ev) => {
    const target = ev.target.closest(sel);
    if (target && root.contains(target)) handler(ev, target);
  });
}

/* ----------------------------------------------------------------- toasts */

let toastSeq = 0;
export function toast(message, kind, opts) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const id = `toast-${++toastSeq}`;
  const node = el(`<div class="toast ${kind || ''}" id="${id}" role="status">
      <span class="tt"></span></div>`);
  node.querySelector('.tt').textContent = message;
  host.appendChild(node);
  const life = (opts && opts.ms) || 3600;
  const kill = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  setTimeout(kill, life);
  node.addEventListener('click', kill);
  return id;
}

/* ----------------------------------------------------------------- sheets */

export function openSheet({ title, body, actions, footer, onMount, dismissible = true }) {
  const root = document.getElementById('sheet-root');
  const back = el(`<div class="sheet-backdrop" role="dialog" aria-modal="true">
      <div class="sheet">
        <div class="sheet-grab"></div>
        ${title ? `<h2></h2>` : ''}
        <div class="sheet-body"></div>
        <div class="sheet-actions"></div>
        ${footer ? `<div class="sheet-foot"></div>` : ''}
      </div>
    </div>`);
  if (title) back.querySelector('h2').textContent = title;
  const bodyHost = back.querySelector('.sheet-body');
  if (typeof body === 'string') bodyHost.innerHTML = body;
  else if (body) bodyHost.appendChild(body);
  if (footer) back.querySelector('.sheet-foot').innerHTML = footer;
  const actionHost = back.querySelector('.sheet-actions');
  (actions || []).forEach((a) => {
    const b = el(`<button class="btn ${a.kind || 'ghost'} block"></button>`);
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      // `onClick` may be async (report submit, export, delete account). Awaiting
      // it matters: an un-awaited promise resolves to a Promise object, which is
      // always truthy, so `keep` was always true and the sheet never closed.
      let keep = false;
      try {
        keep = a.onClick ? await a.onClick(b) : false;
      } catch (err) {
        keep = true;   // 出错时把面板留着，让用户看到错误提示
      }
      if (keep === true) return;
      if (typeof keep === 'function') return;   // 让回调自己决定何时关闭
      close();
    });
    actionHost.appendChild(b);
  });
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    // Listeners elsewhere wait for this to learn the sheet went away without
    // an action being taken (backdrop tap, Escape, hardware back). Without it
    // `confirmSheet` and the voice-note prompt hang until something else fires.
    window.dispatchEvent(new CustomEvent('wy:sheet-dismiss'));
  };
  const onKey = (ev) => { if (ev.key === 'Escape' && dismissible) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (ev) => {
    if (ev.target === back && dismissible) close();
  });
  root.appendChild(back);
  if (onMount) onMount({ root: back, close });
  const firstFocusable = back.querySelector('button, [href], input, textarea');
  if (firstFocusable) firstFocusable.focus({ preventScroll: true });
  return close;
}

export function confirmSheet(opts) {
  return new Promise((resolve) => {
    let decided = false;
    openSheet({
      title: opts.title,
      body: opts.body || '',
      actions: [
        {
          label: opts.confirmLabel || t('common.confirm'),
          kind: opts.danger ? 'danger' : 'accent',
          onClick: () => { decided = true; resolve(true); },
        },
        { label: opts.cancelLabel || t('common.cancel'), kind: 'ghost', onClick: () => resolve(false) },
      ],
    });
    window.addEventListener('wy:sheet-dismiss', () => { if (!decided) resolve(false); }, { once: true });
  });
}

/* ------------------------------------------------------------- formatting */

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T'));
  const diff = (Date.now() - then.getTime()) / 1000;
  if (Number.isNaN(diff)) return '';
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hoursAgo', { n: Math.floor(diff / 3600) });
  if (diff < 604800) return t('time.daysAgo', { n: Math.floor(diff / 86400) });
  return then.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
}

export function clockTime(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit' });
}

export function longDate(date) {
  const d = date || new Date();
  return d.toLocaleDateString(intlLocale(), { weekday: 'long', month: 'long', day: 'numeric' });
}

export function prettyDate(iso) {
  if (!iso) return t('time.notSet');
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function shortDate(date) {
  const d = date || new Date();
  return d.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
}

export function initials(name) {
  const n = String(name || '').trim();
  return n ? n[0].toUpperCase() : 'W';
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* ------------------------------------------------------------------- icons */

const ICONS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.9-5A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z"/>',
  home: '<path d="M3 10.6 12 3l9 7.6V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  sparkle: '<path d="M12 3l1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="m5 13 4.5 4.5L19 7"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7 3.7C19 15.6 12 20 12 20z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  moon: '<path d="M20 14.5A8.3 8.3 0 0 1 9.5 4a8.6 8.6 0 1 0 10.5 10.5z"/>',
  wardrobe: '<path d="M5 4.5h14v15H5z"/><path d="M12 4.5v15"/><circle cx="10" cy="11" r=".8"/>',
  room: '<path d="M3.5 20V9.5L12 3l8.5 6.5V20z"/><path d="M9.5 20v-5.5h5V20"/>',
  sound: '<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gift: '<rect x="3.5" y="9" width="17" height="11.5" rx="2"/><path d="M2.5 9h19v4h-19z"/><path d="M12 9v11.5"/><path d="M12 9S9.5 3.5 7 5s1.5 4 5 4c3.5 0 5.5-2.5 3-4s-3 4-3 4z"/>',
  flame: '<path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-1.8.8-3.3 1.7-4.4C9.8 9.9 12 8 12 3z"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14.5 5.5 18 9"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3c0 1-.8 2-2 2A16 16 0 0 1 4.5 5.5c0-1 1-2 2-2z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9"/>',
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z"/>',
};

export function icon(name, cls) {
  const path = ICONS[name] || ICONS.info;
  return raw(`<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${path}</svg>`);
}

/* --------------------------------------------------------------- haptics */

export function haptic(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms || 8);
  } catch (e) { /* unsupported */ }
}