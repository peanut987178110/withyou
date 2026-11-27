"""WithYou backend core: configuration, SQLite schema, errors, auth and helpers.

Deliberately framework-light: no pydantic models, so the same code runs on
CPython (dev) and Chaquopy/Android (pydantic 1.x, pure-python wheels only).
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

API_PREFIX = "/api/v1"
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = BASE_DIR / "data" / "withyou.db"

DB_PATH = os.environ.get("WITHYOU_DB", str(DEFAULT_DB))
IS_TEST = bool(os.environ.get("WITHYOU_TEST"))
SEED_DEMO = os.environ.get("WITHYOU_SEED", "1") == "1"
AI_MODE = os.environ.get("WITHYOU_AI_MODE", "mock")

FREE_DAILY_REPLIES = int(os.environ.get("WITHYOU_FREE_REPLIES", "50"))
PLUS_DAILY_REPLIES = int(os.environ.get("WITHYOU_PLUS_REPLIES", "300"))
TOKEN_TTL_DAYS = 30
MESSAGE_LIMIT = 4000
MAX_MEMORY_CANDIDATES = 3


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utcnow().isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_in(seconds: int) -> str:
    return (utcnow() + timedelta(seconds=seconds)).isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_in_days(days: int) -> str:
    return iso_in(days * 86400)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def day_bucket(tz_offset_minutes: int = 0) -> str:
    """Local-day bucket computed from a fixed offset (no tzdata dependency)."""
    local = utcnow() + timedelta(minutes=int(tz_offset_minutes or 0))
    return local.date().isoformat()


def db_path() -> str:
    path = DB_PATH
    parent = Path(path).parent
    if str(parent):
        parent.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path(), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  age_verified INTEGER NOT NULL DEFAULT 0,
  region TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  tz_offset_minutes INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  lumen INTEGER NOT NULL DEFAULT 0,
  onboarded INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'none',
  entitlement_end_at TEXT,
  renewal_enabled INTEGER NOT NULL DEFAULT 0,
  proactive_checkins INTEGER NOT NULL DEFAULT 0,
  trial_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS companions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  traits TEXT NOT NULL DEFAULT '[]',
  relationship_type TEXT NOT NULL DEFAULT 'friend',
  energy INTEGER NOT NULL DEFAULT 60,
  intent TEXT,
  wardrobe_item TEXT NOT NULL DEFAULT 'linen_soft',
  room_id TEXT NOT NULL DEFAULT 'sunlit',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  voice_profile TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  client_message_id TEXT,
  parent_message_id TEXT,
  branch_group TEXT,
  safety_level TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS message_events (
  rowid_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);

CREATE TABLE IF NOT EXISTS memory_settings (
  user_id TEXT PRIMARY KEY,
  extraction_enabled INTEGER NOT NULL DEFAULT 1,
  retrieval_enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'confirmed',
  version INTEGER NOT NULL DEFAULT 1,
  source_message_id TEXT,
  source_date TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_completions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  bucket TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  rewards TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, activity_id, bucket, sequence)
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  source TEXT NOT NULL,
  completion_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owned_items (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  receipt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  entitlement_end_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT,
  reason TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS safety_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rating TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------- voice/calls
-- One row per account. `calls_enabled` is the master switch; `prefer_no_calls`
-- is the softer "I'd rather not get calls" preference from R-4.1, which only
-- suppresses AI-initiated calling and must never touch affection, proactive
-- messages or relationship progress.
CREATE TABLE IF NOT EXISTS voice_settings (
  user_id TEXT PRIMARY KEY,
  calls_enabled INTEGER NOT NULL DEFAULT 1,
  prefer_no_calls INTEGER NOT NULL DEFAULT 0,
  captions_enabled INTEGER NOT NULL DEFAULT 0,
  transcript_archive INTEGER NOT NULL DEFAULT 1,
  minor_mode INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- Monthly voice quota. Rows are per local month bucket (YYYY-MM).
CREATE TABLE IF NOT EXISTS voice_quota (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  free_seconds_used INTEGER NOT NULL DEFAULT 0,
  plan_seconds_used INTEGER NOT NULL DEFAULT 0,
  pack_seconds_used INTEGER NOT NULL DEFAULT 0,
  gift_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);

-- Purchased minute packs (6元 / 10 min). Never auto-renewed.
CREATE TABLE IF NOT EXISTS voice_packs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  seconds_left INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  direction TEXT NOT NULL,            -- outbound (T1, user) | inbound (T2, AI)
  status TEXT NOT NULL,               -- ringing | active | ended | missed | failed
  trigger_id TEXT,                    -- dedupe key for T2/T3
  ring_started_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  billed_seconds INTEGER NOT NULL DEFAULT 0,
  silence_seconds INTEGER NOT NULL DEFAULT 0,
  quota_source TEXT,                  -- gift | plan | pack | free | none
  billing_detail TEXT NOT NULL DEFAULT '[]',
  end_reason TEXT,                    -- user_ended | ai_ended | quota | error | soft_cap | no_answer
  unfinished_thread TEXT,
  safety_level TEXT,
  transcript TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  at_ms INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'speech',   -- speech | nudge | system
  created_at TEXT NOT NULL,
  audio_key TEXT,                        -- user clip, when the mic was open
  duration_ms INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  memory_ids TEXT NOT NULL DEFAULT '[]'  -- memories the reply leaned on
);

-- T4 voice notes. `audio` is the legacy data-URL payload; new rows store bytes
-- on disk and keep `audio_key`. Both are readable so nothing had to migrate.
CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  direction TEXT NOT NULL,            -- user | assistant
  duration_ms INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT 'audio/webm',
  audio TEXT,
  transcript TEXT NOT NULL DEFAULT '',
  trigger_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  deleted_at TEXT,
  audio_key TEXT,
  audio_bytes INTEGER NOT NULL DEFAULT 0,
  peaks TEXT NOT NULL DEFAULT '[]'
);

-- AI-initiated call attempts that never connected (T3 voicemail source).
CREATE TABLE IF NOT EXISTS voicemails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  session_id TEXT,
  trigger_id TEXT NOT NULL,
  script TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unread',  -- unread | heard | replied | expired
  created_at TEXT NOT NULL,
  expires_at TEXT,
  audio_key TEXT,
  UNIQUE (user_id, trigger_id)
);

-- The trigger engine's decision log: one row per evaluated trigger, so a
-- trigger can never fire twice (idempotency by trigger_id) and every silence
-- has a recorded reason.
CREATE TABLE IF NOT EXISTS voice_triggers (
  trigger_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- P0 | P1 | P2 | P3 | P4
  reason TEXT NOT NULL,
  decision TEXT NOT NULL,             -- call | voicemail | suppressed | deferred
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_user ON call_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_turns ON call_turns(session_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_voice_notes_user ON voice_notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voicemails_user ON voicemails(user_id, status);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_msg ON message_events(message_id, seq);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at);
"""


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.execute("PRAGMA journal_mode = WAL")


# Columns added after v2.1. `CREATE TABLE IF NOT EXISTS` does nothing to a table
# that already exists, so an upgraded install needs these applied explicitly —
# otherwise the new voice code would read a column that isn't there and fail on
# every request that touches it.
_MIGRATIONS: dict[str, list[tuple[str, str]]] = {
    "companions": [("voice_profile", "TEXT NOT NULL DEFAULT '{}'")],
    "call_turns": [
        ("audio_key", "TEXT"),
        ("duration_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("interrupted", "INTEGER NOT NULL DEFAULT 0"),
        ("memory_ids", "TEXT NOT NULL DEFAULT '[]'"),
    ],
    "voice_notes": [
        ("audio_key", "TEXT"),
        ("audio_bytes", "INTEGER NOT NULL DEFAULT 0"),
        ("peaks", "TEXT NOT NULL DEFAULT '[]'"),
    ],
    "voicemails": [("audio_key", "TEXT")],
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, columns in _MIGRATIONS.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_dict(rows) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        data: dict[str, Any] | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.data = dict(data or {})
        self.data.setdefault("retryable", retryable)


# ---------------------------------------------------------------- security

def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 120_000)
    return f"pbkdf2_sha256$120000${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), int(rounds))
        return secrets.compare_digest(calc.hex(), digest)
    except Exception:
        return False


def create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions(token, user_id, created_at, revoked) VALUES (?,?,?,0)",
        (token, user_id, now_iso()),
    )
    return token


def revoke_sessions(conn: sqlite3.Connection, user_id: str, keep: str | None = None) -> None:
    if keep:
        conn.execute("UPDATE sessions SET revoked=1 WHERE user_id=? AND token<>?", (user_id, keep))
    else:
        conn.execute("UPDATE sessions SET revoked=1 WHERE user_id=?", (user_id,))


def bearer_token(request) -> str | None:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def user_from_token(conn: sqlite3.Connection, token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.token=? AND s.revoked=0",
        (token,),
    ).fetchone()
    return row_dict(row)


def require_user(request) -> dict[str, Any]:
    token = bearer_token(request)
    with connect() as conn:
        user = user_from_token(conn, token)
    if not user:
        raise ApiError(401, "TOKEN_EXPIRED", "Your session has ended. Please sign in again.")
    if user["status"] == "deleted":
        raise ApiError(410, "RESOURCE_DELETED", "This account has been deleted.")
    if user["status"] == "deleting":
        raise ApiError(403, "ACCOUNT_DELETING", "This account is being deleted.")
    return user


def require_verified(user: dict[str, Any]) -> None:
    if not user.get("age_verified"):
        raise ApiError(403, "AGE_REQUIRED", "Confirm that you are 18 or older to start chatting.")


# ---------------------------------------------------------------- helpers

def body_hash(body: Any) -> str:
    raw = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def idempotent_replay(conn: sqlite3.Connection, user_id: str, key: str | None,
                      endpoint: str, body: Any) -> dict[str, Any] | None:
    if not key:
        return None
    row = conn.execute(
        "SELECT * FROM idempotency WHERE key=? AND user_id=?", (key, user_id)
    ).fetchone()
    if not row:
        return None
    if row["body_hash"] != body_hash(body) or row["endpoint"] != endpoint:
        raise ApiError(
            409, "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used with a different request.",
        )
    return json.loads(row["response"])


def idempotent_save(conn: sqlite3.Connection, user_id: str, key: str | None,
                    endpoint: str, body: Any, status_code: int, response: Any) -> None:
    if not key:
        return
    conn.execute(
        "INSERT OR REPLACE INTO idempotency(key,user_id,endpoint,body_hash,status_code,response,created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (key, user_id, endpoint, body_hash(body), status_code,
         json.dumps(response, ensure_ascii=False), now_iso()),
    )


def ok(data: Any = None, message: str = "ok", status: int = 200) -> dict[str, Any]:
    return {"code": 0, "message": message, "data": data, "request_id": ""}


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "id", "email", "display_name", "created_at", "status", "age_verified", "region", "locale",
        "timezone", "xp", "lumen", "onboarded", "plan_id", "subscription_status",
        "entitlement_end_at", "renewal_enabled", "proactive_checkins", "trial_used",
    )
    out = {k: user.get(k) for k in keys}
    out["age_verified"] = bool(out["age_verified"])
    out["onboarded"] = bool(out["onboarded"])
    out["renewal_enabled"] = bool(out["renewal_enabled"])
    out["daily_reply_limit"] = daily_reply_limit(user)
    return out


def entitlement_live(user: dict[str, Any]) -> bool:
    """True while the user still has paid access.

    `canceled` keeps access until the paid period ends — cancelling stops
    renewal, it does not claw back time already paid for.
    """
    status = user.get("subscription_status")
    if status in ("active", "trial", "grace"):
        return True
    if status != "canceled":
        return False
    end = user.get("entitlement_end_at")
    if not end:
        return False
    try:
        return datetime.fromisoformat(str(end).replace("Z", "+00:00")) > utcnow()
    except ValueError:
        return False


def is_plus(user: dict[str, Any]) -> bool:
    return entitlement_live(user)


def daily_reply_limit(user: dict[str, Any]) -> int:
    return PLUS_DAILY_REPLIES if is_plus(user) else FREE_DAILY_REPLIES


def ensure_memory_settings(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM memory_settings WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO memory_settings(user_id, extraction_enabled, retrieval_enabled, version)"
            " VALUES (?,1,1,1)",
            (user_id,),
        )
        row = conn.execute("SELECT * FROM memory_settings WHERE user_id=?", (user_id,)).fetchone()
    return dict(row)


def ensure_usage(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    bucket = day_bucket(user.get("tz_offset_minutes", 0))
    row = conn.execute(
        "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?", (user["id"], bucket)
    ).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO usage_daily(user_id, bucket, replies, turns) VALUES (?,?,0,0)",
            (user["id"], bucket),
        )
        row = conn.execute(
            "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?", (user["id"], bucket)
        ).fetchone()
    return dict(row)


def add_ledger(conn: sqlite3.Connection, user_id: str, kind: str, amount: int,
               source: str, completion_id: str | None = None) -> dict[str, Any]:
    """Apply XP / Lumen atomically and return the ledger row."""
    if amount == 0:
        return {}
    column = "xp" if kind == "xp" else "lumen"
    conn.execute(f"UPDATE users SET {column} = {column} + ? WHERE id=?", (amount, user_id))
    balance = conn.execute(f"SELECT {column} FROM users WHERE id=?", (user_id,)).fetchone()[0]
    ledger_id = new_id("led")
    conn.execute(
        "INSERT INTO wallet_ledger(id,user_id,kind,amount,balance_after,source,completion_id,created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (ledger_id, user_id, kind, amount, balance, source, completion_id, now_iso()),
    )
    return {"ledger_id": ledger_id, "kind": kind, "amount": amount, "balance": balance}