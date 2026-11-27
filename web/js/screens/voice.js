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
import {
  openMic,
  recorderFor,
  createMonitor,
  speak,
  stopSpeaking,
  transcribe,
  blobToBase64,
  caps as audioCaps,
  loadCapabilities,
  speakingMode,
  recordingSupported,
} from '../audio.js';

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
  // The voice list comes from the capabilities probe. Boot fires it, but this
  // screen may be the first thing opened on a cold start, so wait if needed —
  // an empty picker looks like "no voices exist" rather than "still loading".
  if (!audioCaps.loaded) await loadCapabilities();
  // Kept on the shared state so the call screen can honour the captions
  // default without fetching again; it used to be read there and never set.
  state.voiceSettings = s;
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

      <div class="section-head mt-16"><h2>${t('voice.voiceTitle', { name })}</h2></div>
      <p class="sub">${t('voice.voiceSub')}</p>
      <div class="voice-list" id="voice-list">
        ${(audioCaps.tts.voices || []).map((v) => html`
          <div class="voice-option" role="button" tabindex="0" data-voice="${v.id}"
            aria-pressed="${v.id === voiceProfile().voice_id ? 'true' : 'false'}"
            aria-label="${escapeText(v.label)}">
            <span class="name">${escapeText(v.label)}</span>
            <span class="tags">${(v.tags || []).slice(0, 2).join(' · ')}</span>
            <button class="audition" type="button" data-audition="${v.id}">${t('voice.audition')}</button>
          </div>`)}
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

  // --- the voice itself -------------------------------------------------
  // Audition and selection are separate gestures: hearing a voice must not
  // commit to it, or trying three in a row would rewrite the profile twice.
  root.querySelectorAll('[data-audition]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = btn.getAttribute('data-audition');
      const voice = (audioCaps.tts.voices || []).find((v) => v.id === id);
      btn.disabled = true;
      try {
        await speak(t('voice.auditionLine', { name: companionName() }), {
          voiceId: id,
          rate: voice && voice.rate ? voice.rate : 1,
          pitch: 1,
          locale: state.locale,
        });
      } finally {
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll('[data-voice]').forEach((row) => {
    const choose = async () => {
      if (!state.companion) return;
      const id = row.getAttribute('data-voice');
      const profile = { ...voiceProfile(), voice_id: id };
      try {
        const res = await api.patch(`/companions/${state.companion.id}`, {
          voice_profile: profile,
          version: state.companion.version,
        });
        state.companion = res.companion || { ...state.companion, voice_profile: profile };
        root.querySelectorAll('[data-voice]').forEach((x) => {
          x.setAttribute('aria-pressed', String(x.getAttribute('data-voice') === id));
        });
        toast(t('voice.voiceSaved'), 'good');
      } catch (err) {
        toast(err.display || err.message || t('voice.voiceFail'), 'error');
        if (!stillHere()) return;
      }
    };
    row.addEventListener('click', choose);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); }
    });
  });

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
  call.tickers.forEach((id) => {
    try { clearInterval(id); } catch (e) { /* gone */ }
    try { clearTimeout(id); } catch (e) { /* gone */ }
  });
  call.tickers = [];
  clearSilenceTimers();
  // Tear the audio down with the call. A monitor left running keeps the mic
  // indicator on and the device awake after the call has ended.
  if (call.segment) { try { call.segment.cancel(); } catch (e) { /* gone */ } call.segment = null; }
  if (call.monitor) { try { call.monitor.stop(); } catch (e) { /* gone */ } call.monitor = null; }
  if (call.stream) {
    try { call.stream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* gone */ }
    call.stream = null;
  }
  try { stopSpeaking(); } catch (e) { /* nothing playing */ }
}

route('call', async () => {
  if (!state.me || !state.companion) return html`<div class="screen">${loadingBlock()}</div>`;
  const name = companionName();
  const view = call || { status: 'idle' };
  const ended = view.status === 'ended';

  const phase = ended ? 'ended'
    : view.status === 'ringing' ? 'ringing'
      : (view.phase || 'listening');

  return html`
  <div class="screen call-screen" id="call-screen"
    data-phase="${phase}" data-mic="${view.mic || 'unknown'}"
    data-engine="${speakingMode()}">
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
        : view.status === 'ringing' ? t('call.ringing', { name }) : t(`call.phase.${phase}`, { name })}</p>

      ${!ended ? html`<p class="call-notice" id="call-notice" ${view.notice ? '' : 'hidden'}>${escapeText(view.notice || '')}</p>` : ''}

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
  if (wave) {
    wave.classList.toggle('silent', Boolean(call.muted));
    wave.classList.toggle('speaking', call.phase === 'speaking');
    wave.classList.toggle('thinking', call.phase === 'thinking');
  }
  const screen = document.getElementById('call-screen');
  if (screen && call.status !== 'ended') {
    screen.dataset.phase = call.phase || 'listening';
    screen.dataset.mic = call.mic || 'unknown';
  }
  const notice = document.getElementById('call-notice');
  if (notice) {
    notice.textContent = call.notice || '';
    notice.hidden = !call.notice;
  }
  if (status && call.status === 'active' && call.warning) status.textContent = call.warning;
  else if (status && call.status === 'active' && call.phase && !call.warning) {
    status.textContent = t(`call.phase.${call.phase}`, { name: companionName() });
  }
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
      // Mute has to reach the actual track. A boolean that only changes a CSS
      // class looks muted and keeps recording, which is the worst of both.
      if (call.stream) {
        call.stream.getAudioTracks().forEach((tr) => { tr.enabled = !call.muted; });
      }
      if (call.monitor) call.monitor.setMuted(call.muted);
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
    status: 'ringing', phase: 'ringing', line: '', log: [], muted: false,
    captions: Boolean(state.voiceSettings && state.voiceSettings.captions_enabled),
    tickers: [], startedAt: null, duration: 0, billed: 0, warning: null,
    mic: 'unknown', notice: '', interrupted: false,
  };
  paintCall();
  try {
    const res = await api.post('/calls', {});
    call.id = res.session.id;
    call.status = 'active';
    call.phase = 'listening';
    call.startedAt = Date.now();
    call.line = res.opener;
    call.log.push({ role: 'assistant', content: res.opener });
    call.softCap = res.soft_cap_seconds || 600;
    call.quota = res.quota;
    paintCall();
    startTickers();
    // The line is spoken before anything else: a call where the companion's
    // first words are silent for a second and a half reads as a dropped call.
    connectAudio().then(() => speakLine(res.opener));
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

/** Where the companion's voice settings live, resolved once per mount. */
function voiceProfile() {
  const raw = state.companion && state.companion.voice_profile;
  const profile = typeof raw === 'string' ? safeJson(raw) : raw;
  return {
    voice_id: (profile && profile.voice_id) || undefined,
    rate: (profile && profile.rate) || 1,
    pitch: (profile && profile.pitch) || 1,
  };
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * Open the microphone and start watching it.
 *
 * Failure is a state, not an exception: without a mic the call still works as
 * a listening line (you type, they speak), and the screen says which of the
 * two you are in rather than showing a mute-looking waveform.
 */
async function connectAudio() {
  if (!call) return;
  if (!recordingSupported()) {
    call.mic = 'none';
    call.notice = t('call.micNone', { name: companionName() });
    paintCall();
    return;
  }
  const stream = await openMic();
  if (!stream) {
    call.mic = 'denied';
    call.notice = t('call.micDenied', { name: companionName() });
    paintCall();
    return;
  }
  if (!call) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  call.stream = stream;
  call.mic = 'on';
  paintCall();
  call.monitor = createMonitor(stream, {
    onSpeechStart: () => onUserSpeaks(),
    onSpeechEnd: () => finishSegment(),
    onLevel: (level) => {
      const wave = document.getElementById('call-wave');
      if (wave && !call.muted) wave.classList.toggle('loud', level > 0.09);
    },
  });
}

/** The user started talking — either interrupting, or starting a turn. */
function onUserSpeaks() {
  if (!call || call.muted || call.status !== 'active') return;
  if (call.phase === 'speaking') {
    // Barge-in. The companion promised it stops the moment you speak; that is
    // only true if the speaker is actually cancelled.
    bargeIn();
  }
  if (call.phase === 'listening' && !call.segment && call.stream) {
    clearSilenceTimers();
    call.segment = recorderFor(call.stream);
  }
}

/** The user stopped talking: transcribe, then answer. */
async function finishSegment() {
  if (!call || !call.segment) return;
  const rec = call.segment;
  call.segment = null;
  const clip = await rec.stop().catch(() => null);
  if (!call || call.status !== 'active') return;
  if (!clip || clip.ms < 400 || !clip.blob.size) return;

  call.phase = 'thinking';
  paintCall();
  const text = await transcribe(clip.blob, { mime: clip.mime, locale: state.locale });
  if (!call || call.status !== 'active') return;

  if (text === null || !text) {
    // Nothing here can listen. Keep the clip on the turn so the words are not
    // lost, and say plainly that they have to type this one.
    call.unsaid = clip;
    call.notice = t('call.heardNothing');
    call.phase = 'listening';
    paintCall();
    scheduleSilence();
    return;
  }
  call.notice = '';
  await sendTurn(text, clip);
}

function bargeIn() {
  if (!call) return;
  stopSpeaking();
  call.interrupted = true;
  call.phase = 'listening';
  paintCall();
}

/** Say a line, then hand the floor back. */
async function speakLine(text) {
  if (!call || call.status !== 'active' || !text) return;
  if (speakingMode() === 'silent') {
    // Nothing can make sound. Keep the caption and move on; the screen already
    // carries the notice set at connect time.
    if (!call.notice) { call.notice = t('call.silentEngine'); paintCall(); }
    return;
  }
  const profile = voiceProfile();
  call.phase = 'speaking';
  paintCall();
  const result = await speak(text, {
    voiceId: profile.voice_id,
    rate: profile.rate,
    pitch: profile.pitch,
    locale: state.locale,
  });
  if (!call || call.status !== 'active') return;
  if (result.interrupted) return;      // bargeIn already moved the phase
  call.phase = 'listening';
  paintCall();
  scheduleSilence();
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

function clearSilenceTimers() {
  if (!call) return;
  if (call.silenceTimer) {
    try { clearTimeout(call.silenceTimer); } catch (e) { /* gone */ }
  }
  call.silenceTimer = 0;
}

function scheduleSilence() {
  if (!call) return;
  clearSilenceTimers();
  const rungs = [[8000, 3000], [20000, 8000], [35000, 15000]];
  const timer = setTimeout(() => {
    if (!call || call.status !== 'active') return;
    if (call.phase !== 'listening' || call.pending || call.segment) return;
    if (call.lastSpokeAt && call.lastSpokeAt > Date.now() - 6800) return;
    if (call.rungSent && call.rungSent >= 15000) return;
    const rung = (call.rungSent || 0) >= 8000 ? 15000 : (call.rungSent || 0) >= 3000 ? 8000 : 3000;
    call.rungSent = rung;
    sayTurn('', rung);
  }, (call.rungSent || 0) >= 8000 ? 15000 : 12000);
  call.silenceTimer = timer;
  call.tickers.push(timer);
  void rungs;
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

/**
 * One turn: send what the user said (plus their clip), get the reply, say it.
 *
 * `voice` turns the text back into sound before the floor is handed back, so
 * the phase machine reflects what is actually happening — `speaking` while the
 * audio plays, `listening` only once it has finished or been interrupted.
 */
async function sendTurn(text, clip) {
  if (!call || !call.id || call.status !== 'active') return;
  call.pending = true;
  call.phase = 'thinking';
  const at = callElapsed() * 1000;
  if (text) {
    call.log.push({ role: 'user', content: text });
    call.line = '';
    paintCall();
  }
  const payload = {
    text,
    at_ms: at,
    silence_ms: 0,
    elapsed_seconds: callElapsed(),
    interrupted: Boolean(call.interrupted),
  };
  if (clip && clip.blob && clip.blob.size) {
    try {
      payload.audio = await blobToBase64(clip.blob);
      payload.mime = clip.mime || 'audio/webm';
      payload.duration_ms = clip.ms || 0;
    } catch (e) { /* the words matter more than the clip */ }
  }
  call.interrupted = false;
  try {
    const res = await api.post(`/calls/${call.id}/turns`, payload);
    call.pending = false;
    call.lastSpokeAt = Date.now();
    call.line = res.reply;
    call.log.push({ role: 'assistant', content: res.reply, kind: res.blocked ? 'safety' : undefined });
    if (res.memory_used && res.memory_used.length) {
      call.memoryUsed = res.memory_used;
    }
    paintCall();
    if (res.blocked) { call.phase = 'listening'; paintCall(); return; }
    if (!text) {
      // A nudge is spoken too — it is the companion noticing the silence.
      await speakLine(res.reply);
      return;
    }
    await speakLine(res.reply);
  } catch (err) {
    call.pending = false;
    call.phase = 'listening';
    paintCall();
    if (err.status === 409) return finishCall('ai_ended', { silent: true });
    toast(err.display || err.message || t('call.turnFail'), 'error');
    scheduleSilence();
  }
}

/** Kept for the typed fallback (no microphone, or a device without ASR). */
async function sayTurn(text, silenceMs) {
  if (!call || !call.id || call.status !== 'active') return;
  if (!text) {
    if (call.pending) return;
    call.pending = true;
    try {
      const res = await api.post(`/calls/${call.id}/turns`, {
        text: '',
        at_ms: callElapsed() * 1000,
        silence_ms: silenceMs || 0,
        elapsed_seconds: callElapsed(),
      });
      call.pending = false;
      call.line = res.reply;
      call.log.push({ role: 'assistant', content: res.reply, kind: 'nudge' });
      paintCall();
      await speakLine(res.reply);
    } catch (err) {
      call.pending = false;
      if (err.status === 409) return finishCall('ai_ended', { silent: true });
    }
    return;
  }
  const clip = call.unsaid || null;
  call.unsaid = null;
  call.notice = '';
  await sendTurn(text, clip);
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