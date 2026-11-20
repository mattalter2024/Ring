@echo off
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3456

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install --omit=dev
)

if not exist "dist-server\server\index.js" (
  echo Building RingWatch Web UI and Backend...
  call npm install
  call npm run build
)

echo Starting RingWatch NVR ^& AI Backend on http://localhost:%PORT% ...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%PORT%"
node dist-server\server\index.js
pause
