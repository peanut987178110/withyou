"""Voice: settings, quota, calls (T1/T2/T3), voice notes (T4), transcripts.

Routes are thin on purpose — the rules live in `voice.py` so they are enforced
the same way whether the caller is the app, a test, or the trigger engine.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import content, voice
from ..core import ApiError, connect, is_plus, require_user
from .common import body, idem, ok

router = APIRouter(tags=["voice"])


@router.get("/voice")
async def voice_overview(request: Request):
    """Everything the Voice & call screen needs in one round trip."""
    user = require_user(request)
    with connect() as conn:
        settings = voice.settings_row(conn, user["id"])
        quota = voice.quota_payload(conn, user, is_plus(user))
        calls = voice.list_calls(conn, user, limit=10)
        voicemails = voice.list_voicemails(conn, user)
        notes = voice.list_notes(conn, user)
        unlocked = voice.ai_calls_unlocked(conn, user)
    return ok(request, {
        "settings": settings,
        "quota": quota,
        "calls": calls,
        "voicemails": voicemails,
        "notes": notes,
        "authorization": {
            "user_may_call": True,
            "ai_may_call": unlocked,
            "requires": {
                "min_call_seconds": voice.AI_CALL_MIN_CALL_SECONDS,
                "min_account_hours": voice.AI_CALL_MIN_AGE_HOURS,
            },
        },
        "limits": {
            "ring_timeout_seconds": voice.RING_TIMEOUT_SECONDS,
            "voicemail_max_seconds": voice.VOICEMAIL_MAX_SECONDS,
            "voicemail_per_month": voice.T3_PER_MONTH,
            "soft_cap_seconds": voice.SOFT_CAP_SECONDS,
            "minor_soft_cap_seconds": voice.MINOR_SOFT_CAP_SECONDS,
            "minor_quiet_hours": list(voice.MINOR_QUIET_HOURS),
            "silence_forgiveness": voice.SILENCE_FORGIVENESS,
            "bill_min_seconds": voice.BILL_MIN_SECONDS,
            "pack_minutes": voice.PACK_MINUTES,
            "pack_price_cents": voice.PACK_PRICE_CENTS,
        },
    })


@router.patch("/voice/settings")
async def patch_voice_settings(request: Request):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        settings = voice.update_settings(conn, user, payload)
    return ok(request, settings)


@router.get("/voice/quota")
async def get_quota(request: Request):
    user = require_user(request)
    with connect() as conn:
        data = voice.quota_payload(conn, user, is_plus(user))
    return ok(request, data)


@router.post("/voice/packs", status_code=201)
async def buy_voice_pack(request: Request):
    """6元 / 10 minutes. No auto-renew, and the client never pre-ticks it."""
    user = require_user(request)
    key = idem(request)
    with connect() as conn:
        replay = None
        if key:
            from ..core import idempotent_replay, idempotent_save
            replay = idempotent_replay(conn, user["id"], key, "POST /voice/packs", {})
            if replay is not None:
                return ok(request, replay, "replayed", 200)
        result = voice.buy_pack(conn, user)
        if key:
            idempotent_save(conn, user["id"], key, "POST /voice/packs", {}, 201, result)
        quota = voice.quota_payload(conn, user, is_plus(user))
    return ok(request, {**result, "quota": quota}, "purchased", 201)


# -------------------------------------------------------------------- calls

@router.post("/calls", status_code=201)
async def start_call(request: Request):
    """T1: the user calls the companion. Always allowed while calls are on."""
    user = require_user(request)
    payload = await body(request)
    direction = str(payload.get("direction") or "outbound")
    if direction != "outbound":
        # T2 can only be started by the trigger engine, never by a client that
        # asks for it — otherwise the frequency caps are decorative.
        raise ApiError(403, "FORBIDDEN", "Incoming calls are started by the companion, not the client.")
    with connect() as conn:
        session = voice.create_session(conn, user, direction="outbound")
        quota = voice.quota_payload(conn, user, is_plus(user))
        opener = voice._opener_for({"id": session["id"], "trigger_id": None}, user)
        settings = voice.settings_row(conn, user["id"])
    return ok(request, {"session": session, "opener": opener,
                        "quota": quota,
                        "soft_cap_seconds": voice.soft_cap_for(settings),
                        "minor_mode": settings["minor_mode"],
                        "ai_generated": True}, "ringing", 201)


@router.post("/calls/trigger")
async def fire_trigger(request: Request):
    """The trigger engine's entry point (P0–P4).

    Kept as an authenticated user route rather than an internal one because in
    this build the scheduler is the same process; the contract (idempotent by
    trigger_id, never by wall-clock) is what production keeps.
    """
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        result = voice.evaluate_trigger(conn, user, payload)
    fired = result["decision"] in ("call", "voicemail")
    return JSONResponse(
        status_code=201 if fired else 200,
        content=ok(request, result, result["decision"]),
    )


@router.get("/calls")
async def list_calls(request: Request):
    user = require_user(request)
    with connect() as conn:
        items = voice.list_calls(conn, user)
        voicemails = voice.list_voicemails(conn, user)
    return ok(request, {"items": items, "voicemails": voicemails})


@router.get("/calls/{session_id}")
async def get_call(request: Request, session_id: str):
    user = require_user(request)
    with connect() as conn:
        data = voice.call_detail(conn, user, session_id)
    return ok(request, data)


@router.post("/calls/{session_id}/answer")
async def answer_call(request: Request, session_id: str):
    user = require_user(request)
    with connect() as conn:
        result = voice.answer_call(conn, user, session_id)
    return ok(request, result)


@router.post("/calls/{session_id}/turns")
async def say(request: Request, session_id: str):
    """One turn of the live conversation. Text only — audio stays on device."""
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        result = voice.say(conn, user, session_id, payload)
    return ok(request, result)


@router.get("/calls/{session_id}/warning")
async def call_warning(request: Request, session_id: str):
    user = require_user(request)
    with connect() as conn:
        result = voice.warn_threshold(conn, user, session_id)
    return ok(request, result)


@router.post("/calls/{session_id}/timeout")
async def ring_timeout(request: Request, session_id: str):
    """R-4.3: 30s unanswered → missed, one voicemail, then silence."""
    user = require_user(request)
    with connect() as conn:
        result = voice.timeout_ring(conn, user, session_id)
    return ok(request, result)


@router.post("/calls/{session_id}/end")
async def end_call(request: Request, session_id: str):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        result = voice.end_call(conn, user, session_id, payload)
    return ok(request, result)


@router.delete("/calls/{session_id}/transcript")
async def delete_transcript(request: Request, session_id: str):
    user = require_user(request)
    with connect() as conn:
        result = voice.delete_transcript(conn, user, session_id)
    return ok(request, result)


# -------------------------------------------------------------- voice notes

@router.get("/voice-notes")
async def list_notes(request: Request, conversation_id: str | None = None):
    user = require_user(request)
    with connect() as conn:
        items = voice.list_notes(conn, user, conversation_id)
    return ok(request, {"items": items})


@router.post("/voice-notes", status_code=201)
async def create_note(request: Request):
    """T4: a voice message. Unlimited on every plan, including free.

    When the note carries a transcript, it is also fed through the normal
    message pipeline. A voice note is a turn, not an attachment — sending one
    the companion never answers would make the feature a dead end.
    """
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        note = voice.create_note(conn, user, payload)
        reply = None
        text = (note.get("transcript") or "").strip()
        if text and not note.get("message_id"):
            from .. import chat_service
            try:
                result = chat_service.send_message(
                    conn, user, note["conversation_id"],
                    {"content": text, "client_message_id": payload.get("client_message_id")},
                )
                voice.link_note(conn, user, note["id"], result["user_message_id"])
                note["message_id"] = result["user_message_id"]
                reply = result
            except ApiError:
                # The note itself is already stored; a rate limit or a safety
                # block on the words must not undo the recording.
                reply = None
    return ok(request, {"note": note, "reply": reply}, "created", 201)


@router.delete("/voice-notes/{note_id}")
async def delete_note(request: Request, note_id: str):
    user = require_user(request)
    with connect() as conn:
        result = voice.delete_note(conn, user, note_id)
    return ok(request, result)


@router.get("/voice-notes/{note_id}/audio")
async def note_audio(request: Request, note_id: str):
    """Playback. Kept separate from the list so a thread of notes stays light."""
    user = require_user(request)
    with connect() as conn:
        data = voice.note_audio(conn, user, note_id)
    return ok(request, data)


# --------------------------------------------------------------- voicemails

@router.get("/voicemails")
async def list_voicemails(request: Request):
    user = require_user(request)
    with connect() as conn:
        items = voice.list_voicemails(conn, user)
    return ok(request, {"items": items})


@router.patch("/voicemails/{vid}")
async def patch_voicemail(request: Request, vid: str):
    user = require_user(request)
    payload = await body(request)
    status = str(payload.get("status") or "")
    with connect() as conn:
        item = voice.mark_voicemail(conn, user, vid, status)
    return ok(request, item)