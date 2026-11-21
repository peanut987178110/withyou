/* API client: envelope handling, auth, SSE, storage. */

import { apiErrorText } from './i18n.js';

const meta = document.querySelector('meta[name=wy-api]');
export const API = (meta && meta.content) || '/api/v1';

const TOKEN_KEY = 'wy_token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }

export function getToken() { return token; }
export function setToken(value) {
  token = value || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* private mode */ }
}

export class ApiFailure extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data || {};
    this.retryable = Boolean((data || {}).retryable);
  }
}

function headers(extra) {
  const h = { 'Accept': 'application/json', ...(extra || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function newIdempotencyKey() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'k_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export { newIdempotencyKey };

export async function request(method, path, body, opts) {
  const options = opts || {};
  const init = { method, headers: headers(options.headers) };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, init);
  } catch (err) {
    throw new ApiFailure(0, 'NETWORK_ERROR',
      'You appear to be offline. Your draft is saved.', { retryable: true });
  }
  if (res.status === 204) return null;
  let payload = null;
  try { payload = await res.json(); } catch (e) { payload = null; }
  if (!res.ok) {
    const err = payload || {};
    if (res.status === 401 && token) {
      setToken(null);
      window.dispatchEvent(new CustomEvent('wy:signed-out'));
    }
    const failure = new ApiFailure(res.status, err.code || 'HTTP_' + res.status,
      err.message || 'Something went wrong.', err.data);
    // `serverMessage` keeps the English string the API sent; `display` is the
    // same error in the user's language. Call sites show `display` — the code
    // contract (`code`, `status`, `data`) is untouched.
    failure.serverMessage = failure.message;
    failure.display = apiErrorText(failure);
    throw failure;
  }
  return payload ? payload.data : null;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
  patch: (p, b, o) => request('PATCH', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
};

export function idempotentPost(path, body) {
  return request('POST', path, body === undefined ? {} : body,
    { headers: { 'Idempotency-Key': newIdempotencyKey() } });
}

/**
 * Consume a message SSE stream. Falls back to polling if streaming fails —
 * the server log is the source of truth either way.
 *
 * `handlers.signal` lets the caller abandon one turn without touching any
 * other: the chat screen can have several replies in flight at once, and
 * leaving the screen (or stopping one reply) must not cancel the rest.
 */
export async function streamMessage(messageId, handlers) {
  const on = handlers || {};
  const controller = new AbortController();
  const external = on.signal;
  const aborted = () => Boolean((external && external.aborted) || controller.signal.aborted);
  if (external) {
    if (external.aborted) return;
    external.addEventListener('abort', () => { try { controller.abort(); } catch (e) {} }, { once: true });
  }
  let lastSeq = 0;
  let sawTerminal = false;

  const dispatch = (type, payload, seq) => {
    if (seq) lastSeq = Math.max(lastSeq, seq);
    if (type === 'message.delta' && on.delta) on.delta(payload.delta || '');
    else if (type === 'message.completed') { sawTerminal = true; on.completed && on.completed(payload); }
    else if (type === 'message.blocked') { sawTerminal = true; on.blocked && on.blocked(payload); }
    else if (type === 'message.failed') { sawTerminal = true; on.failed && on.failed(payload); }
    else if (type === 'message.canceled') { sawTerminal = true; on.canceled && on.canceled(payload); }
    else if (type === 'memory.proposed' && on.proposal) on.proposal(payload);
    else if (type === 'message.started' && on.started) on.started(payload);
  };

  try {
    const res = await fetch(`${API}/messages/${messageId}/events`, {
      headers: headers({ 'Accept': 'text/event-stream' }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error('stream-unavailable');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      if (aborted()) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let data = '';
        let seq = 0;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) seq = parseInt(line.slice(3).trim(), 10) || 0;
        }
        if (!data) continue;
        let payload = {};
        try { payload = JSON.parse(data); } catch (e) { payload = {}; }
        dispatch(event, payload, seq);
        if (sawTerminal) { try { controller.abort(); } catch (e) {} return; }
      }
    }
  } catch (err) {
    if (sawTerminal || aborted()) return;
    await pollMessage(messageId, { on, lastSeq, aborted });
    return;
  }
  if (!sawTerminal && !aborted()) await pollMessage(messageId, { on, lastSeq, aborted });
}

async function pollMessage(messageId, ctx) {
  const { on, lastSeq, aborted } = ctx;
  let seq = lastSeq || 0;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (aborted && aborted()) return;
    let data;
    try {
      data = await api.get(`/messages/${messageId}`);
    } catch (e) {
      on.failed && on.failed({ message: e.message });
      return;
    }
    const fresh = (data.events || []).filter((e) => e.seq > seq);
    for (const ev of fresh) {
      seq = Math.max(seq, ev.seq);
      if (ev.type === 'message.delta' && on.delta) on.delta(ev.payload.delta || '');
      if (ev.type === 'memory.proposed' && on.proposal) on.proposal(ev.payload);
      if (ev.type === 'message.completed') { on.completed && on.completed(ev.payload); return; }
      if (ev.type === 'message.blocked') { on.blocked && on.blocked(ev.payload); return; }
      if (ev.type === 'message.failed') { on.failed && on.failed(ev.payload); return; }
      if (ev.type === 'message.canceled') { on.canceled && on.canceled(ev.payload); return; }
    }
    if (['completed', 'blocked', 'failed', 'canceled'].includes(data.status)) {
      if (data.status === 'completed') on.completed && on.completed({ content: data.content });
      if (data.status === 'blocked') on.blocked && on.blocked({});
      if (data.status === 'failed') on.failed && on.failed({});
      return;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  on.failed && on.failed({ message: 'This is taking longer than usual.' });
}

export function cancelStream() {
  /* Streams are cancelled server-side; the abort controller lives per call. */
}