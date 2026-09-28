<#
.SYNOPSIS
  One collection cycle for the Windows scheduled task: collect + export (+ optional server restart).

.DESCRIPTION
  Runs the collector's `run` command (collect every enabled source into data/store.sqlite, then export
  data/export/dataset.json and copy it to apps/web/public/data/dataset.json). A server started with
  `npm start` hot-swaps each new export by itself; -RestartServer additionally restarts the server that the
  'VideoTrendIntel-Server' task runs (useful after a code update).

  Output: data/logs/task-YYYY-MM-DD.log (the collector also writes data/logs/collector-YYYY-MM-DD.log).
  Exit code: the collector's (0 ok or partial success, 1 total failure), 3 when another run is in progress.
  Credentials come from .env in the repository root (see .env.example). OWNER: deploy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\run-collect.ps1
#>
[CmdletBinding()]
param(
  [switch]$RestartServer,
  [string]$ServerTaskName = 'VideoTrendIntel-Server'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('task-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $Message
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Host $line
}

function Append-File([string]$Path, [string]$Label) {
  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 0) {
    Add-Content -LiteralPath $log -Value "---- $Label" -Encoding UTF8
    Get-Content -LiteralPath $Path -Encoding UTF8 | Add-Content -LiteralPath $log -Encoding UTF8
  }
}

# One collection at a time on this machine (the scheduled task also uses MultipleInstances=IgnoreNew).
$mutex = New-Object System.Threading.Mutex($false, 'Local\VideoTrendIntel-Collect')
if (-not $mutex.WaitOne(0)) {
  Write-Log 'another collection is still running; skipped'
  exit 3
}

try {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $fallback) { $nodePath = $fallback } else { throw 'node.exe not found (install Node.js >= 22.13)' }
  } else {
    $nodePath = $node.Source
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\tsx'))) { throw 'node_modules\tsx missing: run npm install in the repository root' }

  $out = Join-Path $logDir 'task-last.out.log'
  $err = Join-Path $logDir 'task-last.err.log'
  Write-Log "collect + export started ($nodePath)"
  $started = Get-Date
  # Same as `npm run collect-and-export`, without npm/cmd quoting layers.
  $proc = Start-Process -FilePath $nodePath `
    -ArgumentList @('--import', 'tsx', 'packages/collector/src/cli.ts', 'run') `
    -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err `
    -NoNewWindow -PassThru -Wait
  $code = $proc.ExitCode
  Append-File $out 'stdout'
  Append-File $err 'stderr'
  Write-Log ('collect + export finished: exit {0} in {1:n0}s' -f $code, ((Get-Date) - $started).TotalSeconds)

  if ($RestartServer) {
    $task = Get-ScheduledTask -TaskName $ServerTaskName -ErrorAction SilentlyContinue
    if (-not $task) {
      Write-Log "server task '$ServerTaskName' is not registered; no restart"
    } else {
      $pidFile = Join-Path $logDir 'server.pid'
      if (Test-Path -LiteralPath $pidFile) {
        $serverPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -TotalCount 1), [ref]$serverPid)) {
          $p = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
          if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $serverPid -Force }
        }
      }
      for ($i = 0; $i -lt 30 -and (Get-ScheduledTask -TaskName $ServerTaskName).State -eq 'Running'; $i++) { Start-Sleep -Seconds 1 }
      Start-ScheduledTask -TaskName $ServerTaskName
      Write-Log "server task '$ServerTaskName' restarted"
    }
  }
  exit $code
} catch {
  Write-Log "failed: $($_.Exception.Message)"
  exit 1
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
