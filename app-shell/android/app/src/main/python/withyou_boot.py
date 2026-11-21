"""WithYou 安卓壳的后端启动器（由 Chaquopy 在设备上执行）。

设计要点
--------
1. **只读源码 + 可写数据**：APK 里的 Python 源码位于只读的 assets 目录，
   SQLite 需要写权限，所以数据库放到 App 的文件目录（files/backend/data/）。
2. **离线优先**：AI 走 `WITHYOU_AI_MODE=mock`（确定性桩），不联网、不扣费。
3. **后台线程跑 uvicorn**：主线程留给 WebView；服务只监听 127.0.0.1，
   WiFi 里别的设备访问不到。
4. **幂等**：重复调用 start() 不会起第二个服务。

调试：adb logcat -s WithYouPy
"""
from __future__ import annotations

import logging
import os
import threading
import time

log = logging.getLogger("WithYouPy")

PORT = 8791
_started = threading.Event()
_error: str = ""


def _prepare_env(files_dir: str) -> None:
    """把环境变量和数据库路径指向 App 的可写目录。"""
    data_dir = os.path.join(files_dir, "backend", "data")
    os.makedirs(data_dir, exist_ok=True)
    os.environ.setdefault("WITHYOU_DB", os.path.join(data_dir, "withyou.db"))
    # 离线演示：确定性 mock AI，不调用任何外部模型。
    os.environ.setdefault("WITHYOU_AI_MODE", "mock")
    # 演示账号（Alex / Sam / Riley，密码 demo1234）—— 文档 06 的验收用例依赖它们。
    os.environ.setdefault("WITHYOU_SEED", "1")


def _run_server() -> None:
    global _error
    try:
        import uvicorn

        from app.main import app  # noqa: F401  （导入即建库、注册路由与静态目录）

        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=PORT,
            log_level="warning",
            access_log=False,
            # 手机核少，单 worker 够用；loop 用 asyncio（uvloop 无 Android 轮子）
        )
        server = uvicorn.Server(config)
        _started.set()
        server.run()
    except Exception as exc:  # pragma: no cover - 设备上执行
        _error = repr(exc)
        log.exception("backend failed: %s", exc)
        _started.set()


def start(files_dir: str) -> dict:
    """启动后端起服务。返回 {"port": int, "error": str}。可重复调用。"""
    _prepare_env(files_dir)
    if not _started.is_set():
        threading.Thread(target=_run_server, name="withyou-api", daemon=True).start()
    _started.wait(timeout=30)
    return {"port": PORT, "error": _error}


def wait_ready(timeout: float = 40.0) -> bool:
    """轮询 /healthz，确认**本 App** 的服务真的在应答。

    127.0.0.1 是整台设备共享的：别的 App（例如同机安装的另一个演示包）也可能
    占着同一个端口。所以不能只看"有东西应答"，必须核对 service 字段。
    否则会出现"后端已经崩了，但健康检查通过"——界面照常打开，然后每个请求都 404。
    """
    import json
    import urllib.error
    import urllib.request

    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/healthz", timeout=1) as r:
                if r.status == 200:
                    body = json.loads(r.read().decode("utf-8", "replace"))
                    if body.get("service") == "withyou":
                        return True
                    # 端口被别的服务占着：这不是我们的后端，继续等/最终失败。
                    global _error
                    _error = f"port {PORT} held by foreign service: {body}"
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(0.25)
    return False