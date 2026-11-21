"""Activities, wallet, shop, subscription and jobs."""
from __future__ import annotations

import threading
from typing import Any

from fastapi import APIRouter, Request

from .. import content, locales, services
from ..core import ApiError, connect, day_bucket, require_user
from .common import body, idem, ok

router = APIRouter(tags=["economy"])


@router.get("/activities")
async def activities(request: Request):
    user = require_user(request)
    with connect() as conn:
        items = services.activity_catalog(conn, user)
        wallet = services.wallets(conn, user)
    return ok(request, {"items": items, "wallet": wallet,
                        "moods": content.MOODS})


@router.post("/activities/{activity_id}/completions", status_code=201)
async def complete(request: Request, activity_id: str):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        result = services.complete_activity(
            conn, user, activity_id,
            str(payload.get("rule_version") or ""),
            payload.get("answers") or {},
            idem(request),
            f"POST /activities/{activity_id}/completions",
        )
    return ok(request, result, "granted", 201)


@router.get("/wallet")
async def wallet(request: Request):
    user = require_user(request)
    with connect() as conn:
        data = services.wallets(conn, user)
        activities = services.activity_catalog(conn, user)
    return ok(request, {**data, "activities": activities})


@router.get("/wallet/ledger")
async def ledger(request: Request, cursor: str | None = None, limit: int = 20):
    user = require_user(request)
    limit = max(1, min(int(limit or 20), 100))
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user["id"], limit),
        ).fetchall()
    items = [
        {
            "ledger_id": r["id"],
            "kind": r["kind"],
            "amount": r["amount"],
            "balance_after": r["balance_after"],
            "source": r["source"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return ok(request, {"items": items, "next_cursor": None})


@router.get("/shop")
async def shop(request: Request):
    user = require_user(request)
    with connect() as conn:
        items = services.shop_catalog(conn, user["id"])
        fresh = services.read_user(conn, user["id"])
    return ok(request, {"items": items, "lumen": fresh["lumen"],
                        "rooms": content.ROOMS, "plus": services.subscription_payload(fresh)})


@router.post("/shop/{item_id}/purchase", status_code=201)
async def shop_purchase(request: Request, item_id: str):
    user = require_user(request)
    with connect() as conn:
        result = services.purchase_item(conn, user, item_id)
    return ok(request, result, "purchased", 201)


@router.get("/subscription")
async def subscription(request: Request):
    user = require_user(request)
    with connect() as conn:
        fresh = services.read_user(conn, user["id"])
    data = services.subscription_payload(fresh)
    data["products"] = content.PRODUCTS
    return ok(request, data)


@router.post("/purchases/verify", status_code=202)
async def verify_purchase(request: Request):
    user = require_user(request)
    payload = await body(request)
    platform = str(payload.get("platform") or "google")
    product_id = str(payload.get("product_id") or "")
    transaction_id = str(payload.get("transaction_id") or "")
    receipt = str(payload.get("receipt") or "")
    if not product_id or not transaction_id:
        raise ApiError(400, "VALIDATION_ERROR", "product_id and transaction_id are required.")
    with connect() as conn:
        result = services.start_purchase(conn, user, platform, product_id, transaction_id, receipt)
    if result.get("status") == "pending":
        threading.Thread(target=services.settle_order, args=(result["order_id"],),
                         name=f"wy-order-{result['order_id']}", daemon=True).start()
    return ok(request, {"order_id": result["order_id"], "status": result["status"]}, "pending", 202)


@router.get("/orders/{order_id}")
async def get_order(request: Request, order_id: str):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM orders WHERE id=? AND user_id=?",
                           (order_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Order not found.")
        fresh = services.read_user(conn, user["id"])
    return ok(request, {
        "order_id": row["id"], "status": row["status"], "product_id": row["product_id"],
        "entitlement_end_at": row["entitlement_end_at"],
        "subscription": services.subscription_payload(fresh),
    })


@router.post("/subscription/cancel")
async def cancel_subscription(request: Request):
    user = require_user(request)
    with connect() as conn:
        result = services.cancel_subscription(conn, user["id"])
        fresh = services.read_user(conn, user["id"])
    result["entitlement_end_at"] = fresh["entitlement_end_at"]
    return ok(request, result)


@router.post("/subscription/restore")
async def restore(request: Request):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM orders WHERE user_id=? AND status='verified'"
            " ORDER BY updated_at DESC LIMIT 1", (user["id"],)
        ).fetchone()
        fresh = services.read_user(conn, user["id"])
    if not row:
        return ok(request, {"restored": False, "subscription": services.subscription_payload(fresh)})
    if fresh["subscription_status"] in ("none", "expired"):
        with connect() as conn:
            conn.execute(
                "UPDATE users SET plan_id=?, subscription_status='active', entitlement_end_at=?,"
                " renewal_enabled=1 WHERE id=?",
                (row["product_id"], row["entitlement_end_at"], user["id"]),
            )
            fresh = services.read_user(conn, user["id"])
    return ok(request, {"restored": True, "subscription": services.subscription_payload(fresh)})


@router.get("/settings/notifications")
async def get_notifications(request: Request):
    user = require_user(request)
    with connect() as conn:
        fresh = services.read_user(conn, user["id"])
    return ok(request, {"proactive_checkins": bool(fresh["proactive_checkins"])})


@router.patch("/settings/notifications")
async def patch_notifications(request: Request):
    user = require_user(request)
    payload = await body(request)
    with connect() as conn:
        if "proactive_checkins" in payload:
            conn.execute("UPDATE users SET proactive_checkins=? WHERE id=?",
                         (1 if payload["proactive_checkins"] else 0, user["id"]))
        fresh = services.read_user(conn, user["id"])
    return ok(request, {"proactive_checkins": bool(fresh["proactive_checkins"])})


@router.patch("/settings/locale")
async def patch_locale(request: Request):
    """Store the language the app is running in.

    The reply engine reads `users.locale`, so a device-only choice would leave
    the companion answering in the previous language. Unknown tags are
    normalised (`zh-CN` → `zh`, `pt-BR` → `pt`, junk → `en`) rather than
    rejected: the client may upgrade its locale list before the server does.
    """
    user = require_user(request)
    payload = await body(request)
    code = locales.normalise(payload.get("locale"))
    with connect() as conn:
        conn.execute("UPDATE users SET locale=? WHERE id=?", (code, user["id"]))
    return ok(request, {"locale": code})


@router.post("/growth/reset", status_code=202)
async def reset_growth(request: Request):
    user = require_user(request)
    payload = await body(request)
    if not payload.get("confirm"):
        raise ApiError(400, "VALIDATION_ERROR", "Set confirm=true to reset growth.")
    with connect() as conn:
        # Ledger history is kept; the growth cycle restarts from zero.
        conn.execute("UPDATE users SET xp=0 WHERE id=?", (user["id"],))
        fresh = services.read_user(conn, user["id"])
        wallet = services.wallets(conn, fresh)
    return ok(request, wallet, "reset", 202)