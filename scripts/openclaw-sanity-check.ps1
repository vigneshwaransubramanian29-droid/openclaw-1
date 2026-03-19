param(
    [switch]$DryRun,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:LogFile = Join-Path $env:USERPROFILE ".openclaw\logs\sanity-check.log"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    [Console]::WriteLine($line)
    try {
        $logDir = Split-Path $script:LogFile
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        Add-Content -LiteralPath $script:LogFile -Value $line -ErrorAction SilentlyContinue
    } catch { }
}

function Get-BatchVariable {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*set\s+"([^=]+)=(.*)"\s*$' -or
            $line -match '^\s*set\s+([^=]+)=(.*)\s*$') {
            $key = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            if ($key -ieq $Name) {
                return $value
            }
        }
    }

    return $null
}

function Get-ListeningPids {
    param([int]$Port)

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return @(
            $connections |
                Select-Object -ExpandProperty OwningProcess -Unique |
                Where-Object { $_ -gt 0 }
        )
    } catch {
        $netstat = & netstat -ano -p tcp
        $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
        $pids = @()
        foreach ($line in $netstat) {
            if ($line -match $pattern) {
                $foundPid = [int]$Matches[1]
                if ($foundPid -gt 0 -and $pids -notcontains $foundPid) {
                    $pids += $foundPid
                }
            }
        }
        return $pids
    }
}

function Test-PortListening {
    param([int]$Port)
    return @(
        Get-ListeningPids -Port $Port
    ).Count -gt 0
}

function Get-StaleGatewayProcesses {
    param([int]$Port)

    $patterns = @(
        '\\dist\\index\.js"?\s+gateway\b',
        '\\\.openclaw\\gateway\.cmd\b',
        '\bopenclaw(?:\.cmd|\.mjs)?\b.*\bgateway\b',
        '\bgateway\s+(supervisor\s+)?run\b'
    )

    $results = @()
    $processes = Get-CimInstance Win32_Process |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine }

    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        $matchesGateway = $false
        foreach ($pattern in $patterns) {
            if ($commandLine -imatch $pattern) {
                $matchesGateway = $true
                break
            }
        }

        if (-not $matchesGateway) {
            continue
        }

        if ($Port -gt 0 -and $commandLine -match "(^|[ =])$Port([^\d]|$)") {
            $results += $process
        } elseif ($Port -eq 0) {
            $results += $process
        }
    }

    return @(
        $results |
            Sort-Object -Property ProcessId -Unique
    )
}

function Stop-StaleGatewayProcesses {
    param(
        [int]$Port,
        [switch]$WhatIf
    )

    $processes = @(
        Get-StaleGatewayProcesses -Port $Port
    )
    if ($processes.Count -eq 0) {
        Write-Log "No stale OpenClaw gateway processes found."
        return
    }

    foreach ($process in $processes) {
        $summary = "pid=$($process.ProcessId) name=$($process.Name)"
        if ($WhatIf) {
            Write-Log "[dry-run] Would stop $summary"
            continue
        }

        Write-Log "Stopping stale process $summary"
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Log "Failed to stop pid=$($process.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Start-GatewayDirect {
    param(
        [int]$Port,
        [switch]$WhatIf
    )

    $nodePath = "C:\Program Files\nodejs\node.exe"
    $entryPath = (Resolve-Path (Join-Path $PSScriptRoot "..\dist\index.js") -ErrorAction SilentlyContinue).Path

    if ([string]::IsNullOrWhiteSpace($entryPath)) {
        $entryPath = Join-Path (Split-Path $PSScriptRoot) "dist\index.js"
    }

    if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $entryPath)) {
        Write-Log "Cannot find node ($nodePath) or entry ($entryPath) for direct launch."
        return $false
    }

    if ($WhatIf) {
        Write-Log "[dry-run] Would launch gateway directly: node $entryPath gateway run --port $Port --force"
        return $true
    }

    Write-Log "Launching gateway directly: node $entryPath gateway run --port $Port --force"
    Start-Process -FilePath $nodePath -ArgumentList @($entryPath, "gateway", "run", "--port", "$Port", "--force") -WindowStyle Hidden
    return $true
}

function Start-Gateway {
    param(
        [string]$TaskName,
        [string]$GatewayScriptPath,
        [int]$Port,
        [switch]$WhatIf
    )

    if ($WhatIf) {
        Write-Log "[dry-run] Would start gateway on port $Port"
        return $true
    }

    # Always launch directly — scheduled tasks are unreliable for long-running
    # foreground processes on Windows (cmd exits immediately, node may not survive)
    return (Start-GatewayDirect -Port $Port -WhatIf:$WhatIf)
}

function Wait-ForGatewayPort {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) {
            return $true
        }
        Start-Sleep -Seconds 2
    }

    return (Test-PortListening -Port $Port)
}

$stateDir = Join-Path $env:USERPROFILE ".openclaw"
$gatewayScriptPath = Join-Path $stateDir "gateway.cmd"
$taskName = Get-BatchVariable -Path $gatewayScriptPath -Name "OPENCLAW_WINDOWS_TASK_NAME"
if ([string]::IsNullOrWhiteSpace($taskName)) {
    $taskName = "OpenClaw Gateway"
}

$port = 18789
$portRaw = Get-BatchVariable -Path $gatewayScriptPath -Name "OPENCLAW_GATEWAY_PORT"
if (-not [string]::IsNullOrWhiteSpace($portRaw)) {
    $parsedPort = 0
    if ([int]::TryParse($portRaw, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $port = $parsedPort
    }
}

Write-Log "Sanity check starting for task '$taskName' on port $port"

if (Test-PortListening -Port $port) {
    $listenerPids = Get-ListeningPids -Port $port
    Write-Log "Gateway port $port is already listening (pids: $($listenerPids -join ', '))."
    exit 0
}

Write-Log "Gateway port $port is not listening."
Stop-StaleGatewayProcesses -Port $port -WhatIf:$DryRun

if ($NoRestart) {
    Write-Log "NoRestart requested; leaving gateway stopped."
    exit 0
}

$started = Start-Gateway -TaskName $taskName -GatewayScriptPath $gatewayScriptPath -Port $port -WhatIf:$DryRun
if (-not $started) {
    Write-Log "Gateway start step was skipped or failed."
    exit 1
}

if ($DryRun) {
    Write-Log "[dry-run] Skipping post-start port verification."
    exit 0
}

if (Wait-ForGatewayPort -Port $port -TimeoutSeconds 90) {
    Write-Log "Gateway port $port is listening after restart."
    exit 0
}

Write-Log "Gateway port $port did not come back within 90 seconds."
exit 1
