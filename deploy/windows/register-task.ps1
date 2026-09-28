<#
.SYNOPSIS
  Local collection fallback: register a Windows scheduled task that runs the collector + export every 3 hours.

.DESCRIPTION
  For people who prefer collecting on their own PC instead of (or in addition to) GitHub Actions.
  Registers 'VideoTrendIntel-Collect' for the current user: first run at the next hh:23, then every
  -IntervalHours hours, indefinitely. Each run executes deploy\windows\run-collect.ps1 (collect -> export ->
  copy to apps\web\public\data), logging to data\logs\task-YYYY-MM-DD.log. Missed runs (PC asleep/off) start
  as soon as possible; overlapping runs are skipped.

  -WithServer also registers 'VideoTrendIntel-Server' (at logon) running the API + web server
  (http://localhost:<PORT>, default 8787) with COLLECT_INTERVAL_MIN=0, so collection happens only through the
  collect task. The server picks up every new export by itself; -RestartServer additionally restarts it after
  each collection.

  The tasks run only while you are logged on (no password is stored, no admin rights needed). Credentials for
  the keyed sources are read from .env in the repository root (see .env.example). Re-running this script
  updates the tasks in place. Remove them with deploy\windows\unregister-task.ps1. OWNER: deploy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1 -WithServer -RunNow
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 24)][int]$IntervalHours = 3,
  [string]$TaskName = 'VideoTrendIntel-Collect',
  [string]$ServerTaskName = 'VideoTrendIntel-Server',
  [ValidateRange(0, 65535)][int]$Port = 0,
  [switch]$WithServer,
  [switch]$RestartServer,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$collectScript = Join-Path $root 'deploy\windows\run-collect.ps1'
$serverScript = Join-Path $root 'deploy\windows\run-server.ps1'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'node.exe not found in PATH (install Node.js >= 22.13)' }
$nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) { throw "Node.js >= 22.13 is required (node:sqlite); found $nodeVersion" }
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\tsx'))) { throw "dependencies missing: run 'npm install' in $root first" }
if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
  Write-Warning '.env not found: only the keyless sources (YouTube RSS, Dailymotion, PeerTube, niconico) will run. See .env.example.'
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# ---- collect task
$now = Get-Date
$start = $now.Date.AddHours($now.Hour).AddMinutes(23)
if ($start -le $now.AddMinutes(1)) { $start = $start.AddHours(1) }
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
$collectArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$collectScript`""
if ($RestartServer) { $collectArgs += " -RestartServer -ServerTaskName `"$ServerTaskName`"" }
$action = New-ScheduledTaskAction -Execute $powershell -Argument $collectArgs -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force `
  -Description "Video Trend Intel: collect + export every $IntervalHours h ($root). Logs: data\logs\task-*.log" | Out-Null
Write-Host "registered '$TaskName': every $IntervalHours h, first run $($start.ToString('yyyy-MM-dd HH:mm'))"

# ---- optional server task
if ($WithServer) {
  $serverArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serverScript`""
  if ($Port -gt 0) { $serverArgs += " -Port $Port" }
  $serverAction = New-ScheduledTaskAction -Execute $powershell -Argument $serverArgs -WorkingDirectory $root
  $serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $serverSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $ServerTaskName -Action $serverAction -Trigger $serverTrigger -Principal $principal `
    -Settings $serverSettings -Force -Description "Video Trend Intel: API + web server ($root), collection disabled (see $TaskName)" | Out-Null
  $shownPort = if ($Port -gt 0) { $Port } else { 'PORT from .env or 8787' }
  Write-Host "registered '$ServerTaskName': at logon, http://localhost ($shownPort)"
  if ((Get-ScheduledTask -TaskName $ServerTaskName).State -ne 'Running') { Start-ScheduledTask -TaskName $ServerTaskName }
} elseif ($RestartServer -and -not (Get-ScheduledTask -TaskName $ServerTaskName -ErrorAction SilentlyContinue)) {
  Write-Warning "-RestartServer: '$ServerTaskName' is not registered (add -WithServer); the collect task will skip the restart"
}

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "started '$TaskName' now (log: data\logs\task-$((Get-Date).ToString('yyyy-MM-dd')).log)"
}

Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo |
  Select-Object @{ n = 'Task'; e = { $TaskName } }, NextRunTime, LastRunTime, LastTaskResult | Format-Table -AutoSize
