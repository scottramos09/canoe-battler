@echo off
title CANOE ARENA — Launch
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies on first run...
  call npm install
)

REM already running? then just open the page
netstat -ano | findstr /c:":3000 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Server already running on :3000 - opening page.
) else (
  echo Starting CANOE ARENA server on http://localhost:3000
  echo Server window shows the log. Close it or run shutdown.bat to stop.
  start "CANOE ARENA Server" cmd /k "cd /d %~dp0 && set ALLOW_ADMIN=1 && node server/server.js"
  timeout /t 2 /nobreak >nul
)

start "" http://localhost:3000
