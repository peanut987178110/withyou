"""Reliability: safety helpers, RAG retriever, demo seeding and the FastAPI app."""
from __future__ import annotations

import json
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import content, services
from .core import (
    API_PREFIX, ApiError, SEED_DEMO, connect, create_session, ensure_memory_settings,
    hash_password, init_db, new_id, now_iso, connect as db,
)

# ------------------------------------------------------------------ RAG

KB_PATH = Path(__file__).resolve().parent.parent / "kb" / "kb.json"


class KnowledgeBase:
    """Small BM25-style retriever over reviewed product/policy articles.

    Production swaps this for a vector store; the contract (source_id + text +
    version, tenant-safe, effective-dated) is the same, and instructions found in
    documents are treated as data, never as commands.
    """

    def __init__(self, path: Path) -> None:
        self.docs: list[dict[str, Any]] = []
        self.available = False
        try:
            self.docs = json.loads(path.read_text(encoding="utf-8"))
            self.available = bool(self.docs)
        except Exception:
            self.docs = []

    @staticmethod
    def _tokens(text: str) -> list[str]:
        return re.findall(r"[a-z0-9']{3,}", text.lower())

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        if not self.available:
            return []
        q = set(self._tokens(query))
        if not q:
            return []
        scored = []
        for doc in self.docs:
            body = f"{doc.get('title','')} {doc.get('text','')}"
            toks = self._tokens(body)
            if not toks:
                continue
            overlap = sum(1 for t in toks if t in q)
            if not overlap:
                continue
            score = overlap / (len(toks) ** 0.5)
            scored.append((score, doc))
        scored.sort(key=lambda x: -x[0])
        out = []
        for score, doc in scored[:limit]:
            out.append({
                "source_id": doc["doc_id"],
                "text": doc["text"],
                "version": doc.get("version", "1"),
                "score": round(score, 4),
                "label": f"[KB:{doc['doc_id']} v{doc.get('version','1')}]",
            })
        return out


KB = KnowledgeBase(KB_PATH)


def rag_answer(query: str) -> dict[str, Any] | None:
    """Answer only from retrieved evidence; say so when unsure."""
    hits = KB.search(query, limit=2)
    if not hits:
        return None
    best = hits[0]
    if best["score"] < 0.35:
        return None
    return {
        "text": best["text"],
        "sources": [{"source_id": h["source_id"], "version": h["version"]} for h in hits],
    }


# ------------------------------------------------------------------ seed

DEMO_PASSWORD = "demo1234"

DEMO_USERS = [
    {"email": "alex@withyou.demo", "name": "Alex", "region": "US", "xp": 340, "lumen": 45,
     "partner": "Mia", "traits": ["Warm", "Curious", "Calm"], "relationship": "friend"},
    {"email": "sam@withyou.demo", "name": "Sam", "region": "GB", "xp": 120, "lumen": 20,
     "partner": "Noor", "traits": ["Playful", "Witty"], "relationship": "mentor"},
    {"email": "new@withyou.demo", "name": "Riley", "region": "CA", "xp": 0, "lumen": 0,
     "partner": None, "traits": [], "relationship": "friend"},
]


def seed_demo_data(conn: sqlite3.Connection) -> None:
    for spec in DEMO_USERS:
        exists = conn.execute("SELECT id FROM users WHERE email=?", (spec["email"],)).fetchone()
        if exists:
            continue
        uid = new_id("usr")
        conn.execute(
            "INSERT INTO users(id,email,password_hash,display_name,created_at,age_verified,region,"
            "xp,lumen,onboarded,locale,tz_offset_minutes) VALUES (?,?,?,?,?,1,?,?,?,?,?,?)",
            (uid, spec["email"], hash_password(DEMO_PASSWORD), spec["name"], now_iso(),
             spec["region"], spec["xp"], spec["lumen"], 1 if spec["partner"] else 0, "en", 0),
        )
        ensure_memory_settings(conn, uid)
        if not spec["partner"]:
            continue
        cid = new_id("cmp")
        conn.execute(
            "INSERT INTO companions(id,user_id,name,traits,relationship_type,energy,intent,"
            "wardrobe_item,room_id,version,created_at) VALUES (?,?,?,?,?,60,'talk',"
            "'linen_soft','sunlit',1,?)",
            (cid, uid, spec["partner"], json.dumps(spec["traits"]), spec["relationship"], now_iso()),
        )
        conv = new_id("conv")
        conn.execute(
            "INSERT INTO conversations(id,user_id,companion_id,created_at,last_at) VALUES (?,?,?,?,?)",
            (conv, uid, cid, now_iso(), now_iso()),
        )
        turns = [
            ("assistant", content.LINES["F001"].format(name=spec["partner"])),
            ("user", "I had a long day."),
            ("assistant", "Then we don't have to solve anything right now. I can just stay with you for a while."),
            ("user", "I'd like that."),
            ("assistant", "I'm here. Tell me what made today heavy, or we can sit with something lighter."),
        ]
        for role, text in turns:
            conn.execute(
                "INSERT INTO messages(id,conversation_id,user_id,role,content,status,created_at)"
                " VALUES (?,?,?,?,?,'completed',?)",
                (new_id("msg"), conv, uid, role, text, now_iso()),
            )
        conn.execute(
            "INSERT INTO memories(id,user_id,companion_id,text,category,status,version,"
            "source_date,created_at) VALUES (?,?,?,?,?,'confirmed',1,?,?)",
            (new_id("mem"), uid, cid, "You like listening to jazz on rainy days.",
             "preference", now_iso(), now_iso()),
        )


# ------------------------------------------------------------------ app

def create_app() -> FastAPI:
    from .routers import auth, chat, economy, memory, privacy, voice

    init_db()
    if SEED_DEMO:
        with connect() as conn:
            seed_demo_data(conn)

    app = FastAPI(
        title="WithYou API",
        version="2.1",
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["retry-after"],
    )

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        request.state.request_id = f"req_{uuid.uuid4().hex[:12]}"
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status,
            content={
                "code": exc.code,
                "message": exc.message,
                "data": exc.data,
                "request_id": getattr(request.state, "request_id", ""),
            },
        )

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        return JSONResponse(
            status_code=500,
            content={"code": "INTERNAL_ERROR", "message": "Something went wrong.",
                     "data": {"retryable": True},
                     "request_id": getattr(request.state, "request_id", "")},
        )

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "service": "withyou", "version": "2.1", "ai_mode": "mock"}

    for module in (auth, chat, memory, economy, privacy, voice):
        app.include_router(module.router, prefix=API_PREFIX)
    app.include_router(auth.account_router, prefix=API_PREFIX)

    web_dir = Path(__file__).resolve().parent.parent.parent / "web"
    if web_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()