"""Shared fixtures. Each test module gets a fresh SQLite file."""
from __future__ import annotations

import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP = tempfile.mkdtemp(prefix="wy-test-")
os.environ["WITHYOU_DB"] = str(Path(TMP) / "test.db")
os.environ["WITHYOU_TEST"] = "1"
os.environ["WITHYOU_SEED"] = "0"
os.environ["WITHYOU_AI_MODE"] = "mock"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402

APP = create_app()
CLIENT = TestClient(APP)


def uid() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture()
def client() -> TestClient:
    return CLIENT


def register(client: TestClient, *, verify: bool = True, region: str = "US",
             email: str | None = None) -> dict:
    email = email or f"user-{uid()}@example.test"
    res = client.post("/api/v1/auth/register",
                      json={"email": email, "password": "secret123", "display_name": "Tester"})
    assert res.status_code == 201, res.text
    token = res.json()["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    me = client.get("/api/v1/auth/me", headers=headers).json()["data"]["user"]
    if verify:
        res = client.post("/api/v1/auth/attestation",
                          json={"age_verified": True, "region": region,
                                "timezone": "UTC", "tz_offset_minutes": 0},
                          headers=headers)
        assert res.status_code == 200, res.text
    return {"id": me["id"], "email": email, "token": token, "headers": headers}


def make_companion(client: TestClient, headers: dict, name: str = "Mia") -> dict:
    res = client.post("/api/v1/companions",
                      json={"name": name, "traits": ["Warm", "Curious"],
                            "relationship_type": "friend", "intent": "talk", "energy": 60},
                      headers=headers)
    assert res.status_code in (200, 201), res.text
    return res.json()["data"]


def wait_message(client: TestClient, headers: dict, message_id: str, timeout: float = 12.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        res = client.get(f"/api/v1/messages/{message_id}", headers=headers)
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        if data["status"] in ("completed", "blocked", "failed", "canceled"):
            return data
        time.sleep(0.15)
    raise AssertionError(f"message {message_id} never reached a terminal state")


def send(client: TestClient, headers: dict, conversation_id: str, text: str) -> dict:
    res = client.post(f"/api/v1/conversations/{conversation_id}/messages",
                      json={"content": text, "client_message_id": uuid.uuid4().hex},
                      headers=headers)
    assert res.status_code == 202, res.text
    return res.json()["data"]