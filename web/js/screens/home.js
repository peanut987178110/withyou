/* P04 Home: hero, today's check-in, little moments. */

import { api } from '../api.js';
import { html, raw, icon, timeAgo } from '../dom.js';
import { state, route, go, loadSession, loadMeta } from '../state.js';
import { tabbar, walletPills, loadingBlock } from '../ui.js';
import { t } from '../i18n.js';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return t('home.greetingQuiet');
  if (h < 12) return t('home.greetingMorning');
  if (h < 18) return t('home.greetingAfternoon');
  return t('home.greetingEvening');
}

export async function fetchActivities() {
  return api.get('/activities');
}

route('home', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock(t('home.opening'))}</div>`;
  if (!state.companion) return html`<div class="screen">
    ${tabbar('home')}
    <div class="scroll">
      <div class="empty">
        <div class="glyph">✦</div>
        <h3>${t('home.noCompanionTitle')}</h3>
        <p>${t('home.noCompanionDesc')}</p>
        <button class="btn accent mt-16" data-go="create">${t('home.createCompanion')}</button>
      </div>
    </div>
  </div>`;

  const [activities, memories] = await Promise.all([
    fetchActivities().catch(() => ({ items: [] })),
    api.get('/memories').catch(() => ({ items: [], proposals: [] })),
  ]);

  const name = state.companion.name;
  const first = (state.me.display_name || t('home.there')).split(' ')[0];
  const mood = (activities.items || []).find((a) => a.kind === 'mood');
  const reflect = (activities.items || []).find((a) => a.kind === 'reflect');
  const moodDone = mood && mood.completed_today > 0;
  const reflectDone = reflect && reflect.completed_today > 0;
  const proposals = (memories.proposals || []).length;
  const level = state.wallet ? state.wallet.level.level : 1;
  const lumen = state.wallet ? state.wallet.lumen : 0;

  return html`
  <div class="screen">
    <div class="scroll">
      <div class="home-hero">
        <div class="hero-nav">
          <span class="wordmark">withyou.</span>
          <button class="icon-btn hero-icon" type="button" data-go="memory"
            aria-label="${t('profile.memoryCenter')}">${icon('sparkle')}</button>
        </div>
        <div class="sun"></div>
        <div class="person"></div>
        <div class="presence">
          <b>${name.toUpperCase()}</b>
          <small><i class="led"></i>${t('home.available')}</small>
        </div>
        <div class="hero-copy">
          <div class="eyebrow">${t('home.heroEyebrow')}</div>
          <h1>${t('home.heroTitle1')}<br>${t('home.heroTitle2')}</h1>
          <p>${t('home.heroBody', { first, name })}</p>
        </div>
      </div>

      <div class="section-head">
        <h2>${t('home.todayWith', { name })}</h2>
        <span class="meta">${greeting()}</span>
      </div>

      ${moodDone
        ? html`<div class="checkin-card done">
            <span class="glyph">☁️</span>
            <div class="copy"><b>${t('home.moodDoneTitle')}</b><small>${t('home.moodDoneDesc')}</small></div>
            <span class="badge good">${t('common.done')}</span>
          </div>`
        : html`<button class="checkin-card" type="button" data-go="mood" style="width:100%;border:0;text-align:left">
            <span class="glyph">☁️</span>
            <div class="copy"><b>${t('home.moodAskTitle')}</b><small>${t('home.moodAskDesc')}</small></div>
            <span class="badge accent">${t('home.checkin')}</span>
          </button>`}

      <div class="section-head">
        <h2>${t('home.littleMoments')}</h2>
        <span class="meta">${t('common.optional')}</span>
      </div>
      <div class="mini-grid">
        <button class="mini-card" type="button" data-go="reflection">
          <span class="glyph">${icon('moon')}</span>
          <div><b>${reflectDone ? t('home.reflectSaved') : t('home.reflectKeep')}</b>
            <small>${reflectDone ? t('home.reflectComeBack') : t('home.reflectDuration')}</small></div>
        </button>
        <button class="mini-card" type="button" data-go="chat">
          <span class="glyph">${icon('chat')}</span>
          <div><b>${t('home.talkWith', { name })}</b><small>${t('home.listening', { name })}</small></div>
        </button>
        <button class="mini-card" type="button" data-go="space">
          <span class="glyph">${icon('room')}</span>
          <div><b>${t('home.sharedSpace')}</b><small>${t('home.roomsWardrobe')}</small></div>
        </button>
        <button class="mini-card" type="button" data-go="rewards">
          <span class="glyph">${icon('bolt')}</span>
          <div><b>${t('home.xpLumen')}</b><small>${t('home.levelLumen', { level, lumen })}</small></div>
        </button>
      </div>

      ${proposals ? html`
        <div class="section-head"><h2>${t('home.waitingForYou')}</h2><span class="meta">${proposals}</span></div>
        <button class="setting" type="button" data-go="memory"
          style="width:100%;background:var(--surface);border:1px solid var(--line-soft);border-radius:18px">
          <span class="grow">
            <span class="label">${t(proposals === 1 ? 'home.suggested.one' : 'home.suggested.other', { name, count: proposals })}
              <small>${t('home.nothingSaved')}</small></span>
          </span>
          ${icon('chev', 'chev')}
        </button>` : ''}

      <div class="section-head"><h2>${t('home.yourSpace')}</h2><span class="meta">${walletPills(state.wallet)}</span></div>
      <div class="card wash">
        <p class="card-desc" style="color:#4c4794">
          ${t('home.aiNotice', { name })}
        </p>
      </div>
      <div style="height:8px"></div>
    </div>
    ${tabbar('home')}
  </div>`;
}, {
  onMount: (root) => {
    root.querySelectorAll('[data-go="chat"]').forEach((b) => {
      b.addEventListener('click', () => go('chat'));
    });
  },
});