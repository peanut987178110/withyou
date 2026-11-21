@echo off
cd /d "%~dp0"
title WithYou

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python was not found on PATH.
  echo   Install Python 3.11+ or start the server manually.
  echo.
  pause
  exit /b 1
)

echo.
echo   WithYou is starting at http://127.0.0.1:8765/
echo   Keep this window open. Press Ctrl+C to stop.
echo.

rem Open the browser once the server actually answers, so nobody lands on a dead page.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/healthz -TimeoutSec 1; if($r.StatusCode -eq 200){Start-Process 'http://127.0.0.1:8765/'; break}}catch{}; Start-Sleep -Milliseconds 500}"

python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765

echo.
echo   Server stopped.
pause