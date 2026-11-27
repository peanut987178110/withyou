"""Voice notes (T4) and real-time calls (T1/T2/T3).

This module owns everything the product doc calls the "voice surface": the
authorization chain, the AI-initiated trigger engine with its prohibition list
and frequency caps, billing with silence forgiveness, and the post-call
artifacts (unfinished thread, voicemail, transcript archive).

Design rules encoded here, with the doc section they come from:

* R-4.1  The first call must be user-initiated. AI-initiated calling only
         unlocks after >=1 call longer than 60s AND >=72h since signup, and the
         first AI-initiated call is unlimited and free.
* R-4.2  Every trigger is keyed by `trigger_id` and evaluated at most once.
         Frequency caps and the seven prohibition rules are enforced here, not
         in the UI, because the UI can be bypassed.
* R-4.3  A ring that is not answered within 30s becomes a missed call; at most
         one voicemail ≤20s is left, then silence. One T3 per trigger.
* R-4.5  Billing is per second with a 10s minimum. Silence is not billed while
         it stays under 40% of the call. There is no hard cutoff: at 10%
         remaining the companion announces and wraps up.
* R-4.6  Degraded paths still end in a call record and a T4 note.
* R-4.7  CallSession is the record; every field the detail page needs lives on
         it, including the billing breakdown.

Everything is deterministic and offline by default. Since v2.2 the audio is
real: the device records and plays, `voice_engine` can render speech (a
deterministic WAV when no provider is configured, an OpenAI-compatible endpoint
when one is), and a call turn can carry an audio clip and the memories it
leaned on. What is still simulated is *understanding* — when no recogniser is
configured the transcript is whatever the user typed, and `/voice/capabilities`
says so out loud rather than letting the UI pretend.
"""
from __future__ import annotations

import base64
import binascii
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from . import audio_store, content, locales, mock_ai, voice_engine
from .core import (
    ApiError, connect, new_id, utcnow,
)

# ---------------------------------------------------------------- constants

RING_TIMEOUT_SECONDS = 30           # R-4.3: 30s ring → missed
VOICEMAIL_MAX_SECONDS = 20          # R-4.3: T3 voicemail ≤20s
T3_PER_MONTH = 2                    # R-4.3: ≤2 voicemail/month
AI_CALL_MIN_CALL_SECONDS = 60       # R-4.1: needs one call > 60s
AI_CALL_MIN_AGE_HOURS = 72          # R-4.1: and 72h since signup
STEADY_STATE_PER_WEEK = 1.0         # R-4.2: 0.5–1 per week
STEADY_STATE_MAX_PER_MONTH = 4
MIN_GAP_HOURS = 48
MAX_AI_CONTACTS_PER_DAY = 1         # ≤1 T2+T3 per 24h
SOFT_CAP_SECONDS = 600              # R-4.4: 10-minute soft cap
MINOR_SOFT_CAP_SECONDS = 300        # R-4.8: minor mode caps a call at 5 min
MINOR_QUIET_HOURS = (22, 8)         # R-4.8: no calls 22:00–08:00 in minor mode
SILENCE_FORGIVENESS = 0.40          # R-4.5: silence up to 40% not billed
BILL_MIN_SECONDS = 10               # R-4.5: 10s minimum
FREE_MONTHLY_SECONDS = 180          # R-4.5: 3 min/month on free
PLAN_MONTHLY_SECONDS = 3600         # R-4.5: 60 min/month on Plus
PACK_MINUTES = 10
PACK_PRICE_CENTS = 600              # 6元 / 10 min

WEEKDAY_START_HOUR = 9              # R-4.2: no weekday 09:00–19:00
WEEKDAY_END_HOUR = 19
PRIMARY_WINDOW = (21 * 60 + 30, 23 * 60 + 30)
WEEKEND_WINDOW = (14 * 60, 16 * 60)

def _now() -> datetime:
    """Clock seam. The trigger engine's rules are all about *when* it is, so the
    tests freeze this rather than bending timezone offsets (which cannot change
    the weekday) or depending on which day the suite happens to run."""
    return _CLOCK() if _CLOCK else utcnow()


_CLOCK = None


def set_clock(fn) -> None:
    """Test/ops hook: make the engine believe it is `fn()`."""
    global _CLOCK
    _CLOCK = fn


def reset_clock() -> None:
    global _CLOCK
    _CLOCK = None


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _local(user: dict[str, Any], when: datetime | None = None) -> datetime:
    return (when or _now()) + timedelta(minutes=int(user.get("tz_offset_minutes") or 0))


def _month_bucket(user: dict[str, Any]) -> str:
    return _local(user).strftime("%Y-%m")


def _companion(conn: sqlite3.Connection, user: dict[str, Any]) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM companions WHERE user_id=? ORDER BY created_at LIMIT 1",
                       (user["id"],)).fetchone()
    if not row:
        raise ApiError(400, "VALIDATION_ERROR", "Create your companion first.")
    return row


# ------------------------------------------------------------------ settings

def settings_row(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM voice_settings WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO voice_settings(user_id, calls_enabled, prefer_no_calls,"
            " captions_enabled, transcript_archive, minor_mode, version, updated_at)"
            " VALUES (?,1,0,0,1,0,1,?)",
            (user_id, _iso(_now())),
        )
        row = conn.execute("SELECT * FROM voice_settings WHERE user_id=?", (user_id,)).fetchone()
    out = dict(row)
    for key in ("calls_enabled", "prefer_no_calls", "captions_enabled",
                "transcript_archive", "minor_mode"):
        out[key] = bool(out[key])
    return out


def update_settings(conn: sqlite3.Connection, user: dict[str, Any],
                    payload: dict[str, Any]) -> dict[str, Any]:
    current = settings_row(conn, user["id"])
    if "version" in payload and int(payload["version"]) != int(current["version"]):
        raise ApiError(409, "CONFLICT", "Settings changed elsewhere. Reload and try again.")
    updates = {}
    for key in ("calls_enabled", "prefer_no_calls", "captions_enabled",
                "transcript_archive", "minor_mode"):
        if key in payload:
            updates[key] = 1 if payload[key] else 0
    if not updates:
        return current
    sets = ", ".join(f"{k}=?" for k in updates)
    conn.execute(
        f"UPDATE voice_settings SET {sets}, version=version+1, updated_at=? WHERE user_id=?",
        (*updates.values(), _iso(_now()), user["id"]),
    )
    return settings_row(conn, user["id"])


# --------------------------------------------------------------------- quota

def quota_row(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    month = _month_bucket(user)
    row = conn.execute("SELECT * FROM voice_quota WHERE user_id=? AND month=?",
                       (user["id"], month)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO voice_quota(user_id, month, created_at) VALUES (?,?,?)",
            (user["id"], month, _iso(_now())),
        )
        row = conn.execute("SELECT * FROM voice_quota WHERE user_id=? AND month=?",
                           (user["id"], month)).fetchone()
    return dict(row)


def _pack_seconds(conn: sqlite3.Connection, user_id: str) -> int:
    row = conn.execute("SELECT COALESCE(SUM(seconds_left),0) FROM voice_packs WHERE user_id=?",
                       (user_id,)).fetchone()
    return int(row[0] or 0)


def quota_payload(conn: sqlite3.Connection, user: dict[str, Any],
                  is_plus: bool) -> dict[str, Any]:
    """What the settings screen and the in-call warning both read."""
    row = quota_row(conn, user)
    packs = _pack_seconds(conn, user["id"])
    free_total = FREE_MONTHLY_SECONDS
    plan_total = PLAN_MONTHLY_SECONDS if is_plus else 0
    gift_left = max(0, int(row["gift_seconds"]) - int(row["free_seconds_used"]))
    used_free = int(row["free_seconds_used"])
    free_left = max(0, free_total - max(0, used_free - int(row["gift_seconds"])))
    plan_left = max(0, plan_total - int(row["plan_seconds_used"]))
    total_left = gift_left + plan_left + packs + (free_left if not is_plus else 0)
    return {
        "month": row["month"],
        "plan": "plus" if is_plus else "free",
        "free_seconds_total": free_total,
        "free_seconds_left": free_left,
        "plan_seconds_total": plan_total,
        "plan_seconds_left": plan_left,
        "pack_seconds_left": packs,
        "gift_seconds_left": gift_left,
        "seconds_left": total_left,
        "ai_calls_unlocked": ai_calls_unlocked(conn, user),
        "ai_calls_used_this_month": ai_contacts_this_month(conn, user),
        "voicemails_used_this_month": voicemails_this_month(conn, user),
        "voicemails_per_month": T3_PER_MONTH,
        "pack_minutes": PACK_MINUTES,
        "pack_price_cents": PACK_PRICE_CENTS,
    }


def _spend(conn: sqlite3.Connection, user: dict[str, Any], seconds: int) -> dict[str, Any]:
    """Deduct in priority order: gift → plan → pack → free, per R-4.5.

    Returns the breakdown the call detail page shows. Never leaves a negative
    balance: the caller sizes the call to what is left.
    """
    row = quota_row(conn, user)
    remaining = max(0, int(seconds))
    detail: list[dict[str, Any]] = []

    def take(source: str, available: int) -> int:
        nonlocal remaining
        used = min(remaining, max(0, available))
        if used:
            detail.append({"source": source, "seconds": used})
            remaining -= used
        return used

    gift_avail = max(0, int(row["gift_seconds"]) - int(row["free_seconds_used"]))
    used_gift = take("gift", gift_avail)
    free_avail = max(0, FREE_MONTHLY_SECONDS - max(0, int(row["free_seconds_used"]) - int(row["gift_seconds"])))
    used_free = take("free", free_avail)
    plan_avail = max(0, PLAN_MONTHLY_SECONDS - int(row["plan_seconds_used"]))
    used_plan = take("plan", plan_avail)
    used_pack = 0
    if remaining:
        used_pack = take("pack", _pack_seconds(conn, user["id"]))
        if used_pack:
            _consume_packs(conn, user["id"], used_pack)

    conn.execute(
        "UPDATE voice_quota SET free_seconds_used=free_seconds_used+?,"
        " plan_seconds_used=plan_seconds_used+? WHERE user_id=? AND month=?",
        (used_gift + used_free, used_plan, user["id"], row["month"]),
    )
    return {"charged_seconds": sum(d["seconds"] for d in detail), "breakdown": detail,
            "unbilled_seconds": remaining}


def _consume_packs(conn: sqlite3.Connection, user_id: str, seconds: int) -> None:
    left = seconds
    rows = conn.execute(
        "SELECT * FROM voice_packs WHERE user_id=? AND seconds_left>0 ORDER BY created_at",
        (user_id,),
    ).fetchall()
    for row in rows:
        if left <= 0:
            break
        take = min(left, int(row["seconds_left"]))
        conn.execute("UPDATE voice_packs SET seconds_left=seconds_left-? WHERE id=?",
                     (take, row["id"]))
        left -= take


def buy_pack(conn: sqlite3.Connection, user: dict[str, Any],
             idem_replay: dict[str, Any] | None = None) -> dict[str, Any]:
    if idem_replay is not None:
        return idem_replay
    pack_id = new_id("vpk")
    conn.execute(
        "INSERT INTO voice_packs(id,user_id,minutes,seconds_left,price_cents,created_at)"
        " VALUES (?,?,?,?,?,?)",
        (pack_id, user["id"], PACK_MINUTES, PACK_MINUTES * 60,
         PACK_PRICE_CENTS, _iso(_now())),
    )
    return {"pack_id": pack_id, "minutes": PACK_MINUTES,
            "price_cents": PACK_PRICE_CENTS, "auto_renew": False,
            "seconds_added": PACK_MINUTES * 60}


# ---------------------------------------------------------- authorization chain

def ai_calls_unlocked(conn: sqlite3.Connection, user: dict[str, Any]) -> bool:
    """R-4.1: one call over 60s, and the account is at least 72h old."""
    created = _parse(user.get("created_at"))
    if created and _now() - created < timedelta(hours=AI_CALL_MIN_AGE_HOURS):
        return False
    row = conn.execute(
        "SELECT COUNT(*) FROM call_sessions WHERE user_id=? AND direction='outbound'"
        " AND duration_seconds>=?", (user["id"], AI_CALL_MIN_CALL_SECONDS),
    ).fetchone()
    return int(row[0] or 0) > 0


def _any_answered_call(conn: sqlite3.Connection, user_id: str) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM call_sessions WHERE user_id=? AND answered_at IS NOT NULL",
        (user_id,),
    ).fetchone()
    return int(row[0] or 0) > 0


def ai_contacts_this_month(conn: sqlite3.Connection, user: dict[str, Any]) -> int:
    month = _month_bucket(user)
    rows = conn.execute(
        "SELECT created_at FROM call_sessions WHERE user_id=? AND direction='inbound'"
        " AND status IN ('ended','missed')", (user["id"],),
    ).fetchall()
    return sum(1 for r in rows if (_local(user, _parse(r["created_at"]) or _now()).strftime("%Y-%m") == month))


def voicemails_this_month(conn: sqlite3.Connection, user: dict[str, Any]) -> int:
    month = _month_bucket(user)
    rows = conn.execute("SELECT created_at FROM voicemails WHERE user_id=?", (user["id"],)).fetchall()
    return sum(1 for r in rows
               if (_local(user, _parse(r["created_at"]) or _now()).strftime("%Y-%m") == month))


def _last_inbound_at(conn: sqlite3.Connection, user_id: str) -> datetime | None:
    rows = conn.execute(
        "SELECT created_at FROM call_sessions WHERE user_id=? AND direction='inbound'"
        " ORDER BY created_at DESC LIMIT 1", (user_id,),
    ).fetchall()
    return _parse(rows[0]["created_at"]) if rows else None


def _t3_last_at(conn: sqlite3.Connection, user_id: str) -> datetime | None:
    row = conn.execute(
        "SELECT created_at FROM voicemails WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    return _parse(row["created_at"]) if row else None


def _declined_then_silent(conn: sqlite3.Connection, user: dict[str, Any]) -> bool:
    """R-4.2: if the last AI call was declined and the user has not spoken
    since, stay silent."""
    row = conn.execute(
        "SELECT * FROM call_sessions WHERE user_id=? AND direction='inbound'"
        " ORDER BY created_at DESC LIMIT 1", (user["id"],),
    ).fetchone()
    if not row or row["status"] != "missed":
        return False
    since = _parse(row["created_at"])
    if not since:
        return False
    spoken = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE user_id=? AND role='user' AND created_at>=?",
        (user["id"], _iso(since)),
    ).fetchone()
    return int(spoken[0] or 0) == 0


def _minutes_today(conn: sqlite3.Connection, user: dict[str, Any]) -> int:
    start = _local(user)
    start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start - timedelta(minutes=int(user.get("tz_offset_minutes") or 0))
    row = conn.execute(
        "SELECT COALESCE(SUM(duration_seconds),0) FROM call_sessions WHERE user_id=?"
        " AND created_at>=?", (user["id"], _iso(start_utc)),
    ).fetchone()
    return int(row[0] or 0) // 60


def _has_recent_report(conn: sqlite3.Connection, user_id: str, days: int = 7) -> bool:
    since = _iso(_now() - timedelta(days=days))
    row = conn.execute("SELECT COUNT(*) FROM reports WHERE user_id=? AND created_at>=?",
                       (user_id, since)).fetchone()
    return int(row[0] or 0) > 0


def _in_quiet_hours(user: dict[str, Any]) -> bool:
    """R-4.2 weekday 09:00–19:00 is a hard block."""
    local = _local(user)
    if local.weekday() >= 5:
        return False
    return WEEKDAY_START_HOUR <= local.hour < WEEKDAY_END_HOUR


def _in_preferred_window(user: dict[str, Any]) -> bool:
    local = _local(user)
    minutes = local.hour * 60 + local.minute
    if local.weekday() >= 5:
        lo, hi = WEEKEND_WINDOW
        return lo <= minutes < hi
    lo, hi = PRIMARY_WINDOW
    return lo <= minutes < hi


def _after_midnight(user: dict[str, Any]) -> bool:
    return _local(user).hour < 6


def _adaptive_backoff_days(conn: sqlite3.Connection, user_id: str) -> int:
    """R-4.2 back-off: 4 → 7 → 10 → 14 → 30 days for each consecutive decline."""
    rows = conn.execute(
        "SELECT status FROM call_sessions WHERE user_id=? AND direction='inbound'"
        " ORDER BY created_at DESC LIMIT 5", (user_id,),
    ).fetchall()
    steps = [4, 7, 10, 14, 30]
    declines = 0
    for row in rows:
        if row["status"] == "missed":
            declines += 1
        else:
            break
    return steps[min(declines, len(steps) - 1)] if declines else 0


# --------------------------------------------------------- prohibition list

def prohibition(conn: sqlite3.Connection, user: dict[str, Any],
                settings: dict[str, Any], now: datetime | None = None) -> str | None:
    """Return the reason the AI must not call, or None if it may.

    Order matters: the checks that are absolute come first so the log explains
    the strongest reason. Every branch is one line of the doc's seven-item list
    (plus the account-level switch from R-4.1).
    """
    if not settings["calls_enabled"]:
        return "calls_disabled"
    if settings["prefer_no_calls"]:
        return "prefer_no_calls"
    if settings["minor_mode"]:
        return "minor_mode"
    created = _parse(user.get("created_at"))
    if created and _now() - created < timedelta(hours=24):
        return "account_too_new"
    if _in_quiet_hours(user):
        return "weekday_quiet_hours"
    if _declined_then_silent(conn, user):
        return "declined_then_silent"
    if _minutes_today(conn, user) > 90:
        return "heavy_use_today"
    if _has_recent_report(conn, user["id"]):
        return "recent_report"
    last = _last_inbound_at(conn, user["id"])
    if last and _now() - last < timedelta(hours=MIN_GAP_HOURS):
        return "min_gap"
    if _inbound_last_24h(conn, user["id"]):
        return "daily_cap"
    backoff = _adaptive_backoff_days(conn, user["id"])
    if last and backoff and _now() - last < timedelta(days=backoff):
        return "backoff"
    return None


def _inbound_last_24h(conn: sqlite3.Connection, user_id: str) -> bool:
    since = _iso(_now() - timedelta(hours=24))
    t2 = conn.execute(
        "SELECT COUNT(*) FROM call_sessions WHERE user_id=? AND direction='inbound'"
        " AND created_at>=?", (user_id, since),
    ).fetchone()
    t3 = conn.execute(
        "SELECT COUNT(*) FROM voicemails WHERE user_id=? AND created_at>=?",
        (user_id, since),
    ).fetchone()
    return int(t2[0] or 0) + int(t3[0] or 0) >= MAX_AI_CONTACTS_PER_DAY


# ----------------------------------------------------------- trigger engine

def _record_trigger(conn: sqlite3.Connection, user_id: str, trigger_id: str, kind: str,
                    reason: str, decision: str, detail: dict[str, Any] | None = None) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO voice_triggers(trigger_id,user_id,kind,reason,decision,detail,created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (trigger_id, user_id, kind, reason, decision,
         json.dumps(detail or {}, ensure_ascii=False), _iso(_now())),
    )


def trigger_seen(conn: sqlite3.Connection, trigger_id: str) -> bool:
    row = conn.execute("SELECT 1 FROM voice_triggers WHERE trigger_id=?", (trigger_id,)).fetchone()
    return row is not None


def evaluate_trigger(conn: sqlite3.Connection, user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Decide whether a trigger may start an AI call (T2) or leave a note (T3).

    `payload` carries `trigger_id`, `kind` (P0–P4) and a human `reason`. Returns
    the decision plus, when it fired, the created session/voicemail. The
    trigger_id is idempotent: a second POST with the same id returns the first
    decision instead of dialling twice.
    """
    trigger_id = str(payload.get("trigger_id") or "").strip()
    kind = str(payload.get("kind") or "").strip().upper()
    reason = str(payload.get("reason") or "").strip()
    if not trigger_id or len(trigger_id) > 120:
        raise ApiError(400, "VALIDATION_ERROR", "trigger_id is required.")
    if kind not in {"P0", "P1", "P2", "P3", "P4"}:
        raise ApiError(400, "VALIDATION_ERROR", "Unknown trigger kind.")

    existing = conn.execute("SELECT * FROM voice_triggers WHERE trigger_id=?",
                            (trigger_id,)).fetchone()
    if existing:
        return {"trigger_id": trigger_id, "decision": existing["decision"],
                "detail": json.loads(existing["detail"] or "{}"), "reused": True}

    settings = settings_row(conn, user["id"])
    if not ai_calls_unlocked(conn, user):
        _record_trigger(conn, user["id"], trigger_id, kind, reason, "suppressed",
                        {"why": "not_unlocked"})
        return {"trigger_id": trigger_id, "decision": "suppressed",
                "detail": {"why": "not_unlocked"}, "reused": False}

    blocked = prohibition(conn, user, settings)
    if blocked:
        _record_trigger(conn, user["id"], trigger_id, kind, reason, "suppressed",
                        {"why": blocked})
        return {"trigger_id": trigger_id, "decision": "suppressed",
                "detail": {"why": blocked}, "reused": False}

    # Frequency: steady state 0.5–1/week and ≤4/month.
    if ai_contacts_this_month(conn, user) >= STEADY_STATE_MAX_PER_MONTH:
        _record_trigger(conn, user["id"], trigger_id, kind, reason, "suppressed",
                        {"why": "monthly_cap"})
        return {"trigger_id": trigger_id, "decision": "suppressed",
                "detail": {"why": "monthly_cap"}, "reused": False}

    # P4 (silence repair) may only leave a voice note, never ring.
    if kind == "P4":
        if voicemails_this_month(conn, user) >= T3_PER_MONTH:
            _record_trigger(conn, user["id"], trigger_id, kind, reason, "suppressed",
                            {"why": "voicemail_cap"})
            return {"trigger_id": trigger_id, "decision": "suppressed",
                    "detail": {"why": "voicemail_cap"}, "reused": False}
        note = _create_voicemail(conn, user, trigger_id, reason)
        _record_trigger(conn, user["id"], trigger_id, kind, reason, "voicemail",
                        {"voicemail_id": note["id"]})
        return {"trigger_id": trigger_id, "decision": "voicemail",
                "detail": {"voicemail_id": note["id"]}, "reused": False}

    # P2 only after midnight, and only when a text/voice probe went unanswered.
    if kind == "P2" and _after_midnight(user):
        probe = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE user_id=? AND role='user' AND created_at>=?",
            (user["id"], _iso(_now() - timedelta(hours=3))),
        ).fetchone()
        if int(probe[0] or 0) > 0:
            _record_trigger(conn, user["id"], trigger_id, kind, reason, "suppressed",
                            {"why": "probe_answered"})
            return {"trigger_id": trigger_id, "decision": "suppressed",
                    "detail": {"why": "probe_answered"}, "reused": False}

    first_ever = not _any_inbound_contact(conn, user["id"])
    session = create_session(conn, user, direction="inbound", trigger_id=trigger_id,
                             free_first=first_ever, reason=reason)
    _record_trigger(conn, user["id"], trigger_id, kind, reason, "call",
                    {"session_id": session["id"]})
    return {"trigger_id": trigger_id, "decision": "call",
            "detail": {"session_id": session["id"], "free": first_ever}, "reused": False}


def _any_inbound_contact(conn: sqlite3.Connection, user_id: str) -> bool:
    a = conn.execute("SELECT 1 FROM call_sessions WHERE user_id=? AND direction='inbound'",
                     (user_id,)).fetchone()
    b = conn.execute("SELECT 1 FROM voicemails WHERE user_id=?", (user_id,)).fetchone()
    return bool(a or b)


# -------------------------------------------------------------- call session

def create_session(conn: sqlite3.Connection, user: dict[str, Any], *,
                   direction: str, trigger_id: str | None = None,
                   free_first: bool = False, reason: str = "") -> dict[str, Any]:
    """Open a CallSession. T1 is user-initiated; T2 is the AI calling."""
    companion = _companion(conn, user)
    settings = settings_row(conn, user["id"])
    if direction == "outbound":
        if not settings["calls_enabled"]:
            raise ApiError(403, "CALLS_DISABLED",
                           "Calling is turned off in your settings.")
        if settings["minor_mode"] and _minor_quiet_now(user):
            raise ApiError(403, "MINOR_CALL_HOURS",
                           "Calls are not available between 22:00 and 08:00 in minor mode.")
        left = quota_payload(conn, user, _is_plus(user))["seconds_left"]
        if left <= 0 and not free_first:
            raise ApiError(402, "QUOTA_EXHAUSTED",
                           "You're out of voice minutes this month. You can still send voice notes.")
    session_id = new_id("call")
    conn.execute(
        "INSERT INTO call_sessions(id,user_id,companion_id,direction,status,trigger_id,"
        "ring_started_at,quota_source,transcript,created_at,unfinished_thread)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (session_id, user["id"], companion["id"], direction,
         "ringing" if direction == "inbound" else "active",
         trigger_id, _iso(_now()),
         "gift" if free_first else None, "[]", _iso(_now()), ""),
    )
    if direction == "outbound":
        conn.execute("UPDATE call_sessions SET answered_at=? WHERE id=?", (_iso(_now()), session_id))
    row = conn.execute("SELECT * FROM call_sessions WHERE id=?", (session_id,)).fetchone()
    return session_json(dict(row))


def soft_cap_for(settings: dict[str, Any]) -> int:
    """R-4.4 10 minutes; R-4.8 five minutes when minor mode is on."""
    return MINOR_SOFT_CAP_SECONDS if settings["minor_mode"] else SOFT_CAP_SECONDS


def _minor_quiet_now(user: dict[str, Any]) -> bool:
    start, end = MINOR_QUIET_HOURS
    hour = _local(user).hour
    return hour >= start or hour < end


def _is_plus(user: dict[str, Any]) -> bool:
    from .core import is_plus
    return is_plus(user)


def call_row(conn: sqlite3.Connection, user: dict[str, Any], session_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM call_sessions WHERE id=? AND user_id=?",
                       (session_id, user["id"])).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Call not found.")
    return row


def session_json(row: dict[str, Any], *, detail: bool = False) -> dict[str, Any]:
    out = {
        "id": row["id"],
        "direction": row["direction"],
        "status": row["status"],
        "ring_started_at": row["ring_started_at"],
        "answered_at": row.get("answered_at"),
        "ended_at": row.get("ended_at"),
        "duration_seconds": int(row.get("duration_seconds") or 0),
        "billed_seconds": int(row.get("billed_seconds") or 0),
        "silence_seconds": int(row.get("silence_seconds") or 0),
        # What the detail page labels "forgiven": silence up to 40% of the call.
        "silence_forgiven_seconds": min(
            int(row.get("silence_seconds") or 0),
            int(int(row.get("duration_seconds") or 0) * SILENCE_FORGIVENESS),
        ),
        "quota_source": row.get("quota_source"),
        "end_reason": row.get("end_reason"),
        "trigger_id": row.get("trigger_id"),
        "safety_level": row.get("safety_level"),
        "unfinished_thread": row.get("unfinished_thread") or "",
        "billing_detail": json.loads(row.get("billing_detail") or "[]"),
    }
    if detail:
        out["transcript"] = json.loads(row.get("transcript") or "[]")
    return out


def answer_call(conn: sqlite3.Connection, user: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Pick up an inbound ring. R-4.4: the AI has a specific opener ready."""
    row = call_row(conn, user, session_id)
    if row["direction"] != "inbound":
        raise ApiError(409, "CONFLICT", "This call is already connected.")
    if row["status"] not in ("ringing",):
        raise ApiError(409, "CONFLICT", "This call is no longer ringing.")
    started = _parse(row["ring_started_at"])
    if started and _now() - started > timedelta(seconds=RING_TIMEOUT_SECONDS):
        _finish_missed(conn, user, row)
        raise ApiError(409, "CALL_MISSED", "The call ended. They left you a note.")
    conn.execute("UPDATE call_sessions SET status='active', answered_at=? WHERE id=?",
                 (_iso(_now()), session_id))
    opener, used = _opener_for(conn, row, user, _companion(conn, user))
    _append_turn(conn, session_id, "assistant", opener, 0, memory_ids=used)
    return {"session": session_json(dict(call_row(conn, user, session_id))), "opener": opener}


def _opener_for(conn: sqlite3.Connection, row: Any, user: dict[str, Any],
                companion: Any = None) -> tuple[str, list[str]]:
    """The first line. R-4.4 forbids a bare "你好呀": it must be specific.

    If the user has confirmed a memory, the opener leads with it. A companion
    that calls you and then says something generic has answered the phone but
    not the question of why it dialled.
    """
    pk = locales.pack(user.get("locale"))
    key = f"{row['id']}:{row['trigger_id'] or ''}"

    memories: list[dict[str, Any]] = []
    if companion is not None:
        try:
            rows = conn.execute(
                "SELECT id,text FROM memories WHERE user_id=? AND status='confirmed'"
                " AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3",
                (user["id"],),
            ).fetchall()
            memories = [{"id": r["id"], "text": r["text"]} for r in rows]
        except sqlite3.Error:
            memories = []

    memory_lines = pk.get("call_memory_openers") or []
    if memories and memory_lines:
        pick = memories[_stable_hash(key) % len(memories)]
        text = _memory_clause(pick["text"])
        line = memory_lines[_stable_hash(key) % len(memory_lines)]
        return line.replace("{memory}", text), [pick["id"]]

    lines = pk.get("call_openers") or ["Hey — I was just thinking about that thing you said earlier."]
    return lines[_stable_hash(key) % len(lines)], []


def _memory_clause(text: str) -> str:
    """Make a stored memory safe to say in the middle of a spoken sentence."""
    cleaned = " ".join(str(text or "").split())
    # A memory is written as a standalone statement. Dropping the final period
    # keeps the opener from having two full stops in a row, which reads like a
    # bug when it is spoken aloud.
    cleaned = cleaned.rstrip(".。！!？? ")
    return cleaned[:120]


def _stable_hash(text: str) -> int:
    """`hash()` is salted per process; a call's first line must not change on
    a server restart, and the tests must see the same script every run."""
    import zlib
    return zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF


def _finish_missed(conn: sqlite3.Connection, user: dict[str, Any], row: Any) -> dict[str, Any]:
    conn.execute("UPDATE call_sessions SET status='missed', ended_at=?, end_reason='no_answer'"
                 " WHERE id=?", (_iso(_now()), row["id"]))
    note = None
    if voicemails_this_month(conn, user) < T3_PER_MONTH and row["trigger_id"]:
        note = _create_voicemail(conn, user, row["trigger_id"], "no_answer",
                                 session_id=row["id"])
    return {"session": session_json(dict(call_row(conn, user, row["id"]))),
            "voicemail": note}


def timeout_ring(conn: sqlite3.Connection, user: dict[str, Any], session_id: str) -> dict[str, Any]:
    row = call_row(conn, user, session_id)
    if row["status"] != "ringing":
        return {"session": session_json(dict(row)), "voicemail": None}
    return _finish_missed(conn, user, row)


def _create_voicemail(conn: sqlite3.Connection, user: dict[str, Any], trigger_id: str,
                      reason: str, session_id: str | None = None) -> dict[str, Any]:
    companion = _companion(conn, user)
    pk = locales.pack(user.get("locale"))
    scripts = pk.get("voicemail_scripts") or [
        "Hey, it's me. I know today sounded heavy. No need to call back — I'll be here tomorrow."]
    script = scripts[_stable_hash(trigger_id) % len(scripts)]
    vid = new_id("vml")
    conn.execute(
        "INSERT OR IGNORE INTO voicemails(id,user_id,companion_id,session_id,trigger_id,script,"
        "duration_ms,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (vid, user["id"], companion["id"], session_id, trigger_id, script,
         min(18000, 9000 + len(script) * 40), "unread", _iso(_now()),
         _iso(_now() + timedelta(days=30))),
    )
    row = conn.execute("SELECT * FROM voicemails WHERE user_id=? AND trigger_id=?",
                       (user["id"], trigger_id)).fetchone()
    return voicemail_json(dict(row))


def voicemail_json(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"], "session_id": row.get("session_id"),
        "trigger_id": row["trigger_id"], "script": row["script"],
        "duration_ms": int(row.get("duration_ms") or 0),
        "status": row["status"], "created_at": row["created_at"],
        "expires_at": row.get("expires_at"), "max_seconds": VOICEMAIL_MAX_SECONDS,
    }


def _append_turn(conn: sqlite3.Connection, session_id: str, role: str, content_text: str,
                 at_ms: int, kind: str = "speech", *, audio_key: str | None = None,
                 duration_ms: int = 0, interrupted: bool = False,
                 memory_ids: list[str] | None = None) -> dict[str, Any]:
    tid = new_id("turn")
    conn.execute(
        "INSERT INTO call_turns(id,session_id,role,content,at_ms,kind,created_at,"
        "audio_key,duration_ms,interrupted,memory_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (tid, session_id, role, content_text, int(at_ms), kind, _iso(_now()),
         audio_key, int(duration_ms or 0), 1 if interrupted else 0,
         json.dumps(memory_ids or [], ensure_ascii=False)),
    )
    return {"id": tid, "role": role, "content": content_text, "at_ms": int(at_ms),
            "kind": kind, "interrupted": bool(interrupted)}


def _level_for(xp: int) -> int:
    level = 1
    for item in content.LEVELS:
        if int(xp or 0) >= int(item["xp"]):
            level = int(item["level"])
    return level


def _call_context(conn: sqlite3.Connection, user: dict[str, Any],
                  companion: Any) -> dict[str, Any]:
    """What the companion is allowed to remember *while speaking*.

    A call is long, and a companion that forgets what was said ten minutes ago
    is not a companion. So the same confirmed memories the text chat uses are
    handed to the call, plus the last few messages, plus the relationship
    level — all of it scoped to this user, none of it from proposals.
    """
    try:
        mem_rows = conn.execute(
            "SELECT id,text,category,created_at FROM memories"
            " WHERE user_id=? AND status='confirmed' AND deleted_at IS NULL"
            " ORDER BY created_at DESC LIMIT 5", (user["id"],),
        ).fetchall()
    except sqlite3.Error:
        mem_rows = []
    memories = [{"id": r["id"], "text": r["text"], "category": r["category"]} for r in mem_rows]

    try:
        hist_rows = conn.execute(
            "SELECT role, content FROM messages WHERE user_id=? AND companion_id=?"
            " ORDER BY created_at DESC LIMIT 6",
            (user["id"], companion["id"]),
        ).fetchall()
    except sqlite3.Error:
        hist_rows = []
    history = [{"role": r["role"], "content": r["content"][:400]} for r in reversed(hist_rows)]

    xp = 0
    row = conn.execute("SELECT xp FROM users WHERE id=?", (user["id"],)).fetchone()
    if row:
        xp = int(row["xp"] or 0)

    settings = conn.execute("SELECT * FROM voice_settings WHERE user_id=?",
                            (user["id"],)).fetchone()
    retrieval = bool(settings["captions_enabled"]) if settings else False

    return {"memories": memories, "history": history, "level": _level_for(xp),
            "retrieval_enabled": retrieval}


def say(conn: sqlite3.Connection, user: dict[str, Any], session_id: str,
        payload: dict[str, Any]) -> dict[str, Any]:
    """One turn of the live call: store what the user said, reply, bill.

    This is the whole in-call loop, kept server-side so the quota, the safety
    check and the transcript cannot be skipped by a modified client.

    The user's side may arrive as text (typed, or produced by speech
    recognition on the device) and optionally as a clip. Keeping the clip is
    what makes "I said something and it did not hear me" an honest state rather
    than a lost sentence.
    """
    row = call_row(conn, user, session_id)
    if row["status"] != "active":
        raise ApiError(409, "CONFLICT", "This call has ended.")
    text = str(payload.get("text") or "").strip()
    at_ms = int(payload.get("at_ms") or 0)
    silence = int(payload.get("silence_ms") or 0)
    interrupted = bool(payload.get("interrupted"))
    spoken_ms = int(payload.get("duration_ms") or 0)
    spoke = bool(text)

    audio_key = None
    clip = payload.get("audio")
    if isinstance(clip, str) and clip:
        audio_key = _store_base64_audio(user, clip, str(payload.get("mime") or "audio/webm"))

    if spoke:
        verdict = mock_ai.classify(text)
        if verdict["blocked"]:
            conn.execute("UPDATE call_sessions SET safety_level=? WHERE id=?",
                         (verdict["level"], session_id))
            safety = mock_ai.crisis_reply(verdict["category"], user.get("region"),
                                          user.get("locale"))
            reply = safety["reply_text"]
            _append_turn(conn, session_id, "user", text, at_ms, audio_key=audio_key,
                         duration_ms=spoken_ms)
            _append_turn(conn, session_id, "assistant", reply, at_ms, "system")
            return {"reply": reply, "blocked": True, "resources": safety.get("resources", []),
                    "safety_level": verdict["level"], "memory_used": [],
                    "session": session_json(dict(call_row(conn, user, session_id)))}
        companion = _companion(conn, user)
        ctx = _call_context(conn, user, companion)
        result = mock_ai.compose_reply(
            user_text=text, name=companion["name"],
            traits=json.loads(companion["traits"] or "[]"),
            relationship_type=companion["relationship_type"],
            level=ctx["level"], memories=ctx["memories"],
            retrieval_enabled=True, history=ctx["history"],
            region=user.get("region"), locale=user.get("locale"),
        )
        reply = _voice_safe(result["reply_text"])
        used = [m["id"] for m in ctx["memories"] if m["text"] and m["text"][:24] in reply]
        _append_turn(conn, session_id, "user", text, at_ms, audio_key=audio_key,
                     duration_ms=spoken_ms)
    else:
        reply = _silence_nudge(conn, user, row, silence)
        used = []
        _append_turn(conn, session_id, "assistant", reply, at_ms, "nudge")

    if spoke:
        _append_turn(conn, session_id, "assistant", reply, at_ms,
                     interrupted=interrupted, memory_ids=used)
    _turn_effect(conn, user, row, duration_seconds=int(payload.get("elapsed_seconds") or 0),
                 silence_seconds=silence // 1000 if silence else 0)
    return {"reply": reply, "blocked": False, "memory_used": used,
            "session": session_json(dict(call_row(conn, user, session_id)))}


def _store_base64_audio(user: dict[str, Any], clip: str, mime: str) -> str | None:
    """Accept either a bare base64 body or a data URL, store it, return the key.

    Oversize or malformed clips are dropped rather than failing the turn: a
    call that cannot keep the audio should still keep the words.
    """
    raw = clip
    if clip.startswith("data:"):
        head, _, raw = clip.partition(",")
        if ";base64" not in head:
            return None
        mime = head[5:].split(";")[0] or mime
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not data:
        return None
    try:
        return audio_store.save(user["id"], data, mime)["key"]
    except ValueError:
        return None


def _voice_safe(text: str) -> str:
    """R-4.4: strip action/emotion stage directions like `*she smiles*`."""
    import re
    cleaned = re.sub(r"\*[^*]{0,80}\*", "", text)
    cleaned = re.sub(r"（[^）]{0,40}）|\([^)]{0,40}\)", "", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip() or text


def _silence_nudge(conn: sqlite3.Connection, user: dict[str, Any], row: Any,
                   silence_ms: int) -> str:
    """3s / 8s / 15s ladder, then ask-and-hang-up at 60s (R-4.4)."""
    seconds = silence_ms // 1000
    pk = locales.pack(user.get("locale"))
    ladder = pk.get("call_silence") or [
        "I'm still here.",
        "Take your time. Want to keep going, or stop for now?",
        "I'll let you go in a moment — we can pick this up later.",
    ]
    if seconds < 3:
        return ladder[0]
    if seconds < 8:
        return ladder[1]
    return ladder[2]


def _turn_effect(conn: sqlite3.Connection, user: dict[str, Any], row: Any,
                 *, duration_seconds: int, silence_seconds: int) -> None:
    if duration_seconds > 0:
        conn.execute("UPDATE call_sessions SET duration_seconds=?, silence_seconds=?"
                     " WHERE id=?", (duration_seconds, silence_seconds, row["id"]))


def warn_threshold(conn: sqlite3.Connection, user: dict[str, Any],
                   session_id: str) -> dict[str, Any]:
    """R-4.5: at 10% remaining the companion announces and starts wrapping up."""
    row = call_row(conn, user, session_id)
    quota = quota_payload(conn, user, _is_plus(user))
    left = quota["seconds_left"]
    duration = int(row["duration_seconds"] or 0)
    cap = soft_cap_for(settings_row(conn, user["id"]))
    near_cap = cap - duration <= 60
    return {"seconds_left": left,
            "should_warn": near_cap or left <= max(30, int(duration * 0.1)),
            "near_soft_cap": near_cap,
            "soft_cap_seconds": cap,
            "hard_cutoff": False}


def end_call(conn: sqlite3.Connection, user: dict[str, Any], session_id: str,
             payload: dict[str, Any]) -> dict[str, Any]:
    """Close the call: forgive silence, bill per second, keep the open thread."""
    row = call_row(conn, user, session_id)
    if row["status"] in ("ended", "missed", "failed"):
        return {"session": session_json(dict(row), detail=True),
                "voicemail": None, "already": True}
    duration = max(0, int(payload.get("duration_seconds") or row["duration_seconds"] or 0))
    silence = max(0, int(payload.get("silence_seconds") or row["silence_seconds"] or 0))
    reason = str(payload.get("end_reason") or "user_ended")
    # R-4.8: minor mode is a hard five-minute ceiling, not just a warning. The
    # client is told the same cap on /calls, so this only catches a stale one.
    cap = soft_cap_for(settings_row(conn, user["id"]))
    if duration > cap:
        duration, reason = cap, "soft_cap"
    thread = str(payload.get("unfinished_thread") or row["unfinished_thread"] or "")

    # Silence forgiveness: up to 40% of the call is not billed. Beyond that the
    # excess is billed, because a call that is mostly silence still occupied the
    # line — but the user is told exactly this on the detail page.
    forgiven = min(silence, int(duration * SILENCE_FORGIVENESS))
    billable = duration - forgiven
    if billable and billable < BILL_MIN_SECONDS:
        billable = min(BILL_MIN_SECONDS, duration)

    source = row["quota_source"]
    billed = 0
    breakdown: list[dict[str, Any]] = []
    if source == "gift":
        # First AI-initiated call: unlimited and free (R-4.1).
        breakdown = [{"source": "gift", "seconds": billable}]
    elif billable > 0:
        spend = _spend(conn, user, billable)
        billed = spend["charged_seconds"]
        breakdown = spend["breakdown"] or []

    conn.execute(
        "UPDATE call_sessions SET status='ended', ended_at=?, duration_seconds=?,"
        " billed_seconds=?, silence_seconds=?, end_reason=?, unfinished_thread=?,"
        " billing_detail=? WHERE id=?",
        (_iso(_now()), duration, billed, silence, reason, thread,
         json.dumps(breakdown), session_id),
    )
    turns = conn.execute("SELECT * FROM call_turns WHERE session_id=? ORDER BY at_ms, created_at",
                         (session_id,)).fetchall()
    transcript = [{"role": r["role"], "content": r["content"], "at_ms": r["at_ms"],
                   "kind": r["kind"]} for r in turns]
    conn.execute("UPDATE call_sessions SET transcript=? WHERE id=?",
                 (json.dumps(transcript, ensure_ascii=False), session_id))

    # R-4.4: an ending must leave one unfinished thread, recapped by a T4 note
    # within 24h. If the caller did not supply one, derive it from the last
    # user turn so the promise is never silently dropped.
    voicemail = None
    if duration >= 60 and not thread:
        last_user = next((x for x in reversed(transcript) if x["role"] == "user"), None)
        thread = last_user["content"][:160] if last_user else ""
        if thread:
            conn.execute("UPDATE call_sessions SET unfinished_thread=? WHERE id=?",
                         (thread, session_id))

    note = _post_call_note(conn, user, session_id, thread)
    return {"session": session_json(dict(call_row(conn, user, session_id)), detail=True),
            "voicemail": voicemail, "voice_note": note,
            "quota": quota_payload(conn, user, _is_plus(user))}


def _post_call_note(conn: sqlite3.Connection, user: dict[str, Any], session_id: str,
                    thread: str) -> dict[str, Any] | None:
    """Turn the unfinished thread into a T4 note queued in the chat."""
    if not thread:
        return None
    companion = _companion(conn, user)
    conv = conn.execute(
        "SELECT * FROM conversations WHERE user_id=? AND companion_id=? ORDER BY created_at DESC LIMIT 1",
        (user["id"], companion["id"]),
    ).fetchone()
    if not conv:
        return None
    text = f"{thread}"
    mid = new_id("msg")
    pk = locales.pack(user.get("locale"))
    prefix = pk.get("post_call_prefix") or "About before — "
    line = prefix + text
    conn.execute(
        "INSERT INTO messages(id,conversation_id,user_id,role,content,status,created_at)"
        " VALUES (?,?,?,'assistant',?,'completed',?)",
        (mid, conv["id"], user["id"], line, _iso(_now())),
    )

    # It is a *voice* note, so it has to have a voice. The old build wrote
    # mime='audio/mock' with no audio at all: the bubble could not play and the
    # chat did not even render it. Render with the caller's own voice profile.
    audio_key = None
    audio_bytes = 0
    mime = "audio/wav"
    duration_ms = 12000
    try:
        raw_profile = companion["voice_profile"] if "voice_profile" in companion.keys() else None
        profile = voice_engine.normalise_profile(
            _load_json(raw_profile),
            json.loads(companion["traits"] or "[]"), user.get("locale") or "en")
        data, mime = voice_engine.synthesize(line, profile["voice_id"],
                                             profile["rate"], profile["pitch"])
        stored = audio_store.save(user["id"], data, mime)
        audio_key = stored["key"]
        audio_bytes = stored["bytes"]
        duration_ms = int(max(0.5, len(text) * 0.075) * 1000)
    except (voice_engine.VoiceEngineError, ValueError, KeyError):
        # No engine, or the bytes were refused: keep the words and let the
        # bubble fall back to the transcript rather than to a dead player.
        audio_key = None
        mime = "text/plain"

    nid = new_id("vn")
    conn.execute(
        "INSERT INTO voice_notes(id,user_id,conversation_id,message_id,direction,duration_ms,"
        "mime,audio,transcript,created_at,expires_at,audio_key,audio_bytes)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (nid, user["id"], conv["id"], mid, "assistant", duration_ms, mime, None,
         text, _iso(_now()), _iso(_now() + timedelta(days=30)), audio_key, audio_bytes),
    )
    return {"id": nid, "message_id": mid, "transcript": text,
            "has_audio": bool(audio_key), "duration_ms": duration_ms}


def _load_json(raw: Any) -> Any:
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return raw


# ------------------------------------------------------------- voice notes

def create_note(conn: sqlite3.Connection, user: dict[str, Any],
                payload: dict[str, Any]) -> dict[str, Any]:
    """T4: a user voice message. Transcription is best-effort; audio is kept.

    The clip goes to disk (`audio_store`), the row keeps a key and the waveform
    peaks. Peaks are computed by the client while it still has the samples in
    memory — the chat list can then draw a real waveform without decoding any
    audio, which is the difference between a voice note and a grey bar.
    """
    duration_ms = int(payload.get("duration_ms") or 0)
    if duration_ms <= 0 or duration_ms > 300000:
        raise ApiError(400, "VALIDATION_ERROR", "Voice notes must be between 1s and 5 minutes.")
    conversation_id = payload.get("conversation_id")
    conv = conn.execute("SELECT * FROM conversations WHERE id=? AND user_id=?",
                        (conversation_id, user["id"])).fetchone()
    if not conv:
        raise ApiError(404, "NOT_FOUND", "Conversation not found.")

    audio_key = None
    audio_bytes = 0
    legacy_audio = None
    raw_audio = payload.get("audio")
    if isinstance(raw_audio, str) and raw_audio:
        try:
            stored = _store_base64_audio(user, raw_audio,
                                         str(payload.get("mime") or "audio/webm"))
        except ApiError:
            stored = None
        if stored:
            audio_key = stored
            audio_bytes = len(raw_audio) * 3 // 4
        elif len(raw_audio) > 4_000_000:
            raise ApiError(413, "AUDIO_TOO_LARGE", "That recording is too large to keep.")
        else:
            # Unparseable but small: keep the legacy path rather than losing it.
            legacy_audio = raw_audio

    peaks = payload.get("peaks")
    if not isinstance(peaks, list):
        peaks = []
    peaks = [round(float(p), 3) for p in peaks[:64] if isinstance(p, (int, float))]

    transcript = str(payload.get("transcript") or "").strip()
    if not transcript and payload.get("client_transcript"):
        transcript = str(payload.get("client_transcript") or "").strip()
    message_id = payload.get("message_id")
    if message_id:
        # The chat renders a voice bubble *instead of* the text bubble, so the
        # note has to point at the message it replaces — otherwise every voice
        # note would render twice (once as text, once as audio) or not at all.
        msg = conn.execute("SELECT id FROM messages WHERE id=? AND user_id=?",
                           (message_id, user["id"])).fetchone()
        if not msg:
            raise ApiError(404, "NOT_FOUND", "Message not found.")
    nid = new_id("vn")
    conn.execute(
        "INSERT INTO voice_notes(id,user_id,conversation_id,message_id,direction,duration_ms,"
        "mime,audio,transcript,created_at,expires_at,audio_key,audio_bytes,peaks)"
        " VALUES (?,?,?,?,'user',?,?,?,?,?,?,?,?,?)",
        (nid, user["id"], conversation_id, message_id, duration_ms,
         str(payload.get("mime") or "audio/webm")[:60], legacy_audio, transcript,
         _iso(_now()), _iso(_now() + timedelta(days=30)), audio_key, audio_bytes,
         json.dumps(peaks)),
    )
    row = conn.execute("SELECT * FROM voice_notes WHERE id=?", (nid,)).fetchone()
    return note_json(dict(row))


def link_note(conn: sqlite3.Connection, user: dict[str, Any], note_id: str,
              message_id: str) -> None:
    """Attach a note to the message it stands in for, after the message exists.

    The bubble is drawn from the message row, so this is what makes the audio
    appear inside the thread rather than beside it.
    """
    conn.execute("UPDATE voice_notes SET message_id=? WHERE id=? AND user_id=?",
                 (message_id, note_id, user["id"]))


def _peaks_of(row: dict[str, Any]) -> list[float]:
    try:
        value = json.loads(row.get("peaks") or "[]")
        return [float(x) for x in value][:64] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError, ValueError):
        return []


def note_json(row: dict[str, Any], *, with_audio: bool = False) -> dict[str, Any]:
    out = {
        "id": row["id"], "conversation_id": row.get("conversation_id"),
        "message_id": row.get("message_id"), "direction": row["direction"],
        "duration_ms": int(row.get("duration_ms") or 0), "mime": row.get("mime"),
        "transcript": row.get("transcript") or "", "created_at": row["created_at"],
        "deleted": bool(row.get("deleted_at")),
        "peaks": _peaks_of(row),
        "bytes": int(row.get("audio_bytes") or 0),
        "has_audio": bool(row.get("audio_key") or row.get("audio")),
    }
    if with_audio:
        out["audio"] = row.get("audio")
    return out


def list_notes(conn: sqlite3.Connection, user: dict[str, Any],
               conversation_id: str | None = None) -> list[dict[str, Any]]:
    if conversation_id:
        rows = conn.execute(
            "SELECT * FROM voice_notes WHERE user_id=? AND conversation_id=? AND deleted_at IS NULL"
            " ORDER BY created_at DESC LIMIT 50", (user["id"], conversation_id),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM voice_notes WHERE user_id=? AND deleted_at IS NULL"
            " ORDER BY created_at DESC LIMIT 50", (user["id"],),
        ).fetchall()
    return [note_json(dict(r)) for r in rows]


def note_audio(conn: sqlite3.Connection, user: dict[str, Any], note_id: str) -> dict[str, Any]:
    """The recording itself, for playback.

    New rows read from disk; rows written before v2.2 still carry a data URL in
    the `audio` column and are returned as they are. Both shapes reach the
    client through one route, so nothing had to be migrated.
    """
    row = conn.execute(
        "SELECT audio, mime, deleted_at, audio_key FROM voice_notes WHERE id=? AND user_id=?",
        (note_id, user["id"]),
    ).fetchone()
    if not row or row["deleted_at"]:
        raise ApiError(404, "NOT_FOUND", "Voice note not found.")
    mime = row["mime"] or "audio/webm"
    if row["audio_key"]:
        data = audio_store.open_bytes(row["audio_key"])
        if data is None:
            raise ApiError(404, "NOT_FOUND", "This note has no audio.")
        return {"id": note_id, "mime": mime, "audio_bytes": data, "encoding": "binary"}
    if not row["audio"]:
        raise ApiError(404, "NOT_FOUND", "This note has no audio.")
    return {"id": note_id, "mime": mime, "audio": row["audio"], "encoding": "data-url"}


def delete_note(conn: sqlite3.Connection, user: dict[str, Any], note_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM voice_notes WHERE id=? AND user_id=?",
                       (note_id, user["id"])).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Voice note not found.")
    if row["audio_key"]:
        audio_store.delete(row["audio_key"])
    conn.execute(
        "UPDATE voice_notes SET deleted_at=?, audio=NULL, audio_key=NULL, audio_bytes=0 WHERE id=?",
        (_iso(_now()), note_id))
    return {"id": note_id, "deleted": True}


def sweep_expired(conn: sqlite3.Connection, user: dict[str, Any] | None = None) -> dict[str, int]:
    """Delete the audio of expired notes. Rows stay; the words stay.

    Nothing did this before, so `expires_at` was decoration and a user who
    asked for 30-day retention kept everything forever. Cheap to run on every
    voice-screen load: the index makes it a scan of a handful of rows.
    """
    sql = ("SELECT id, audio_key, audio FROM voice_notes"
           " WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?")
    params: list[Any] = [_iso(_now())]
    if user is not None:
        sql += " AND user_id=?"
        params.append(user["id"])
    rows = conn.execute(sql, params).fetchall()
    removed = 0
    for row in rows:
        if row["audio_key"]:
            audio_store.delete(row["audio_key"])
            removed += 1
        conn.execute(
            "UPDATE voice_notes SET audio_key=NULL, audio=NULL, audio_bytes=0, deleted_at=?"
            " WHERE id=?", (_iso(_now()), row["id"]))
    return {"expired": len(rows), "audio_removed": removed}


# -------------------------------------------------------------- transcripts

def list_calls(conn: sqlite3.Connection, user: dict[str, Any], limit: int = 30) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM call_sessions WHERE user_id=? AND status IN ('ended','missed','failed')"
        " ORDER BY created_at DESC LIMIT ?", (user["id"], limit),
    ).fetchall()
    return [session_json(dict(r)) for r in rows]


def call_detail(conn: sqlite3.Connection, user: dict[str, Any], session_id: str) -> dict[str, Any]:
    row = call_row(conn, user, session_id)
    settings = settings_row(conn, user["id"])
    data = session_json(dict(row), detail=bool(settings["transcript_archive"]))
    data["quota"] = quota_payload(conn, user, _is_plus(user))
    data["transcript_archived"] = bool(settings["transcript_archive"])
    data["recording_days_kept"] = 7
    return data


def delete_transcript(conn: sqlite3.Connection, user: dict[str, Any],
                      session_id: str) -> dict[str, Any]:
    row = call_row(conn, user, session_id)
    conn.execute("UPDATE call_sessions SET transcript='[]' WHERE id=?", (row["id"],))
    return {"id": session_id, "transcript": []}


# ------------------------------------------------------------ voicemail API

def list_voicemails(conn: sqlite3.Connection, user: dict[str, Any]) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM voicemails WHERE user_id=? ORDER BY created_at DESC LIMIT 20",
        (user["id"],),
    ).fetchall()
    return [voicemail_json(dict(r)) for r in rows]


def mark_voicemail(conn: sqlite3.Connection, user: dict[str, Any], vid: str,
                   status: str) -> dict[str, Any]:
    if status not in ("heard", "replied"):
        raise ApiError(400, "VALIDATION_ERROR", "Unknown voicemail status.")
    row = conn.execute("SELECT * FROM voicemails WHERE id=? AND user_id=?",
                       (vid, user["id"])).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Voicemail not found.")
    conn.execute("UPDATE voicemails SET status=? WHERE id=?", (status, vid))
    row = conn.execute("SELECT * FROM voicemails WHERE id=?", (vid,)).fetchone()
    return voicemail_json(dict(row))