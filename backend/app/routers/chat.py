"""Companions, conversations, messages, SSE, feedback and reports."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .. import chat_service, content, services
from ..core import (
    ApiError, connect, new_id, now_iso, require_user, require_verified,
)
from .common import body, ok

router = APIRouter(tags=["chat"])

POLICY_VERSION = "2026-11-18.1"


def _companion_json(row) -> dict[str, Any]:
    data = dict(row)
    data["traits"] = json.loads(data.get("traits") or "[]")
    # The client should not have to parse a JSON string inside a JSON response
    # to find out which voice it is holding.
    raw = data.get("voice_profile")
    if isinstance(raw, str):
        try:
            data["voice_profile"] = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data["voice_profile"] = {}
    return data


@router.get("/companions")
async def list_companions(request: Request):
    user = require_user(request)
    with connect() as conn:
        rows = conn.execute("SELECT * FROM companions WHERE user_id=?", (user["id"],)).fetchall()
        info = services.level_info(user["xp"])
    return ok(request, {"items": [_companion_json(r) for r in rows], "level": info,
                        "relationship_types": content.RELATIONSHIP_TYPES})


@router.post("/companions", status_code=201)
async def create_companion(request: Request):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        result = chat_service.create_companion_and_conversation(conn, user, payload)
        comp = result["companion"]
        conv = result["conversation"]
        created = result["created"]
    return ok(request, {
        "companion_id": comp["id"],
        "conversation_id": conv["id"],
        "version": comp["version"],
        "created": created,
        "companion": _companion_json(comp),
    }, "created" if created else "ok", 201 if created else 200)


@router.get("/companions/{companion_id}")
async def get_companion(request: Request, companion_id: str):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM companions WHERE id=? AND user_id=?",
                           (companion_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Companion not found.")
        data = _companion_json(row)
        data["level"] = services.level_info(user["xp"])
    return ok(request, data)


@router.patch("/companions/{companion_id}")
async def patch_companion(request: Request, companion_id: str):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM companions WHERE id=? AND user_id=?",
                           (companion_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Companion not found.")
        if "version" in payload and int(payload["version"]) != int(row["version"]):
            raise ApiError(409, "CONFLICT", "This companion was updated elsewhere. Reload and try again.")
        updates: dict[str, Any] = {}
        if "name" in payload:
            name = str(payload["name"]).strip()
            if not 1 <= len(name) <= 24:
                raise ApiError(400, "VALIDATION_ERROR", "Name must be 1–24 characters.")
            updates["name"] = name
        if "traits" in payload:
            traits = payload["traits"]
            if not isinstance(traits, list) or not 1 <= len(traits) <= 5:
                raise ApiError(400, "VALIDATION_ERROR", "Choose 1–5 traits.")
            updates["traits"] = json.dumps(traits)
        if "relationship_type" in payload:
            rel = str(payload["relationship_type"])
            if rel not in {r["id"] for r in content.RELATIONSHIP_TYPES}:
                raise ApiError(400, "VALIDATION_ERROR", "Unknown relationship type.")
            updates["relationship_type"] = rel
        for field in ("energy", "intent", "wardrobe_item", "room_id"):
            if field in payload:
                updates[field] = payload[field]
        if "voice_profile" in payload:
            from .. import voice_engine
            traits_now = json.loads(updates.get("traits", row["traits"]) or "[]")
            profile = voice_engine.normalise_profile(
                payload["voice_profile"], traits_now, user.get("locale") or "en")
            updates["voice_profile"] = json.dumps(profile, ensure_ascii=False)
        if not updates:
            raise ApiError(400, "VALIDATION_ERROR", "Nothing to update.")
        sets = ", ".join(f"{k}=?" for k in updates)
        conn.execute(
            f"UPDATE companions SET {sets}, version=version+1 WHERE id=? AND user_id=?",
            (*updates.values(), companion_id, user["id"]),
        )
        fresh = conn.execute("SELECT * FROM companions WHERE id=?", (companion_id,)).fetchone()
    return ok(request, {"companion": _companion_json(fresh), "version": fresh["version"]})


@router.post("/conversations", status_code=201)
async def create_conversation(request: Request):
    user = require_user(request)
    payload = await body(request)
    companion_id = payload.get("companion_id")
    with connect() as conn:
        if not companion_id:
            row = conn.execute("SELECT id FROM companions WHERE user_id=? ORDER BY created_at LIMIT 1",
                               (user["id"],)).fetchone()
            if not row:
                raise ApiError(404, "NOT_FOUND", "Create a companion first.")
            companion_id = row["id"]
        conv = chat_service.ensure_conversation(conn, user, companion_id)
    return ok(request, {"conversation_id": conv["id"], "policy_version": POLICY_VERSION})


@router.get("/conversations")
async def list_conversations(request: Request):
    user = require_user(request)
    with connect() as conn:
        rows = conn.execute(
            "SELECT c.*, (SELECT content FROM messages m WHERE m.conversation_id=c.id"
            " AND m.role='assistant' ORDER BY m.created_at DESC LIMIT 1) AS preview"
            " FROM conversations c WHERE c.user_id=? ORDER BY c.last_at DESC",
            (user["id"],),
        ).fetchall()
    return ok(request, {"items": [dict(r) for r in rows]})


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(request: Request, conversation_id: str, limit: int = 50,
                        before_id: str | None = None):
    user = require_user(request)
    limit = max(1, min(int(limit or 20), 100))
    with connect() as conn:
        conv = conn.execute("SELECT * FROM conversations WHERE id=? AND user_id=?",
                            (conversation_id, user["id"])).fetchone()
        if not conv:
            raise ApiError(404, "NOT_FOUND", "Conversation not found.")
        sql = "SELECT * FROM messages WHERE conversation_id=?"
        args: list[Any] = [conversation_id]
        if before_id:
            pivot = conn.execute("SELECT created_at FROM messages WHERE id=?", (before_id,)).fetchone()
            if pivot:
                sql += " AND created_at < ?"
                args.append(pivot["created_at"])
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        rows = conn.execute(sql, args).fetchall()
        items = [chat_service.message_json(r) for r in reversed(rows)]
        has_more = len(rows) == limit
    return ok(request, {
        "items": items,
        "next_cursor": items[0]["id"] if has_more and items else None,
        "has_more": has_more,
    })


@router.post("/conversations/{conversation_id}/messages", status_code=202)
async def post_message(request: Request, conversation_id: str):
    user = require_user(request)
    require_verified(user)
    payload = await body(request)
    with connect() as conn:
        result = chat_service.send_message(conn, user, conversation_id, payload)
    return ok(request, result, "accepted", 202)


@router.get("/messages/{message_id}")
async def get_message(request: Request, message_id: str):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=? AND user_id=?",
                           (message_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Message not found.")
        events = chat_service.event_payloads(conn, message_id)
    data = chat_service.message_json(row)
    data["events"] = events
    return ok(request, data)


@router.get("/messages/{message_id}/events")
async def message_events(request: Request, message_id: str):
    user = require_user(request)
    last = request.headers.get("last-event-id") or request.query_params.get("last_event_id") or "0"
    try:
        last_seq = int(last)
    except ValueError:
        last_seq = 0
    with connect() as conn:
        row = conn.execute("SELECT id FROM messages WHERE id=? AND user_id=?",
                           (message_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Message not found.")
    return StreamingResponse(
        chat_service.sse_events(message_id, last_seq),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/messages/{message_id}/cancel")
async def cancel(request: Request, message_id: str):
    user = require_user(request)
    with connect() as conn:
        result = chat_service.cancel_message(conn, user, message_id)
    return ok(request, result)


@router.post("/messages/{message_id}/regenerate", status_code=202)
async def regen(request: Request, message_id: str):
    user = require_user(request)
    with connect() as conn:
        result = chat_service.regenerate(conn, user, message_id)
    return ok(request, result, "accepted", 202)


@router.patch("/messages/{message_id}")
async def edit_message(request: Request, message_id: str):
    user = require_user(request)
    payload = await body(request)
    text = str(payload.get("content") or "").strip()
    if not text or len(text) > 4000:
        raise ApiError(400, "VALIDATION_ERROR", "Message must be 1–4000 characters.")
    with connect() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=? AND user_id=? AND role='user'",
                           (message_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Message not found.")
        conn.execute("UPDATE messages SET content=? WHERE id=?", (text, message_id))
        fresh = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        # Old memories derived from this branch stay; the client prompts a review.
        conn.execute(
            "INSERT INTO jobs(id,user_id,kind,status,token,result,created_at,updated_at)"
            " VALUES (?,?,'memory_review','completed',?,?,?,?)",
            (new_id("job"), user["id"], new_id("tok"),
             json.dumps({"message_id": message_id}), now_iso(), now_iso()),
        )
    data = chat_service.message_json(fresh)
    data["reviews"] = ["memories_from_this_message"]
    return ok(request, data)


@router.post("/messages/{message_id}/feedback", status_code=201)
async def feedback(request: Request, message_id: str):
    user = require_user(request)
    payload = await body(request)
    rating = str(payload.get("rating") or "").lower()
    if rating not in ("up", "down", "helpful", "not_helpful", "positive", "negative"):
        raise ApiError(400, "VALIDATION_ERROR", "rating must be up/down.")
    with connect() as conn:
        msg = conn.execute("SELECT id FROM messages WHERE id=? AND user_id=?",
                           (message_id, user["id"])).fetchone()
        if not msg:
            raise ApiError(404, "NOT_FOUND", "Message not found.")
        fid = new_id("fb")
        conn.execute(
            "INSERT INTO feedback(id,user_id,message_id,rating,reason,created_at)"
            " VALUES (?,?,?,?,?,?)",
            (fid, user["id"], message_id, rating,
             str(payload.get("reason") or "")[:500], now_iso()),
        )
    return ok(request, {"feedback_id": fid}, "recorded", 201)


@router.post("/reports", status_code=201)
async def report(request: Request):
    user = require_user(request)
    payload = await body(request)
    reason = str(payload.get("reason") or "").strip()
    if not reason:
        raise ApiError(400, "VALIDATION_ERROR", "Choose a reason for the report.")
    message_id = payload.get("message_id")
    with connect() as conn:
        if message_id:
            msg = conn.execute("SELECT id FROM messages WHERE id=? AND user_id=?",
                               (message_id, user["id"])).fetchone()
            if not msg:
                raise ApiError(404, "NOT_FOUND", "Message not found.")
        rid = new_id("rep")
        conn.execute(
            "INSERT INTO reports(id,user_id,message_id,reason,comment,status,created_at)"
            " VALUES (?,?,?,?,?,'submitted',?)",
            (rid, user["id"], message_id, reason,
             str(payload.get("comment") or "")[:1000], now_iso()),
        )
    return ok(request, {"report_id": rid, "status": "submitted"}, "submitted", 201)