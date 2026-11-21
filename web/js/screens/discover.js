/* P07 Discover / P08 Reflection / mood check-in / rewards. */

import { api, idempotentPost } from '../api.js';
import { html, raw, icon, toast, openSheet } from '../dom.js';
import { state, route, go, loadSession, mountGuard } from '../state.js';
import { tabbar, topbar, loadingBlock, walletPills } from '../ui.js';
import { t, tf } from '../i18n.js';

/* --------------------------------------------------------------- discover */

/**
 * The catalog is keyed by dictionary keys, not by literal text: the tab names
 * and every card are resolved at paint time, and the chat seed is stored under
 * its English canonical form (it is fed to the model, not shown).
 */
const CATALOG = [
  {
    tabKey: 'discover.tabForYou',
    items: [
      { glyph: '◌', titleKey: 'discover.item1Title', descKey: 'discover.item1Desc', go: 'mood' },
      { glyph: '♧', titleKey: 'discover.item2Title', descKey: 'discover.item2Desc', go: 'chat', seed: 'discover.seed1' },
      { glyph: '✦', titleKey: 'discover.item3Title', descKey: 'discover.item3Desc', go: 'reflection' },
    ],
  },
  {
    tabKey: 'discover.tabGames',
    items: [
      { glyph: '⌘', titleKey: 'discover.item4Title', descKey: 'discover.item4Desc', go: 'chat', seed: 'discover.seed2' },
      { glyph: '▧', titleKey: 'discover.item5Title', descKey: 'discover.item5Desc', go: 'chat', seed: 'discover.seed3' },
    ],
  },
  {
    tabKey: 'discover.tabStories',
    items: [
      { glyph: '☾', titleKey: 'discover.item6Title', descKey: 'discover.item6Desc', go: 'chat', seed: 'discover.seed4' },
      { glyph: '❋', titleKey: 'discover.item7Title', descKey: 'discover.item7Desc', go: 'reflection' },
    ],
  },
];

const SEEDS = {
  'discover.seed1': 'Let’s make a story. A rainy cabin, one warm lamp.',
  'discover.seed2': 'Let’s play twenty questions. You think of something.',
  'discover.seed3': 'Two truths and something small I’m looking forward to.',
  'discover.seed4': 'Tell me a slow story set on a midnight train.',
};

route('discover', () => {
  const name = state.companion ? state.companion.name : t('chat.companionFallback');
  return html`
  <div class="screen">
    <div class="scroll" id="discover-scroll">
      ${topbar({ eyebrow: t('discover.eyebrow'), title: t('discover.title') })}
      <p class="sub">${t('discover.sub')}</p>

      <button class="featured" type="button" data-go="reflection">
        <div class="eyebrow">${t('discover.featuredEyebrow')}</div>
        <h3>${t('discover.featuredTitle1')}<br>${t('discover.featuredTitle2')}</h3>
        <span class="go">${t('discover.startMoment')} ${icon('chev')}</span>
      </button>

      <div class="tabs" role="tablist">
        ${CATALOG.map((c, i) => html`<button type="button" role="tab" data-tab="${i}"
          aria-selected="${i === 0 ? 'true' : 'false'}">${t(c.tabKey)}</button>`)}
      </div>
      <div id="tab-body"></div>
      <div style="height:12px"></div>
    </div>
    ${tabbar('discover')}
  </div>`;
}, {
  onMount: (root) => {
    const host = root.querySelector('#tab-body');
    const name = state.companion ? state.companion.name : t('chat.companionFallback');
    const paint = (index) => {
      host.innerHTML = '';
      for (const item of CATALOG[index].items) {
        const btn = document.createElement('button');
        btn.className = 'list-item';
        btn.type = 'button';
        btn.innerHTML = `<span class="glyph">${item.glyph}</span>
          <span class="copy"><b></b><small></small></span>
          <span class="chev">›</span>`;
        btn.querySelector('b').textContent = t(item.titleKey, { name });
        btn.querySelector('small').textContent = t(item.descKey, { name });
        btn.addEventListener('click', () => {
          if (item.seed) {
            // Seed the composer with the language's own wording; the model
            // reads the user's language, not the English canonical string.
            try { sessionStorage.setItem('wy_seed', t(item.seed, { name })); } catch (e) { /* ignore */ }
          }
          go(item.go);
        });
        host.appendChild(btn);
      }
    };
    paint(0);
    root.querySelectorAll('[data-tab]').forEach((b) => {
      b.addEventListener('click', () => {
        root.querySelectorAll('[data-tab]').forEach((x) => {
          x.setAttribute('aria-selected', String(x === b));
        });
        paint(Number(b.getAttribute('data-tab')));
      });
    });
  },
});

/* --------------------------------------------------------------- mood */

let lastMood = null;

route('mood', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const data = await api.get('/activities');
  const moods = data.moods || [];
  const mood = (data.items || []).find((a) => a.id === 'daily_mood_v1');
  const done = mood && mood.completed_today > 0;

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'home', eyebrow: t('mood.eyebrow'), title: t('mood.title') })}
      <p class="sub">${t('mood.sub')}</p>

      ${done ? html`<div class="card mt-24">
        <div class="card-title">${t('mood.alreadyTitle')}</div>
        <p class="card-desc">${t('mood.alreadyDesc')}</p>
      </div>` : html`
      <div class="mood-grid" id="mood-grid">
        ${moods.map((m) => html`<button class="mood" type="button" data-mood="${m.id}"
          aria-pressed="false"><span class="glyph">${m.emoji}</span>${tf(`moodlabel.${m.id}`, m.label)}</button>`)}
      </div>

      <div class="card wash">
        <div class="row between">
          <div>
            <div class="card-title" style="color:#3f3a72">${t('mood.checkingTitle')}</div>
            <p class="card-desc" style="color:#4c4794">${t('mood.rewardLine', { xp: mood ? mood.xp : 10, lumen: mood ? mood.lumen : 5 })}</p>
          </div>
          ${walletPills(data.wallet)}
        </div>
      </div>

      <div class="field-error" id="mood-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="mood-save" disabled>${t('mood.save')}</button>`}
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    const grid = root.querySelector('#mood-grid');
    if (!grid) return;
    const save = root.querySelector('#mood-save');
    const error = root.querySelector('#mood-error');

    grid.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mood]');
      if (!b) return;
      lastMood = b.getAttribute('data-mood');
      grid.querySelectorAll('[data-mood]').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b));
      });
      save.disabled = false;
    });

    save.addEventListener('click', async () => {
      if (!lastMood) return;
      save.disabled = true;
      save.textContent = t('common.saving');
      try {
        const result = await idempotentPost('/activities/daily_mood_v1/completions', {
          rule_version: '2026-11-18.1',
          answers: { mood: lastMood },
        });
        await loadSession();
        toast(rewardText(result), 'good');
        if (stillHere()) go('home');
      } catch (err) {
        error.textContent = err.display || err.message || t('mood.err');
        error.hidden = false;
        save.disabled = false;
        save.textContent = t('mood.save');
      }
    });
  },
});

export function rewardText(result) {
  const parts = ((result && result.rewards) || []).map((r) => `${r.amount} ${r.type.toUpperCase()}`);
  return parts.length ? t('mood.saved', { rewards: parts.join(' + ') }) : t('mood.savedPlain');
}

/* ----------------------------------------------------------- reflection */

route('reflection', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const data = await api.get('/activities');
  const activity = (data.items || []).find((a) => a.id === 'daily_reflect_v1');
  const done = activity && activity.completed_today > 0;

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'discover', eyebrow: t('reflection.eyebrow'), title: '' })}
      <div class="reflection-hero">
        <div class="glyph">${icon('moon')}</div>
        <h2 class="display h2">${t('reflection.title')}</h2>
        <p class="sub">${t('reflection.sub')}</p>
      </div>

      ${done ? html`<div class="card">
        <div class="card-title">${t('reflection.savedTitle')}</div>
        <p class="card-desc">${t('reflection.savedDesc')}</p>
      </div>` : html`
      <label class="field-label" for="reflect-text">${t('reflection.label')}</label>
      <textarea class="field" id="reflect-text" maxlength="280"
        placeholder="${t('reflection.placeholder')}"></textarea>
      <div class="word-count" id="reflect-count">0 / 280</div>

      <div class="card wash mt-16">
        <div class="row between">
          <div>
            <div class="card-title" style="color:#3f3a72">${t('reflection.rewardTitle')}</div>
            <p class="card-desc" style="color:#4c4794">${t('mood.rewardLine', { xp: activity ? activity.xp : 15, lumen: activity ? activity.lumen : 5 })}</p>
          </div>
          ${walletPills(data.wallet)}
        </div>
      </div>

      <div class="field-error" id="reflect-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="reflect-save" disabled>${t('reflection.save')}</button>
      <button class="btn link block mt-8" type="button" data-go="home">${t('reflection.skip')}</button>`}
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    const area = root.querySelector('#reflect-text');
    if (!area) return;
    const count = root.querySelector('#reflect-count');
    const save = root.querySelector('#reflect-save');
    const error = root.querySelector('#reflect-error');

    area.addEventListener('input', () => {
      count.textContent = `${area.value.length} / 280`;
      count.classList.toggle('over', area.value.length > 280);
      save.disabled = !area.value.trim() || area.value.length > 280;
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = t('common.saving');
      try {
        const result = await idempotentPost('/activities/daily_reflect_v1/completions', {
          rule_version: '2026-11-18.1',
          answers: { text: area.value.trim() },
        });
        await loadSession();
        toast(rewardText(result), 'good');
        if (stillHere()) go('home');
      } catch (err) {
        error.textContent = err.display || err.message || t('reflection.err');
        error.hidden = false;
        save.disabled = false;
        save.textContent = t('reflection.save');
      }
    });
  },
});

/* --------------------------------------------------------------- rewards */

route('rewards', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const [activities, ledger] = await Promise.all([
    api.get('/activities'),
    api.get('/wallet/ledger?limit=30'),
  ]);
  const w = activities.wallet || {};
  const info = w.level || { level: 1, name: t('level.1'), progress: 0, next_at: 100 };
  const items = activities.items || [];

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'profile', eyebrow: t('rewards.eyebrow'), title: t('rewards.title') })}

      <div class="card mt-16">
        <div class="row between">
          <div>
            <div class="card-title">${t('rewards.levelLine', { level: info.level, name: tf(`level.${info.level}`, info.name) })}</div>
            <p class="card-desc">${info.next_at
              ? t('rewards.xpToNext', { xp: w.xp || 0, n: info.next_at - (w.xp || 0) })
              : t('rewards.xpTop', { xp: w.xp || 0 })}</p>
          </div>
          <span class="reward-pill lumen">✦ ${w.lumen || 0}</span>
        </div>
        <div class="xp-bar mt-12"><i style="width:${Math.round((info.progress || 0) * 100)}%"></i></div>
      </div>

      <div class="section-head"><h2>${t('rewards.todayActivities')}</h2><span class="meta">${t('rewards.oncePerDay')}</span></div>
      <div class="stack">
        ${items.map((a) => html`
          <div class="task-card">
            <div class="head">
              <div>
                <h3>${tf(`activity.${a.id}.title`, a.title)}</h3>
                <p>${tf(`activity.${a.id}.desc`, a.desc)}</p>
              </div>
              <span class="badge ${a.available ? 'good' : ''}">${a.completed_today}/${a.daily_limit}</span>
            </div>
            <div class="rewards">
              ${a.xp ? html`<span class="reward-pill">+${a.xp} XP</span>` : ''}
              ${a.lumen ? html`<span class="reward-pill lumen">+${a.lumen} Lumen</span>` : ''}
            </div>
            <button class="btn sm ${a.available ? 'accent' : 'ghost'} block mt-12" type="button"
              data-activity="${a.id}" ${a.available ? '' : 'disabled'}>
              ${a.available ? (a.kind === 'chat' ? t('rewards.goChat') : a.kind === 'mood' ? t('rewards.checkIn') : t('rewards.reflect'))
                : a.remaining > 0 ? t('rewards.keepChatting') : t('rewards.backTomorrow')}
            </button>
          </div>`)}
      </div>

      <div class="section-head"><h2>${t('rewards.recent')}</h2><span class="meta">${(ledger.items || []).length}</span></div>
      <div class="card">
        ${(ledger.items || []).length === 0
          ? html`<p class="card-desc">${t('rewards.none')}</p>`
          : (ledger.items || []).map((r) => html`
            <div class="ledger-row">
              <span class="grow">
                <b style="font-size:13px">${prettySource(r.source)}</b>
                <small class="tiny" style="display:block">${r.created_at.slice(0, 16).replace('T', ' ')}</small>
              </span>
              <span class="amt ${r.amount > 0 ? 'pos' : 'neg'} ${r.kind}">
                ${r.amount > 0 ? '+' : ''}${r.amount} ${r.kind === 'xp' ? 'XP' : '✦'}
              </span>
            </div>`)}
      </div>

      <div class="inline-note mt-16">
        <span>${icon('info')}</span>
        <span>${t('rewards.note')}</span>
      </div>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    root.querySelectorAll('[data-activity]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-activity');
        if (id === 'daily_mood_v1') go('mood');
        else if (id === 'daily_reflect_v1') go('reflection');
        else go('chat');
      });
    });
  },
});

function prettySource(source) {
  const map = {
    daily_mood_v1: 'rewards.sourceMood',
    daily_reflect_v1: 'rewards.sourceReflect',
    chat_session_v1: 'rewards.sourceChat',
    onboarding_v1: 'rewards.sourceOnboarding',
  };
  if (map[source]) return t(map[source]);
  if (String(source).startsWith('shop:')) {
    const item = source.slice(5);
    return t('rewards.sourceWardrobe', { item: tf(`outfit.${item}`, item.replace(/_/g, ' ')) });
  }
  return t('rewards.sourceReward');
}