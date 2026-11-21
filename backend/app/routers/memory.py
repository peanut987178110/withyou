"""Memory center: settings, proposals, confirmed memories."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from .. import services
from ..core import ApiError, connect, require_user
from .common import body, ok

router = APIRouter(tags=["memory"])


def _memory_json(row) -> dict[str, Any]:
    data = dict(row)
    return {
        "id": data["id"],
        "text": data["text"],
        "category": data["category"],
        "status": data["status"],
        "version": data["version"],
        "source_date": data.get("source_date"),
        "expires_at": data.get("expires_at"),
        "created_at": data["created_at"],
    }


@router.get("/settings/memory")
async def get_settings(request: Request):
    user = require_user(request)
    with connect() as conn:
        settings = services.memory_settings(conn, user["id"])
    return ok(request, settings)


@router.patch("/settings/memory")
async def patch_settings(request: Request):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        current = services.memory_settings(conn, user["id"])
        extraction = payload.get("extraction_enabled", current["extraction_enabled"])
        retrieval = payload.get("retrieval_enabled", current["retrieval_enabled"])
        if "version" in payload and int(payload["version"]) != current["version"]:
            raise ApiError(409, "CONFLICT", "Settings changed elsewhere. Reload and try again.")
        conn.execute(
            "UPDATE memory_settings SET extraction_enabled=?, retrieval_enabled=?, version=version+1"
            " WHERE user_id=?",
            (1 if extraction else 0, 1 if retrieval else 0, user["id"]),
        )
        fresh = services.memory_settings(conn, user["id"])
    return ok(request, fresh)


@router.get("/memories")
async def list_memories(request: Request, status: str | None = None,
                        category: str | None = None, limit: int = 100):
    user = require_user(request)
    limit = max(1, min(int(limit or 20), 100))
    with connect() as conn:
        sql = "SELECT * FROM memories WHERE user_id=?"
        args: list[Any] = [user["id"]]
        if status:
            sql += " AND status=?"
            args.append(status)
        else:
            sql += " AND status<>'deleted'"
        if category:
            sql += " AND category=?"
            args.append(category)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        memories = [_memory_json(r) for r in conn.execute(sql, args).fetchall()]
        proposals = [
            dict(r) for r in conn.execute(
                "SELECT * FROM memory_proposals WHERE user_id=? AND status='proposed'"
                " ORDER BY created_at DESC", (user["id"],)
            ).fetchall()
        ]
        settings = services.memory_settings(conn, user["id"])
    return ok(request, {"items": memories, "proposals": proposals, "settings": settings,
                        "next_cursor": None})


@router.post("/memory-proposals/{proposal_id}/decision")
async def decide(request: Request, proposal_id: str):
    user = require_user(request)
    payload = await body(request)
    decision = str(payload.get("decision") or "").lower()
    allowed = ("confirm", "reject", "session_only")
    if decision not in allowed:
        raise ApiError(400, "VALIDATION_ERROR", "decision must be confirm, reject or session_only.")
    with connect() as conn:
        result = services.decide_proposal(conn, user["id"], proposal_id, decision)
    return ok(request, result, decision)


@router.patch("/memories/{memory_id}")
async def update_memory(request: Request, memory_id: str):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        row = services.update_memory(
            conn, user["id"], memory_id,
            str(payload.get("content") or ""), int(payload.get("version") or 0),
        )
    return ok(request, _memory_json(row))


@router.delete("/memories/{memory_id}", status_code=202)
async def delete_memory(request: Request, memory_id: str):
    user = require_user(request)
    with connect() as conn:
        job_id = services.delete_memory(conn, user["id"], memory_id)
    return ok(request, {"deletion_job_id": job_id, "read_blocked": True}, "accepted", 202)