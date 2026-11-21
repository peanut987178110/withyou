/* P05 Chat: interleaved streaming, per-reply stop, regenerate, proposals, feedback.
 *
 * Each outgoing message owns its own reply. Sending does not take over the
 * composer or a shared "typing" slot: the new message gets its own placeholder
 * directly beneath it, and that placeholder fills in on its own stream. So
 * three quick messages produce
 *
 *     you  ▸ reply 1
 *     you  ▸ reply 2
 *     you  ▸ reply 3
 *
 * instead of three questions followed by three replies stacked at the bottom.
 * There is no global `pending` slot to overwrite and no `#typing-host` to
 * clear — the old design wiped the first reply's node the moment a second
 * message was sent, which is exactly what the screen used to show.
 */

import { api, streamMessage } from '../api.js';
import { html, raw, icon, toast, clockTime, shortDate, openSheet } from '../dom.js';
import { state, route, go, loadSession } from '../state.js';
import { tabbar, loadingBlock } from '../ui.js';
import { t } from '../i18n.js';

/** Dictionary keys, resolved at paint time so a language switch re-labels them. */
const SUGGESTION_KEYS = ['chat.suggest1', 'chat.suggest2', 'chat.suggest3', 'chat.suggest4'];

/** Replies currently streaming, across remounts. `resetChatState` aborts them. */
const turns = new Set();
let turnSeq = 0;
let proposals = [];   // proposals currently on screen
/** Voice notes for the open conversation, keyed by the message they replace. */
const notes = new Map();

/**
 * 账号切换时必须清空这些模块级的残留。
 *
 * 它们绑的是"上一个用户"的提议和正在生成的回复：退出登录后不清，
 * 下一个账号的聊天页会画出别人的待确认记忆，点下去只会 404 —— 而且这属于
 * 跨账号看到别人的数据。`app.js` 在 wy:signed-out 时会调它。
 * 正在流式接收的回复也要一并掐掉，否则它们会继续往已经换人的界面上写。
 */
export function resetChatState() {
  for (const turn of turns) {
    try { turn.controller.abort(); } catch (e) { /* already done */ }
  }
  turns.clear();
  proposals = [];
  notes.clear();
  // A note can still be recording or playing when the user signs out; both
  // hold a live media resource that outlives the screen it belonged to.
  if (recorder) { try { recorder.rec.stop(); } catch (e) { /* gone */ } recorder = null; }
}

function bubbleClass(msg) {
  const cls = ['msg', msg.role === 'user' ? 'me' : 'ai'];
  return cls.join(' ');
}

function bodyFor(msg) {
  return msg.content || '';
}

function assistantMeta(msg) {
  if (msg.status === 'canceled') return html`<span>${t('chat.metaStopped')}</span>`;
  if (msg.status === 'blocked') return html`<span>${t('chat.metaSafety')}</span>`;
  return html`<span>${clockTime(msg.created_at)}</span>`;
}

function messageNode(msg) {
  const safety = msg.safety_level && msg.safety_level !== 'S0';
  const pending = msg.role !== 'user' && (msg.status === 'accepted' || msg.status === 'generating');
  // A voice note replaces its own text bubble. Rendering both would show the
  // same sentence twice, which is what makes people distrust transcription.
  const note = msg.role === 'user' ? notes.get(msg.id) : null;
  return `<div class="${bubbleClass(msg)}${pending ? ' generating' : ''}${note ? ' has-note' : ''}" data-mid="${msg.id}"
      data-status="${msg.status || 'completed'}">
    <div class="bubble ${safety ? 'safety' : ''}">${pending
      ? `<span class="typing"><i></i><i></i><i></i></span>`
      : note ? voiceBubble(note) : escapeText(bodyFor(msg))}</div>
    <div class="meta">${pending
      ? `<span>${escapeText(t('chat.thinking'))}</span>`
      : assistantMeta(msg)}</div>
  </div>`;
}

/**
 * A playable voice note. The duration comes from the server, not from the
 * media element, so the label is right before the audio has loaded.
 */
function voiceBubble(note) {
  const secs = Math.max(1, Math.round((note.duration_ms || 0) / 1000));
  return `<div class="voice-note" data-note="${note.id}">
    <button class="play" type="button" data-note-play="${note.id}" aria-label="${t('voice.notePlay')}">${icon('play')}</button>
    <span class="track"><i></i></span>
    <span class="dur">${t('voice.minutesShort', { s: secs })}</span>
    <button class="del" type="button" data-note-del="${note.id}" aria-label="${t('voice.noteDelete')}">${icon('close')}</button>
  </div>${note.transcript
    ? `<span class="note-transcript">${escapeText(note.transcript)}</span>` : ''}`;
}

function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function messageActions(msg) {
  if (msg.role !== 'assistant') return '';
  const rating = state.feedback && state.feedback[msg.id];
  return html`<button type="button" data-act="regen" data-mid="${msg.id}"
      aria-label="${t('chat.regenAria')}">${icon('refresh')} ${t('common.again')}</button>
    <button type="button" data-act="copy" data-mid="${msg.id}" aria-label="${t('chat.copyAria')}">${icon('copy')} ${t('common.copy')}</button>
    <button type="button" data-act="down" data-mid="${msg.id}"
      class="${rating === 'down' ? 'on' : ''}" aria-label="${t('chat.down')}">${t('chat.down')}</button>
    <button type="button" data-act="report" data-mid="${msg.id}" aria-label="${t('common.report')}">${icon('flag')} ${t('common.report')}</button>`;
}

/* ---------------------------------------------------------------- clipboard */

/**
 * Copy text, with a fallback that actually works inside an Android WebView.
 *
 * `navigator.clipboard` is only exposed in a secure context. The APK serves the
 * UI from `http://localhost`, and Chrome does treat localhost as secure, but the
 * async clipboard API additionally requires document focus — inside a Capacitor
 * WebView the document is often not focused when a tap lands, so writeText
 * rejects with "Document is not focused". The execCommand path has no such
 * requirement, so try it after the modern API fails.
 */
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------- proposals */

function proposalCard(p) {
  return `<div class="proposal-card" data-pid="${p.id}">
    <div class="eyebrow">${escapeText(p.category || t('chat.categoryFallback'))} · ${t('chat.proposalSuggested')}</div>
    <p>${escapeText(p.text)}</p>
    <div class="proposal-actions">
      <button class="btn sm soft" type="button" data-pact="confirm" data-pid="${p.id}">${t('chat.rememberThis')}</button>
      <button class="btn sm ghost" type="button" data-pact="session_only" data-pid="${p.id}">${t('chat.justThisChat')}</button>
      <button class="btn sm ghost" type="button" data-pact="reject" data-pid="${p.id}">${t('chat.forgetIt')}</button>
    </div>
  </div>`;
}

export async function decideProposal(pid, decision, root) {
  try {
    const result = await api.post(`/memory-proposals/${pid}/decision`, { decision });
    // 服务端已经关掉的提议，本地也不能再留着 —— 它会随下一次渲染画回聊天页，
    // 而点它必然 404（"Proposal not found."）。
    proposals = proposals.filter((x) => x.id !== pid);
    const card = root && root.querySelector(`.proposal-card[data-pid="${pid}"]`);
    if (card) {
      const label = decision === 'confirm' ? t('chat.savedConfirm')
        : decision === 'session_only' ? t('chat.savedSession')
        : t('chat.savedNone');
      card.outerHTML = `<div class="proposal-card done" data-pid="${pid}">
        <div class="eyebrow">${decision === 'confirm' ? t('chat.labelConfirmed') : t('chat.labelNotSaved')}</div>
        <p>${escapeText(card.querySelector('p').textContent)} — ${label}</p>
      </div>`;
    }
    await loadSession().catch(() => {});
    if (decision === 'confirm') toast(t('chat.toastConfirmed'), 'good');
  } catch (err) {
    // 提议已经不在（别的标签页/设备上处理过，或已过期）：移除这张卡，
    // 而不是留一张点不动的死卡片。
    if (err && (err.status === 404 || err.status === 409)) {
      proposals = proposals.filter((x) => x.id !== pid);
      const stale = root && root.querySelector(`.proposal-card[data-pid="${pid}"]`);
      if (stale) stale.remove();
      toast(t('chat.toastAlready'), 'error');
      await loadSession().catch(() => {});
      return;
    }
    toast(err.display || err.message || t('chat.toastDecideFail'), 'error');
  }
}

/* ---------------------------------------------------------------- screen */

route('chat', async () => {
  if (!state.me || !state.conversationId) {
    return html`<div class="screen">${tabbar('chat')}${loadingBlock(t('chat.opening'))}</div>`;
  }
  const data = await api.get(`/conversations/${state.conversationId}/messages?limit=50`);
  const msgs = data.items || [];
  // 每次进聊天都以后端为准重取待定提议：模块级的 `proposals` 只是**本次会话**
  // 的增量，绝不能作为"现在还有哪些提议"的真相来源 —— 否则退出再进来就会
  // 画出已经决定过的卡片，点下去只得到 404。
  const live = await api.get('/memories').catch(() => null);
  if (live) proposals = (live.proposals || []).map((p) => ({
    id: p.id, text: p.text, category: p.category,
  }));
  const name = state.companion ? state.companion.name : t('chat.companionFallback');
  const limit = state.wallet ? state.wallet.daily_limit : 50;
  const used = state.wallet ? state.wallet.replies_today : 0;
  const left = Math.max(0, limit - used);

  // T4. A voice note is drawn *instead of* the text bubble it replaced, so the
  // lookup is keyed by message id. Failing here must not break the thread.
  const noteRows = await api.get(`/voice-notes?conversation_id=${encodeURIComponent(state.conversationId)}`)
    .catch(() => null);
  notes.clear();
  for (const n of (noteRows && noteRows.items) || []) {
    if (n.message_id) notes.set(n.message_id, n);
  }

  // Anything still streaming belongs to the DOM that is about to be replaced.
  // Abort those streams; the server keeps generating and the next paint reads
  // the finished rows back from the API.
  for (const turn of turns) {
    try { turn.controller.abort(); } catch (e) { /* already done */ }
  }
  turns.clear();

  return html`
  <div class="screen">
    <div class="chat-head">
      <div class="avatar">${name[0] ? name[0].toUpperCase() : 'W'}</div>
      <div class="who">
        <b>${name}</b>
        <small>${t('chat.subtitle')}</small>
      </div>
      <div class="quota ${left <= 5 ? 'warn' : ''}">
        ${t('chat.quotaLine', { left, limit })}<br>${t('chat.quotaLeft')}
      </div>
      <button class="icon-btn" type="button" id="chat-more" aria-label="${t('chat.options')}">${icon('more')}</button>
    </div>

    <div class="chat-body" id="chat-body">
      <div class="chat-date">${t('chat.todayDate', { date: shortDate() })}</div>
      ${msgs.map((m) => html`${raw(messageNode(m))}`)}
      <div id="proposal-host">${raw(proposals.map(proposalCard).join(''))}</div>
    </div>

    <div class="chat-suggestions" id="chat-suggestions">
      ${SUGGESTION_KEYS.map((k) => html`<button type="button" data-suggest="${t(k)}">${t(k)}</button>`)}
    </div>

    <div class="composer-wrap">
      <form class="composer" id="composer">
        <button class="mic-btn" type="button" id="composer-mic"
          aria-label="${t('voice.noteRecord')}" aria-pressed="false">${icon('mic')}</button>
        <textarea id="composer-input" rows="1" maxlength="4000"
          placeholder="${t('chat.placeholder', { name })}" aria-label="${t('chat.placeholder', { name })}"></textarea>
        <button class="send" type="submit" id="composer-send" aria-label="${t('chat.send')}" disabled>
          ${icon('send')}
        </button>
      </form>
      <div class="composer-foot">
        <span class="ai-note" id="composer-hint">${icon('info')} ${t('chat.aiNote', { name })}</span>
        <span id="composer-count">0 / 4000</span>
      </div>
    </div>
    ${tabbar('chat')}
  </div>`;
}, {
  onMount: (root) => mountChat(root),
});

function scrollBottom() {
  const body = document.getElementById('chat-body');
  if (body) body.scrollTop = body.scrollHeight;
}

/* ------------------------------------------------------------ voice notes */

/** Recording state. Module-level so a repaint cannot orphan a live recorder. */
let recorder = null;

/**
 * Start recording, if this browser allows it.
 *
 * Returns null when it does not — the caller falls back to sending text rather
 * than silently doing nothing, because a mic button that does nothing is worse
 * than one that tells you it is unavailable.
 */
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return null;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return null;   // denied, or no device
  }
  const chunks = [];
  const mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm' : '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); });
  const done = new Promise((resolve) => {
    rec.addEventListener('stop', () => {
      stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (e) { /* gone */ } });
      const type = rec.mimeType || 'audio/webm';
      resolve({ blob: new Blob(chunks, { type }), mime: type, ms: Date.now() - startedAt });
    });
  });
  const startedAt = Date.now();
  rec.start();
  recorder = { rec, done, startedAt };
  return recorder;
}

function stopRecording() {
  if (!recorder) return null;
  try { recorder.rec.stop(); } catch (e) { /* already stopped */ }
  const pending = recorder.done;
  recorder = null;
  return pending;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** The longest note the server will take; stopping here beats a 400. */
const NOTE_MAX_MS = 300000;

function mountChat(root) {
  const body = root.querySelector('#chat-body');
  const host = root.querySelector('#proposal-host');
  const form = root.querySelector('#composer');
  const input = root.querySelector('#composer-input');
  const send = root.querySelector('#composer-send');
  const count = root.querySelector('#composer-count');
  const suggestions = root.querySelector('#chat-suggestions');
  const micBtn = root.querySelector('#composer-mic');
  const hint = root.querySelector('#composer-hint');

  // Follow the stream only while the reader is already at the bottom. Someone
  // scrolling back through earlier messages should not be yanked down by a
  // reply that is still arriving.
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 96;
  const follow = (force) => {
    if (force || atBottom()) body.scrollTop = body.scrollHeight;
  };

  const syncSend = () => {
    send.disabled = !input.value.trim();
    send.classList.remove('stop');
    send.innerHTML = icon('send').value;
    send.dataset.mode = 'send';
    send.setAttribute('aria-label', t('chat.send'));
  };

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    count.textContent = `${input.value.length} / 4000`;
    syncSend();
  };
  grow();

  const appendUser = (text, id) => {
    const node = document.createElement('div');
    node.className = 'msg me';
    node.dataset.mid = id || '';
    node.innerHTML = `<div class="bubble">${escapeText(text)}</div>
      <div class="meta"><span>${clockTime(new Date().toISOString())}</span></div>`;
    body.insertBefore(node, host);
    follow(true);
    return node;
  };

  /**
   * One reply bubble, inserted *after* the message it answers.
   *
   * `afterNode` is the user bubble (normal send) or the assistant bubble being
   * regenerated. Inserting next to it — rather than into a shared host at the
   * bottom — is what keeps several concurrent replies attached to their own
   * question.
   */
  const newTurn = (afterNode) => {
    const controller = new AbortController();
    const node = document.createElement('div');
    node.className = 'msg ai generating';
    const id = `turn_${++turnSeq}`;
    node.dataset.turn = id;
    node.innerHTML = `<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>
      <div class="meta"><span>${escapeText(t('chat.thinking'))}</span>
        <button type="button" data-act="stop-turn" data-turn="${id}">${t('chat.stop')}</button>
      </div>`;
    body.insertBefore(node, afterNode && afterNode.nextSibling ? afterNode.nextSibling : host);
    follow(true);
    const turn = { id, node, buffer: '', controller, messageId: null, stopped: false, kind: 'completed' };
    turns.add(turn);
    return turn;
  };

  const renderStreaming = (turn, text) => {
    const bubble = turn.node.querySelector('.bubble');
    bubble.innerHTML = escapeText(text) + '<span class="caret"></span>';
    follow(false);
  };

  /** Settle a bubble into its final state. Safe to call more than once. */
  const finishTurn = (turn, kind, text) => {
    if (turn.finished) return;
    turn.finished = true;
    turns.delete(turn);
    const node = turn.node;
    node.classList.remove('generating');
    node.dataset.mid = turn.messageId || '';
    node.dataset.status = kind;
    if (kind === 'failed') node.classList.add('failed');
    const bubble = node.querySelector('.bubble');
    if (kind === 'blocked') {
      bubble.classList.add('safety');
      bubble.innerHTML = escapeText(text);
    } else {
      bubble.textContent = text;
    }
    const meta = node.querySelector('.meta');
    if (kind === 'canceled') meta.innerHTML = `<span>${t('chat.metaStopped')}</span>`;
    else if (kind === 'blocked') meta.innerHTML = `<span>${t('chat.metaSafety')}</span>`;
    else meta.innerHTML = `<span>${clockTime(new Date().toISOString())}</span>`;
    if (kind === 'completed' && turn.messageId) attachActions(node, turn.messageId, text);
    follow(false);
  };

  const cancelTurn = (turn, notify) => {
    turn.stopped = true;
    try { turn.controller.abort(); } catch (e) { /* already done */ }
    if (turn.messageId) {
      api.post(`/messages/${turn.messageId}/cancel`, {}).catch(() => {});
    }
    finishTurn(turn, 'canceled', turn.buffer || t('chat.metaStopped'));
    if (notify) toast(t('chat.toastStopped'));
  };

  /** Shared stream wiring: every send and every regenerate goes through here. */
  const runTurn = async (turn, messageId) => {
    turn.messageId = messageId;
    await streamMessage(messageId, {
      signal: turn.controller.signal,
      delta: (chunk) => {
        if (turn.stopped) return;
        turn.buffer += chunk;
        renderStreaming(turn, turn.buffer);
      },
      proposal: (p) => {
        proposals.unshift(p);
        // Anchor the card to the reply that produced it, not to the bottom of
        // the thread — otherwise a card can appear below a newer message.
        turn.node.insertAdjacentHTML('afterend', proposalCard(p));
      },
      completed: (payload) => {
        if (turn.stopped) return;
        const text = (payload && payload.content) || turn.buffer;
        turn.buffer = text;
        finishTurn(turn, 'completed', text);
      },
      blocked: (payload) => {
        if (turn.stopped) return;
        finishTurn(turn, 'blocked', (payload && payload.fallback_text) || t('chat.blockedFallback'));
      },
      failed: (payload) => {
        if (turn.stopped) return;
        finishTurn(turn, 'failed', t('chat.failedFallback'));
        toast((payload && payload.message) || t('chat.toastFailed'), 'error');
      },
      canceled: () => {
        finishTurn(turn, 'canceled', turn.buffer || t('chat.metaStopped'));
      },
    });
    // A stream can end without a terminal event (abort, dropped connection);
    // never leave a bubble spinning forever.
    if (!turn.finished) {
      finishTurn(turn, turn.buffer ? 'completed' : 'canceled',
        turn.buffer || t('chat.metaStopped'));
    }
  };

  async function sendCurrent() {
    const text = input.value.trim();
    if (!text) return;
    const clientId = (crypto.randomUUID ? crypto.randomUUID() : 'c_' + Date.now() + Math.random());
    input.value = '';
    grow();
    const userNode = appendUser(text, clientId);
    const turn = newTurn(userNode);

    try {
      const res = await api.post(`/conversations/${state.conversationId}/messages`, {
        content: text,
        client_message_id: clientId,
      });
      if (res.user_message_id) userNode.dataset.mid = res.user_message_id;
      turn.messageId = res.message_id;
      // Stopped while the request was in flight: the server may already have
      // started generating, so cancel it there too rather than letting it run.
      if (turn.stopped) {
        api.post(`/messages/${res.message_id}/cancel`, {}).catch(() => {});
        return;
      }
      if (res.safety) {
        const full = await api.get(`/messages/${res.message_id}`);
        finishTurn(turn, 'blocked', full.content);
        attachActions(turn.node, res.message_id, full.content);
        loadSession().then(() => refreshQuota(root)).catch(() => {});
        return;
      }
      await runTurn(turn, res.message_id);
      if (turn.kind !== 'failed') {
        loadSession().then(() => refreshQuota(root)).catch(() => {});
      }
    } catch (err) {
      finishTurn(turn, 'failed', t('chat.sendFail'));
      // Only put the draft back if the composer is still free: restoring over
      // something the user has typed since would delete their new message.
      if (!input.value.trim()) {
        input.value = text;
        grow();
      } else {
        toast(t('chat.draftKept'), 'error');
      }
      toast(err.display || err.message || t('chat.toastSendFail'), 'error');
      if (err.status === 429) {
        openSheet({
          title: t('chat.limitTitle'),
          body: `<p class="sub">${t('chat.limitBody')}</p>`,
          actions: [
            { label: t('chat.seePlus'), kind: 'accent', onClick: () => { go('plus'); } },
            { label: t('common.notNow'), kind: 'ghost' },
          ],
        });
      }
    }
  }

  function attachActions(node, msgId, content) {
    if (node.querySelector('.meta [data-act="copy"]')) return;
    const meta = node.querySelector('.meta');
    if (!meta) return;
    meta.insertAdjacentHTML('beforeend',
      `<button type="button" data-act="copy" data-mid="${msgId}" aria-label="${t('chat.copyAria')}">${t('common.copy')}</button>
       <button type="button" data-act="regen" data-mid="${msgId}" aria-label="${t('chat.regenAria')}">${t('common.again')}</button>
       <button type="button" data-act="report" data-mid="${msgId}" aria-label="${t('common.report')}">${t('common.report')}</button>`);
  }

  /* ---------------------------------------------------------- recording */

  /**
   * Press once to start, again to stop. Tap-to-toggle rather than hold-to-talk:
   * hold gestures fight the Android back-gesture and lose the recording when a
   * finger slides off the button.
   */
  let armed = false;
  let autoStop = 0;

  const setArmed = (on) => {
    armed = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.classList.toggle('recording', on);
    micBtn.setAttribute('aria-label', on ? t('voice.noteStop') : t('voice.noteRecord'));
    hint.innerHTML = on
      ? `${icon('mic')} <span id="rec-elapsed">0:00</span> · ${t('voice.noteHeld')}`
      : `${icon('info')} ${t('chat.aiNote', { name: state.companion ? state.companion.name : '' })}`;
  };

  const tickElapsed = () => {
    const el = document.getElementById('rec-elapsed');
    if (!el || !recorder) return;
    const s = Math.floor((Date.now() - recorder.startedAt) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  let recTimer = 0;

  micBtn.addEventListener('click', async () => {
    if (!armed) {
      // A draft in the composer is text, not speech. Recording over it would
      // throw away what they typed, so ask them to send it first.
      if (input.value.trim()) {
        toast(t('voice.noteDraftFirst'), 'error');
        return;
      }
      const rec = await startRecording();
      if (!rec) {
        toast(t('voice.noteUnavailable'), 'error');
        return;
      }
      setArmed(true);
      recTimer = setInterval(tickElapsed, 500);
      autoStop = setTimeout(() => { if (armed) micBtn.click(); }, NOTE_MAX_MS);
      return;
    }

    clearInterval(recTimer);
    clearTimeout(autoStop);
    const pending = stopRecording();
    setArmed(false);
    if (!pending) return;
    const { blob, mime, ms } = await pending;
    if (ms < 400 || !blob.size) {
      toast(t('voice.noteTooShort'), 'error');
      return;
    }
    const transcript = await askTranscript();
    await sendNote(blob, mime, ms, transcript);
  });

  /**
   * Send a recorded note.
   *
   * `transcript` is what lets the companion answer: a voice note is a turn, so
   * without words there is nothing to reply to and the note becomes a dead end.
   * It is typed by the user rather than guessed — claiming to transcribe audio
   * we have not heard would be a lie the bubble repeats back.
   */
  async function sendNote(blob, mime, ms, transcript) {
    const clientId = (crypto.randomUUID ? crypto.randomUUID() : 'c_' + Date.now() + Math.random());
    const audio = await blobToDataUrl(blob).catch(() => null);
    const node = document.createElement('div');
    node.className = 'msg me';
    node.dataset.mid = clientId;
    node.innerHTML = `<div class="bubble"><div class="voice-note pending-send">
        <span class="track"><i></i></span>
        <span class="dur">${t('voice.minutesShort', { s: Math.round(ms / 1000) })}</span>
      </div></div>
      <div class="meta"><span>${escapeText(t('voice.noteSending'))}</span></div>`;
    body.insertBefore(node, host);
    follow(true);

    try {
      const res = await api.post('/voice-notes', {
        conversation_id: state.conversationId,
        duration_ms: ms,
        mime: mime,
        audio: audio,
        transcript: transcript || '',
        client_message_id: clientId,
      });
      const note = res.note || res;
      note.duration_ms = ms;
      const reply = res.reply || null;
      const userMid = (reply && reply.user_message_id) || clientId;
      notes.set(userMid, note);
      node.dataset.mid = userMid;
      node.innerHTML = `<div class="bubble">${voiceBubble(note)}</div>
        <div class="meta"><span>${clockTime(new Date().toISOString())}</span></div>`;

      // The note is a turn: stream the reply that answers it.
      if (reply && reply.message_id) {
        const turn = newTurn(node);
        if (reply.safety) {
          const full = await api.get(`/messages/${reply.message_id}`);
          finishTurn(turn, 'blocked', full.content);
          attachActions(turn.node, reply.message_id, full.content);
        } else {
          await runTurn(turn, reply.message_id);
        }
        loadSession().then(() => refreshQuota(root)).catch(() => {});
      }
    } catch (err) {
      node.remove();
      toast(err.display || err.message || t('voice.noteFail'), 'error');
    }
  }

  /** Ask what the note says before sending it; without words it cannot be answered. */
  function askTranscript() {
    return new Promise((resolve) => {
      let decided = false;
      const done = (value) => { decided = true; resolve(value); };
      openSheet({
        title: t('voice.noteTranscriptTitle'),
        body: `<p class="sub">${escapeText(t('voice.noteTranscriptBody'))}</p>
          <input id="note-transcript" class="field mt-12" maxlength="600" autocomplete="off"
            placeholder="${escapeText(t('voice.noteTranscriptHint'))}"
            aria-label="${escapeText(t('voice.noteTranscript'))}">`,
        actions: [
          { label: t('voice.noteSend'), kind: 'accent',
            onClick: () => {
              const el = document.getElementById('note-transcript');
              done((el && el.value.trim()) || '');
            } },
          { label: t('voice.noteSendSilent'), kind: 'ghost', onClick: () => done('') },
        ],
        onMount: ({ root: sheet }) => {
          const el = sheet.querySelector('#note-transcript');
          if (el) {
            el.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); done(el.value.trim()); }
            });
          }
        },
      });
      // Backdrop tap or Escape closes the sheet without an action; treat that
      // as "sent without words" so the recording is never silently swallowed.
      window.addEventListener('wy:sheet-dismiss', () => { if (!decided) done(''); }, { once: true });
    });
  }

  /* ----------------------------------------------------------- playback */

  let audioEl = null;
  let playingId = null;

  function stopPlayback() {
    if (audioEl) { try { audioEl.pause(); } catch (e) { /* gone */ } audioEl = null; }
    if (playingId) {
      const btn = body.querySelector(`[data-note-play="${playingId}"]`);
      if (btn) btn.innerHTML = icon('play').value;
      playingId = null;
    }
  }

  async function playNote(id) {
    if (playingId === id) { stopPlayback(); return; }
    stopPlayback();
    const btn = body.querySelector(`[data-note-play="${id}"]`);
    try {
      const data = await api.get(`/voice-notes/${id}/audio`);
      audioEl = new Audio(data.audio);
      playingId = id;
      const bar = btn.closest('.voice-note').querySelector('.track i');
      if (btn) btn.innerHTML = icon('pause').value;
      audioEl.addEventListener('timeupdate', () => {
        if (bar && audioEl && audioEl.duration) {
          bar.style.width = `${Math.min(100, (audioEl.currentTime / audioEl.duration) * 100)}%`;
        }
      });
      audioEl.addEventListener('ended', () => {
        if (bar) bar.style.width = '0';
        stopPlayback();
      });
      await audioEl.play();
    } catch (err) {
      toast(err.display || err.message || t('voice.notePlayFail'), 'error');
      stopPlayback();
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    sendCurrent();
  });

  input.addEventListener('input', grow);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendCurrent();
    }
  });

  suggestions.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-suggest]');
    if (!b) return;
    input.value = b.getAttribute('data-suggest');
    grow();
    input.focus();
  });

  body.addEventListener('click', async (ev) => {
    const playBtn = ev.target.closest('[data-note-play]');
    if (playBtn) {
      await playNote(playBtn.getAttribute('data-note-play'));
      return;
    }
    const delBtn = ev.target.closest('[data-note-del]');
    if (delBtn) {
      const id = delBtn.getAttribute('data-note-del');
      stopPlayback();
      try {
        await api.del(`/voice-notes/${id}`);
        for (const [mid, n] of notes) if (n.id === id) notes.delete(mid);
        const host = delBtn.closest('.msg');
        if (host) host.remove();
        toast(t('voice.noteDeleted'), 'good');
      } catch (err) {
        toast(err.display || err.message || t('voice.noteDeleteFail'), 'error');
      }
      return;
    }
    const pbtn = ev.target.closest('[data-pact]');
    if (pbtn) {
      await decideProposal(pbtn.getAttribute('data-pid'), pbtn.getAttribute('data-pact'), root);
      return;
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const mid = btn.getAttribute('data-mid');
    const act = btn.getAttribute('data-act');

    if (act === 'stop-turn') {
      const turn = [...turns].find((x) => x.id === btn.getAttribute('data-turn'));
      if (!turn) return;
      cancelTurn(turn, true);
      return;
    }

    if (act === 'copy') {
      const node = body.querySelector(`[data-mid="${mid}"] .bubble`);
      const text = node ? node.textContent : '';
      const copied = await copyText(text);
      toast(copied ? t('chat.toastCopied') : t('chat.toastCopyFail'), copied ? 'good' : 'error');
    }
    if (act === 'regen') {
      const anchor = body.querySelector(`[data-mid="${mid}"]`);
      try {
        const res = await api.post(`/messages/${mid}/regenerate`, {});
        const turn = newTurn(anchor || null);
        await runTurn(turn, res.message_id);
      } catch (err) {
        toast(err.display || err.message || t('chat.toastRegenFail'), 'error');
      }
    }
    if (act === 'down') {
      try {
        await api.post(`/messages/${mid}/feedback`, { rating: 'down' });
        btn.classList.add('on');
        toast(t('chat.toastThanks'));
      } catch (err) {
        toast(err.display || err.message || t('chat.toastFeedbackFail'), 'error');
      }
    }
    if (act === 'report') {
      /* The value posted to /reports is the canonical English label, not the
       * translated one: review queues and any later analytics must not break
       * when the reporter's UI language changes. The chips still *show* the
       * translated text. */
      const reasons = [
        ['Unsafe advice', 'chat.reasonUnsafe'],
        ['Pressuring me', 'chat.reasonPressure'],
        ['Fake real-world action', 'chat.reasonFake'],
        ['Other', 'chat.reasonOther'],
      ];
      openSheet({
        title: t('chat.reportTitle'),
        body: `<p class="sub">${t('chat.reportBody')}</p>
          <div class="chips mt-16">
            ${reasons.map(([canonical, key]) => `<button class="chip" type="button" data-reason="${canonical}">${t(key)}</button>`).join('')}
          </div>`,
        actions: [
          { label: t('chat.submitReport'), kind: 'accent', onClick: async () => {
              const chosen = document.querySelector('[data-reason][aria-pressed="true"]');
              const reason = chosen ? chosen.getAttribute('data-reason') : 'Other';
              try {
                await api.post('/reports', { message_id: mid, reason });
                toast(t('chat.toastReported'), 'good');
              } catch (err) {
                toast(err.display || err.message || t('chat.toastReportFail'), 'error');
              }
            } },
          { label: t('common.cancel'), kind: 'ghost' },
        ],
        onMount: ({ root: sheet }) => {
          sheet.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-reason]');
            if (!chip) return;
            sheet.querySelectorAll('[data-reason]').forEach((c) => {
              c.setAttribute('aria-pressed', String(c === chip));
            });
          });
        },
      });
    }
  });

  root.querySelector('#chat-more').addEventListener('click', () => {
    openSheet({
      title: t('chat.convTitle'),
      body: `<p class="sub">${t('chat.convBody')}</p>`,
      actions: [
        { label: t('chat.memoryCenter'), kind: 'ghost', onClick: () => { go('memory'); } },
        { label: t('chat.relationshipStyle'), kind: 'ghost', onClick: () => { go('relationship'); } },
        { label: t('chat.privacyData'), kind: 'ghost', onClick: () => { go('privacy'); } },
        { label: t('common.close'), kind: 'accent' },
      ],
    });
  });

  scrollBottom();
  setTimeout(scrollBottom, 40);

  // Rows that were still generating when this screen last rendered arrive as
  // `accepted`/`generating`. Reattach a stream to each instead of leaving a
  // permanent three-dot bubble behind.
  for (const node of body.querySelectorAll('[data-status="accepted"], [data-status="generating"]')) {
    const mid = node.dataset.mid;
    if (!mid) continue;
    const controller = new AbortController();
    const turn = { id: `turn_${++turnSeq}`, node, buffer: '', controller,
      messageId: mid, stopped: false, finished: false };
    node.classList.add('generating');
    turns.add(turn);
    runTurn(turn, mid);
  }
}

function refreshQuota(root) {
  const q = root.querySelector('.chat-head .quota');
  if (!q || !state.wallet) return;
  const limit = state.wallet.daily_limit;
  const left = Math.max(0, limit - state.wallet.replies_today);
  q.innerHTML = `${t('chat.quotaLine', { left, limit })}<br>${t('chat.quotaLeft')}`;
  q.classList.toggle('warn', left <= 5);
}