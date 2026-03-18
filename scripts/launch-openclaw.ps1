$ErrorActionPreference = "SilentlyContinue"

$repoRoot  = "C:\openclaw"
$nodePath  = "C:\Program Files\nodejs\node.exe"
$logDir    = Join-Path $env:LOCALAPPDATA "OpenClaw\logs"
$nodeLog   = Join-Path $logDir "openclaw.log"
$gwLog     = Join-Path $logDir "gateway.log"
$launchLog = Join-Path $logDir "launch.log"

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] $Message" | Out-File -FilePath $launchLog -Append -Encoding utf8
}

# 1. Kill stale OpenClaw processes
Write-Log "Stopping any running OpenClaw processes..."
$killed = 0

# Kill by command line pattern (run-node.mjs wrappers and openclaw.mjs children)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -and ($cmd -match "openclaw" -or $cmd -match "run-node\.mjs")) {
        Write-Log "  Killing node PID $($_.ProcessId) [$($cmd.Substring(0, [Math]::Min(60,$cmd.Length)))]"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}

# Also kill whatever is holding port 18789 (the gateway port)
$portPid = (netstat -ano 2>$null | Select-String ':18789\s.*LISTENING' | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Select-Object -First 1)
if ($portPid -and $portPid -match '^\d+$') {
    $portProc = Get-Process -Id ([int]$portPid) -ErrorAction SilentlyContinue
    if ($portProc) {
        Write-Log "  Killing port-18789 holder PID $portPid ($($portProc.ProcessName))"
        Stop-Process -Id ([int]$portPid) -Force -ErrorAction SilentlyContinue
        $killed++
    }
}

if ($killed -gt 0) {
    Write-Log "Stopped $killed process(es). Waiting 3s for ports to release..."
    Start-Sleep -Seconds 3
} else {
    Write-Log "No stale processes found."
}

# Helper: write a temp wrapper script, then run it hidden so output goes to log
function Start-NodeProcess {
    param([string]$NodeArgs, [string]$LogFile, [string]$Label)

    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] --- $Label starting ---" | Out-File -FilePath $LogFile -Encoding utf8

    $wrapperPath = Join-Path $env:TEMP "openclaw-run-$Label.ps1"
$wrapperContent = @"
Set-Location '$repoRoot'
& '$nodePath' $NodeArgs 2>&1 | ForEach-Object { `$_ | Out-File -FilePath '$LogFile' -Append -Encoding utf8 }
"@
    $wrapperContent | Out-File -FilePath $wrapperPath -Encoding utf8 -Force

    $proc = Start-Process powershell.exe `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $wrapperPath `
        -WindowStyle Hidden `
        -PassThru

    Write-Log "$Label started (wrapper PID $($proc.Id)) -> $LogFile"
    return $proc
}

# 2. Start gateway first (handles Telegram, channels, memory, API)
$gwProc = Start-NodeProcess -NodeArgs "scripts\run-node.mjs gateway" `
                            -LogFile $gwLog `
                            -Label "Gateway"

# Wait for gateway to bind port 18789
Write-Log "Waiting for gateway on port 18789..."
$gwReady = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $listening = netstat -ano 2>$null | Select-String ':18789\s.*LISTENING'
    if ($listening) {
        $gwReady = $true
        Write-Log "Gateway ready after $($i+1)s."
        break
    }
}
if (-not $gwReady) {
    Write-Log "WARNING: Gateway not ready after 60s - check gateway.log for errors."
}

# 3. Start node host (connects to gateway as a local headless node)
$nodeProc = Start-NodeProcess -NodeArgs "scripts\run-node.mjs node run" `
                              -LogFile $nodeLog `
                              -Label "NodeHost"

Write-Log "Both processes started. Gateway=$($gwProc.Id)  NodeHost=$($nodeProc.Id)"

# 4. Open a live log-tail window
$tailCmd = "Write-Host 'Gateway  -> $gwLog' -ForegroundColor Green; Write-Host 'NodeHost -> $nodeLog' -ForegroundColor Cyan; Write-Host ''; Get-Content -Wait -Tail 5 '$gwLog','$nodeLog'"

$wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wtCmd) {
    Start-Process $wtCmd.Source -ArgumentList "new-tab", "--title", "OpenClaw Logs", "powershell.exe", "-NoProfile", "-NoExit", "-Command", $tailCmd
} else {
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-NoExit", "-Command", $tailCmd
}
# Launcher exits -- both wrapper processes keep running independently.
