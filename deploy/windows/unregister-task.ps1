<#
.SYNOPSIS
  Remove the scheduled tasks created by deploy\windows\register-task.ps1 (and stop the server they started).

.DESCRIPTION
  Stops and unregisters 'VideoTrendIntel-Collect' and 'VideoTrendIntel-Server' (unless -KeepServer), and stops
  the node server recorded in data\logs\server.pid. Data (data\store.sqlite, exports, logs) is left untouched.
  Safe to run when the tasks do not exist. OWNER: deploy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\unregister-task.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'VideoTrendIntel-Collect',
  [string]$ServerTaskName = 'VideoTrendIntel-Server',
  [switch]$KeepServer
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$names = @($TaskName)
if (-not $KeepServer) { $names += $ServerTaskName }
foreach ($name in $names) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "'$name' is not registered"
    continue
  }
  if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "removed '$name'"
}

if (-not $KeepServer) {
  # Stopping the task ends its PowerShell wrapper; the node child is stopped here explicitly.
  $pidFile = Join-Path $root 'data\logs\server.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $serverPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -TotalCount 1), [ref]$serverPid)) {
      $p = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') {
        Stop-Process -Id $serverPid -Force
        Write-Host "stopped server process $serverPid"
      }
    }
    Remove-Item -LiteralPath $pidFile -Force
  }
}
