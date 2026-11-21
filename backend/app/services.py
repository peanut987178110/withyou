"""Domain services: growth, economy, memory, billing and background jobs."""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import content
from .core import (
    ApiError, add_ledger, connect, day_bucket, ensure_memory_settings,
    iso_in_days, new_id, now_iso, utcnow,
)


# ------------------------------------------------------------------- growth

def level_info(xp: int) -> dict[str, Any]:
    level = content.LEVELS[0]
    for item in content.LEVELS:
        if xp >= item["xp"]:
            level = item
    idx = content.LEVELS.index(level)
    nxt = content.LEVELS[idx + 1] if idx + 1 < len(content.LEVELS) else None
    floor = level["xp"]
    ceiling = nxt["xp"] if nxt else floor
    span = max(ceiling - floor, 1)
    progress = 1.0 if not nxt else min(1.0, max(0.0, (xp - floor) / span))
    return {
        "level": level["level"],
        "name": level["name"],
        "xp": xp,
        "level_floor": floor,
        "next_at": ceiling if nxt else None,
        "progress": round(progress, 4),
    }


def read_user(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Account not found.")
    return dict(row)


def wallets(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    fresh = read_user(conn, user["id"])
    info = level_info(fresh["xp"])
    return {
        "xp": fresh["xp"],
        "lumen": fresh["lumen"],
        "level": info,
    }


# ----------------------------------------------------------------- economy

def activity_catalog(conn: sqlite3.Connection, user: dict[str, Any]) -> list[dict[str, Any]]:
    bucket = day_bucket(user.get("tz_offset_minutes", 0))
    usage = conn.execute(
        "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?", (user["id"], bucket)
    ).fetchone()
    turns = usage["turns"] if usage else 0
    out = []
    for activity in content.DAILY_ACTIVITIES:
        count = conn.execute(
            "SELECT COUNT(*) FROM activity_completions WHERE user_id=? AND activity_id=? AND bucket=?",
            (user["id"], activity["id"], bucket),
        ).fetchone()[0]
        item = dict(activity)
        item["completed_today"] = count
        item["remaining"] = max(0, activity["daily_limit"] - count)
        item["available"] = item["remaining"] > 0
        if activity["kind"] == "chat":
            item["progress"] = turns % 3
            item["turns_today"] = turns
            item["available"] = item["available"] and turns >= 3 * (count + 1)
        out.append(item)
    return out


def _grant(conn: sqlite3.Connection, user_id: str, activity: dict[str, Any],
           bucket: str, sequence: int, answers: dict[str, Any],
           *, completion_id: str | None = None) -> dict[str, Any]:
    completion_id = completion_id or new_id("cmp")
    rewards: list[dict[str, Any]] = []
    if activity.get("xp"):
        led = add_ledger(conn, user_id, "xp", int(activity["xp"]), activity["id"], completion_id)
        rewards.append({"type": "xp", "amount": int(activity["xp"]), "ledger_id": led["ledger_id"]})
    if activity.get("lumen"):
        led = add_ledger(conn, user_id, "lumen", int(activity["lumen"]), activity["id"], completion_id)
        rewards.append({"type": "lumen", "amount": int(activity["lumen"]), "ledger_id": led["ledger_id"]})
    conn.execute(
        "INSERT INTO activity_completions(id,user_id,activity_id,rule_version,bucket,sequence,answers,rewards,created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (completion_id, user_id, activity["id"], activity["rule_version"], bucket, sequence,
         json.dumps(answers, ensure_ascii=False), json.dumps(rewards), now_iso()),
    )
    fresh = read_user(conn, user_id)
    return {
        "completion_id": completion_id,
        "activity_id": activity["id"],
        "rewards": rewards,
        "balance": {"xp": fresh["xp"], "lumen": fresh["lumen"]},
        "level": level_info(fresh["xp"]),
        "sequence": sequence,
    }


def complete_activity(conn: sqlite3.Connection, user: dict[str, Any], activity_id: str,
                      rule_version: str, answers: dict[str, Any], idem_key: str | None,
                      endpoint: str) -> dict[str, Any]:
    from .core import idempotent_replay, idempotent_save
    body = {"rule_version": rule_version, "answers": answers}
    replay = idempotent_replay(conn, user["id"], idem_key, endpoint, body)
    if replay is not None:
        return replay

    activity = next((a for a in content.DAILY_ACTIVITIES if a["id"] == activity_id), None)
    if not activity:
        raise ApiError(404, "NOT_FOUND", "Unknown activity.")
    if rule_version and rule_version != activity["rule_version"]:
        raise ApiError(409, "RULE_EXPIRED", "This activity version is no longer active.")

    if activity["kind"] == "mood" and not answers.get("mood"):
        raise ApiError(400, "VALIDATION_ERROR", "Choose a mood first.")
    if activity["kind"] == "reflect" and not str(answers.get("text", "")).strip():
        raise ApiError(400, "VALIDATION_ERROR", "Write a short reflection first.")
    if activity["kind"] == "reflect" and len(str(answers.get("text", ""))) > 280:
        raise ApiError(400, "VALIDATION_ERROR", "Reflections can be up to 280 characters.")

    bucket = day_bucket(user.get("tz_offset_minutes", 0))
    count = conn.execute(
        "SELECT COUNT(*) FROM activity_completions WHERE user_id=? AND activity_id=? AND bucket=?",
        (user["id"], activity_id, bucket),
    ).fetchone()[0]
    if count >= activity["daily_limit"]:
        raise ApiError(429, "RATE_LIMITED", "You've already completed this today. It returns tomorrow.",
                       {"activity_id": activity_id}, retryable=False)

    if activity["kind"] == "chat":
        usage = conn.execute(
            "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?", (user["id"], bucket)
        ).fetchone()
        turns = usage["turns"] if usage else 0
        if turns < 3 * (count + 1):
            raise ApiError(409, "CONFLICT", "Three completed rounds are needed for this reward.",
                           {"turns_today": turns, "needed": 3 * (count + 1)})

    result = _grant(conn, user["id"], activity, bucket, count + 1, answers)
    idempotent_save(conn, user["id"], idem_key, endpoint, body, 201, result)
    return result


def maybe_award_chat_turn(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any] | None:
    """Server-side auto-grant after every third completed exchange, max 3/day."""
    activity = next(a for a in content.DAILY_ACTIVITIES if a["id"] == "chat_session_v1")
    bucket = day_bucket(user.get("tz_offset_minutes", 0))
    usage = conn.execute(
        "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?", (user["id"], bucket)
    ).fetchone()
    turns = usage["turns"] if usage else 0
    if turns == 0 or turns % 3 != 0:
        return None
    count = conn.execute(
        "SELECT COUNT(*) FROM activity_completions WHERE user_id=? AND activity_id=? AND bucket=?",
        (user["id"], "chat_session_v1", bucket),
    ).fetchone()[0]
    if count >= activity["daily_limit"]:
        return None
    try:
        return _grant(conn, user["id"], activity, bucket, count + 1, {"auto": True})
    except sqlite3.IntegrityError:
        return None


def grant_onboarding(conn: sqlite3.Connection, user_id: str) -> dict[str, Any] | None:
    existing = conn.execute(
        "SELECT * FROM activity_completions WHERE user_id=? AND activity_id='onboarding_v1'",
        (user_id,),
    ).fetchone()
    if existing:
        return None
    act = {"id": "onboarding_v1", "rule_version": "2026-11-18.1", "xp": 0,
           "lumen": content.ONBOARDING_REWARD["lumen"]}
    return _grant(conn, user_id, act, "lifetime", 1, {"onboarding": True})


# ------------------------------------------------------------------ memory

def memory_settings(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    row = ensure_memory_settings(conn, user_id)
    return {
        "extraction_enabled": bool(row["extraction_enabled"]),
        "retrieval_enabled": bool(row["retrieval_enabled"]),
        "version": row["version"],
    }


def confirmed_memories(conn: sqlite3.Connection, user_id: str, companion_id: str | None = None,
                       *, retrieval_only: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT * FROM memories WHERE user_id=? AND status='confirmed'"
    args: list[Any] = [user_id]
    if companion_id:
        sql += " AND companion_id=?"
        args.append(companion_id)
    if retrieval_only:
        settings = ensure_memory_settings(conn, user_id)
        if not settings["retrieval_enabled"]:
            return []
    sql += " ORDER BY created_at DESC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def _normal(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", (text or "").lower()).strip()


def create_proposals(conn: sqlite3.Connection, user: dict[str, Any], companion_id: str,
                     source_message_id: str, proposals: list[dict[str, str]]) -> list[dict[str, Any]]:
    if not proposals:
        return []
    settings = ensure_memory_settings(conn, user["id"])
    if not settings["extraction_enabled"]:
        return []
    existing = [dict(r) for r in conn.execute(
        "SELECT * FROM memories WHERE user_id=?", (user["id"],)).fetchall()]
    pending = [dict(r) for r in conn.execute(
        "SELECT * FROM memory_proposals WHERE user_id=? AND status='proposed'", (user["id"],)
    ).fetchall()]
    seen = {_normal(m["text"]) for m in existing + pending}
    recent_rejected = {_normal(r["text"]) for r in conn.execute(
        "SELECT text FROM memory_proposals WHERE user_id=? AND status='rejected'"
        " AND created_at >= datetime('now','-30 days')", (user["id"],)).fetchall()}
    created = []
    for proposal in proposals:
        norm = _normal(proposal["text"])
        if norm in seen or norm in recent_rejected:
            continue
        pid = new_id("prop")
        conn.execute(
            "INSERT INTO memory_proposals(id,user_id,companion_id,text,category,source_message_id,status,created_at,expires_at)"
            " VALUES (?,?,?,?,?,?,'proposed',?,?)",
            (pid, user["id"], companion_id, proposal["text"], proposal.get("category", "general"),
             source_message_id, now_iso(), iso_in_days(7)),
        )
        created.append({"id": pid, "text": proposal["text"], "category": proposal.get("category", "general")})
        seen.add(norm)
    return created


def decide_proposal(conn: sqlite3.Connection, user_id: str, proposal_id: str,
                    decision: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM memory_proposals WHERE id=? AND user_id=?", (proposal_id, user_id)
    ).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Proposal not found.")
    proposal = dict(row)
    if decision in ("confirm", "session_only") and proposal["status"] not in ("proposed", "confirmed", "session_only"):
        raise ApiError(409, "CONFLICT", "This proposal has already been decided.")
    if decision == "confirm":
        existing = conn.execute(
            "SELECT * FROM memories WHERE user_id=? AND text=? AND status='confirmed'",
            (user_id, proposal["text"]),
        ).fetchone()
        if existing:
            mem = dict(existing)
        else:
            mem_id = new_id("mem")
            conn.execute(
                "INSERT INTO memories(id,user_id,companion_id,text,category,status,version,"
                "source_message_id,source_date,created_at) VALUES (?,?,?,?,?,'confirmed',1,?,?,?)",
                (mem_id, user_id, proposal["companion_id"], proposal["text"],
                 proposal["category"], proposal["source_message_id"], now_iso(), now_iso()),
            )
            mem = {"id": mem_id, "text": proposal["text"], "version": 1}
        conn.execute("UPDATE memory_proposals SET status='confirmed' WHERE id=?", (proposal_id,))
        return {"decision": "confirm", "memory_id": mem["id"], "status": "confirmed",
                "version": mem.get("version", 1), "text": mem["text"]}
    if decision == "reject":
        conn.execute("UPDATE memory_proposals SET status='rejected' WHERE id=?", (proposal_id,))
        return {"decision": "reject", "proposal_status": "rejected"}
    if decision == "session_only":
        conn.execute("UPDATE memory_proposals SET status='session_only' WHERE id=?", (proposal_id,))
        return {"decision": "session_only", "proposal_status": "session_only"}
    raise ApiError(400, "VALIDATION_ERROR", "decision must be confirm, reject or session_only.")


def delete_memory(conn: sqlite3.Connection, user_id: str, memory_id: str) -> str:
    row = conn.execute("SELECT * FROM memories WHERE id=? AND user_id=?", (memory_id, user_id)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Memory not found.")
    conn.execute(
        "UPDATE memories SET status='deleted', deleted_at=? WHERE id=? AND user_id=?",
        (now_iso(), memory_id, user_id),
    )
    # Tombstone is committed with the request; retrieval reads only confirmed rows,
    # so this is an immediate read block (T05).
    job_id = new_id("job")
    conn.execute(
        "INSERT INTO jobs(id,user_id,kind,status,token,result,created_at,updated_at)"
        " VALUES (?,?,'memory_delete','completed',?,?,?,?)",
        (job_id, user_id, new_id("tok"), json.dumps({"memory_id": memory_id}), now_iso(), now_iso()),
    )
    return job_id


def update_memory(conn: sqlite3.Connection, user_id: str, memory_id: str,
                  text: str, version: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM memories WHERE id=? AND user_id=?", (memory_id, user_id)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Memory not found.")
    if int(version) != int(row["version"]):
        raise ApiError(409, "CONFLICT", "This memory was updated elsewhere. Reload and try again.")
    if not text.strip() or len(text) > 240:
        raise ApiError(400, "VALIDATION_ERROR", "Memory text must be 1–240 characters.")
    conn.execute(
        "UPDATE memories SET text=?, version=version+1 WHERE id=? AND user_id=?",
        (text.strip(), memory_id, user_id),
    )
    updated = conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
    return dict(updated)


# ----------------------------------------------------------------- billing

CANCEL_URL = "https://play.google.com/store/account/subscriptions"


def _iso_after_days(days: int) -> str:
    from datetime import timedelta
    return (utcnow() + timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


def subscription_payload(user: dict[str, Any]) -> dict[str, Any]:
    from .core import daily_reply_limit
    status = user.get("subscription_status") or "none"
    end = user.get("entitlement_end_at")
    if status == "canceled" and end:
        try:
            expired = datetime.fromisoformat(end.replace("Z", "+00:00")) <= utcnow()
        except ValueError:
            expired = False
        if expired:
            status = "expired"
    return {
        "status": status,
        "plan_id": user.get("plan_id"),
        "entitlement_end_at": end,
        "renewal_enabled": bool(user.get("renewal_enabled")),
        "cancel_url": CANCEL_URL,
        "daily_reply_limit": daily_reply_limit(user),
        "trial_used": bool(user.get("trial_used")),
    }


def start_purchase(conn: sqlite3.Connection, user: dict[str, Any], platform: str,
                   product_id: str, transaction_id: str, receipt: str) -> dict[str, Any]:
    product = next((p for p in content.PRODUCTS if p["id"] == product_id), None)
    if not product:
        raise ApiError(404, "NOT_FOUND", "Unknown product.")
    existing = conn.execute("SELECT * FROM orders WHERE transaction_id=?", (transaction_id,)).fetchone()
    if existing:
        order = dict(existing)
        return {"order_id": order["id"], "status": order["status"], "reused": True}
    if not (receipt or "").startswith("mock-"):
        conn.execute(
            "INSERT INTO orders(id,user_id,platform,product_id,transaction_id,receipt,status,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,'failed',?,?)",
            (new_id("ord"), user["id"], platform, product_id, transaction_id, receipt or "",
             now_iso(), now_iso()),
        )
        raise ApiError(400, "VALIDATION_ERROR", "The receipt could not be verified.", retryable=False)
    order_id = new_id("ord")
    conn.execute(
        "INSERT INTO orders(id,user_id,platform,product_id,transaction_id,receipt,status,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,'pending',?,?)",
        (order_id, user["id"], platform, product_id, transaction_id, receipt, now_iso(), now_iso()),
    )
    return {"order_id": order_id, "status": "pending", "product": product}


def settle_order(order_id: str) -> None:
    """Background verification (mock store). Runs after `pending` is returned."""
    import time
    time.sleep(1.2)
    with connect() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not order or order["status"] != "pending":
            return
        order = dict(order)
        product = next((p for p in content.PRODUCTS if p["id"] == order["product_id"]), None)
        if not product:
            return
        user = read_user(conn, order["user_id"])
        trial = product["trial_days"] > 0 and not user["trial_used"]
        days = product["entitlement_days"]
        status = "trial" if trial else "active"
        conn.execute(
            "UPDATE orders SET status='verified', updated_at=?, entitlement_end_at=? WHERE id=?",
            (now_iso(), _iso_after_days(days), order_id),
        )
        conn.execute(
            "UPDATE users SET plan_id=?, subscription_status=?, entitlement_end_at=?,"
            " renewal_enabled=1, trial_used=trial_used+? WHERE id=?",
            (product["id"], status, _iso_after_days(days), 1 if trial else 0, user["id"]),
        )
        # One-time bundle item, idempotent by primary key.
        conn.execute(
            "INSERT OR IGNORE INTO owned_items(user_id,item_id,acquired_at) VALUES (?,?,?)",
            (user["id"], "moonlight_knit", now_iso()),
        )


def cancel_subscription(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    user = read_user(conn, user_id)
    if user["subscription_status"] not in ("active", "trial", "grace", "canceled"):
        raise ApiError(409, "CONFLICT", "There is no active subscription to cancel.")
    conn.execute(
        "UPDATE users SET renewal_enabled=0, subscription_status='canceled' WHERE id=?", (user_id,)
    )
    return subscription_payload(read_user(conn, user_id))


# -------------------------------------------------------------------- shop

def shop_catalog(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    owned = {r["item_id"] for r in conn.execute(
        "SELECT item_id FROM owned_items WHERE user_id=?", (user_id,)).fetchall()}
    out = []
    for item in content.SHOP_ITEMS:
        entry = dict(item)
        entry["owned"] = item.get("default", False) or item["id"] in owned
        out.append(entry)
    return out


def purchase_item(conn: sqlite3.Connection, user: dict[str, Any], item_id: str) -> dict[str, Any]:
    item = next((i for i in content.SHOP_ITEMS if i["id"] == item_id), None)
    if not item:
        raise ApiError(404, "NOT_FOUND", "Unknown item.")
    if item.get("default") or conn.execute(
        "SELECT 1 FROM owned_items WHERE user_id=? AND item_id=?", (user["id"], item_id)
    ).fetchone():
        return {"item_id": item_id, "owned": True, "charged": 0,
                "balance": read_user(conn, user["id"])["lumen"]}
    price = int(item["price"])
    fresh = read_user(conn, user["id"])
    if fresh["lumen"] < price:
        raise ApiError(409, "INSUFFICIENT_FUNDS", "Not enough Lumen for this item.",
                       {"price": price, "balance": fresh["lumen"]})
    add_ledger(conn, user["id"], "lumen", -price, f"shop:{item_id}")
    conn.execute(
        "INSERT INTO owned_items(user_id,item_id,acquired_at) VALUES (?,?,?)",
        (user["id"], item_id, now_iso()),
    )
    return {"item_id": item_id, "owned": True, "charged": price,
            "balance": read_user(conn, user["id"])["lumen"]}


# -------------------------------------------------------------------- jobs

def create_job(conn: sqlite3.Connection, user_id: str, kind: str,
               result: dict[str, Any] | None = None, status: str = "pending") -> dict[str, Any]:
    job_id = new_id("job")
    token = new_id("tok")
    conn.execute(
        "INSERT INTO jobs(id,user_id,kind,status,token,result,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (job_id, user_id, kind, status, token,
         json.dumps(result or {}), now_iso(), now_iso()),
    )
    return {"job_id": job_id, "status": status, "token": token}


def job_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    try:
        result = json.loads(data.get("result") or "{}")
    except Exception:
        result = {}
    return {
        "job_id": data["id"],
        "kind": data["kind"],
        "status": data["status"],
        "result": result,
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
    }


def export_payload(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    user = read_user(conn, user_id)
    companions = [dict(r) for r in conn.execute(
        "SELECT * FROM companions WHERE user_id=?", (user_id,)).fetchall()]
    conversations = [dict(r) for r in conn.execute(
        "SELECT * FROM conversations WHERE user_id=?", (user_id,)).fetchall()]
    messages = [dict(r) for r in conn.execute(
        "SELECT id,conversation_id,role,content,status,created_at FROM messages"
        " WHERE user_id=? ORDER BY created_at", (user_id,)).fetchall()]
    memories = [dict(r) for r in conn.execute(
        "SELECT id,text,category,status,version,source_date,created_at,deleted_at"
        " FROM memories WHERE user_id=?", (user_id,)).fetchall()]
    ledger = [dict(r) for r in conn.execute(
        "SELECT id,kind,amount,balance_after,source,created_at FROM wallet_ledger"
        " WHERE user_id=? ORDER BY created_at", (user_id,)).fetchall()]
    reports = [dict(r) for r in conn.execute(
        "SELECT id,reason,status,created_at FROM reports WHERE user_id=?", (user_id,)).fetchall()]
    return {
        "exported_at": now_iso(),
        "account": {k: user[k] for k in ("id", "email", "display_name", "created_at", "region", "locale")},
        "companions": companions,
        "conversations": conversations,
        "messages": messages,
        "memories": memories,
        "wallet_ledger": ledger,
        "reports": reports,
        "subscription": subscription_payload(user),
    }


def delete_account_job(conn: sqlite3.Connection, user_id: str) -> str:
    conn.execute("UPDATE users SET status='deleting' WHERE id=?", (user_id,))
    job = create_job(conn, user_id, "account_delete", {"platform_cancel_url": CANCEL_URL})
    return job["job_id"]


def run_delete_job(job_id: str, user_id: str) -> None:
    import time
    time.sleep(1.5)
    with connect() as conn:
        conn.execute("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (now_iso(), job_id))
        # Tokens and push first, then content tables; keep minimal ledger/report audit.
        conn.execute("UPDATE sessions SET revoked=1 WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM message_events WHERE message_id IN"
                     " (SELECT id FROM messages WHERE user_id=?)", (user_id,))
        for table in ("messages", "conversations", "companions", "memories",
                      "memory_proposals", "usage_daily", "owned_items"):
            conn.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM memory_settings WHERE user_id=?", (user_id,))
        conn.execute("UPDATE users SET status='deleted', age_verified=0 WHERE id=?", (user_id,))
        conn.execute(
            "UPDATE jobs SET status='completed', updated_at=?, result=? WHERE id=?",
            (now_iso(), json.dumps({"deleted": True}), job_id),
        )