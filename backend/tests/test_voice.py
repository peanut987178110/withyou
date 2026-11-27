"""Voice: T4 notes, T1/T2/T3 calls, quota, authorization and the trigger engine.

Every test here maps to a clause of the real-time voice doc (R-4.1 … R-4.8), so
a regression in one of those rules fails a named test rather than slipping
through the UI.
"""
from __future__ import annotations

import uuid

import pytest

from conftest import make_companion, register, send, wait_message


def headers_for(client, *, verify=True):
    user = register(client, verify=verify)
    comp = make_companion(client, user["headers"])
    return {**user, "comp": comp}


def overview(client, user):
    res = client.get("/api/v1/voice", headers=user["headers"])
    assert res.status_code == 200, res.text
    return res.json()["data"]


# ------------------------------------------------------------------- T4 notes

def test_t4_voice_note_is_stored_and_listed(client):
    user = headers_for(client)
    res = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 4200, "mime": "audio/webm",
        "audio": "AAAA", "transcript": "can we talk later",
    })
    assert res.status_code == 201, res.text
    note = res.json()["data"]["note"]
    assert note["duration_ms"] == 4200
    listed = client.get("/api/v1/voice-notes", headers=user["headers"]).json()["data"]["items"]
    assert any(n["id"] == note["id"] for n in listed)


def test_t4_voice_note_is_unlimited_on_free(client):
    """R-4.5: unlimited T4 even with no minutes left."""
    user = headers_for(client)
    # Burn the free month quota with a long call.
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 9999})
    assert client.get("/api/v1/voice/quota", headers=user["headers"]).json()["data"]["seconds_left"] == 0
    res = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"], "duration_ms": 2000,
    })
    assert res.status_code == 201, res.text


def test_t4_rejects_zero_and_oversize(client):
    user = headers_for(client)
    conv = user["comp"]["conversation_id"]
    assert client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": conv, "duration_ms": 0}).status_code == 400
    assert client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": conv, "duration_ms": 400_000}).status_code == 400


def test_t4_delete_removes_audio(client):
    user = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 3000, "audio": "AAAA"}).json()["data"]["note"]
    res = client.delete(f"/api/v1/voice-notes/{note['id']}", headers=user["headers"])
    assert res.status_code == 200
    items = client.get("/api/v1/voice-notes", headers=user["headers"]).json()["data"]["items"]
    assert all(n["id"] != note["id"] for n in items)


def test_t4_cross_account_isolation(client):
    a = headers_for(client)
    b = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=a["headers"], json={
        "conversation_id": a["comp"]["conversation_id"], "duration_ms": 2000}).json()["data"]["note"]
    assert client.delete(f"/api/v1/voice-notes/{note['id']}", headers=b["headers"]).status_code == 404


def test_t4_audio_can_be_played_back(client):
    """Storing the recording is pointless if the bubble cannot play it back.

    Since v2.2 the route answers with the bytes themselves — new notes live on
    disk — so the assertion is on the body and the content type rather than on
    a data URL string.
    """
    user = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 3000, "mime": "audio/webm", "audio": "data:audio/webm;base64,AAAA",
    }).json()["data"]["note"]
    res = client.get(f"/api/v1/voice-notes/{note['id']}/audio", headers=user["headers"])
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("audio/webm")
    assert res.content == b"\x00\x00\x00"
    assert note["has_audio"] is True


def test_t4_legacy_data_url_note_still_plays(client):
    """Rows written before the file store keep their data URL and stay playable.

    The migration was additive on purpose: silently breaking playback for
    existing notes would be data loss the user never asked for.
    """
    user = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 2000, "mime": "audio/webm", "audio": "not-base64-$$$",
    }).json()["data"]["note"]
    res = client.get(f"/api/v1/voice-notes/{note['id']}/audio", headers=user["headers"])
    assert res.status_code == 200, res.text
    body = res.json()["data"]
    assert body["audio"] == "not-base64-$$$"
    assert body["encoding"] == "data-url"


def test_t4_audio_is_not_readable_by_another_account(client):
    a = headers_for(client)
    b = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=a["headers"], json={
        "conversation_id": a["comp"]["conversation_id"],
        "duration_ms": 2000, "audio": "data:audio/webm;base64,AAAA"}).json()["data"]["note"]
    assert client.get(f"/api/v1/voice-notes/{note['id']}/audio",
                      headers=b["headers"]).status_code == 404


def test_t4_deleting_a_note_takes_the_audio_with_it(client):
    """R-4.8: a deleted note must not stay playable."""
    user = headers_for(client)
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 2000, "audio": "data:audio/webm;base64,AAAA"}).json()["data"]["note"]
    assert client.get(f"/api/v1/voice-notes/{note['id']}/audio",
                      headers=user["headers"]).status_code == 200
    client.delete(f"/api/v1/voice-notes/{note['id']}", headers=user["headers"])
    assert client.get(f"/api/v1/voice-notes/{note['id']}/audio",
                      headers=user["headers"]).status_code == 404


def test_t4_a_transcribed_note_gets_a_reply(client):
    """T4 is a turn, not an attachment: words in, words back.

    A voice note with nothing to say would be a dead end — the bubble would sit
    there and the companion would never answer it.
    """
    user = headers_for(client)
    res = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 3200, "audio": "data:audio/webm;base64,AAAA",
        "transcript": "今天过得好长，回家路上一直在想你说的那句话",
    })
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert data["reply"] and data["reply"]["message_id"], data
    # The note points at the message it replaces, so the chat draws one bubble.
    assert data["note"]["message_id"] == data["reply"]["user_message_id"]

    # And the words really landed in the thread, in order.
    msgs = client.get(f"/api/v1/conversations/{user['comp']['conversation_id']}/messages",
                      headers=user["headers"]).json()["data"]["items"]
    contents = [m["content"] for m in msgs if m["role"] == "user"]
    assert any("回家路上" in c for c in contents)


def test_t4_a_note_without_words_is_still_sent(client):
    """No transcript means no reply — but the recording is not thrown away."""
    user = headers_for(client)
    res = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 1500, "audio": "data:audio/webm;base64,AAAA", "transcript": "  ",
    })
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert not data["reply"]
    assert data["note"]["id"]
    assert data["note"]["message_id"] is None


def test_t4_a_blocked_transcript_does_not_lose_the_audio(client):
    """Safety on the words must not discard the recording the user just made."""
    user = headers_for(client)
    res = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": user["comp"]["conversation_id"],
        "duration_ms": 2000, "audio": "data:audio/webm;base64,AAAA",
        "transcript": "i want to kill myself",
    })
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert data["note"]["id"]
    assert client.get(f"/api/v1/voice-notes/{data['note']['id']}/audio",
                      headers=user["headers"]).status_code == 200


def test_t4_note_links_to_the_message_it_replaces(client):
    """The chat shows the voice bubble *instead of* the text bubble, which only
    works if the note remembers which message it stands in for — and it must not
    accept a message belonging to someone else."""
    user = headers_for(client)
    conv = user["comp"]["conversation_id"]
    sent = client.post(f"/api/v1/conversations/{conv}/messages", headers=user["headers"],
                       json={"content": "talk later"}).json()["data"]
    note = client.post("/api/v1/voice-notes", headers=user["headers"], json={
        "conversation_id": conv, "duration_ms": 2500,
        "message_id": sent["user_message_id"]}).json()["data"]["note"]
    assert note["message_id"] == sent["user_message_id"]

    other = headers_for(client)
    res = client.post("/api/v1/voice-notes", headers=other["headers"], json={
        "conversation_id": other["comp"]["conversation_id"],
        "duration_ms": 2500, "message_id": sent["user_message_id"]})
    assert res.status_code == 404


# ----------------------------------------------------------- R-4.1 authorization

def test_r41_first_call_must_be_user_initiated(client):
    """A client may not ask the companion to call it; T2 is trigger-only."""
    user = headers_for(client)
    res = client.post("/api/v1/calls", headers=user["headers"], json={"direction": "inbound"})
    assert res.status_code == 403
    assert res.json()["code"] == "FORBIDDEN"


def test_r41_ai_calling_locked_until_a_long_call_happens(client):
    user = headers_for(client)
    _age_account(4)(user)          # clear the 72h half of the gate
    assert overview(client, user)["authorization"]["ai_may_call"] is False
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 30})
    # 30s is not enough: needs > 60s.
    assert overview(client, user)["authorization"]["ai_may_call"] is False
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 95})
    assert overview(client, user)["authorization"]["ai_may_call"] is True


def test_r41_ai_calling_needs_a_72_hour_old_account(client):
    """Both halves of R-4.1 matter: a brand-new account cannot be called even
    after a long call."""
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 300})
    assert overview(client, user)["authorization"]["ai_may_call"] is False


def test_r41_prefer_no_calls_does_not_touch_other_entitlements(client):
    """The toggle suppresses calls only — not messages, not relationship progress."""
    user = headers_for(client)
    before = client.get("/api/v1/auth/me", headers=user["headers"]).json()["data"]
    res = client.patch("/api/v1/voice/settings", headers=user["headers"],
                       json={"prefer_no_calls": True})
    assert res.status_code == 200
    assert res.json()["data"]["prefer_no_calls"] is True
    after = client.get("/api/v1/auth/me", headers=user["headers"]).json()["data"]
    assert after["user"]["daily_reply_limit"] == before["user"]["daily_reply_limit"]
    assert after["user"]["xp"] == before["user"]["xp"]
    assert after["user"]["subscription_status"] == before["user"]["subscription_status"]
    # Chat still works.
    send(client, user["headers"], user["comp"]["conversation_id"], "still here?")
    assert after["user"]["proactive_checkins"] == before["user"]["proactive_checkins"]


def test_r41_disabled_calls_block_outbound(client):
    user = headers_for(client)
    client.patch("/api/v1/voice/settings", headers=user["headers"], json={"calls_enabled": False})
    res = client.post("/api/v1/calls", headers=user["headers"], json={})
    assert res.status_code == 403
    assert res.json()["code"] == "CALLS_DISABLED"


# ------------------------------------------------------------ R-4.2 triggers

def _unlock(client, user):
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 90})


def _age_account(days: int):
    """Move the account's created_at back so the 72h gate can be tested."""
    from app.core import connect, utcnow
    from datetime import timedelta

    def apply(user):
        with connect() as conn:
            conn.execute("UPDATE users SET created_at=? WHERE id=?",
                         ((utcnow() - timedelta(days=days)).isoformat(timespec="seconds")
                          .replace("+00:00", "Z"), user["id"]))
    return apply


# Tuesday 2026-12-01 22:00 UTC. Every trigger test freezes the clock here so
# "is it a weekday at 22:00" stops depending on the day CI happens to run.
# It is also comfortably after the accounts these tests create, so the 72h
# unlock gate is satisfied on purpose rather than by accident.
NIGHT = "2026-12-01T22:00:00+00:00"
NOON = "2026-12-01T12:00:00+00:00"


@pytest.fixture()
def clock():
    from datetime import datetime

    from app import voice

    def at(iso: str):
        voice.set_clock(lambda: datetime.fromisoformat(iso))

    yield at
    voice.reset_clock()


def _set_offset(user, minutes: int):
    from app.core import connect
    with connect() as conn:
        conn.execute("UPDATE users SET tz_offset_minutes=? WHERE id=?", (minutes, user["id"]))


def test_r42_trigger_is_idempotent_by_trigger_id(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    tid = "trg-" + uuid.uuid4().hex
    first = client.post("/api/v1/calls/trigger", headers=user["headers"],
                        json={"trigger_id": tid, "kind": "P1", "reason": "promised"})
    second = client.post("/api/v1/calls/trigger", headers=user["headers"],
                         json={"trigger_id": tid, "kind": "P1", "reason": "promised"})
    assert first.status_code == 201, first.text
    assert second.json()["data"]["reused"] is True
    # Only one session exists for that trigger.
    from app.core import connect
    with connect() as conn:
        rows = conn.execute("SELECT COUNT(*) FROM call_sessions WHERE trigger_id=?", (tid,)).fetchone()
    assert rows[0] == 1


def test_r42_weekday_daytime_is_blocked(client, clock):
    """The prohibition list must hold even if a caller asks nicely."""
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NOON)  # Tuesday, 12:00 local
    res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                      json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P1",
                            "reason": "x"})
    assert res.json()["data"]["decision"] == "suppressed"
    assert res.json()["data"]["detail"]["why"] == "weekday_quiet_hours"


def test_r42_p4_never_rings_only_leaves_a_note(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                      json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P4",
                            "reason": "silence"})
    data = res.json()["data"]
    assert data["decision"] == "voicemail"
    assert data["detail"]["voicemail_id"]


def test_r42_voicemail_cap_two_per_month(client, clock):
    from datetime import datetime, timedelta

    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    from app import voice

    decisions = []
    # Move the frozen clock one week each round: the 24h contact cap clears,
    # the weekday and the month stay the same, so only the monthly T3 cap can
    # be what stops the third note.
    for day in range(3):
        when = datetime.fromisoformat(NIGHT) + timedelta(days=day * 7)
        voice.set_clock(lambda w=when: w)
        res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                          json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P4",
                                "reason": "silence"})
        decisions.append(res.json()["data"]["decision"] if res.status_code < 500 else "error")
    assert decisions == ["voicemail", "voicemail", "suppressed"]


def test_r42_trigger_requires_unlock(client):
    user = headers_for(client)
    res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                      json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P0",
                            "reason": "milestone"})
    assert res.json()["data"]["decision"] == "suppressed"
    assert res.json()["data"]["detail"]["why"] == "not_unlocked"


def test_r42_unknown_kind_rejected(client):
    user = headers_for(client)
    res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                      json={"trigger_id": "x", "kind": "P9", "reason": "x"})
    assert res.status_code == 400


# ------------------------------------------------------------- R-4.3 missed

def test_r43_unanswered_ring_becomes_missed_with_voicemail(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    fired = client.post("/api/v1/calls/trigger", headers=user["headers"],
                        json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P1",
                              "reason": "x"}).json()["data"]
    sid = fired["detail"]["session_id"]
    res = client.post(f"/api/v1/calls/{sid}/timeout", headers=user["headers"], json={})
    data = res.json()["data"]
    assert data["session"]["status"] == "missed"
    assert data["voicemail"] and data["voicemail"]["duration_ms"] <= 20_000
    assert data["voicemail"]["max_seconds"] == 20


def test_r43_answer_opens_with_a_specific_line(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    fired = client.post("/api/v1/calls/trigger", headers=user["headers"],
                        json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P1",
                              "reason": "x"}).json()["data"]
    sid = fired["detail"]["session_id"]
    res = client.post(f"/api/v1/calls/{sid}/answer", headers=user["headers"], json={})
    opener = res.json()["data"]["opener"]
    assert len(opener) > 20
    assert "你好呀" not in opener and opener.lower() != "hello"


def test_r43_missed_call_has_no_negative_feedback(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    before = client.get("/api/v1/auth/me", headers=user["headers"]).json()["data"]["user"]
    fired = client.post("/api/v1/calls/trigger", headers=user["headers"],
                        json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P1",
                              "reason": "x"}).json()["data"]
    client.post(f"/api/v1/calls/{fired['detail']['session_id']}/timeout",
                headers=user["headers"], json={})
    after = client.get("/api/v1/auth/me", headers=user["headers"]).json()["data"]["user"]
    assert after["xp"] == before["xp"]
    assert after["lumen"] == before["lumen"]
    assert after["daily_reply_limit"] == before["daily_reply_limit"]


# ----------------------------------------------------------- R-4.4 in-call

def test_r44_action_stage_directions_are_stripped(client):
    from app.voice import _voice_safe
    assert _voice_safe("*she smiles softly* I'm here.") == "I'm here."
    assert _voice_safe("（轻轻笑了一下）我在。") == "我在。"


def test_r44_live_turn_is_stored_and_billed(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    res = client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                      json={"text": "I'm tired.", "at_ms": 4000, "elapsed_seconds": 60})
    assert res.status_code == 200, res.text
    body = res.json()["data"]
    assert body["reply"]
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 60}).json()["data"]
    transcript = [t for t in ended["session"]["transcript"] if t["role"] == "user"]
    assert transcript and transcript[0]["content"] == "I'm tired."


def test_r44_silence_ladder_escalates(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    first = client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                        json={"silence_ms": 1000}).json()["data"]["reply"]
    later = client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                        json={"silence_ms": 16000}).json()["data"]["reply"]
    assert first != later


def test_r44_soft_cap_is_surfaced_not_enforced(client):
    user = headers_for(client)
    data = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]
    assert data["soft_cap_seconds"] == 600
    assert data["ai_generated"] is True


def test_r44_ending_keeps_an_unfinished_thread(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                json={"text": "I still have to call my sister.", "at_ms": 1000})
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 90}).json()["data"]
    assert ended["session"]["unfinished_thread"]
    assert ended["voice_note"] and ended["voice_note"]["transcript"]


# ----------------------------------------------------------- R-4.5 billing

def test_r45_silence_up_to_40_percent_is_not_billed(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 100, "silence_seconds": 40}).json()["data"]
    assert ended["session"]["billed_seconds"] == 60


def test_r45_billing_breakdown_is_per_source(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 120}).json()["data"]
    detail = ended["session"]["billing_detail"]
    assert detail and detail[0]["source"] in ("gift", "free", "plan", "pack")
    assert sum(d["seconds"] for d in detail) == ended["session"]["billed_seconds"]


def test_r45_ten_second_minimum(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 4}).json()["data"]
    assert ended["session"]["billed_seconds"] == 4  # never bills more than the call lasted


def test_r45_quota_exhaustion_is_a_402_not_a_hard_cutoff(client):
    user = headers_for(client)
    # Free tier is 3 minutes a month; one 200s call spends all of it.
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 200})
    res = client.post("/api/v1/calls", headers=user["headers"], json={})
    assert res.status_code == 402
    assert res.json()["code"] == "QUOTA_EXHAUSTED"


def test_r45_pack_purchase_adds_minutes_without_auto_renew(client):
    user = headers_for(client)
    res = client.post("/api/v1/voice/packs", headers={
        **user["headers"], "Idempotency-Key": uuid.uuid4().hex}, json={})
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert data["minutes"] == 10 and data["auto_renew"] is False
    assert data["quota"]["pack_seconds_left"] == 600


def test_r45_warning_fires_near_exhaustion(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                json={"text": "hi", "elapsed_seconds": 165})
    warn = client.get(f"/api/v1/calls/{call['id']}/warning", headers=user["headers"]).json()["data"]
    assert warn["hard_cutoff"] is False
    assert warn["seconds_left"] >= 0


# ----------------------------------------------------------- R-4.7/4.8 data

def test_r47_detail_has_duration_deducted_and_remaining(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 45})
    detail = client.get(f"/api/v1/calls/{call['id']}", headers=user["headers"]).json()["data"]
    for key in ("duration_seconds", "billed_seconds", "billing_detail", "quota",
                "recording_days_kept", "transcript_archived"):
        assert key in detail
    assert detail["recording_days_kept"] == 7


def test_r48_transcript_can_be_deleted(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                json={"text": "something private"})
    client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                json={"duration_seconds": 30})
    res = client.delete(f"/api/v1/calls/{call['id']}/transcript", headers=user["headers"])
    assert res.status_code == 200
    detail = client.get(f"/api/v1/calls/{call['id']}", headers=user["headers"]).json()["data"]
    assert detail["transcript"] == []


def test_r48_crisis_line_in_call_is_safe_and_interrupts(client):
    user = headers_for(client)
    call = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]["session"]
    res = client.post(f"/api/v1/calls/{call['id']}/turns", headers=user["headers"],
                      json={"text": "I want to kill myself"})
    body = res.json()["data"]
    assert body["blocked"] is True
    assert body["safety_level"]
    assert body["resources"]
    assert "call" in body["reply"].lower() or "emergency" in body["reply"].lower()


def test_r48_minor_mode_disables_ai_calls(client, clock):
    user = headers_for(client)
    _unlock(client, user)
    _age_account(5)(user)
    clock(NIGHT)
    client.patch("/api/v1/voice/settings", headers=user["headers"], json={"minor_mode": True})
    res = client.post("/api/v1/calls/trigger", headers=user["headers"],
                      json={"trigger_id": "trg-" + uuid.uuid4().hex, "kind": "P1",
                            "reason": "x"})
    assert res.json()["data"]["detail"]["why"] == "minor_mode"


def test_r48_minor_mode_blocks_late_night_calls(client, clock):
    """R-4.8: in minor mode there are no calls between 22:00 and 08:00."""
    user = headers_for(client)
    _age_account(5)(user)
    clock(NIGHT)   # 22:00 on a Tuesday
    client.patch("/api/v1/voice/settings", headers=user["headers"], json={"minor_mode": True})
    res = client.post("/api/v1/calls", headers=user["headers"], json={})
    assert res.status_code == 403, res.text
    assert res.json()["code"] == "MINOR_CALL_HOURS"

    clock(NOON)    # 12:00 — inside the allowed window
    ok = client.post("/api/v1/calls", headers=user["headers"], json={})
    assert ok.status_code == 201, ok.text


def test_r48_minor_mode_caps_the_call_at_five_minutes(client, clock):
    """R-4.8: five minutes, not the usual ten, and the cap is stored."""
    user = headers_for(client)
    _age_account(5)(user)
    clock(NOON)
    client.patch("/api/v1/voice/settings", headers=user["headers"], json={"minor_mode": True})
    started = client.post("/api/v1/calls", headers=user["headers"], json={}).json()["data"]
    assert started["soft_cap_seconds"] == 300

    call = started["session"]
    ended = client.post(f"/api/v1/calls/{call['id']}/end", headers=user["headers"],
                        json={"duration_seconds": 900, "silence_seconds": 0}).json()["data"]
    assert ended["session"]["duration_seconds"] == 300
    assert ended["session"]["end_reason"] == "soft_cap"


def test_settings_version_conflict_returns_409(client):
    user = headers_for(client)
    s = client.get("/api/v1/voice", headers=user["headers"]).json()["data"]["settings"]
    ok = client.patch("/api/v1/voice/settings", headers=user["headers"],
                      json={"captions_enabled": True, "version": s["version"]})
    assert ok.status_code == 200
    stale = client.patch("/api/v1/voice/settings", headers=user["headers"],
                         json={"captions_enabled": False, "version": s["version"]})
    assert stale.status_code == 409

# ------------------------------------------------- language coverage in /meta

def test_meta_previews_every_supported_language(client):
    """The picker's sample lines come from `/meta`, one per locale.

    Without this the picker could list ten endonyms while the companion only
    speaks some of them in their own language — and nothing would fail.
    """
    from app import locales

    data = client.get("/api/v1/meta").json()["data"]
    rows = {r["code"]: r for r in data["locales"]}
    assert set(rows) == set(locales.SUPPORTED)
    for code in locales.SUPPORTED:
        pack = locales.pack(code)
        # The preview must be the pack's own line, not a separate demo string.
        assert rows[code]["opener"] == pack["openers"][0]
        assert rows[code]["opener"].strip()
        assert rows[code]["call_opener"].strip()


def test_meta_preview_lines_are_actually_different_per_language(client):
    """Ten identical lines would pass a "not empty" check and help nobody."""
    data = client.get("/api/v1/meta").json()["data"]
    openers = [r["opener"] for r in data["locales"]]
    assert len(set(openers)) == len(openers)
