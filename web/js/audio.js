/**
 * The audio layer: record, play, speak.
 *
 * Everything that makes noise goes through this file so the screens never
 * touch a media API directly. That matters for two reasons:
 *
 * 1. The same code runs in Chrome, in the Android WebView, and in headless
 *    Chromium during tests — and those three have very different capabilities.
 *    `speech` therefore has three backends and degrades in a visible way
 *    rather than silently doing nothing.
 * 2. A call needs the microphone *and* the speaker at the same time, with the
 *    microphone able to interrupt the speaker. That is one shared
 *    AudioContext, not two independent toys.
 */
import { api } from './api.js';

const TARGET_RATE = 16000;

/** What this deployment can do. Filled by `loadCapabilities()`. */
export const caps = {
  loaded: false,
  tts: { channel: 'client', provider: 'none', server_synth: false, voices: [] },
  asr: { available: false, provider: 'none', locales: [] },
  limits: { note_max_ms: 300000, audio_max_bytes: 8 * 1024 * 1024 },
};

export async function loadCapabilities() {
  try {
    const data = await api.get('/voice/capabilities');
    caps.tts = { ...caps.tts, ...(data.tts || {}) };
    caps.asr = { ...caps.asr, ...(data.asr || {}) };
    caps.limits = { ...caps.limits, ...(data.limits || {}) };
    caps.loaded = true;
  } catch (err) {
    // Boot calls this before anyone is signed in, where the answer is 401.
    // Marking it "loaded" then would leave the picker permanently empty, so a
    // failure stays unloaded and the next screen that needs it retries.
    caps.loaded = false;
  }
  return caps;
}

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && typeof MediaRecorder !== 'undefined');
}

/* ---------------------------------------------------------------- recording */

/**
 * Open the microphone once and keep it for the whole call.
 *
 * A call cannot ask for permission on every utterance, and re-opening the
 * device between turns adds half a second of dead air. So the stream lives as
 * long as the screen does, and `recorderFor()` slices it into clips.
 */
export async function openMic() {
  if (!recordingSupported()) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch {
    return null;
  }
}

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const m of options) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * Record one clip from an existing stream.
 *
 * Returns a controller rather than a promise so the caller can watch the level
 * while the user is still talking — that level is what drives the live
 * waveform in both the note recorder and the call.
 */
export function recorderFor(stream, { onLevel } = {}) {
  const mime = pickMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  const peaks = [];
  const startedAt = Date.now();

  let ctx = null;
  let analyser = null;
  let timer = null;

  if (typeof AudioContext !== 'undefined' && onLevel) {
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let lastPeak = 0;
      timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        onLevel(rms);
        // One peak every ~90 ms is enough to draw a recognisable envelope and
        // keeps the stored array small enough for any screen width.
        if (Date.now() - lastPeak > 90) {
          peaks.push(Math.min(1, rms * 3.2));
          lastPeak = Date.now();
        }
      }, 60);
    } catch {
      ctx = null;
    }
  }

  rec.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); });
  rec.start();

  function cleanup() {
    if (timer) clearInterval(timer);
    timer = null;
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } }
    ctx = null;
  }

  return {
    startedAt,
    elapsedMs: () => Date.now() - startedAt,
    level: () => (peaks.length ? peaks[peaks.length - 1] : 0),
    stop() {
      return new Promise((resolve) => {
        if (rec.state === 'inactive') {
          cleanup();
          resolve({ blob: new Blob(chunks, { type: mime || 'audio/webm' }), ms: 0, peaks, mime });
          return;
        }
        rec.addEventListener('stop', () => {
          cleanup();
          const ms = Math.max(1, Date.now() - startedAt);
          resolve({ blob: new Blob(chunks, { type: mime || 'audio/webm' }), ms, peaks, mime });
        }, { once: true });
        rec.stop();
      });
    },
    cancel() {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
      cleanup();
    },
  };
}

/** A one-shot recording session for the chat composer. */
export async function startRecording(opts = {}) {
  const stream = await openMic();
  if (!stream) return null;
  const rec = recorderFor(stream, opts);
  return {
    ...rec,
    stop: async () => {
      const out = await rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      return out;
    },
    cancel: () => {
      rec.cancel();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/* ------------------------------------------------------------------- player */

/**
 * Thin wrapper over an `<audio>` element.
 *
 * `src` may be a Blob, an object URL, a data URL or a plain URL. Playback is
 * deliberately owned here instead of being spread across the bubble code, so
 * pressing play on a second note stops the first.
 */
let activePlayer = null;

export function stopPlayback() {
  if (activePlayer) {
    try { activePlayer.pause(); } catch { /* not started */ }
    activePlayer = null;
  }
  if (typeof speechSynthesis !== 'undefined') {
    try { speechSynthesis.cancel(); } catch { /* unsupported */ }
  }
}

export function playAudio(src, { onTime, onEnd } = {}) {
  stopPlayback();
  const el = new Audio();
  el.preload = 'auto';
  el.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  const revoke = typeof src === 'string' ? null : el.src;
  activePlayer = el;

  el.addEventListener('timeupdate', () => {
    onTime && onTime({ current: el.currentTime, duration: el.duration || 0 });
  });
  el.addEventListener('ended', () => {
    onTime && onTime({ current: el.currentTime, duration: el.duration || 0 });
    onEnd && onEnd();
  });
  el.play().catch(() => { /* a blocked autoplay is not an error worth surfacing */ });

  return {
    el,
    pause() { el.pause(); },
    resume() { el.play().catch(() => {}); },
    seek(fraction) {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = Math.max(0, Math.min(el.duration, el.duration * fraction));
      }
    },
    stop() {
      try { el.pause(); } catch { /* not started */ }
      if (revoke) URL.revokeObjectURL(revoke);
      if (activePlayer === el) activePlayer = null;
    },
  };
}

/* ------------------------------------------------------------------ speaking */

/**
 * Which channel will actually produce sound.
 *
 * - `server`: the deployment has a TTS provider; we POST the text and play the
 *   bytes. Same voice on every device.
 * - `browser`: `speechSynthesis` with whatever voice the OS has.
 * - `silent`: nothing can speak. The call still runs — captions, the turn
 *   timer, billing — but the UI says so instead of pretending.
 */
export function speakingMode() {
  if (caps.tts.channel === 'server' && caps.tts.server_synth) return 'server';
  if (typeof speechSynthesis !== 'undefined' && browserVoices().length) return 'browser';
  return 'silent';
}

export function browserVoices() {
  if (typeof speechSynthesis === 'undefined') return [];
  try { return speechSynthesis.getVoices() || []; } catch { return []; }
}

/** Resolve a companion's voice id to a system voice, preferring its language. */
export function pickBrowserVoice({ voiceId, style, locale } = {}) {
  const voices = browserVoices();
  if (!voices.length) return null;
  const lang = (locale || 'en').toLowerCase();
  const base = lang.split('-')[0];
  const sameLang = voices.filter((v) => {
    const vl = (v.lang || '').toLowerCase();
    return vl === lang || vl.startsWith(`${base}-`) || vl === base;
  });
  const pool = sameLang.length ? sameLang : voices;
  const seed = Array.from(String(voiceId || style || 'warm'))
    .reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100000, 7);
  return pool[seed % pool.length];
}

let speechToken = 0;

/**
 * Say `text`. Resolves with `{ interrupted }` when the utterance ends, stops,
 * or is cancelled by a newer one.
 *
 * `onStart` fires when sound actually begins (the call uses it to switch state
 * and to arm the barge-in window), and `onEnd` always fires exactly once so the
 * caller can never get stuck in "speaking".
 */
export async function speak(text, { voiceId, rate = 1, pitch = 1, locale = 'en', onStart, onBoundary } = {}) {
  const body = String(text || '').trim();
  if (!body) return { interrupted: false, mode: 'none' };
  const token = ++speechToken;
  const stale = () => token !== speechToken;
  const mode = speakingMode();

  if (mode === 'server') {
    try {
      const blob = await api.upload('/voice/tts', {
        text: body, voice_id: voiceId, rate, pitch,
      }, { method: 'POST', json: true, expect: 'blob' });
      if (stale()) return { interrupted: true, mode };
      await new Promise((resolve) => {
        const p = playAudio(blob, { onEnd: () => resolve() });
        onStart && onStart();
        // `playAudio` stops a previous player, which would also cancel this
        // one; only the current token may resolve via onEnd, and stopSpeaking
        // bumps the token before cancelling.
        p.el.addEventListener('error', () => resolve(), { once: true });
      });
      return { interrupted: stale(), mode };
    } catch {
      // Fall through to the device voice rather than leaving the call mute.
    }
  }

  if (mode === 'browser' || speakingMode() === 'browser') {
    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(body);
      const voice = pickBrowserVoice({ voiceId, locale });
      if (voice) utter.voice = voice;
      utter.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
      utter.pitch = Math.max(0.5, Math.min(2, Number(pitch) || 1));
      utter.lang = (voice && voice.lang) || locale || 'en';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve({ interrupted: stale(), mode: 'browser' });
      };
      // Some WebViews report a voice and then never fire `onstart` or `onend`
      // (no TTS engine behind the API). Without a cap the call would sit in
      // `speaking` forever — the state machine has to be able to give up.
      const guard = setTimeout(finish, Math.max(3000, body.length * 90 + 2500));
      utter.onstart = () => { onStart && onStart(); };
      utter.onboundary = (ev) => { onBoundary && onBoundary(ev); };
      utter.onend = finish;
      utter.onerror = finish;
      try { speechSynthesis.speak(utter); } catch { finish(); }
    });
  }

  // Silent: keep the rhythm so the call's state machine and captions advance
  // at a human pace, and let the screen say that nothing was heard.
  const ms = Math.max(600, Math.min(9000, (body.length * 55) / (Number(rate) || 1)));
  onStart && onStart();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { interrupted: stale(), mode: 'silent' };
}

export function stopSpeaking() {
  speechToken += 1;
  if (typeof speechSynthesis !== 'undefined') {
    try { speechSynthesis.cancel(); } catch { /* unsupported */ }
  }
  stopPlayback();
}

/* ------------------------------------------------------------- voice monitor */

/**
 * Continuous microphone level with speech onset/offset detection.
 *
 * This is what makes interruption possible: while the companion is talking we
 * keep watching the same stream, and the first sustained rise above the noise
 * floor stops the speech. `attack` debounces a cough; `hangover` decides when
 * the user has finished a sentence.
 */
export function createMonitor(stream, {
  onSpeechStart, onSpeechEnd, onLevel, threshold = 0.055, attack = 220, hangover = 800,
} = {}) {
  if (!stream || typeof AudioContext === 'undefined') {
    return { stop() {}, level: () => 0, setMuted() {} };
  }
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  let muted = false;
  let speaking = false;
  let aboveSince = 0;
  let lastAbove = 0;
  let level = 0;

  const tick = setInterval(() => {
    if (muted) { level = 0; onLevel && onLevel(0); return; }
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    level = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (level > threshold) {
      lastAbove = now;
      if (!aboveSince) aboveSince = now;
      if (!speaking && now - aboveSince >= attack) {
        speaking = true;
        onSpeechStart && onSpeechStart();
      }
    } else {
      aboveSince = 0;
      if (speaking && now - lastAbove >= hangover) {
        speaking = false;
        onSpeechEnd && onSpeechEnd();
      }
    }
    onLevel && onLevel(level);
  }, 50);

  return {
    level: () => level,
    isSpeaking: () => speaking,
    setMuted(value) { muted = !!value; if (muted) { speaking = false; aboveSince = 0; } },
    stop() {
      clearInterval(tick);
      try { ctx.close(); } catch { /* already closed */ }
    },
  };
}

/* ------------------------------------------------------------------ helpers */

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Speech to text, or null. Null means "nothing can listen here", not "silence". */
export async function transcribe(blob, { mime = 'audio/webm', locale = 'en' } = {}) {
  if (!caps.asr.available) return null;
  try {
    const b64 = await blobToBase64(blob);
    const data = await api.post('/voice/transcribe', { audio: b64, mime, locale });
    return (data && data.text) || '';
  } catch {
    return null;
  }
}

export { TARGET_RATE };
