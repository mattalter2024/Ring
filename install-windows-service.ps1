param(
  [switch]$Uninstall,
  [int]$Port = 3456,
  [string]$HostAddress = "0.0.0.0",
  [string]$AuthPassword = "",
  [switch]$DebugLogging,
  [string]$UserDataDir = "",
  [string]$UserRecordingsDir = ""
)

$ErrorActionPreference = "Stop"
$ServiceName = "RingWatchNvrService"
$DisplayName = "RingWatch 24/7 NVR & AI Backend"
$Description = "Runs the RingWatch 24/7 Ring camera NVR, live HLS server, and AI package detection backend in the background."
$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunRegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunRegName = "RingWatchTray"

# Capture non-elevated user's profile paths before UAC elevation
if (-not $UserDataDir) {
  $UserDataDir = Join-Path $env:APPDATA "RingWatch"
}
if (-not $UserRecordingsDir) {
  $UserRecordingsDir = Join-Path $env:USERPROFILE "Videos\RingWatch"
}

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  Write-Host "Requesting Administrator privileges to configure the RingWatch Windows Service..." -ForegroundColor Cyan
  $argList = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$($MyInvocation.MyCommand.Path)`"",
    "-Port", $Port,
    "-HostAddress", "`"$HostAddress`"",
    "-UserDataDir", "`"$UserDataDir`"",
    "-UserRecordingsDir", "`"$UserRecordingsDir`""
  )
  if ($Uninstall) { $argList += "-Uninstall" }
  if ($DebugLogging) { $argList += "-DebugLogging" }
  if ($AuthPassword -ne "") { $argList += @("-AuthPassword", "`"$AuthPassword`"") }
  Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -Wait
  exit 0
}

function Ensure-NativeBinaries {
  $svcExe = Join-Path $BaseDir "RingWatchService.exe"
  $trayExe = Join-Path $BaseDir "RingWatchTray.exe"
  if ((Test-Path $svcExe) -and (Test-Path $trayExe)) {
    return
  }

  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
  }
  if (-not (Test-Path $csc)) {
    throw "RingWatchService.exe / RingWatchTray.exe not found and .NET csc.exe is unavailable."
  }

  $iconArg = ""
  $icoPath = Join-Path $BaseDir "build\icon.ico"
  if (Test-Path $icoPath) { $iconArg = "/win32icon:`"$icoPath`"" }

  Write-Host "Compiling RingWatchService.exe and RingWatchTray.exe..." -ForegroundColor Cyan
  $svcSrc = Join-Path $BaseDir "windows\RingWatchService.cs"
  $traySrc = Join-Path $BaseDir "windows\RingWatchTray.cs"

  & $csc /nologo /optimize /target:exe /out:"$svcExe" /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll $iconArg "$svcSrc"
  if ($LASTEXITCODE -ne 0) { throw "Failed to compile RingWatchService.exe" }

  & $csc /nologo /optimize /target:winexe /out:"$trayExe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll $iconArg "$traySrc"
  if ($LASTEXITCODE -ne 0) { throw "Failed to compile RingWatchTray.exe" }
}

if ($Uninstall) {
  Write-Host "Stopping RingWatch tray icon..." -ForegroundColor Cyan
  Get-Process -Name "RingWatchTray" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  if (Get-ItemProperty -Path $RunRegPath -Name $RunRegName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $RunRegPath -Name $RunRegName -ErrorAction SilentlyContinue
  }

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Status -ne "Stopped") {
      Write-Host "Stopping Windows Service '$ServiceName'..." -ForegroundColor Cyan
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
    Write-Host "Removing Windows Service '$ServiceName'..." -ForegroundColor Cyan
    & sc.exe delete $ServiceName | Out-Null
    Write-Host "RingWatch Windows Service and taskbar tray icon removed." -ForegroundColor Green
  } else {
    Write-Host "Windows Service '$ServiceName' was not installed." -ForegroundColor Yellow
  }
  exit 0
}

Ensure-NativeBinaries

$ServiceExe = Join-Path $BaseDir "RingWatchService.exe"
$TrayExe = Join-Path $BaseDir "RingWatchTray.exe"
$LogsDir = Join-Path $UserDataDir "logs"

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
New-Item -ItemType Directory -Force -Path $UserRecordingsDir | Out-Null

# Write service configuration so LocalSystem service shares the user's data, recordings, and logs folders
$ConfigPath = Join-Path $BaseDir "RingWatchService.config.json"
$ConfigObj = @{
  port          = $Port
  host          = $HostAddress
  dataDir       = $UserDataDir
  recordingsDir = $UserRecordingsDir
  logsDir       = $LogsDir
  authPassword  = $AuthPassword
  debugLogging  = [bool]$DebugLogging
}
$ConfigObj | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Encoding UTF8

# Allow the desktop tray icon to toggle verbose debug logging without UAC
& icacls.exe "$ConfigPath" /grant "*S-1-5-11:(M)" /Q | Out-Null

# Stop & remove any existing service registration so path/config updates cleanly
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Updating existing '$ServiceName' Windows Service..." -ForegroundColor Cyan
  if ($existing.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "Installing Windows Service '$ServiceName'..." -ForegroundColor Cyan
& sc.exe create $ServiceName binPath= "`"$ServiceExe`"" start= auto DisplayName= "`"$DisplayName`"" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "sc.exe create failed with exit code $LASTEXITCODE"
}
& sc.exe description $ServiceName "$Description" | Out-Null
# Automatic crash recovery: restart after 5s, 15s, 60s
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
# Grant Interactive Users (IU) permission to Start/Stop/Query this service from the taskbar tray icon without UAC prompts
& sc.exe sdset $ServiceName "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)" | Out-Null

Write-Host "Starting Windows Service '$ServiceName'..." -ForegroundColor Cyan
Start-Service -Name $ServiceName

# Register taskbar tray icon to start automatically at logon
Set-ItemProperty -Path $RunRegPath -Name $RunRegName -Value "`"$TrayExe`""

# Restart tray icon immediately so user sees the taskbar status icon right away
Get-Process -Name "RingWatchTray" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $TrayExe -WorkingDirectory $BaseDir

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host "  RingWatch Windows Service & Taskbar Icon Installed!" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
Write-Host "  Service Name : $ServiceName ($DisplayName)"
Write-Host "  Web UI       : http://localhost:$Port" -ForegroundColor Cyan
Write-Host "  Data Folder  : $UserDataDir"
Write-Host "  Logs Folder  : $LogsDir"
Write-Host "  Taskbar Icon : Look for the RingWatch icon in the Windows tray"
Write-Host "                 (Right-click for Start / Stop / Restart / Logs)"
Write-Host "==============================================================" -ForegroundColor Green
