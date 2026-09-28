<#
.SYNOPSIS
  Windows wrapper for deploy/bootstrap.sh: runs it with Git for Windows' bash (WSL bash is not used).

.DESCRIPTION
  All arguments are passed through, e.g. --secrets, --force-store, --no-run, --repo owner/name.
  See deploy/bootstrap.sh for what it does. OWNER: deploy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\bootstrap.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\bootstrap.ps1 --secrets
#>
$ErrorActionPreference = 'Stop'

$candidates = @()
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) { $candidates += (Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe') }
$candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')
if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
$bash = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $bash) { throw 'Git for Windows (bash.exe) not found: install it from https://git-scm.com/download/win' }

& $bash (Join-Path $PSScriptRoot 'bootstrap.sh') @args
exit $LASTEXITCODE
