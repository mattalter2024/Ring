param(
  [switch]$Uninstall,
  [int]$Port = 3456,
  [string]$AuthPassword = ""
)

$ErrorActionPreference = "Stop"
$TaskName = "RingWatchNvrBackend"
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EntryScript = Join-Path $RepoDir "dist-server\server\index.js"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Windows startup task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "Startup task '$TaskName' was not installed." -ForegroundColor Yellow
  }
  exit 0
}

$NodeExe = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path $EntryScript)) {
  Write-Host "Building RingWatch Web UI & Backend first..." -ForegroundColor Cyan
  Push-Location $RepoDir
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$EnvPrefix = "set PORT=$Port"
if ($AuthPassword -ne "") {
  $EnvPrefix = "$EnvPrefix && set RINGWATCH_AUTH_PASSWORD=$AuthPassword"
}

$Action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c $EnvPrefix && `"$NodeExe`" `"$EntryScript`"" `
  -WorkingDirectory $RepoDir

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Runs the RingWatch 24/7 NVR & AI Package Detection backend automatically at Windows logon." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host ""
Write-Host "RingWatch NVR & AI Backend installed and started!" -ForegroundColor Green
Write-Host "Open http://localhost:$Port in your browser." -ForegroundColor Cyan
Write-Host "To uninstall later: .\install-windows-startup.ps1 -Uninstall" -ForegroundColor Gray
