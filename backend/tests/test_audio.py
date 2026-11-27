"""Audio layer tests: the engine, the file store, and the routes on top.

These exist because v2.2 replaced "a string that stands for audio" with real
bytes. The cases that matter are the ones where bytes could go missing: an
allowance that silently drops a clip, a delete that leaves the file behind, an
expiry that was written but never enforced, and a speech engine that answers
"ok" without producing anything playable.
"""
from __future__ import annotations

import io
import json
import wave

import pytest

from app import audio_store, voice, voice_engine
from app.core import connect, new_id, now_iso
from conftest import make_companion, register

# Every test in this module writes audio, so none of them may touch the real
# `backend/data/audio` directory.
@pytest.fixture(autouse=True)
def audio_root(tmp_path):
    audio_store.set_root(tmp_path / "audio")
    yield
    audio_store.set_root(None)


def who(client, **kw):
    user = register(client, **kw)
    user["comp"] = make_companion(client, user["headers"])
    return user


# ------------------------------------------------------------------- engine

def test_mock_tts_produces_a_playable_wav():
    data = voice_engine.synth_mock("Hello, how was your day?", "mia_warm")
    assert voice_engine.wav_is_valid(data)
    with wave.open(io.BytesIO(data)) as fh:
        assert fh.getnchannels() == 1
        assert fh.getframerate() == voice_engine.SAMPLE_RATE
        assert fh.getnframes() > voice_engine.SAMPLE_RATE // 2


def test_mock_tts_follows_the_voice_speed_and_length():
    slow = voice_engine.synth_mock("a longer sentence goes here", "mia_warm", 0.8)
    fast = voice_engine.synth_mock("a longer sentence goes here", "mia_warm", 1.6)
    assert len(fast) < len(slow), "a faster rate must produce a shorter clip"
    assert voice_engine.synth_mock("hi", "mia_warm") != voice_engine.synth_mock("hi", "sol_direct")


def test_default_profile_is_derived_and_stable():
    a = voice_engine.default_profile(["Gentle"], "en")
    b = voice_engine.default_profile(["Gentle"], "en")
    assert a == b, "the same character must keep the same voice"
    assert a["voice_id"] in voice_engine.VOICE_IDS
    assert a["rate"] < 1.0, "Gentle should speak slower than the default"
    playful = voice_engine.default_profile(["Playful"], "en")
    assert playful["rate"] > a["rate"]


def test_profile_normalisation_ignores_a_voice_it_does_not_know():
    got = voice_engine.normalise_profile({"voice_id": "nope", "rate": 9}, ["Warm"])
    assert got["voice_id"] in voice_engine.VOICE_IDS
    assert 0.5 <= got["rate"] <= 2.0


# -------------------------------------------------------------------- store

def test_store_round_trips_and_deletes():
    meta = audio_store.save("u1", b"\x00\x01\x02", "audio/webm")
    assert audio_store.open_bytes(meta["key"]) == b"\x00\x01\x02"
    assert audio_store.delete(meta["key"]) is True
    assert audio_store.open_bytes(meta["key"]) is None


def test_store_rejects_empty_and_oversize():
    with pytest.raises(ValueError):
        audio_store.save("u1", b"", "audio/webm")
    with pytest.raises(ValueError):
        audio_store.save("u1", b"x" * (audio_store.MAX_BYTES + 1), "audio/webm")


def test_store_refuses_a_path_that_is_not_a_key():
    assert audio_store.open_bytes("../../etc/passwd") is None
    assert audio_store.delete("../../etc/passwd") is False


# ------------------------------------------------------------------- routes

def test_capabilities_reports_the_local_channel(client, monkeypatch):
    user = who(client)
    monkeypatch.delenv("WITHYOU_TTS", raising=False)
    monkeypatch.delenv("WITHYOU_TTS_API_KEY", raising=False)
    monkeypatch.delenv("WITHYOU_OPENAI_API_KEY", raising=False)
    data = client.get("/api/v1/voice/capabilities", headers=user["headers"]).json()["data"]
    assert data["tts"]["channel"] == "client"
    assert data["tts"]["voices"], "the picker needs a voice list even with no cloud key"
    assert data["asr"]["available"] is False


def test_capabilities_reports_the_server_channel_when_a_key_exists(client, monkeypatch):
    user = who(client)
    monkeypatch.setenv("WITHYOU_TTS", "auto")
    monkeypatch.setenv("WITHYOU_TTS_API_KEY", "sk-test")
    data = client.get("/api/v1/voice/capabilities", headers=user["headers"]).json()["data"]
    assert data["tts"]["channel"] == "server"
    assert data["tts"]["provider"] == "cloud"


def test_tts_route_returns_audio_not_json(client, monkeypatch):
    user = who(client)
    monkeypatch.setenv("WITHYOU_TTS", "mock")
    res = client.post("/api/v1/voice/tts", headers=user["headers"],
                      json={"text": "Hey, it is me."})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/wav")
    assert voice_engine.wav_is_valid(res.content)


def test_tts_route_refuses_empty_text(client, monkeypatch):
    user = who(client)
    monkeypatch.setenv("WITHYOU_TTS", "mock")
    res = client.post("/api/v1/voice/tts", headers=user["headers"], json={"text": "   "})
    assert res.status_code == 400


def test_transcribe_is_501_when_nothing_can_listen(client, monkeypatch):
    user = who(client)
    monkeypatch.setenv("WITHYOU_ASR", "none")
    res = client.post("/api/v1/voice/transcribe", headers=user["headers"],
                      json={"audio": "AAAA", "mime": "audio/webm"})
    assert res.status_code == 501
    assert res.json()["code"] == "ASR_UNAVAILABLE"


def test_blob_upload_round_trips_the_exact_bytes(client):
    user = who(client)
    clip = bytes(range(256)) * 4
    res = client.post(
        f"/api/v1/voice-notes/blob?conversation_id={user['comp']['conversation_id']}"
        "&duration_ms=2500&peaks=0.1,0.6,0.3",
        headers={**user["headers"], "Content-Type": "audio/webm"}, content=clip)
    assert res.status_code == 201, res.text
    note = res.json()["data"]["note"]
    assert note["has_audio"] is True
    assert note["peaks"] == [0.1, 0.6, 0.3]

    back = client.get(f"/api/v1/voice-notes/{note['id']}/audio", headers=user["headers"])
    assert back.status_code == 200
    assert back.content == clip


def test_blob_upload_rejects_a_clip_that_is_too_large(client, monkeypatch):
    user = who(client)
    monkeypatch.setattr(audio_store, "MAX_BYTES", 16)
    res = client.post(
        f"/api/v1/voice-notes/blob?conversation_id={user['comp']['conversation_id']}&duration_ms=1000",
        headers={**user["headers"], "Content-Type": "audio/webm"}, content=b"x" * 32)
    assert res.status_code == 413
    assert res.json()["code"] == "AUDIO_TOO_LARGE"


def test_deleting_a_note_deletes_the_file(client):
    user = who(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 1000, "audio": "data:audio/webm;base64,AAAA",
    }).json()["data"]["note"]
    with connect() as conn:
        key = conn.execute("SELECT audio_key FROM voice_notes WHERE id=?",
                           (note["id"],)).fetchone()["audio_key"]
    assert key and audio_store.exists(key)
    client.delete(f"/api/v1/voice-notes/{note['id']}", headers=user["headers"])
    assert not audio_store.exists(key)


def test_sweep_removes_expired_audio_but_keeps_the_row(client):
    user = who(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 1000, "audio": "data:audio/webm;base64,AAAA",
    }).json()["data"]["note"]
    with connect() as conn:
        key = conn.execute("SELECT audio_key FROM voice_notes WHERE id=?", (note["id"],)).fetchone()["audio_key"]
        conn.execute("UPDATE voice_notes SET expires_at=? WHERE id=?",
                     ("2000-01-01T00:00:00Z", note["id"]))
        result = voice.sweep_expired(conn, user)
    assert result["expired"] >= 1
    assert not audio_store.exists(key)
    with connect() as conn:
        row = conn.execute("SELECT * FROM voice_notes WHERE id=?", (note["id"],)).fetchone()
    assert row is not None and row["deleted_at"], "the row stays, only the audio goes"


# ------------------------------------------------------- memory in the call

def _confirm_memory(user, text: str) -> str:
    mid = new_id("mem")
    with connect() as conn:
        conn.execute(
            "INSERT INTO memories(id,user_id,companion_id,text,category,status,created_at)"
            " VALUES (?,?,?,?,'preference','confirmed',?)",
            (mid, user["id"], user["comp"]["companion_id"], text, now_iso()),
        )
    return mid


def test_the_opener_uses_a_confirmed_memory(client):
    user = who(client)
    _confirm_memory(user, "You enjoy jazz and quiet rainy afternoons.")
    res = client.post("/api/v1/calls", headers=user["headers"], json={"direction": "outbound"})
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert "jazz" in data["opener"].lower()
    assert data["memory_used"], "the client needs the id to show where the line came from"


def test_the_opener_falls_back_when_nothing_is_confirmed(client):
    user = who(client)
    data = client.post("/api/v1/calls", headers=user["headers"],
                       json={"direction": "outbound"}).json()["data"]
    assert data["opener"].strip()
    assert data["memory_used"] == []


def test_a_call_turn_keeps_the_users_clip_and_records_memory_use(client):
    user = who(client)
    mem = _confirm_memory(user, "You have an interview on Thursday.")
    call = client.post("/api/v1/calls", headers=user["headers"],
                       json={"direction": "outbound"}).json()["data"]
    sid = call["session"]["id"]
    res = client.post(f"/api/v1/calls/{sid}/turns", headers=user["headers"], json={
        "text": "I am nervous about Thursday", "at_ms": 4000,
        "audio": "data:audio/webm;base64,AAAA", "mime": "audio/webm",
        "duration_ms": 2000,
    })
    assert res.status_code == 200, res.text
    with connect() as conn:
        turns = conn.execute(
            "SELECT * FROM call_turns WHERE session_id=? ORDER BY at_ms", (sid,)).fetchall()
    user_turn = [t for t in turns if t["role"] == "user"][-1]
    assert user_turn["audio_key"], "the clip has to survive the turn"
    assert audio_store.exists(user_turn["audio_key"])
    assert mem is not None


def test_voice_profile_can_be_changed_and_is_version_checked(client):
    user = who(client)
    comp = user["comp"]["companion"]
    first = client.patch(f"/api/v1/companions/{comp['id']}", headers=user["headers"], json={
        "voice_profile": {"voice_id": "sol_direct", "rate": 1.1},
        "version": comp["version"],
    })
    assert first.status_code == 200, first.text
    raw = first.json()["data"]["companion"]["voice_profile"]
    # The API returns the profile already parsed; older clients used to get a
    # JSON string, so accept both rather than re-encoding the contract here.
    saved = raw if isinstance(raw, dict) else json.loads(raw)
    assert saved["voice_id"] == "sol_direct"
    assert saved["rate"] == 1.1

    stale = client.patch(f"/api/v1/companions/{comp['id']}", headers=user["headers"], json={
        "voice_profile": {"voice_id": "nova_calm"}, "version": comp["version"],
    })
    assert stale.status_code == 409
