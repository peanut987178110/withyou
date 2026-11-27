"""Chat orchestration: message lifecycle, staged output, SSE event log."""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from typing import Any, AsyncIterator

from . import content, locales, mock_ai, services
from .core import (
    API_PREFIX, ApiError, connect, ensure_memory_settings, ensure_usage,
    new_id, now_iso,
)
from .services import read_user

TERMINAL = {"message.completed", "message.blocked", "message.failed", "message.canceled"}


def append_event(conn: sqlite3.Connection, message_id: str, kind: str,
                 payload: dict[str, Any]) -> dict[str, Any]:
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq),0)+1 FROM message_events WHERE message_id=?", (message_id,)
    ).fetchone()[0]
    event_id = f"evt_{message_id}_{seq}"
    created = now_iso()
    conn.execute(
        "INSERT INTO message_events(event_id,message_id,seq,type,payload,created_at)"
        " VALUES (?,?,?,?,?,?)",
        (event_id, message_id, seq, kind, json.dumps(payload, ensure_ascii=False), created),
    )
    return {"event_id": event_id, "seq": seq, "type": kind,
            "payload": payload, "message_id": message_id, "created_at": created}


def message_json(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    return {
        "id": data["id"],
        "conversation_id": data["conversation_id"],
        "role": data["role"],
        "content": data["content"],
        "status": data["status"],
        "parent_message_id": data.get("parent_message_id"),
        "branch_group": data.get("branch_group"),
        "safety_level": data.get("safety_level"),
        "created_at": data["created_at"],
    }


def conversation_history(conn: sqlite3.Connection, conversation_id: str,
                         limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id=? AND status='completed'"
        " ORDER BY created_at DESC LIMIT ?", (conversation_id, limit)
    ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def ensure_conversation(conn: sqlite3.Connection, user: dict[str, Any],
                        companion_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM conversations WHERE user_id=? AND companion_id=?"
        " ORDER BY created_at DESC LIMIT 1", (user["id"], companion_id)
    ).fetchone()
    if row:
        return dict(row)
    comp = conn.execute("SELECT * FROM companions WHERE id=?", (companion_id,)).fetchone()
    if not comp:
        raise ApiError(404, "NOT_FOUND", "Companion not found.")
    cid = new_id("conv")
    ts = now_iso()
    conn.execute(
        "INSERT INTO conversations(id,user_id,companion_id,created_at,last_at) VALUES (?,?,?,?,?)",
        (cid, user["id"], companion_id, ts, ts),
    )
    greeting = locales.pack(user.get("locale"))["safety"]["F001"].format(name=comp["name"])
    mid = new_id("msg")
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,created_at)"
        " VALUES (?,?,?,'assistant',?,'completed',?)",
        (mid, cid, user["id"], greeting, ts),
    )
    return dict(conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone())


def create_companion_and_conversation(conn: sqlite3.Connection, user: dict[str, Any],
                                      payload: dict[str, Any]) -> dict[str, Any]:
    return _create(conn, user, payload)


def _create(conn: sqlite3.Connection, user: dict[str, Any],
            payload: dict[str, Any]) -> dict[str, Any]:
    name = (payload.get("name") or "Mia").strip()
    if not 1 <= len(name) <= 24:
        raise ApiError(400, "VALIDATION_ERROR", "Name must be 1–24 characters.")
    traits = payload.get("traits") or ["Warm", "Curious"]
    if not isinstance(traits, list) or len(traits) > 5:
        raise ApiError(400, "VALIDATION_ERROR", "Choose up to 5 traits.")
    relationship = payload.get("relationship_type") or "friend"
    if relationship not in {r["id"] for r in content.RELATIONSHIP_TYPES}:
        relationship = "friend"

    existing = conn.execute("SELECT * FROM companions WHERE user_id=?", (user["id"],)).fetchone()
    if existing:
        comp = dict(existing)
        conv = ensure_conversation(conn, user, comp["id"])
        return {"companion": comp, "conversation": conv, "created": False}

    comp_id = new_id("cmp")
    # The voice is derived from the personality at creation time, so a call
    # already sounds like the character before anyone opens a settings page.
    try:
        from . import voice_engine
        profile = voice_engine.default_profile(traits, user.get("locale") or "en")
    except Exception:
        profile = {}
    conn.execute(
        "INSERT INTO companions(id,user_id,name,traits,relationship_type,energy,intent,"
        "wardrobe_item,room_id,version,created_at,voice_profile)"
        " VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
        (comp_id, user["id"], name, json.dumps(traits), relationship,
         int(payload.get("energy", 60)), payload.get("intent"), "linen_soft", "sunlit",
         now_iso(), json.dumps(profile, ensure_ascii=False)),
    )
    conn.execute("UPDATE users SET onboarded=1 WHERE id=?", (user["id"],))
    comp = dict(conn.execute("SELECT * FROM companions WHERE id=?", (comp_id,)).fetchone())
    conv = ensure_conversation(conn, user, comp_id)
    return {"companion": comp, "conversation": conv, "created": True}


def _safety_message(conn: sqlite3.Connection, user: dict[str, Any], conversation_id: str,
                    result: dict[str, Any], user_message_id: str) -> dict[str, Any]:
    mid = new_id("msg")
    ts = now_iso()
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,parent_message_id,"
        "safety_level,created_at) VALUES (?,?,?,'assistant',?,'completed',?,?,?)",
        (mid, conversation_id, user["id"], result["reply_text"],
         user_message_id, result["risk_level"], ts),
    )
    append_event(conn, mid, "message.started", {"role": "assistant", "safety": True})
    append_event(conn, mid, "message.delta", {"delta": result["reply_text"]})
    append_event(conn, mid, "message.completed", {
        "content": result["reply_text"], "safety": True,
        "category": result.get("category"), "resources": result.get("resources", []),
    })
    conn.execute(
        "INSERT INTO safety_events(id,user_id,message_id,level,category,created_at)"
        " VALUES (?,?,?,?,?,?)",
        (new_id("saf"), user["id"], mid, result["risk_level"],
         result.get("category", "none"), now_iso()),
    )
    return {"id": mid, "content": result["reply_text"], "status": "completed"}


def send_message(conn: sqlite3.Connection, user: dict[str, Any], conversation_id: str,
                 payload: dict[str, Any]) -> dict[str, Any]:
    from .core import MESSAGE_LIMIT, daily_reply_limit

    text = str(payload.get("content") or "").strip()
    if not text:
        raise ApiError(400, "VALIDATION_ERROR", "Message can't be empty.")
    if len(text) > MESSAGE_LIMIT:
        raise ApiError(400, "VALIDATION_ERROR", f"Message can be up to {MESSAGE_LIMIT} characters.")

    conv = conn.execute(
        "SELECT * FROM conversations WHERE id=? AND user_id=?", (conversation_id, user["id"])
    ).fetchone()
    if not conv:
        raise ApiError(404, "NOT_FOUND", "Conversation not found.")
    companion = conn.execute("SELECT * FROM companions WHERE id=?", (conv["companion_id"],)).fetchone()
    if not companion:
        raise ApiError(404, "NOT_FOUND", "Companion not found.")

    client_id = payload.get("client_message_id")
    if client_id:
        existing = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND client_message_id=?",
            (conversation_id, client_id),
        ).fetchone()
        if existing:
            reply = conn.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND role='assistant'"
                " AND created_at>=? ORDER BY created_at LIMIT 1",
                (conversation_id, existing["created_at"]),
            ).fetchone()
            return {
                "message_id": reply["id"] if reply else None,
                "user_message_id": existing["id"],
                "status": reply["status"] if reply else "completed",
                "stream_url": f"{API_PREFIX}/messages/{reply['id']}/events" if reply else None,
                "reused": True,
            }

    verdict = mock_ai.classify(text)
    user_mid = new_id("msg")
    ts = now_iso()
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,client_message_id,"
        "created_at) VALUES (?,?,?,'user',?,'completed',?,?)",
        (user_mid, conversation_id, user["id"], text, client_id, ts),
    )
    conn.execute("UPDATE conversations SET last_at=? WHERE id=?", (ts, conversation_id))

    if verdict["blocked"]:
        safety = mock_ai.crisis_reply(verdict["category"], user.get("region"), user.get("locale"))
        assistant = _safety_message(conn, user, conversation_id, safety, user_mid)
        return {
            "message_id": assistant["id"], "user_message_id": user_mid,
            "status": "completed", "safety": True,
            "stream_url": f"{API_PREFIX}/messages/{assistant['id']}/events",
        }

    usage = ensure_usage(conn, user)
    limit = daily_reply_limit(user)
    if usage["replies"] >= limit:
        raise ApiError(
            429, "RATE_LIMITED",
            "You've reached today's reply limit. You can still read history and manage your data.",
            {"limit": limit, "used": usage["replies"], "resets": "next local day"},
            retryable=False,
        )

    settings = ensure_memory_settings(conn, user["id"])
    memories = services.confirmed_memories(
        conn, user["id"], conv["companion_id"],
        retrieval_only=bool(settings["retrieval_enabled"]),
    )
    history = conversation_history(conn, conversation_id)
    info = services.level_info(read_user(conn, user["id"])["xp"])

    assistant_mid = new_id("msg")
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,parent_message_id,"
        "branch_group,created_at) VALUES (?,?,?,'assistant','','accepted',?,?,?)",
        (assistant_mid, conversation_id, user["id"], user_mid, assistant_mid, now_iso()),
    )
    append_event(conn, assistant_mid, "message.started", {"role": "assistant"})

    threading.Thread(
        target=run_generation,
        name=f"wy-gen-{assistant_mid}",
        daemon=True,
        args=(assistant_mid, user, companion, text, history, memories,
              bool(settings["extraction_enabled"]), bool(settings["retrieval_enabled"]),
              info["level"]),
    ).start()
    return {
        "message_id": assistant_mid, "user_message_id": user_mid,
        "status": "accepted", "stream_url": f"{API_PREFIX}/messages/{assistant_mid}/events",
    }


def regenerate(conn: sqlite3.Connection, user: dict[str, Any], message_id: str) -> dict[str, Any]:
    original = conn.execute(
        "SELECT * FROM messages WHERE id=? AND user_id=? AND role='assistant'",
        (message_id, user["id"]),
    ).fetchone()
    if not original:
        raise ApiError(404, "NOT_FOUND", "Message not found.")
    if original["status"] != "completed":
        raise ApiError(409, "CONFLICT", "Only a completed message can be regenerated.")
    parent = original["parent_message_id"]
    user_msg = conn.execute("SELECT * FROM messages WHERE id=?", (parent,)).fetchone()
    if not user_msg:
        raise ApiError(409, "CONFLICT", "The original prompt is unavailable.")
    conv = conn.execute("SELECT * FROM conversations WHERE id=?", (original["conversation_id"],)).fetchone()
    companion = conn.execute("SELECT * FROM companions WHERE id=?", (conv["companion_id"],)).fetchone()
    settings = ensure_memory_settings(conn, user["id"])
    memories = services.confirmed_memories(conn, user["id"], conv["companion_id"],
                                           retrieval_only=bool(settings["retrieval_enabled"]))
    history = conversation_history(conn, conv["id"])
    info = services.level_info(read_user(conn, user["id"])["xp"])
    new_mid = new_id("msg")
    branch = original["branch_group"] or original["id"]
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,parent_message_id,"
        "branch_group,created_at) VALUES (?,?,?,'assistant','','accepted',?,?,?)",
        (new_mid, conv["id"], user["id"], parent, branch, now_iso()),
    )
    append_event(conn, new_mid, "message.started", {"role": "assistant", "regenerated": True})
    threading.Thread(
        target=run_generation,
        name=f"wy-gen-{new_mid}",
        daemon=True,
        args=(new_mid, user, companion, user_msg["content"], history, memories,
              False, bool(settings["retrieval_enabled"]), info["level"]),
        kwargs={"charge": False},
    ).start()
    return {"message_id": new_mid, "status": "accepted",
            "stream_url": f"{API_PREFIX}/messages/{new_mid}/events", "replaces": message_id}


def run_generation(message_id: str, user: dict[str, Any], companion: sqlite3.Row,
                   text: str, history: list[dict[str, Any]], memories: list[dict[str, Any]],
                   extraction_enabled: bool, retrieval_enabled: bool, level: int,
                   *, charge: bool = True) -> None:
    """Background worker. Own connections; never blocks the event loop.

    `charge=False` is used by regenerate: the round was already billed and
    counted when the original reply was produced, so the retry only rewrites
    the text and must not consume a second reply, turn or reward.
    """
    try:
        with connect() as conn:
            conn.execute("UPDATE messages SET status='generating' WHERE id=?", (message_id,))
        time.sleep(0.35)
        result = mock_ai.compose_reply(
            user_text=text,
            name=companion["name"],
            traits=json.loads(companion["traits"] or "[]"),
            relationship_type=companion["relationship_type"],
            level=level,
            memories=memories,
            retrieval_enabled=retrieval_enabled,
            history=history,
            region=user.get("region"),
            locale=user.get("locale"),
        )
        reply = result["reply_text"]
        accumulated = ""
        for chunk in mock_ai.chunk_text(reply):
            with connect() as conn:
                row = conn.execute("SELECT status FROM messages WHERE id=?", (message_id,)).fetchone()
                if not row or row["status"] == "canceled":
                    return
                accumulated += chunk
                check = mock_ai.output_check(accumulated)
                if check["blocked"]:
                    conn.execute("UPDATE messages SET status='blocked' WHERE id=?", (message_id,))
                    append_event(conn, message_id, "message.blocked", {
                        "reason": check["reason"],
                        "fallback_text": locales.pack(user.get("locale"))["safety"]["E001"],
                    })
                    return
                append_event(conn, message_id, "message.delta", {"delta": chunk})
            time.sleep(0.045)

        with connect() as conn:
            row = conn.execute("SELECT status FROM messages WHERE id=?", (message_id,)).fetchone()
            if not row or row["status"] == "canceled":
                return
            conn.execute("UPDATE messages SET content=?, status='completed' WHERE id=?",
                         (reply, message_id))
            proposals: list[dict[str, Any]] = []
            if extraction_enabled and not result.get("memory_proposals"):
                candidates = mock_ai.extract_memories(text, memories, [], user.get("locale"))
                proposals = services.create_proposals(
                    conn, user, companion["id"], message_id, candidates[:3])
            for proposal in proposals:
                append_event(conn, message_id, "memory.proposed", proposal)
            append_event(conn, message_id, "message.completed", {
                "content": reply,
                "interaction_mode": result.get("interaction_mode", "listen"),
            })
            usage = ensure_usage(conn, user)
            if charge:
                conn.execute(
                    "UPDATE usage_daily SET replies=replies+1, turns=turns+1"
                    " WHERE user_id=? AND bucket=?",
                    (user["id"], usage["bucket"]),
                )
                fresh = read_user(conn, user["id"])
                services.maybe_award_chat_turn(conn, fresh)
                first = conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE user_id=? AND role='user'", (user["id"],)
                ).fetchone()[0]
                if first <= 1:
                    services.grant_onboarding(conn, user["id"])
    except Exception as exc:  # pragma: no cover - defensive
        try:
            with connect() as conn:
                conn.execute("UPDATE messages SET status='failed' WHERE id=?", (message_id,))
                append_event(conn, message_id, "message.failed", {
                    "message": "Response generation failed. No quota was used.",
                    "retryable": True, "error": type(exc).__name__,
                })
        except Exception:
            pass


def cancel_message(conn: sqlite3.Connection, user: dict[str, Any],
                   message_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM messages WHERE id=? AND user_id=?",
                       (message_id, user["id"])).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Message not found.")
    if row["status"] in ("accepted", "generating"):
        conn.execute("UPDATE messages SET status='canceled' WHERE id=?", (message_id,))
        append_event(conn, message_id, "message.canceled", {"canceled": True})
        return {"message_id": message_id, "status": "canceled"}
    return {"message_id": message_id, "status": row["status"]}


async def sse_events(message_id: str, last_seq: int) -> AsyncIterator[str]:
    deadline = time.time() + 70
    sent = last_seq
    while time.time() < deadline:
        rows: list[sqlite3.Row] = []
        status = None
        try:
            with connect() as conn:
                status_row = conn.execute("SELECT status FROM messages WHERE id=?",
                                          (message_id,)).fetchone()
                status = status_row["status"] if status_row else None
                rows = conn.execute(
                    "SELECT * FROM message_events WHERE message_id=? AND seq>? ORDER BY seq",
                    (message_id, sent),
                ).fetchall()
        except Exception:
            rows = []
        for row in rows:
            sent = row["seq"]
            yield (f"id: {row['seq']}\n"
                   f"event: {row['type']}\n"
                   f"data: {row['payload']}\n\n")
        if status in ("completed", "blocked", "failed", "canceled") and not rows:
            break
        await asyncio.sleep(0.12)


def event_payloads(conn: sqlite3.Connection, message_id: str, after: int = 0) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM message_events WHERE message_id=? AND seq>? ORDER BY seq",
        (message_id, after),
    ).fetchall()
    out = []
    for row in rows:
        out.append({"event_id": row["event_id"], "seq": row["seq"], "type": row["type"],
                    "payload": json.loads(row["payload"]), "created_at": row["created_at"]})
    return out