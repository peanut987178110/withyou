"""Privacy: export, account deletion, deletion status."""
from __future__ import annotations

import json
import threading

from fastapi import APIRouter, Request

from .. import services
from ..core import ApiError, connect, require_user, verify_password
from .common import body, ok

router = APIRouter(tags=["privacy"])


def require_reauth(request_body: dict, user: dict) -> None:
    """Re-authenticate before an irreversible or whole-account action.

    This used to accept *any* non-empty `password` string — the gate only
    proved the client had sent a field, not that the person at the keyboard
    knew the password. A leaked session token could therefore export or delete
    an account outright. Whatever arrives must now verify against the stored
    hash; a wrong password is the same answer as a missing one.
    """
    supplied = request_body.get("password") or request_body.get("reauth_token")
    if not supplied:
        raise ApiError(403, "REAUTH_REQUIRED", "Confirm your password to continue.")
    if not verify_password(str(request_body.get("password") or ""), user["password_hash"]):
        raise ApiError(403, "REAUTH_REQUIRED", "That password doesn't match.")


@router.post("/exports", status_code=202)
async def create_export(request: Request):
    user = require_user(request)
    payload = await body(request)
    require_reauth(payload, user)
    with connect() as conn:
        data = services.export_payload(conn, user["id"])
        job = services.create_job(conn, user["id"], "export", data, status="completed")
    return ok(request, {"job_id": job["job_id"], "status": "completed",
                        "download_url": f"/api/v1/jobs/{job['job_id']}/download"},
              "accepted", 202)


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: str):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=? AND user_id=?",
                           (job_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Job not found.")
    return ok(request, services.job_payload(row))


@router.get("/jobs/{job_id}/download")
async def download_job(request: Request, job_id: str):
    user = require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=? AND user_id=?",
                           (job_id, user["id"])).fetchone()
        if not row or row["kind"] != "export":
            raise ApiError(404, "NOT_FOUND", "Export not found.")
        payload = json.loads(row["result"] or "{}")
    return ok(request, payload)


@router.delete("/account", status_code=202)
async def delete_account(request: Request):
    user = require_user(request)
    payload = await body(request)
    if not payload.get("confirmation"):
        raise ApiError(400, "VALIDATION_ERROR", "Set confirmation=true after reviewing the scope.")
    require_reauth(payload, user)
    with connect() as conn:
        job_id = services.delete_account_job(conn, user["id"])
    threading.Thread(target=services.run_delete_job, args=(job_id, user["id"]),
                     name=f"wy-del-{job_id}", daemon=True).start()
    return ok(request, {
        "job_id": job_id,
        "status": "pending",
        "platform_cancel_url": services.CANCEL_URL,
        "note": "Deleting your account does not cancel an Apple or Google subscription.",
    }, "accepted", 202)


@router.get("/account/deletion-status")
async def deletion_status(request: Request, job_id: str):
    """Uses the short-lived job status endpoint; the session is already revoked."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=? AND kind='account_delete'",
                           (job_id,)).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Job not found.")
    return ok(request, services.job_payload(row))