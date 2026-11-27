"""Where the voice comes from.

There are two channels and the product runs both:

- **client** — the browser or WebView speaks with `speechSynthesis`. Nothing to
  configure, works offline, and the timbre is whatever the device has. This is
  the default, and on a phone it is the only channel that exists without a key.
- **server** — an OpenAI-compatible `/audio/speech` endpoint renders the audio
  and the client just plays the bytes. One voice everywhere, but it needs a key
  and a network round trip.

`WITHYOU_TTS=auto` picks server when a key is configured and mock otherwise, so
the same build behaves correctly in a demo, in CI, and on a phone.

The mock provider is not a placeholder that returns silence: it synthesises a
real 16-bit PCM WAV whose pitch follows `voice_id` and whose length follows the
text and the speech rate. That is what makes "each character has a different
voice" demonstrable — and testable — without any network at all.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import struct
import urllib.error
import urllib.request
from array import array
from typing import Any

SAMPLE_RATE = 16000
MAX_TTS_CHARS = 1200


class VoiceEngineError(Exception):
    """Provider failed. Callers fall back to the client channel."""


class VoiceEngineUnavailable(VoiceEngineError):
    """No provider is configured at all — a 501, not a 500."""


# The selectable voices. `id` is what a companion stores; `gender` and `tags`
# let the client match a system voice when it is speaking locally, and let the
# persona defaults pick something sensible.
VOICES: list[dict[str, Any]] = [
    {"id": "mia_warm", "label": "Mia · warm", "gender": "f", "tags": ["warm", "gentle"]},
    {"id": "nova_calm", "label": "Nova · calm", "gender": "f", "tags": ["calm", "grounded"]},
    {"id": "june_playful", "label": "June · playful", "gender": "f", "tags": ["playful", "witty"]},
    {"id": "sol_direct", "label": "Sol · direct", "gender": "m", "tags": ["direct", "grounded"]},
    {"id": "atlas_gentle", "label": "Atlas · gentle", "gender": "m", "tags": ["gentle", "dreamy"]},
    {"id": "kit_curious", "label": "Kit · curious", "gender": "n", "tags": ["curious", "witty"]},
]

VOICE_IDS = [v["id"] for v in VOICES]


def voice_by_id(voice_id: str | None) -> dict[str, Any]:
    for v in VOICES:
        if v["id"] == voice_id:
            return v
    return VOICES[0]


def default_profile(traits: list[str] | None, locale: str = "en") -> dict[str, Any]:
    """The voice a character starts with, derived from how they behave.

    Users do not pick a voice from a list of 150 and then wonder why it does
    not match the personality. The personality picks first; the user can
    audition and override afterwards, and that choice sticks.
    """
    from . import content

    wanted = [t for t in (traits or []) if t in content.VOICE_PRESETS]
    trait = wanted[0] if wanted else "Warm"
    preset = content.VOICE_PRESETS.get(trait, content.VOICE_PRESETS["Warm"])

    gender = content._TRAIT_VOICE_GENDER.get(trait, "f")
    pool = [v for v in VOICES if v["gender"] == gender] or VOICES
    # Stable per (locale, trait): the same character always sounds the same,
    # even after a restart or on another device.
    bucket = int(hashlib.sha256(f"{locale}:{trait}".encode()).hexdigest()[:8], 16)
    chosen = pool[bucket % len(pool)]

    return {
        "voice_id": chosen["id"],
        "rate": preset["rate"],
        "pitch": preset["pitch"],
        "style": preset["style"],
        "trait": trait,
    }


def normalise_profile(raw: Any, traits: list[str] | None = None,
                      locale: str = "en") -> dict[str, Any]:
    """Merge whatever the client sent onto the derived defaults.

    Unknown voice ids fall back to the default rather than erroring: a client
    from an older build should still get a working call, not a 400.
    """
    base = default_profile(traits, locale)
    if not isinstance(raw, dict):
        return base
    voice_id = raw.get("voice_id")
    if isinstance(voice_id, str) and voice_id in VOICE_IDS:
        base["voice_id"] = voice_id
    for key, lo, hi in (("rate", 0.5, 2.0), ("pitch", 0.5, 2.0)):
        value = raw.get(key)
        if isinstance(value, (int, float)) and lo <= float(value) <= hi:
            base[key] = round(float(value), 3)
    style = raw.get("style")
    if isinstance(style, str) and style in ("warm", "calm", "playful", "direct", "gentle", "witty"):
        base["style"] = style
    return base


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _tts_choice() -> str:
    return _env("WITHYOU_TTS", "auto").lower()


def _asr_choice() -> str:
    return _env("WITHYOU_ASR", "auto").lower()


def _cloud_key() -> str:
    return _env("WITHYOU_TTS_API_KEY") or _env("WITHYOU_OPENAI_API_KEY")


# --------------------------------------------------------------------- mock


def _seed(voice_id: str) -> int:
    return int(hashlib.sha256((voice_id or "mia_warm").encode()).hexdigest()[:8], 16)


def _wav_header(n_samples: int, sample_rate: int = SAMPLE_RATE) -> bytes:
    byte_rate = sample_rate * 2
    data_size = n_samples * 2
    return b"".join([
        b"RIFF", struct.pack("<I", 36 + data_size), b"WAVE",
        b"fmt ", struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, 2, 16),
        b"data", struct.pack("<I", data_size),
    ])


def mock_duration(text: str, rate: float = 1.0) -> float:
    """Seconds of audio the mock produces for this text.

    Roughly a spoken pace (about 5.5 chars per second at rate 1.0), clamped so
    a one-word reply is audible and a long paragraph does not become a minute
    of beeping.
    """
    body = (text or "").strip()
    speed = rate if isinstance(rate, (int, float)) and rate > 0 else 1.0
    seconds = 0.45 + len(body) * 0.055
    return max(0.35, min(8.0, seconds / speed))


def synth_mock(text: str, voice_id: str = "mia_warm", rate: float = 1.0,
               pitch: float = 1.0) -> bytes:
    """Deterministic PCM WAV for `text`.

    Each voice gets a base frequency from its id, `pitch` scales it, and the
    amplitude is gated per ~110 ms syllable with a short attack/release so the
    result sounds like speech rhythm rather than a dial tone.
    """
    seconds = mock_duration(text, rate)
    total = int(seconds * SAMPLE_RATE)

    seed = _seed(voice_id)
    base = 120.0 + (seed % 90)          # 120–210 Hz
    base *= (pitch if isinstance(pitch, (int, float)) and pitch > 0 else 1.0)
    # A gentle upward drift over each phrase reads as intonation.
    drift = ((seed >> 8) % 40) - 20

    samples = array("h", bytes(total * 2))
    syl = max(1, int(0.11 * SAMPLE_RATE))
    gate_len = max(1, int(syl * 0.72))
    for i in range(total):
        t = i / SAMPLE_RATE
        pos = i % syl
        if pos >= gate_len:              # the gap between syllables
            continue
        env = min(1.0, pos / (0.012 * SAMPLE_RATE))
        tail = gate_len - pos
        if tail < 0.012 * SAMPLE_RATE:
            env *= max(0.0, tail / (0.012 * SAMPLE_RATE))
        f0 = base + drift * (t / max(0.001, seconds))
        # Two partials keep it from sounding like a pure sine.
        value = 0.62 * _sine(f0, t) + 0.24 * _sine(f0 * 2.0, t) + 0.10 * _sine(f0 * 3.0, t)
        samples[i] = int(max(-1.0, min(1.0, value * env * 0.28)) * 32767)

    return _wav_header(total) + samples.tobytes()


def _sine(freq: float, t: float) -> float:
    # math.sin is fine but we avoid importing math just for this hot loop.
    return _sin2pi((freq * t) % 1.0)


def _sin2pi(x: float) -> float:
    """sin(2*pi*x) without `math`, accurate enough for a tone generator."""
    # Reduce to [-0.5, 0.5] for 4th-order Taylor around 0.
    if x > 0.5:
        x -= 1.0
    if x < -0.5:
        x += 1.0
    y = 2.0 * 3.141592653589793 * x
    y2 = y * y
    return y * (1.0 - y2 / 6.0 * (1.0 - y2 / 20.0 * (1.0 - y2 / 42.0)))


def wav_is_valid(data: bytes) -> bool:
    return (len(data) > 44 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"
            and data[12:16] == b"fmt ")


# -------------------------------------------------------------------- cloud


class HttpTTS:
    """OpenAI-compatible `/audio/speech`.

    Deliberately provider-agnostic: change `WITHYOU_TTS_BASE_URL` and the same
    code talks to any gateway that implements the shape.
    """

    name = "cloud"

    def __init__(self) -> None:
        self.base = _env("WITHYOU_TTS_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = _cloud_key()
        self.model = _env("WITHYOU_TTS_MODEL", "gpt-4o-mini-tts")
        self.default_voice = _env("WITHYOU_TTS_VOICE", "alloy")
        self.timeout = float(_env("WITHYOU_TTS_TIMEOUT", "12"))

    def synthesize(self, text: str, voice_id: str | None = None, rate: float = 1.0,
                   pitch: float = 1.0) -> tuple[bytes, str]:
        if not text.strip():
            raise VoiceEngineError("nothing to say")
        body = {
            "model": self.model,
            "input": text[:MAX_TTS_CHARS],
            "voice": voice_id or self.default_voice,
            "response_format": "mp3",
        }
        # Most gateways ignore `speed`; sending it is harmless and the ones
        # that honour it get the persona's pacing for free.
        if isinstance(rate, (int, float)) and 0.25 <= rate <= 4.0:
            body["speed"] = round(float(rate), 2)
        req = urllib.request.Request(
            f"{self.base}/audio/speech",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.key}",
                "User-Agent": "withyou-voice/2.2",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                data = res.read()
                mime = (res.headers.get("Content-Type") or "audio/mpeg").split(";")[0]
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            raise VoiceEngineError(f"tts failed: {exc}") from exc
        if not data:
            raise VoiceEngineError("tts returned nothing")
        return data, mime


class MockTTS:
    name = "mock"

    def synthesize(self, text: str, voice_id: str | None = None, rate: float = 1.0,
                   pitch: float = 1.0) -> tuple[bytes, str]:
        return synth_mock(text, voice_id or "mia_warm", rate, pitch), "audio/wav"


# ---------------------------------------------------------------------- asr


class NoneASR:
    """No recogniser, and it says so.

    Returning an empty string here would be the lie the old build told: the UI
    would show a blank transcript and the user would think the device had heard
    something. `available = False` lets the client show the honest fallback.
    """

    name = "none"
    available = False
    locales: list[str] = []

    def transcribe(self, data: bytes, mime: str, locale: str = "en") -> str:
        raise VoiceEngineUnavailable("speech recognition is not configured")


class HttpASR:
    name = "cloud"
    available = True

    def __init__(self) -> None:
        self.base = _env("WITHYOU_ASR_BASE_URL",
                         _env("WITHYOU_TTS_BASE_URL", "https://api.openai.com/v1")).rstrip("/")
        self.key = _env("WITHYOU_ASR_API_KEY") or _cloud_key()
        self.model = _env("WITHYOU_ASR_MODEL", "whisper-1")
        self.timeout = float(_env("WITHYOU_ASR_TIMEOUT", "20"))
        self.locales = [c.strip() for c in _env("WITHYOU_ASR_LOCALES", "en,zh,zh-TW,ja,ko,es,fr,de,pt,ar").split(",") if c.strip()]

    def transcribe(self, data: bytes, mime: str, locale: str = "en") -> str:
        if not data:
            raise VoiceEngineError("empty audio")
        boundary = "----withyou" + hashlib.md5(data[:32] or b"x").hexdigest()[:12]
        ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav",
               "audio/mpeg": "mp3", "audio/mp4": "m4a"}.get((mime or "").split(";")[0], "webm")
        parts: list[bytes] = []

        def field(name: str, value: str) -> None:
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
            )

        field("model", self.model)
        field("language", (locale or "en").split("-")[0])
        parts.append(
            (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"clip.{ext}\"\r\nContent-Type: {mime or 'audio/webm'}\r\n\r\n").encode()
        )
        parts.append(data)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        payload = b"".join(parts)

        req = urllib.request.Request(
            f"{self.base}/audio/transcriptions",
            data=payload,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Authorization": f"Bearer {self.key}",
                "User-Agent": "withyou-voice/2.2",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                body = json.loads(res.read().decode("utf-8", "replace") or "{}")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError,
                json.JSONDecodeError) as exc:
            raise VoiceEngineError(f"asr failed: {exc}") from exc
        return str(body.get("text") or "").strip()


# ---------------------------------------------------------------- selection


def tts_provider():
    choice = _tts_choice()
    if choice == "none":
        return None
    if choice == "mock":
        return MockTTS()
    if choice == "cloud":
        return HttpTTS()
    # auto
    if _cloud_key():
        return HttpTTS()
    return MockTTS()


def asr_provider():
    choice = _asr_choice()
    if choice in ("none", "off"):
        return NoneASR()
    if choice == "cloud":
        return HttpASR()
    if _cloud_key() and choice == "auto":
        return HttpASR()
    return NoneASR()


def needs_client_tts() -> bool:
    """True when the phone should speak for itself with `speechSynthesis`."""
    return _tts_choice() == "none"


def capabilities() -> dict[str, Any]:
    tts = tts_provider()
    asr = asr_provider()
    server_tts = tts is not None and tts.name == "cloud"
    return {
        # `server` means the client should POST /voice/tts and play the bytes;
        # `client` means speechSynthesis. Mock is exposed as `mock` so a demo
        # can show tones without pretending they are a voice.
        "tts": {
            "channel": "server" if server_tts else "client",
            "provider": tts.name if tts is not None else "none",
            "server_synth": tts is not None,
            "voices": VOICES,
            "max_chars": MAX_TTS_CHARS,
        },
        "asr": {
            "available": bool(getattr(asr, "available", False)),
            "provider": asr.name,
            "locales": getattr(asr, "locales", []),
        },
        "limits": {
            "note_max_ms": 300000,
            "audio_max_bytes": int(os.environ.get("WITHYOU_AUDIO_MAX_BYTES",
                                                  str(8 * 1024 * 1024))),
        },
    }


def synthesize(text: str, voice_id: str | None = None, rate: float = 1.0,
               pitch: float = 1.0) -> tuple[bytes, str]:
    provider = tts_provider()
    if provider is None:
        raise VoiceEngineUnavailable("text to speech is turned off")
    return provider.synthesize(text, voice_id, rate, pitch)


def transcribe(data: bytes, mime: str, locale: str = "en") -> str:
    provider = asr_provider()
    if not getattr(provider, "available", False):
        raise VoiceEngineUnavailable("speech recognition is not configured")
    return provider.transcribe(data, mime, locale)
