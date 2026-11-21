/* P06 Call (T1/T2/T3), P24 Voice & call settings, P25 Call details, T4 notes.
 *
 * The rules live on the server (`backend/app/voice.py`); this file only draws
 * them. Three screens:
 *
 *   voice        settings + this month's minutes + recent calls + voicemails
 *   call         the live call: ringing → active → ended, in one screen
 *   callDetail   what a finished call cost, and the transcript
 *
 * Two behaviours are worth knowing before reading the code:
 *
 * 1. **The call never trusts the client with money.** Elapsed time is measured
 *    here for display and reported on each turn, but `end_call` recomputes the
 *    bill from what it recorded and clamps it (per-second, 10s minimum, 40%
 *    silence forgiven, soft cap in minor mode). A tampered client cannot buy
 *    free minutes; it can only shorten its own call.
 * 2. **Captions default off.** R-4.4 asks for that: reading along is opt-in.
 *    Because this build has no speech output, the companion's *current* line
 *    is always on screen — there is nothing else to hear — while the toggle
 *    controls the rolling transcript of what was said before. That is a
 *    limitation of the mock, not of the design, and the screen says so.
 */

import { api } from '../api.js';
import { html, raw, icon, toast, openSheet, confirmSheet, clockTime, timeAgo } from '../dom.js';
import { state, route, go, loadSession, mountGuard, parseHash, renderApp } from '../state.js';
import { topbar, loadingBlock } from '../ui.js';
import { t, tf } from '../i18n.js';

function companionName() {
  return state.companion ? state.companion.name : t('chat.companionFallback');
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function minutesLabel(seconds) {
  const m = Math.floor(Math.max(0, seconds || 0) / 60);
  const s = Math.round(Math.max(0, seconds || 0) % 60);
  if (m === 0) return t('voice.minutesShort', { s });
  return t('voice.minutesLong', { m, s });
}

/* ================================================================= voice */

route('voice', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const data = await api.get('/voice');
  const q = data.quota;
  const s = data.settings;
  const name = companionName();
  const calls = data.calls || [];
  const voicemails = data.voicemails || [];

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'profile', eyebrow: t('voice.eyebrow'), title: t('voice.title') })}
      <p class="sub">${t('voice.sub', { name })}</p>

      <div class="voice-quota">
        <div class="row between">
          <span class="eyebrow">${t('voice.quotaTitle')}</span>
          <span class="badge ${q.plan === 'plus' ? 'accent' : ''}">${q.plan === 'plus' ? t('voice.planPlus') : t('voice.planFree')}</span>
        </div>
        <div class="voice-left"><b id="voice-left">${minutesLabel(q.seconds_left)}</b>${t('voice.left')}</div>
        <div class="quota-bars">
          ${q.plan === 'plus' ? quotaBar('plan', t('voice.quotaPlan'), q.plan_seconds_left, q.plan_seconds_total) : ''}
          ${q.plan === 'plus' ? '' : quotaBar('free', t('voice.quotaFree'), q.free_seconds_left, q.free_seconds_total)}
          ${q.pack_seconds_left ? quotaBar('pack', t('voice.quotaPack'), q.pack_seconds_left, q.pack_seconds_left) : ''}
        </div>
        <div class="row mt-12" style="gap:8px;flex-wrap:wrap">
          <button class="btn sm accent" type="button" id="voice-start">${icon('phone')} ${t('voice.startCall', { name })}</button>
          <button class="btn sm ghost" type="button" id="voice-buy">${t('voice.buyPack', { price: (q.pack_price_cents / 100).toFixed(0) })}</button>
        </div>
        <p class="tiny mt-8">${t('voice.buyPackSub')}</p>
      </div>

      <div class="inline-note mt-16">
        <span>${icon('info')}</span>
        <span>${data.authorization.ai_may_call
          ? t('voice.unlockYes', { name })
          : t('voice.unlockNo', { name })}</span>
      </div>

      <div class="settings-group mt-16">
        <div class="setting">
          <span class="label">${t('voice.callsEnabled')}<small>${t('voice.callsEnabledSub')}</small></span>
          <button class="toggle" role="switch" data-vtoggle="calls_enabled"
            aria-checked="${s.calls_enabled ? 'true' : 'false'}"
            aria-label="${t('voice.callsEnabled')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('voice.preferNoCalls')}<small>${t('voice.preferNoCallsSub', { name })}</small></span>
          <button class="toggle" role="switch" data-vtoggle="prefer_no_calls"
            aria-checked="${s.prefer_no_calls ? 'true' : 'false'}"
            aria-label="${t('voice.preferNoCalls')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('voice.captions')}<small>${t('voice.captionsSub')}</small></span>
          <button class="toggle" role="switch" data-vtoggle="captions_enabled"
            aria-checked="${s.captions_enabled ? 'true' : 'false'}"
            aria-label="${t('voice.captions')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('voice.transcriptArchive')}<small>${t('voice.transcriptArchiveSub')}</small></span>
          <button class="toggle" role="switch" data-vtoggle="transcript_archive"
            aria-checked="${s.transcript_archive ? 'true' : 'false'}"
            aria-label="${t('voice.transcriptArchive')}"></button>
        </div>
        <div class="setting">
          <span class="label">${t('voice.minorMode')}<small>${t('voice.minorModeSub')}</small></span>
          <button class="toggle" role="switch" data-vtoggle="minor_mode"
            aria-checked="${s.minor_mode ? 'true' : 'false'}"
            aria-label="${t('voice.minorMode')}"></button>
        </div>
      </div>

      <div class="card sunken mt-16">
        <div class="card-title">${t('voice.limitsTitle')}</div>
        <ul class="voice-rules">
          <li>${t('voice.rule1')}</li>
          <li>${t('voice.rule2')}</li>
          <li>${t('voice.rule3', { name })}</li>
          <li>${t('voice.rule4', { name })}</li>
        </ul>
      </div>

      <div class="section-head"><h2>${t('voice.callsTitle')}</h2><span class="meta">${calls.length}</span></div>
      ${calls.length === 0 ? html`<p class="sub">${t('voice.callsEmpty')}</p>` : html`
        <div class="stack">
          ${calls.map((c) => html`
            <button class="setting" type="button" data-call="${c.id}">
              <span class="label">${c.direction === 'inbound'
                  ? t('voice.callInbound', { name })
                  : t('voice.callOutbound', { name })}
                <small>${timeAgo(c.created_at)} · ${mmss(c.duration_seconds)}</small></span>
              <span class="badge ${c.status === 'missed' ? 'warn' : ''}">${c.status === 'missed'
                ? t('voice.callMissed') : minutesLabel(c.billed_seconds)}</span>
              ${icon('chev', 'chev')}
            </button>`)}
        </div>`}

      <div class="section-head"><h2>${t('voice.voicemailsTitle', { name })}</h2><span class="meta">${voicemails.length}</span></div>
      ${voicemails.length === 0 ? html`<p class="sub">${t('voice.voicemailsEmpty', { name })}</p>` : html`
        <div class="stack">
          ${voicemails.map((v) => html`
            <div class="card voice-mail" data-vid="${v.id}">
              <div class="row between">
                <span class="badge ${v.status === 'unread' ? 'accent' : ''}">${v.status === 'unread'
                  ? t('voice.unread') : v.status === 'replied' ? t('voice.replied') : t('voice.heard')}</span>
                <span class="tiny">${timeAgo(v.created_at)} · ${mmss(v.duration_ms / 1000)}</span>
              </div>
              <p class="card-desc mt-8">${v.script}</p>
              <div class="row mt-12" style="gap:8px">
                <button class="btn sm ghost" type="button" data-vheard="${v.id}">${t('voice.markHeard')}</button>
                <button class="btn sm ghost" type="button" data-vreply="${v.id}">${t('voice.replyByNote')}</button>
              </div>
            </div>`)}
        </div>`}
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => mountVoiceSettings(root),
});

function quotaBar(kind, label, left, total) {
  const pct = total > 0 ? Math.round((left / total) * 100) : 0;
  return html`<div class="quota-row">
    <span class="quota-label">${label}</span>
    <span class="quota-bar"><i class="${kind}" style="width:${pct}%"></i></span>
    <span class="quota-value">${Math.floor(left / 60)}′</span>
  </div>`;
}

function mountVoiceSettings(root) {
  const stillHere = mountGuard();

  root.querySelectorAll('[data-vtoggle]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.getAttribute('data-vtoggle');
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      try {
        // The version is read fresh on each click: two quick toggles in a row
        // would otherwise send the first click's stale version and 409.
        const fresh = await api.get('/voice');
        const updated = await api.patch('/voice/settings',
          { [key]: next, version: fresh.settings.version });
        sw.setAttribute('aria-checked', String(updated[key]));
        toast(t('voice.toastSaved'), 'good');
        if (key === 'minor_mode' && stillHere()) {
          // The 5-minute cap and the 22:00–08:00 rule are enforced server-side;
          // re-render so the visible limits match what will actually happen.
          setTimeout(() => { if (stillHere()) go('voice', { force: true }); }, 220);
        }
      } catch (err) {
        sw.setAttribute('aria-checked', String(!next));
        toast(err.display || err.message || t('voice.toastFail'), 'error');
      }
    });
  });

  root.querySelector('#voice-start').addEventListener('click', () => startNewCall());
  root.querySelector('#voice-buy').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.post('/voice/packs', {});
      const left = document.querySelector('#voice-left');
      if (left && res.quota) left.textContent = minutesLabel(res.quota.seconds_left);
      toast(t('voice.packBought', { minutes: res.minutes }), 'good');
      if (stillHere()) go('voice', { force: true });
    } catch (err) {
      toast(err.display || err.message || t('voice.packFail'), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelectorAll('[data-call]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-call');
      go(`callDetail?id=${encodeURIComponent(id)}`);
    });
  });

  root.querySelectorAll('[data-vheard]').forEach((b) => {
    b.addEventListener('click', async () => {
      const vid = b.getAttribute('data-vheard');
      try {
        await api.patch(`/voicemails/${vid}`, { status: 'heard' });
        const card = root.querySelector(`[data-vid="${vid}"]`);
        const badge = card && card.querySelector('.badge');
        if (badge) { badge.className = 'badge'; badge.textContent = t('voice.heard'); }
        toast(t('voice.toastHeard'), 'good');
      } catch (err) {
        toast(err.display || err.message || t('voice.toastHeardFail'), 'error');
      }
    });
  });

  root.querySelectorAll('[data-vreply]').forEach((b) => {
    b.addEventListener('click', async () => {
      const vid = b.getAttribute('data-vreply');
      try {
        await api.patch(`/voicemails/${vid}`, { status: 'replied' });
        toast(t('voice.toastReplied'), 'good');
        if (stillHere()) go('chat');
      } catch (err) {
        toast(err.display || err.message || t('voice.toastRepliedFail'), 'error');
      }
    });
  });
}

/* ================================================================== call */

/**
 * Live-call state. Module level on purpose: the screen repaints on a language
 * switch, and a switch must not drop the call. `resetCallState()` is what
 * clearing it (sign-out, navigation away) goes through.
 */
let call = null;

export function resetCallState() {
  if (!call) return;
  try { call.tickers.forEach((id) => clearInterval(id)); } catch (e) { /* gone */ }
  call = null;
}

/**
 * Enter the call screen *intending to dial*.
 *
 * `go('call')` on its own is not enough once a call has ended: the route's
 * mount sees the leftover ended session and re-renders the receipt — which is
 * exactly what the in-place repaint after `finishCall()` must do. So "call
 * again" has to be an explicit intent, expressed here by the buttons that mean
 * it, rather than inferred from arriving at the route.
 *
 * A session that is still live is resumed instead of dropped: leaving the call
 * screen mid-call (to change a setting, or a repaint) must not silently leave
 * a billed session open with no way back to it.
 */
export function startNewCall() {
  if (call && (call.status === 'active' || call.status === 'ringing')) {
    go('call', { force: true });
    return;
  }
  resetCallState();
  go('call', { force: true });
}

function stopCall() {
  if (!call) return;
  call.tickers.forEach((id) => clearInterval(id));
  call.tickers = [];
}

route('call', async () => {
  if (!state.me || !state.companion) return html`<div class="screen">${loadingBlock()}</div>`;
  const name = companionName();
  const view = call || { status: 'idle' };
  const ended = view.status === 'ended';

  return html`
  <div class="screen call-screen">
    <div class="call-top">
      <span id="call-top-label">${ended ? t('call.endedTop') : view.status === 'ringing' ? t('call.ringingTop') : t('call.live')}</span>
      <span class="call-elapsed" id="call-elapsed">${view.status === 'ended' ? mmss(view.duration || 0) : '0:00'}</span>
    </div>

    <div class="call-stage">
      <div class="glow"></div>
      <div class="figure"></div>
      <div class="wave" id="call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </div>

    <div class="call-meta">
      <h2>${name}</h2>
      <p id="call-status">${ended
        ? t('call.endedBody', { duration: mmss(view.duration || 0), billed: minutesLabel(view.billed || 0) })
        : view.status === 'ringing' ? t('call.ringing', { name }) : t('call.liveSub')}</p>

      <div class="call-line" id="call-line" aria-live="polite">${escapeText(view.line || '')}</div>

      <div class="call-captions" id="call-captions" ${view.captions ? '' : 'hidden'}>
        ${(view.captions ? view.log || [] : []).map((x) => html`
          <div class="cap ${x.role}"><b>${x.role === 'user' ? t('call.you') : name}</b>${escapeText(x.content)}</div>`)}
      </div>

      <div class="call-actions" id="call-actions">
        ${ended
          ? html`<button type="button" data-go="chat" aria-label="${t('call.backToChat')}">${icon('chat')}</button>
                 <button type="button" id="call-detail" aria-label="${t('call.viewDetail')}">${icon('info')}</button>
                 <button class="end" type="button" data-go="voice" aria-label="${t('common.close')}">${icon('close')}</button>`
          : html`<button type="button" data-mute aria-label="${t('call.mute')}" aria-pressed="${view.muted ? 'true' : 'false'}">${icon('mic')}</button>
                 <button type="button" id="call-captions-toggle" aria-label="${t('call.captions')}" aria-pressed="${view.captions ? 'true' : 'false'}">${icon('chat')}</button>
                 <button class="end" type="button" data-end aria-label="${t('call.end')}">${icon('close')}</button>`}
      </div>

      ${ended ? html`
        <button class="btn accent block lg mt-24" type="button" id="call-detail-cta">${t('call.viewDetail')}</button>`
        : html`
        <form class="call-composer" id="call-composer">
          <input id="call-input" class="field" maxlength="600" autocomplete="off"
            placeholder="${t('call.placeholder', { name })}" aria-label="${t('call.placeholder', { name })}">
          <button class="send" type="submit" id="call-send" aria-label="${t('call.sendAria')}" disabled>${icon('send')}</button>
        </form>`}
      <p class="tiny mt-16" style="color:#7f7c8e;padding:0 20px">${t('call.note')}</p>
    </div>
  </div>`;
}, {
  onMount: (root) => mountCall(root),
});

function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function callElapsed() {
  if (!call || !call.startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
}

/** Repaint just the parts of the call screen that move, never the whole route. */
function paintCall() {
  const line = document.getElementById('call-line');
  const status = document.getElementById('call-status');
  const top = document.getElementById('call-top-label');
  const elapsed = document.getElementById('call-elapsed');
  const wave = document.getElementById('call-wave');
  const caps = document.getElementById('call-captions');
  if (!call) return;
  if (line) line.textContent = call.line || '';
  // The route paints the top label once, at mount, while the call is still
  // ringing. Without this line it kept saying "Calling…" for the whole call —
  // the one piece of chrome that never caught up with the connection.
  if (top) {
    top.textContent = call.status === 'ended' ? t('call.endedTop')
      : call.status === 'ringing' ? t('call.ringingTop') : t('call.live');
  }
  if (elapsed) elapsed.textContent = mmss(call.status === 'ended' ? call.duration : callElapsed());
  if (wave) wave.classList.toggle('silent', Boolean(call.muted));
  if (status && call.status === 'active' && call.warning) status.textContent = call.warning;
  if (caps) {
    caps.hidden = !call.captions;
    if (call.captions) {
      caps.innerHTML = (call.log || []).map((x) => (
        `<div class="cap ${x.role}"><b>${x.role === 'user' ? t('call.you') : companionName()}</b>${escapeText(x.content)}</div>`
      )).join('');
      caps.scrollTop = caps.scrollHeight;
    }
  }
  const toggle = document.getElementById('call-captions-toggle');
  if (toggle) toggle.setAttribute('aria-pressed', call.captions ? 'true' : 'false');
}

function mountCall(root) {
  const name = companionName();
  const input = root.querySelector('#call-input');
  const send = root.querySelector('#call-send');

  if (call && call.status !== 'ended') {
    // Arrived back on the screen mid-call (language switch, or a repaint).
    // Re-attach the timers the previous mount cleared.
    startTickers();
    paintCall();
  } else if (!call) {
    beginCall(root);
  }

  if (input) {
    const sync = () => { send.disabled = !input.value.trim(); };
    input.addEventListener('input', sync);
    root.querySelector('#call-composer').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send.disabled = true;
      sayTurn(text);
    });
    sync();
  }

  const muteBtn = root.querySelector('[data-mute]');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      if (!call) return;
      call.muted = !call.muted;
      muteBtn.setAttribute('aria-pressed', String(call.muted));
      muteBtn.setAttribute('aria-label', call.muted ? t('call.unmute') : t('call.mute'));
      toast(call.muted ? t('call.toastMute') : t('call.toastUnmute'));
      paintCall();
    });
  }

  const capBtn = root.querySelector('#call-captions-toggle');
  if (capBtn) {
    capBtn.addEventListener('click', async () => {
      if (!call) return;
      call.captions = !call.captions;
      paintCall();
      try {
        await api.patch('/voice/settings', { captions_enabled: call.captions });
      } catch (e) { /* the in-call toggle still works for this call */ }
    });
  }

  const endBtn = root.querySelector('[data-end]');
  if (endBtn) {
    endBtn.addEventListener('click', async () => {
      endBtn.disabled = true;
      await finishCall('user_ended');
    });
  }

  // Two ways into the receipt: the icon in the action row and the wide CTA
// underneath it. Both are on screen at once, so both need the handler —
// binding only the first left the more obvious button doing nothing.
  root.querySelectorAll('#call-detail, #call-detail-cta').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (call && call.id) go(`callDetail?id=${encodeURIComponent(call.id)}`);
      else go('voice');
    });
  });

  document.title = call && call.status === 'active'
    ? t('call.docTitleActive', { name }) : t('app.title');
}

async function beginCall(root) {
  call = {
    status: 'ringing', line: '', log: [], muted: false,
    captions: Boolean(state.voiceSettings && state.voiceSettings.captions_enabled),
    tickers: [], startedAt: null, duration: 0, billed: 0, warning: null,
  };
  paintCall();
  try {
    const res = await api.post('/calls', {});
    call.id = res.session.id;
    call.status = 'active';
    call.startedAt = Date.now();
    call.line = res.opener;
    call.log.push({ role: 'assistant', content: res.opener });
    call.softCap = res.soft_cap_seconds || 600;
    call.quota = res.quota;
    if (root.querySelector('#call-status')) {
      root.querySelector('#call-status').textContent = t('call.liveSub');
    }
    paintCall();
    startTickers();
  } catch (err) {
    call = null;
    // 402 = no minutes; 403 = calling is off. Both need an explanation and a
    // way forward, not a dead dark screen.
    openSheet({
      title: t('call.cannotTitle'),
      body: `<p class="sub">${escapeText(err.display || err.message || t('call.cannotBody'))}</p>`,
      actions: [
        { label: t('call.toVoice'), kind: 'accent', onClick: () => { go('voice'); } },
        { label: t('common.close'), kind: 'ghost', onClick: () => { go('space'); } },
      ],
    });
  }
}

function startTickers() {
  if (!call) return;
  stopCall();
  // Clock: cheap, once a second, and only while the screen is mounted.
  call.tickers.push(setInterval(() => {
    if (!call) return;
    if (call.status === 'active') {
      const el = document.getElementById('call-elapsed');
      if (el) el.textContent = mmss(callElapsed());
      checkWarning();
    }
  }, 1000));
  // Silence ladder. This build carries text, not audio, so the "silence" is a
  // pause in typing and the rung is reported rather than the wall time — the
  // server needs the rung to pick 3s / 8s / 15s wording.
  scheduleSilence();
}

function scheduleSilence() {
  if (!call) return;
  if (call.silenceTimer) clearTimeout(call.silenceTimer);
  const rungs = [[8000, 3000], [20000, 8000], [35000, 15000]];
  rungs.forEach(([delay, rung]) => {
    call.tickers.push(setTimeout(() => {
      if (!call || call.status !== 'active' || call.pending) return;
      if (call.lastSpokeAt && call.lastSpokeAt > Date.now() - delay + 1200) return;
      if (call.rungSent && call.rungSent >= rung) return;
      call.rungSent = rung;
      sayTurn('', rung);
    }, delay));
  });
}

async function checkWarning() {
  if (!call || !call.id || call.warned || call.status !== 'active') return;
  if (callElapsed() < 30) return;
  try {
    const w = await api.get(`/calls/${call.id}/warning`);
    if (!w.should_warn) return;
    call.warned = true;
    call.warning = w.near_soft_cap
      ? t('call.wrapUp')
      : t('call.lowMinutes', { left: minutesLabel(w.seconds_left) });
    paintCall();
  } catch (e) { /* a warning is best-effort; end_call still bills correctly */ }
}

async function sayTurn(text, silenceMs) {
  if (!call || !call.id || call.status !== 'active') return;
  call.pending = true;
  const at = callElapsed() * 1000;
  if (text) {
    call.log.push({ role: 'user', content: text });
    call.line = '';
    paintCall();
  }
  try {
    const res = await api.post(`/calls/${call.id}/turns`, {
      text,
      at_ms: at,
      silence_ms: silenceMs || 0,
      elapsed_seconds: callElapsed(),
    });
    call.pending = false;
    call.lastSpokeAt = Date.now();
    call.line = res.reply;
    call.log.push({ role: 'assistant', content: res.reply, kind: res.blocked ? 'safety' : undefined });
    if (res.blocked) call.status = 'active';
    paintCall();
    if (!text) return;
    scheduleSilence();
  } catch (err) {
    call.pending = false;
    if (err.status === 409) return finishCall('ai_ended', { silent: true });
    toast(err.display || err.message || t('call.turnFail'), 'error');
  }
}

async function finishCall(reason, opts) {
  if (!call || !call.id) { go('voice'); return; }
  const duration = callElapsed();
  const snapshot = call;
  stopCall();
  try {
    const res = await api.post(`/calls/${snapshot.id}/end`, {
      duration_seconds: duration,
      silence_seconds: 0,
      end_reason: reason,
    });
    call = {
      ...snapshot, status: 'ended', line: '',
      duration: res.session.duration_seconds, billed: res.session.billed_seconds,
      endedAt: Date.now(),
    };
    if (!opts || !opts.silent) toast(t('call.toastEnded', { duration: mmss(res.session.duration_seconds) }));
  } catch (err) {
    call = { ...snapshot, status: 'ended', duration, billed: 0 };
    toast(err.display || err.message || t('call.endFail'), 'error');
  }
  // Repaint in place rather than re-routing: a route change would re-run
  // `beginCall` and immediately dial again.
  await renderApp();
}

/* ============================================================ call detail */

route('callDetail', async () => {
  if (!state.me) return html`<div class="screen">${loadingBlock()}</div>`;
  const { params } = parseHash();
  const id = params.id;
  if (!id) return html`<div class="screen">${loadingBlock()}</div>`;
  const data = await api.get(`/calls/${encodeURIComponent(id)}`);
  const name = companionName();
  const q = data.quota || {};
  const breakdown = data.billing_detail || [];
  const transcript = data.transcript || [];

  return html`
  <div class="screen">
    <div class="scroll no-nav">
      ${topbar({ back: 'voice', eyebrow: t('callDetail.eyebrow'), title: t('callDetail.title') })}

      <div class="card mt-16">
        <div class="row between">
          <div>
            <div class="eyebrow">${data.direction === 'inbound' ? t('voice.callInbound', { name }) : t('voice.callOutbound', { name })}</div>
            <h2 class="display h3">${data.status === 'missed' ? t('voice.callMissed') : mmss(data.duration_seconds)}</h2>
          </div>
          <span class="badge ${data.status === 'missed' ? 'warn' : 'good'}">${clockTime(data.created_at)}</span>
        </div>
        ${data.end_reason ? html`<p class="card-desc">${tf(`callEnd.${data.end_reason}`, data.end_reason)}</p>` : ''}
      </div>

      <div class="section-head"><h2>${t('callDetail.billed')}</h2></div>
      <div class="settings-group">
        <div class="setting"><span class="label">${t('callDetail.duration')}</span>
          <span class="value">${mmss(data.duration_seconds)}</span></div>
        <div class="setting"><span class="label">${t('callDetail.deducted')}</span>
          <span class="value">${mmss(data.billed_seconds)}</span></div>
        <div class="setting"><span class="label">${t('callDetail.forgiven')}</span>
          <span class="value">${mmss(data.silence_forgiven_seconds || 0)}</span></div>
        <div class="setting"><span class="label">${t('callDetail.remaining')}</span>
          <span class="value">${minutesLabel(q.seconds_left || 0)}</span></div>
      </div>

      ${breakdown.length ? html`
        <div class="section-head"><h2>${t('callDetail.breakdown')}</h2></div>
        <div class="stack">
          ${breakdown.map((b) => html`
            <div class="quota-row">
              <span class="quota-label">${tf(`callSource.${b.source}`, b.source)}</span>
              <span class="quota-bar"><i class="${b.source}"></i></span>
              <span class="quota-value">${mmss(b.seconds)}</span>
            </div>`)}
        </div>` : ''}

      ${data.unfinished_thread ? html`
        <div class="inline-note mt-16">
          <span>${icon('info')}</span>
          <span>${t('callDetail.thread', { thread: data.unfinished_thread })}</span>
        </div>` : ''}

      <div class="section-head"><h2>${t('callDetail.transcript')}</h2>
        ${transcript.length ? html`<button class="btn sm ghost" type="button" id="transcript-delete">${t('callDetail.deleteTranscript')}</button>` : ''}
      </div>
      ${!data.transcript_archived ? html`<p class="sub">${t('callDetail.transcriptOff')}</p>`
        : transcript.length === 0 ? html`<p class="sub">${t('callDetail.transcriptEmpty')}</p>`
        : html`<div class="stack">
            ${transcript.map((x) => html`
              <div class="transcript-line ${x.role}">
                <b>${x.role === 'user' ? t('call.you') : name}</b>
                <span>${x.content}</span>
              </div>`)}
          </div>`}

      <p class="tiny center mt-24">${t('callDetail.recording', { days: data.recording_days_kept || 7 })}</p>
      <div style="height:12px"></div>
    </div>
  </div>`;
}, {
  onMount: (root) => {
    const btn = root.querySelector('#transcript-delete');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const { params } = parseHash();
      const ok = await confirmSheet({
        title: t('callDetail.deleteTitle'),
        body: `<p class="sub">${t('callDetail.deleteBody')}</p>`,
        confirmLabel: t('callDetail.deleteTranscript'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/calls/${encodeURIComponent(params.id)}/transcript`);
        toast(t('callDetail.deleted'), 'good');
        go(`callDetail?id=${encodeURIComponent(params.id)}`, { force: true });
      } catch (err) {
        toast(err.display || err.message || t('callDetail.deleteFail'), 'error');
      }
    });
  },
});