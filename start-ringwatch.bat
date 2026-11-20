@echo off
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3456

REM 1. Prefer bundled standalone Node.js runtime (included in RingWatch-Windows-Server.zip)
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%I in ('where node') do (
      if not defined NODE_EXE set "NODE_EXE=%%I"
    )
  ) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js was not found on this PC and no bundled runtime\node.exe is present.
  echo.
  echo Option A ^(Easiest^): Download the latest self-contained RingWatch-Windows-Server.zip
  echo                      from GitHub Actions ^(includes Node.js + FFmpeg, zero install needed^).
  echo Option B ^(From source^): Install Node.js 24 LTS from https://nodejs.org/
  echo                         or run: winget install OpenJS.NodeJS.LTS
  echo                         then close and re-run start-ringwatch.bat.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] node_modules folder is missing and npm is not installed.
    echo Please download the self-contained RingWatch-Windows-Server.zip or install Node.js LTS.
    pause
    exit /b 1
  )
  echo Installing dependencies...
  call npm install --omit=dev
)

if not exist "dist-server\server\index.js" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] dist-server build output is missing and npm is not installed.
    echo Please download the self-contained RingWatch-Windows-Server.zip or install Node.js LTS.
    pause
    exit /b 1
  )
  echo Building RingWatch Web UI and Backend...
  call npm install
  call npm run build
)

echo Using Node runtime: "%NODE_EXE%"
echo Starting RingWatch NVR ^& AI Backend on http://localhost:%PORT% ...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%PORT%"
"%NODE_EXE%" "dist-server\server\index.js"
pause
