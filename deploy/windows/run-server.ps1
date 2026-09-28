<#
.SYNOPSIS
  Run the API + web server (apps/server) for the 'VideoTrendIntel-Server' scheduled task.

.DESCRIPTION
  Starts `node --import tsx apps/server/src/main.ts` with COLLECT_INTERVAL_MIN=0 (the
  'VideoTrendIntel-Collect' task owns collection, so the two never write the store at the same time),
  records the node PID in data/logs/server.pid (used by run-collect.ps1 -RestartServer and unregister-task.ps1)
  and waits for it. The server hot-swaps every new data/export/dataset.json on its own.
  Logs: data/logs/server.out.log and data/logs/server.err.log (previous run: *.prev.log). OWNER: deploy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\run-server.ps1 -Port 8787
#>
[CmdletBinding()]
param(
  [ValidateRange(0, 65535)][int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { $nodePath = $node.Source } else { $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'node.exe not found (install Node.js >= 22.13)' }

# Inherited by node; the server's own .env loading never overrides variables that are already set.
$env:COLLECT_INTERVAL_MIN = '0'
if ($Port -gt 0) { $env:PORT = "$Port" }

$out = Join-Path $logDir 'server.out.log'
$err = Join-Path $logDir 'server.err.log'
foreach ($f in @($out, $err)) {
  if (Test-Path -LiteralPath $f) { Move-Item -LiteralPath $f -Destination ($f -replace '\.log$', '.prev.log') -Force }
}

$proc = Start-Process -FilePath $nodePath -ArgumentList @('--import', 'tsx', 'apps/server/src/main.ts') `
  -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
$pidFile = Join-Path $logDir 'server.pid'
Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
try {
  $proc.WaitForExit()
  exit $proc.ExitCode
} finally {
  if ((Test-Path -LiteralPath $pidFile) -and ((Get-Content -LiteralPath $pidFile -TotalCount 1) -eq "$($proc.Id)")) {
    Remove-Item -LiteralPath $pidFile -Force
  }
}
