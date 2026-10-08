@echo off
rem Local preview launcher for the yczx_musicvote site (ASCII-only on purpose).
rem Starts the built-in server (Node >= 22.7 via DSH Desktop Electron) and opens the browser.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=1
set ALLOW_DEFAULT_ADMIN_PASSWORD=1
if not exist "data\yczx.db" (
  echo First run: initializing local database...
  "D:\dsh\DSH Desktop\DSH Desktop.exe" server.mjs --init
)
start "yczx-server" "D:\dsh\DSH Desktop\DSH Desktop.exe" server.mjs
timeout /t 3 >nul
start "" http://127.0.0.1:8788/
echo.
echo Local preview: http://127.0.0.1:8788/
echo Test credentials: class=yczx2026   admin=admin / admin888
echo Keep this window open; close it to stop the server.
pause
