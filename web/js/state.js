/* App state + client-side route table. */

import { api, setToken, getToken, ApiFailure } from './api.js';
import { t, onLocaleChange } from './i18n.js';

export const state = {
  me: null,
  meta: null,
  companion: null,
  conversationId: null,
  wallet: null,
  memorySettings: null,
  subscription: null,
  // Read by the call screen for the captions default. It had been referenced
  // there since 2.1 but never assigned anywhere, so captions always started
  // off no matter what the account had saved.
  voiceSettings: null,
  screens: [],
  route: null,
  online: navigator.onLine !== false,
  bootError: null,
  demoMode: false,
};

/**
 * Tab labels are resolved on every render rather than baked into this array:
 * `nav` is read by `tabbar()` on each paint, so a language change is picked up
 * by the next paint without rebuilding the array.
 */
export const nav = [
  { id: 'home', key: 'nav.home', icon: 'home' },
  { id: 'chat', key: 'nav.chat', icon: 'chat' },
  { id: 'discover', key: 'nav.discover', icon: 'compass' },
  { id: 'space', key: 'nav.space', icon: 'sparkle' },
  { id: 'profile', key: 'nav.profile', icon: 'user' },
];

export function navLabel(item) {
  return t(item.key || `nav.${item.id}`);
}

const ROUTES = new Map();
export function route(name, render, opts) {
  ROUTES.set(name, { render, opts: opts || {} });
}

export function currentRoute() {
  return state.route;
}

export function parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [name, query] = raw.split('?');
  const params = {};
  if (query) {
    for (const part of query.split('&')) {
      const [k, v] = part.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { name: name || 'home', params };
}

let rendering = false;
let repaintQueued = false;
let paintSeq = 0;

export async function renderApp() {
  // A render is asynchronous (each screen may fetch). A navigation that lands
  // mid-flight must not be dropped: remember it and run again afterwards.
  if (rendering) { repaintQueued = true; return; }
  rendering = true;
  try {
    do {
      repaintQueued = false;
      await paintOnce();
    } while (repaintQueued);
  } finally {
    rendering = false;
  }
}

/**
 * Call from an `onMount` handler to learn whether this screen is still the one
 * on display. Async handlers await network calls; by the time they resume the
 * user may have navigated away, and a late `go()` would yank them back.
 */
export function mountGuard() {
  const seq = paintSeq;
  return () => seq === paintSeq;
}

async function paintOnce() {
  const host = document.getElementById('app');
  const { name } = parseHash();
  state.route = name;
  const entry = ROUTES.get(name) || ROUTES.get('home');
  // Guard on every paint, not just at boot: a token can expire or be removed
  // while the app is open, and hash navigation alone does not reload the page.
  const PUBLIC = new Set(['welcome', 'signup', 'signin', 'age', 'create']);
  if (!PUBLIC.has(name) && !getToken()) {
    if (location.hash !== '#/welcome') location.replace('#/welcome');
    return;
  }
  try {
    const out = await entry.render();
    // The awaiting render may have raced a newer navigation; never paint stale.
    paintSeq += 1;
    host.innerHTML = '';
    if (typeof out === 'string') {
      const t = document.createElement('template');
      t.innerHTML = out;
      host.appendChild(t.content);
    } else if (out) {
      host.appendChild(out);
    }
    if (entry.opts && entry.opts.onMount) entry.opts.onMount(host);
    const scrollables = host.querySelectorAll('.scroll, .chat-body');
    scrollables.forEach((s) => s.addEventListener('scroll', () => {
      const bar = host.querySelector('.topbar');
      if (bar) bar.classList.toggle('scrolled', s.scrollTop > 4);
    }, { passive: true }));
    if (entry.opts && entry.opts.focus) {
      const target = host.querySelector(entry.opts.focus);
      if (target) target.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  } catch (err) {
    host.innerHTML = '';
    host.appendChild(errorScreen(err));
  }
}

function errorScreen(err) {
  const wrap = document.createElement('div');
  wrap.className = 'screen';
  const msg = (err && (err.display || err.message)) || t('state.somethingWrong');
  wrap.innerHTML = `<div class="scroll no-nav" style="padding-top:60px">
      <div class="empty">
        <div class="glyph">✦</div>
        <h3>${t('state.errorTitle')}</h3>
        <p></p>
      </div>
      <button class="btn accent block" id="retry">${t('common.tryAgain')}</button>
    </div>`;
  wrap.querySelector('p').textContent = msg;
  wrap.querySelector('#retry').addEventListener('click', () => renderApp());
  return wrap;
}

export function go(path, opts) {
  const target = `#/${path}`;
  if (location.hash === target) {
    if (opts && opts.force) renderApp();
    return;
  }
  history.pushState(null, '', target);
  renderApp();
}

export function back(fallback) {
  if (history.length > 1) history.back();
  else go(fallback || 'home');
}

export async function loadSession() {
  if (!getToken()) {
    state.me = null;
    return null;
  }
  try {
    const data = await api.get('/auth/me');
    state.me = data.user;
    state.companion = data.companion;
    state.conversationId = data.conversation_id;
    state.wallet = data.wallet;
    state.memorySettings = data.memory_settings;
    state.subscription = data.subscription;
    return data;
  } catch (err) {
    if (err instanceof ApiFailure && (err.status === 401 || err.status === 410)) {
      setToken(null);
      state.me = null;
      return null;
    }
    throw err;
  }
}

export async function loadMeta() {
  if (state.meta) return state.meta;
  state.meta = await api.get('/meta');
  return state.meta;
}

export function levelLabel(level) {
  const idx = Math.max(1, Math.min(5, level || 1));
  return t(`level.${idx}`);
}

export function needsOnboarding() {
  if (!state.me) return true;
  if (!state.me.age_verified) return true;
  return !state.companion;
}

export function resetState() {
  state.me = null;
  state.companion = null;
  state.conversationId = null;
  state.wallet = null;
  state.memorySettings = null;
  state.subscription = null;
  state.demoMode = false;
}

window.addEventListener('hashchange', () => renderApp());
window.addEventListener('popstate', () => renderApp());

/**
 * A language change must repaint everything: every string on screen came from
 * `t()` at paint time. Re-running the router is the whole mechanism — no
 * reload, no per-node bookkeeping, and the current route survives.
 */
onLocaleChange(() => { renderApp(); });