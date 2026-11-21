/* P09 Space, P10 Wardrobe, P11 Room presets. (The call screen is screens/voice.js.) */

import { api } from '../api.js';
import { html, raw, icon, toast, openSheet } from '../dom.js';
import { state, route, go, loadSession, mountGuard } from '../state.js';
import { tabbar, topbar, loadingBlock } from '../ui.js';
import { t, tf } from '../i18n.js';
import { startNewCall } from './voice.js';

const SCENE_IDS = ['sunlit', 'midnight', 'rainy'];

function currentRoom() {
  return (state.companion && state.companion.room_id) || 'sunlit';
}

function currentOutfit() {
  return (state.companion && state.companion.wardrobe_item) || 'linen_soft';
}

function sceneClass(id) {
  return id === 'sunlit' ? '' : id;
}

function companionName() {
  return state.companion ? state.companion.name : t('space.companionFallback');
}

/* ------------------------------------------------------------------ space */

route('space', () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const room = currentRoom();
  const name = companionName();

  return html`
  <div class="screen">
    <div class="scroll" style="padding-top:0">
      ${topbar({ eyebrow: t('space.eyebrow'), title: t('space.title') })}
      <div class="space-scene ${sceneClass(room)}">
        <div class="window"></div>
        <div class="rain"></div>
        <div class="plant">♧</div>
        <div class="chair"></div>
        <div class="companion"></div>
        <div class="scene-label">
          <div class="eyebrow">${tf(`room.${room}.name`, room)}</div>
          <b>${t('space.with', { name })}</b>
        </div>
      </div>

      <div class="space-actions">
        <button type="button" data-go="wardrobe"><span class="glyph">${icon('wardrobe')}</span>${t('space.wardrobe')}</button>
        <button type="button" data-go="rooms"><span class="glyph">${icon('room')}</span>${t('space.rooms')}</button>
        <button type="button" id="space-call"><span class="glyph">${icon('sound')}</span>${t('space.sounds')}</button>
      </div>

      <div class="section-head"><h2>${t('space.quietTitle')}</h2><span class="meta">${t('space.quietMeta')}</span></div>
      <div class="card">
        <p class="card-desc">
          ${t('space.quietBody', { name })}
        </p>
        <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
          <button class="btn sm ghost" type="button" data-go="chat">${t('space.talkHere')}</button>
          <button class="btn sm ghost" type="button" data-go="reflection">${t('space.reflectHere')}</button>
        </div>
      </div>
      <div style="height:12px"></div>
    </div>
    ${tabbar('space')}
  </div>`;
}, {
  onMount: (root) => {
    // Space's call button means "call", not "open whatever is left of the last
    // call". Routing through `startNewCall` is what makes the second call a
    // call instead of a repaint of the previous receipt.
    const callBtn = root.querySelector('#space-call');
    if (callBtn) callBtn.addEventListener('click', () => startNewCall());
  },
});

/* --------------------------------------------------------------- wardrobe */

route('wardrobe', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const shop = await api.get('/shop').catch(() => ({ items: [], lumen: 0 }));
  const items = shop.items || [];
  const owned = currentOutfit();
  const name = companionName();

  return html`
  <div class="screen wardrobe-page">
    <div class="scroll no-nav">
      ${topbar({ back: 'space', eyebrow: t('wardrobe.eyebrow', { name }), title: t('wardrobe.title') })}
      <div class="stage">
        <div class="portrait">
          <div class="hair"></div><div class="face"></div>
          <div class="body"></div><div class="collar"></div>
        </div>
      </div>

      <div class="row between mt-16">
        <div>
          <div class="eyebrow">${t('wardrobe.everyday')}</div>
          <h2 class="display h3" id="outfit-name">${tf(`outfit.${owned}`, owned)}</h2>
        </div>
        <span class="reward-pill lumen" title="${t('rewards.title')}">✦ ${shop.lumen || 0} Lumen</span>
      </div>
      <p class="sub" id="outfit-desc">${t('wardrobe.sub', { name })}</p>

      <div class="section-head"><h2>${t('wardrobe.heading')}</h2><span class="meta">${t('wardrobe.meta', { count: items.length })}</span></div>
      <div class="stack">
        ${items.map((item) => html`
          <button class="setting" type="button" data-item="${item.id}"
            style="background:var(--surface);border:1px solid ${item.id === owned ? 'var(--accent)' : 'var(--line-soft)'};border-radius:18px">
            <span class="grow">
              <span class="label">${tf(`outfit.${item.id}`, item.name)}
                <small>${tf(`outfit.${item.id}.desc`, item.desc)}</small></span>
            </span>
            ${item.owned
              ? html`<span class="badge ${item.id === owned ? 'accent' : 'good'}">${item.id === owned ? t('wardrobe.wearing') : t('wardrobe.owned')}</span>`
              : html`<span class="badge warn">✦ ${item.price}</span>`}
          </button>`)}
      </div>

      <div class="inline-note mt-16">
        <span>${icon('info')}</span>
        <span>${t('wardrobe.note')}</span>
      </div>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    root.querySelectorAll('[data-item]').forEach((b) => {
      b.addEventListener('click', async () => {
        const itemId = b.getAttribute('data-item');
        const badge = b.querySelector('.badge');
        const isOwned = badge && badge.classList.contains('good') || badge && badge.classList.contains('accent');
        if (!isOwned) {
          const price = badge ? badge.textContent.replace(/[^\d]/g, '') : '';
          const ok = await new Promise((resolve) => {
            openSheet({
              title: t('wardrobe.unlockTitle'),
              body: `<p class="sub">${t('wardrobe.unlockBody', { price })}</p>`,
              actions: [
                { label: t('wardrobe.unlockFor', { price }), kind: 'accent', onClick: () => resolve(true) },
                { label: t('common.notNow'), kind: 'ghost', onClick: () => resolve(false) },
              ],
            });
          });
          if (!ok) return;
          try {
            await api.post(`/shop/${itemId}/purchase`, {});
            toast(t('wardrobe.toastUnlocked'), 'good');
          } catch (err) {
            toast(err.display || err.message || t('wardrobe.toastUnlockFail'), 'error');
            return;
          }
        }
        try {
          await api.patch(`/companions/${state.companion.id}`, {
            wardrobe_item: itemId,
            version: state.companion.version,
          });
          await loadSession();
          const shop = await api.get('/shop').catch(() => null);
          toast(t('wardrobe.toastUpdated'), 'good');
          if (!stillHere()) return;
          const entry = (shop && shop.items || []).find((i) => i.id === itemId);
          const nameEl = document.getElementById('outfit-name');
          if (nameEl && entry) nameEl.textContent = tf(`outfit.${entry.id}`, entry.name);
          root.querySelectorAll('[data-item]').forEach((x) => {
            const bd = x.querySelector('.badge');
            if (!bd) return;
            const id = x.getAttribute('data-item');
            // The row's accent border marks "the set being worn", so it has to
            // move with the badge. Repainting only the badge left the old set
            // outlined in accent after a purchase — the list said "Wearing:
            // Moonlight knit" while the highlight still sat on linen.
            // Set the whole shorthand, not `borderColor`: Chromium serialises a
            // lone border-color by clearing style/width, and the row loses its
            // border entirely.
            x.style.border = `1px solid ${id === itemId ? 'var(--accent)' : 'var(--line-soft)'}`;
            const ownedItem = (shop && shop.items || []).find((i) => i.id === id);
            if (ownedItem && ownedItem.owned) {
              bd.className = 'badge ' + (id === itemId ? 'accent' : 'good');
              bd.textContent = id === itemId ? t('wardrobe.wearing') : t('wardrobe.owned');
            }
          });
          const portrait = root.querySelector('.stage');
          if (portrait) {
            portrait.className = 'stage ' + (itemId === 'moonlight_knit' ? 'midnight'
              : itemId === 'studio_denim' ? 'denim' : itemId === 'garden_shirt' ? 'garden' : '');
          }
        } catch (err) {
          toast(err.display || err.message || t('wardrobe.toastFail'), 'error');
        }
      });
    });
  },
});

/* ------------------------------------------------------------------ rooms */

route('rooms', () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const current = currentRoom();
  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'space', eyebrow: t('rooms.eyebrow'), title: t('rooms.title') })}
      <p class="sub">${t('rooms.sub')}</p>

      <div class="stack mt-24">
        ${SCENE_IDS.map((id) => html`
          <button class="room-card ${id}" type="button" data-room="${id}"
            aria-pressed="${id === current}">
            <b>${tf(`room.${id}.name`, id)}</b>
            <small>${tf(`room.${id}.desc`, '')}</small>
          </button>`)}
      </div>

      <div class="field-error" id="room-error" role="alert" hidden></div>
      <button class="btn accent block lg mt-24" id="room-save">${t('rooms.use')}</button>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const stillHere = mountGuard();
    let chosen = currentRoom();
    root.querySelectorAll('[data-room]').forEach((b) => {
      b.addEventListener('click', () => {
        chosen = b.getAttribute('data-room');
        root.querySelectorAll('[data-room]').forEach((x) => {
          x.setAttribute('aria-pressed', String(x === b));
        });
      });
    });
    root.querySelector('#room-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api.patch(`/companions/${state.companion.id}`, {
          room_id: chosen,
          version: state.companion.version,
        });
        await loadSession();
        toast(t('rooms.toast'), 'good');
        if (stillHere()) go('space');
      } catch (err) {
        const e = root.querySelector('#room-error');
        e.textContent = err.display || err.message || t('rooms.err');
        e.hidden = false;
        btn.disabled = false;
      }
    });
  },
});

/* ------------------------------------------------------------------- call */

/* The real call screen lives in screens/voice.js — it drives the server's
 * billing and trigger rules, so it owns the `call` route. Space hands off to
 * `startNewCall()` above rather than linking to the route: a bare link would
 * reopen the previous call's receipt once a call has ended. */
