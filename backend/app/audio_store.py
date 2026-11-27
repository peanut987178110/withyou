"""Audio blobs on disk.

Here is why this module exists. The first build kept every recording as a
base64 data URL in `voice_notes.audio`, a TEXT column. That is fine for a
30-second note and wrong for everything after it:

- a 60-second webm is ~700 kB, ~930 kB once base64'd, sitting in a row that
  is read on every note listing;
- `voice_notes` had a 4 MB character cap, so a real recording near the top of
  the allowed duration was silently refused;
- the call feature needs per-turn clips, which would multiply the above by
  however many turns a conversation has.

So: bytes go to files, rows keep a key. Old rows that still carry a data URL
keep working — `voice.note_audio` falls back to the column when `audio_key`
is empty. Nothing is migrated destructively.
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from pathlib import Path
from typing import Any

from . import core

# 8 MB is comfortably above a five-minute opus note (~2.5 MB) and far below
# anything that would make a listing slow.
MAX_BYTES = int(os.environ.get("WITHYOU_AUDIO_MAX_BYTES", str(8 * 1024 * 1024)))

_MIME_EXT = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
}

# Keys are generated here, never taken from a client. The regex is the guard
# for the one place a key does come back from the outside: the audio route.
_KEY_RE = re.compile(r"^[0-9a-f]{24}\.(webm|ogg|wav|mp3|m4a|aac)$")

_root_override: Path | None = None


def root() -> Path:
    if _root_override is not None:
        return _root_override
    configured = os.environ.get("WITHYOU_AUDIO_DIR")
    if configured:
        return Path(configured)
    # Next to the database, which is what every other runtime artefact does.
    return Path(core.db_path()).parent / "audio"


def set_root(path: str | Path | None) -> None:
    """Tests point this at a temp dir; the app never calls it."""
    global _root_override
    _root_override = Path(path) if path is not None else None


def ext_for(mime: str) -> str:
    base = (mime or "").split(";")[0].strip().lower()
    return _MIME_EXT.get(base, "bin")


def valid_key(key: str | None) -> bool:
    return bool(key) and bool(_KEY_RE.match(key))


def _path_for(key: str) -> Path:
    if not valid_key(key):
        raise ValueError("bad audio key")
    # Two-character shard keeps any single directory from holding every file.
    return root() / key[:2] / key


def save(user_id: str, data: bytes, mime: str) -> dict[str, Any]:
    """Write bytes and return the metadata a row needs.

    Raises `ValueError` on oversize input; the router turns that into 413 so
    the limit is stated once here rather than duplicated per endpoint.
    """
    if not data:
        raise ValueError("empty audio")
    if len(data) > MAX_BYTES:
        raise ValueError("audio too large")

    key = f"{uuid.uuid4().hex[:24]}.{ext_for(mime)}"
    path = _path_for(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename: a crash mid-write must not leave a half file that a
    # later read would happily serve as if it were whole.
    tmp = path.with_suffix(path.suffix + ".part")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)

    return {
        "key": key,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "user_id": user_id,
        "mime": (mime or "application/octet-stream").split(";")[0].strip(),
    }


def open_bytes(key: str) -> bytes | None:
    if not valid_key(key):
        return None
    path = _path_for(key)
    try:
        return path.read_bytes()
    except OSError:
        return None


def exists(key: str) -> bool:
    return valid_key(key) and _path_for(key).exists()


def delete(key: str) -> bool:
    """Remove the file. Returns False when there was nothing to remove."""
    if not valid_key(key):
        return False
    path = _path_for(key)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def total_bytes(user_id: str | None = None) -> int:
    """Disk accounting. `user_id` is not part of the key, so this is global."""
    base = root()
    if not base.exists():
        return 0
    total = 0
    for path in base.rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return total
