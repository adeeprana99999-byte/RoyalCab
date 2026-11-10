@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or newer, then run this file again.
  pause
  exit /b 1
)
echo ProLift will open at http://localhost:4720
echo Keep this window open while using the app. Press Ctrl+C to stop.
node server.cjs --open
pause
