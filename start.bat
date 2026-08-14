@echo off
title CANOE ARENA — Box Geometry Naval Battler
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies (first run)...
  call npm install
)

echo Starting CANOE ARENA server on http://localhost:3000
echo Open that URL in any browser. Friends on your LAN can join at http://YOUR-IP:3000
echo (Ctrl+C to stop)
node server/server.js
pause
