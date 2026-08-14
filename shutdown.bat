@echo off
title CANOE ARENA — Shutdown
echo Stopping game servers...
set FOUND=0

REM Kill only the processes LISTENING on the game ports. This never
REM touches hermes.exe / other apps — by-port PID targeting only.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3000 " ^| findstr /i "LISTENING"') do (
  echo   stopping CANOE ARENA   :3000  PID %%a
  taskkill /f /pid %%a >nul 2>nul
  set FOUND=1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":4777 " ^| findstr /i "LISTENING"') do (
  echo   stopping GODLING       :4777  PID %%a
  taskkill /f /pid %%a >nul 2>nul
  set FOUND=1
)

if "%FOUND%"=="1" (
  echo Done. Servers stopped.
) else (
  echo No game server was running on :3000 or :4777.
)
echo.
pause
