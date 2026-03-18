$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $env:LOCALAPPDATA "OpenClaw\logs"
$logPath = Join-Path $logDir "sanity-check.log"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Push-Location $repoRoot
try {
  "[$timestamp] Starting sanity check" | Out-File -FilePath $logPath -Append -Encoding utf8
  & $nodePath openclaw.mjs doctor --fix --non-interactive *>&1 |
    Out-File -FilePath $logPath -Append -Encoding utf8
  "[$timestamp] Sanity check finished" | Out-File -FilePath $logPath -Append -Encoding utf8
} finally {
  Pop-Location
}
