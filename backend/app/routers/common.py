"""Shared request helpers for routers."""
from __future__ import annotations

from typing import Any

from fastapi import Request

from ..core import ApiError


def ok(request: Request, data: Any = None, message: str = "ok",
       status: int | None = None) -> dict[str, Any]:
    """Envelope {code,message,data,request_id}. `status` is accepted for call-site
    readability; the HTTP status comes from the route decorator."""
    del status
    return {
        "code": 0,
        "message": message,
        "data": data,
        "request_id": getattr(request.state, "request_id", ""),
    }


async def body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        raise ApiError(400, "VALIDATION_ERROR", "Request body must be valid JSON.")
    if not isinstance(data, dict):
        raise ApiError(400, "VALIDATION_ERROR", "Request body must be a JSON object.")
    return data


def idem(request: Request) -> str | None:
    return request.headers.get("idempotency-key")


def client_meta(request: Request) -> dict[str, Any]:
    return {
        "ip": request.client.host if request.client else "",
        "ua": request.headers.get("user-agent", ""),
    }