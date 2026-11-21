/* Shared UI pieces: tabbar, headers, state blocks. */

import { html, raw, icon, join } from './dom.js';
import { nav, navLabel, state, go } from './state.js';
import { t } from './i18n.js';

export function tabbar(active) {
  return html`<nav class="tabbar" aria-label="${t('common.mainNav')}">
    ${nav.map((item) => html`
      <button type="button" data-go="${item.id}"
        aria-current="${item.id === active ? 'page' : 'false'}"
        aria-label="${navLabel(item)}">
        ${icon(item.icon)}
        <span>${navLabel(item)}</span>
      </button>`)}
  </nav>`;
}

export function topbar(opts) {
  const o = opts || {};
  return html`<header class="topbar">
    ${o.back ? html`<button class="icon-btn" type="button" data-back="${o.back}"
        aria-label="${t('common.back')}">${icon('back')}</button>` : ''}
    <div class="grow">
      ${o.eyebrow ? html`<div class="eyebrow">${o.eyebrow}</div>` : ''}
      <h1>${o.title || ''}</h1>
      ${o.subline ? html`<div class="subline">${o.subline}</div>` : ''}
    </div>
    ${o.action || ''}
  </header>`;
}

export function emptyState(glyph, title, body, action) {
  return html`<div class="empty">
    <div class="glyph">${raw(glyph || '✦')}</div>
    <h3>${title}</h3>
    <p>${body}</p>
    ${action || ''}
  </div>`;
}

export function loadingBlock(label) {
  return html`<div class="stack" style="padding:24px 0">
    <div class="skeleton" style="height:18px;width:52%"></div>
    <div class="skeleton" style="height:14px;width:78%"></div>
    <div class="skeleton" style="height:14px;width:66%"></div>
    <div class="skeleton" style="height:14px;width:74%"></div>
    ${label ? html`<p class="tiny center mt-16">${label}</p>` : ''}
  </div>`;
}

export function quotaLine(wallet) {
  if (!wallet) return '';
  const used = wallet.replies_today || 0;
  const limit = wallet.daily_limit || 50;
  const left = Math.max(0, limit - used);
  return t('ui.quotaLeft', { left, limit });
}

export function walletPills(wallet) {
  if (!wallet) return '';
  return join([
    raw(`<span class="reward-pill">XP ${wallet.xp}</span>`),
    raw(`<span class="reward-pill lumen">✦ ${wallet.lumen}</span>`),
  ]);
}

/** Attach delegated handlers for data-go / data-back buttons in a subtree. */
export function wireNav(root) {
  root.addEventListener('click', (ev) => {
    const goBtn = ev.target.closest('[data-go]');
    if (goBtn) { go(goBtn.getAttribute('data-go')); return; }
    const backBtn = ev.target.closest('[data-back]');
    if (backBtn) {
      const target = backBtn.getAttribute('data-back');
      if (window.history.length > 1) history.back();
      else go(target);
    }
  });
}

export function banner(kind, text, action) {
  const a = action
    ? html`<button class="b-action" type="button" data-action="${action.id}">${action.label}</button>`
    : '';
  return html`<div class="banner ${kind}">
    <span>${icon(kind === 'warn' ? 'info' : 'sparkle')}</span>
    <span class="grow">${text}</span>${a}
  </div>`;
}

export function subscriptionLabel(sub) {
  if (!sub) return t('sub.free');
  const map = {
    none: 'sub.free', trial: 'sub.trial', active: 'sub.active', grace: 'sub.grace',
    canceled: 'sub.canceled', expired: 'sub.expired',
  };
  return t(map[sub.status] || 'sub.free');
}

export function navTo(name, params) {
  const q = params
    ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  go(name + q);
}