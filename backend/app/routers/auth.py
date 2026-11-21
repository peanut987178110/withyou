"""Account, authentication and age/region attestation."""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, Request

from .. import content, locales, services
from ..core import (
    ApiError, connect, create_session, daily_reply_limit, day_bucket,
    ensure_memory_settings, hash_password, is_plus, new_id, now_iso, public_user,
    require_user, revoke_sessions, user_from_token, verify_password, bearer_token,
)
from .common import body, ok

router = APIRouter(prefix="/auth", tags=["auth"])
account_router = APIRouter(tags=["account"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REGIONS = ["US", "GB", "CA", "AU", "CN", "SG", "DE", "FR", "IN", "JP", "OTHER"]


def _validate_credentials(payload: dict[str, Any], *, registering: bool) -> tuple[str, str]:
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not EMAIL_RE.match(email):
        raise ApiError(400, "VALIDATION_ERROR", "Enter a valid email address.")
    if len(password) < 6:
        raise ApiError(400, "VALIDATION_ERROR", "Password must be at least 6 characters.")
    return email, password


@router.post("/register", status_code=201)
async def register(request: Request):
    payload = await body(request)
    email, password = _validate_credentials(payload, registering=True)
    display_name = str(payload.get("display_name") or "").strip()[:40]
    with connect() as conn:
        exists = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if exists:
            raise ApiError(409, "EMAIL_IN_USE", "An account with this email already exists.")
        user_id = new_id("usr")
        conn.execute(
            "INSERT INTO users(id,email,password_hash,display_name,created_at,locale,tz_offset_minutes)"
            " VALUES (?,?,?,?,?,?,?)",
            (user_id, email, hash_password(password), display_name or email.split("@")[0],
             now_iso(), locales.normalise(payload.get("locale")),
             int(payload.get("tz_offset_minutes") or 0)),
        )
        ensure_memory_settings(conn, user_id)
        token = create_session(conn, user_id)
        user = dict(conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
    return ok(request, {"token": token, "user": public_user(user)})


@router.post("/login")
async def login(request: Request):
    payload = await body(request)
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            raise ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.")
        if row["status"] == "deleted":
            raise ApiError(410, "RESOURCE_DELETED", "This account has been deleted.")
        if row["status"] == "deleting":
            raise ApiError(403, "ACCOUNT_DELETING", "This account is being deleted.")
        token = create_session(conn, row["id"])
        user = dict(row)
    return ok(request, {"token": token, "user": public_user(user)})


@router.post("/refresh")
async def refresh(request: Request):
    user = require_user(request)
    old = bearer_token(request)
    with connect() as conn:
        revoke_sessions(conn, user["id"], keep=None)
        token = create_session(conn, user["id"])
    return ok(request, {"token": token, "user": public_user(user)})


@router.post("/logout")
async def logout(request: Request):
    user = require_user(request)
    token = bearer_token(request)
    with connect() as conn:
        conn.execute("UPDATE sessions SET revoked=1 WHERE token=? AND user_id=?",
                     (token, user["id"]))
    return ok(request, {"revoked": True})


@router.post("/attestation")
async def attestation(request: Request):
    user = require_user(request)
    payload = await body(request)
    age_ok = bool(payload.get("age_verified") or payload.get("is_adult"))
    region = str(payload.get("region") or "").upper()
    if not age_ok:
        raise ApiError(403, "AGE_REQUIRED", "WithYou is only available to adults (18+).")
    if region not in REGIONS:
        raise ApiError(400, "VALIDATION_ERROR", "Choose your region so we can show the right support.")
    with connect() as conn:
        conn.execute(
            "UPDATE users SET age_verified=1, region=?, locale=?, timezone=?, tz_offset_minutes=?"
            " WHERE id=?",
            (region, locales.normalise(payload.get("locale") or user.get("locale") or "en"),
             str(payload.get("timezone") or user.get("timezone") or "UTC"),
             int(payload.get("tz_offset_minutes") or 0), user["id"]),
        )
        fresh = dict(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())
    return ok(request, {"user": public_user(fresh)})


@router.get("/me")
async def me(request: Request):
    user = require_user(request)
    with connect() as conn:
        fresh = dict(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())
        settings = ensure_memory_settings(conn, user["id"])
        comp = conn.execute("SELECT * FROM companions WHERE user_id=?", (user["id"],)).fetchone()
        conv = None
        if comp:
            conv = conn.execute(
                "SELECT * FROM conversations WHERE user_id=? AND companion_id=?"
                " ORDER BY created_at DESC LIMIT 1", (user["id"], comp["id"])
            ).fetchone()
        companion = None
        if comp:
            companion = dict(comp)
            companion["traits"] = json.loads(companion["traits"] or "[]")
            companion["level"] = services.level_info(fresh["xp"])
        usage = conn.execute(
            "SELECT * FROM usage_daily WHERE user_id=? AND bucket=?",
            (user["id"], day_bucket(fresh["tz_offset_minutes"])),
        ).fetchone()
        wallet = {"xp": fresh["xp"], "lumen": fresh["lumen"],
                  "level": services.level_info(fresh["xp"]),
                  "plus": is_plus(fresh),
                  "daily_limit": daily_reply_limit(fresh),
                  "replies_today": usage["replies"] if usage else 0,
                  "turns_today": usage["turns"] if usage else 0}
        data = {
            "user": public_user(fresh),
            "companion": companion,
            "conversation_id": conv["id"] if conv else None,
            "memory_settings": {
                "extraction_enabled": bool(settings["extraction_enabled"]),
                "retrieval_enabled": bool(settings["retrieval_enabled"]),
                "version": settings["version"],
            },
            "wallet": wallet,
            "subscription": services.subscription_payload(fresh),
        }
    return ok(request, data)


@account_router.get("/meta")
async def meta(request: Request):
    return ok(request, {
        "product": "WithYou",
        "version": "2.1",
        "levels": content.LEVELS,
        "relationship_types": content.RELATIONSHIP_TYPES,
        "traits": content.TRAITS,
        "moods": content.MOODS,
        "activities": content.DAILY_ACTIVITIES,
        "products": content.PRODUCTS,
        "rooms": content.ROOMS,
        "shop_items": content.SHOP_ITEMS,
        "regions": REGIONS,
        "lines": content.LINES,
        "safety": {
            "note": "Demo resource set. Production uses a reviewed, region-approved resource KB.",
            "regions": list(content.CRISIS_RESOURCES.keys()),
        },
        "limits": {"message_chars": 4000, "memories_per_turn": 3},
        "context_budget": content.CONTEXT_BUDGET,
        # One real line per supported language, in that language, so the
        # language picker can preview what the companion actually sounds like
        # rather than only naming the locale. Drawn from the same pack the
        # reply engine uses — a preview built from separate demo copy could
        # promise a register the companion does not speak in.
        "locales": [
            {
                "code": code,
                "opener": locales.pack(code)["openers"][0],
                "call_opener": (locales.pack(code).get("call_openers") or [""])[0],
            }
            for code in locales.SUPPORTED
        ],
    })