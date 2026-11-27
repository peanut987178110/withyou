/* Bootstrap: session, meta, routes, sign-out handling, global nav delegation. */

import { api, getToken, setToken } from './api.js';
import { toast } from './dom.js';
import { state, renderApp, go, loadSession, loadMeta, resetState } from './state.js';
import { t, paintBootText } from './i18n.js';
import { adoptAccountLocale } from './language.js';
import { loadCapabilities } from './audio.js';
import './screens/auth.js';
import './screens/home.js';
import { resetChatState } from './screens/chat.js';
import './screens/discover.js';
import './screens/space.js';
import './screens/profile.js';
import { resetCallState } from './screens/voice.js';

const PUBLIC_ROUTES = new Set(['welcome', 'signup', 'signin', 'age', 'create']);

function currentScreen() {
  return (location.hash || '').replace(/^#\/?/, '').split('?')[0] || '';
}

/** 换账号/退出时把会话级残留一起清掉（聊天里的待定提议属于上一个用户）。 */
export function forgetUserState() {
  resetState();
  resetChatState();
  resetCallState();
}

/* ------------------------------------------------------------- delegation */

document.addEventListener('click', (ev) => {
  const back = ev.target.closest('[data-back]');
  if (back) {
    const fallback = back.getAttribute('data-back');
    if (history.length > 1) history.back();
    else go(fallback || 'home');
    return;
  }
  const nav = ev.target.closest('[data-go]');
  if (nav && !nav.closest('.sheet-backdrop')) {
    go(nav.getAttribute('data-go'));
  }
});

window.addEventListener('wy:signed-out', () => {
  forgetUserState();
  if (!PUBLIC_ROUTES.has(currentScreen())) {
    toast(t('app.signedOut'));
    go('welcome');
  }
});

window.addEventListener('online', () => {
  const bar = document.querySelector('.offline-bar');
  if (bar) bar.remove();
  toast(t('app.backOnline'), 'good');
});
window.addEventListener('offline', () => {
  if (document.querySelector('.offline-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'offline-bar';
  bar.textContent = t('app.offline');
  document.body.prepend(bar);
});

/* --------------------------------------------------------------- routing */

/**
 * Where a session lands after boot.
 *
 * `companion` is a sibling of `user` in the `/auth/me` payload, not a field on
 * it — reading `me.companion` here sent every signed-in reload back to the
 * create flow. Ask `state`, which `loadSession()` has already filled.
 */
function landingFor(me) {
  if (!me) return 'welcome';
  if (!me.age_verified) return 'age';
  if (!state.companion) return 'create';
  return 'home';
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const bootEl = document.getElementById('boot');
  // The static HTML ships an English spinner; the saved (or device) locale is
  // already known by now, so the first thing the user sees should be in it.
  paintBootText();
  await loadMeta().catch(() => null);
  // What this deployment can do with sound is needed by both the call screen
  // and the voice picker. Only ask once there is a session: on a logged-out
  // first run the endpoint answers 401, and that shows up as a failed request
  // that looks like a bug in every report it lands in.
  if (getToken()) loadCapabilities().catch(() => null);

  let me = null;
  if (getToken()) {
    try {
      const data = await loadSession();
      me = data ? data.user : null;
      // 账号上记着的语言只有在设备没选过语言时才生效（见 language.js）。
      if (me && me.locale) adoptAccountLocale(me.locale);
    } catch (err) {
      toast((err && err.message) || t('app.sessionFail'));
    }
  }

  const screen = currentScreen();
  const landing = landingFor(me);

  if (!me && !PUBLIC_ROUTES.has(screen)) {
    location.replace('#/' + landing);
  } else if (me && !me.age_verified && screen !== 'age') {
    location.replace('#/age');
  } else if (me && me.age_verified && !state.companion && !['age', 'create', 'welcome'].includes(screen)) {
    location.replace('#/create');
  } else if (me && state.companion && ['', 'welcome', 'signin', 'signup', 'age', 'create'].includes(screen)) {
    location.replace('#/home');
  }

  if (bootEl) bootEl.remove();
  await renderApp();
}

if (!location.hash) {
  location.replace('#/welcome');
}

boot().catch((err) => {
  const host = document.getElementById('app');
  if (!host) return;
  host.innerHTML = `<div class="screen"><div class="scroll no-nav" style="padding-top:70px">
      <div class="empty"><div class="glyph">✦</div><h3>${t('app.bootTitle')}</h3>
      <p id="boot-msg"></p></div>
      <button class="btn accent block" id="boot-retry">${t('common.tryAgain')}</button>
    </div></div>`;
  const msg = host.querySelector('#boot-msg');
  if (msg) msg.textContent = (err && err.message) || t('app.bootGeneric');
  host.querySelector('#boot-retry').addEventListener('click', () => location.reload());
});