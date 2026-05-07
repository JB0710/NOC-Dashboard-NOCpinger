param(
    [string]$BindAddress = "localhost",
    [int]$Port = 8085,
    [int]$PingIntervalSeconds = 5,
    [int]$TimeoutMs = 1000,
    [int]$FailureThreshold = 2,
    [int]$MaxHistory = 60,
    [int]$MaxLogs = 500,
    [string]$DevicesFile = ".\devices.json",
    [string]$DataPath = ".\noc-data",
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptRoot

if (-not (Test-Path -LiteralPath $DataPath)) {
    New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
}

$EventLogCsv = Join-Path $DataPath "events.csv"
if (-not (Test-Path -LiteralPath $EventLogCsv)) {
    "Timestamp,Level,Target,Message" | Set-Content -LiteralPath $EventLogCsv -Encoding UTF8
}

$DevicesPath = Join-Path $ScriptRoot $DevicesFile
if (-not (Test-Path -LiteralPath $DevicesPath)) {
    throw "Devices file not found: $DevicesPath"
}

$script:DevicesFileLastWrite = [System.IO.File]::GetLastWriteTimeUtc($DevicesPath)

$script:State = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    settings  = [ordered]@{
        bindAddress         = $BindAddress
        port                = $Port
        pingIntervalSeconds = $PingIntervalSeconds
        timeoutMs           = $TimeoutMs
        failureThreshold    = $FailureThreshold
        maxHistory          = $MaxHistory
        maxLogs             = $MaxLogs
    }
    devices   = [System.Collections.Generic.List[object]]::new()
    logs      = [System.Collections.Generic.List[object]]::new()
    config    = [ordered]@{
        path         = $DevicesPath
        lastLoadedAt = $null
        lastReloadAt = $null
        deviceCount  = 0
        skippedCount = 0
        lastError    = $null
    }
}

function Write-EventCsv {
    param(
        [Parameter(Mandatory)][string]$Timestamp,
        [Parameter(Mandatory)][string]$Level,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$Message
    )

    $safe = @(
        $Timestamp.Replace('"','""')
        $Level.Replace('"','""')
        $Target.Replace('"','""')
        $Message.Replace('"','""')
    )

    $line = '"' + ($safe -join '","') + '"'
    Add-Content -LiteralPath $EventLogCsv -Value $line -Encoding UTF8
}

function Add-LogEntry {
    param(
        [Parameter(Mandatory)][ValidateSet("INFO","WARN","ERROR")][string]$Level,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$Message
    )

    $timestamp = (Get-Date).ToString("o")
    $entry = [pscustomobject]@{
        timestamp = $timestamp
        level     = $Level
        target    = $Target
        message   = $Message
    }

    $script:State.logs.Insert(0, $entry)
    while ($script:State.logs.Count -gt $MaxLogs) {
        $script:State.logs.RemoveAt($script:State.logs.Count - 1)
    }

    Write-EventCsv -Timestamp $timestamp -Level $Level -Target $Target -Message $Message
}

function Get-Optional {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Name,
        $Default = ""
    )

    if ($Object.PSObject.Properties.Name -contains $Name) {
        return $Object.$Name
    }
    return $Default
}

function Test-IPAddressValue {
    param([string]$IPAddress)

    $parsed = $null
    return [System.Net.IPAddress]::TryParse($IPAddress, [ref]$parsed)
}

function Validate-DeviceConfig {
    param(
        [Parameter(Mandatory)]$Device
    )

    $errors = [System.Collections.Generic.List[string]]::new()

    $ip = [string](Get-Optional -Object $Device -Name "ip" -Default "")
    $hostname = [string](Get-Optional -Object $Device -Name "hostname" -Default $ip)
    $group = ([string](Get-Optional -Object $Device -Name "group" -Default "access")).ToLowerInvariant()
    $location = [string](Get-Optional -Object $Device -Name "location" -Default "Unknown")
    $notes = [string](Get-Optional -Object $Device -Name "notes" -Default "")

    if ([string]::IsNullOrWhiteSpace($ip)) {
        $errors.Add("Missing ip")
    }
    elseif (-not (Test-IPAddressValue -IPAddress $ip)) {
        $errors.Add("Invalid IP: $ip")
    }

    if ([string]::IsNullOrWhiteSpace($hostname)) {
        $errors.Add("Missing hostname")
    }

    if ($group -notin @("core","distribution","access")) {
        $errors.Add("Invalid group '$group'")
    }

    return [pscustomobject]@{
        Valid      = ($errors.Count -eq 0)
        Errors     = @($errors)
        Normalized = [ordered]@{
            ip       = $ip
            hostname = $hostname
            group    = $group
            location = $location
            notes    = $notes
        }
    }
}

function New-DeviceState {
    param(
        [Parameter(Mandatory)]$DeviceConfig
    )

    [pscustomobject]@{
        id                = [guid]::NewGuid().ToString("N")
        target            = [string]$DeviceConfig.ip
        displayName       = [string]$DeviceConfig.hostname
        hostname          = [string]$DeviceConfig.hostname
        location          = [string]$DeviceConfig.location
        group             = [string]$DeviceConfig.group
        notes             = [string]$DeviceConfig.notes
        status            = "unknown"
        failCount         = 0
        totalChecks       = 0
        successCount      = 0
        failureCount      = 0
        packetLossPercent = 0
        uptimePercent     = 0
        lastLatencyMs     = $null
        avgLatencyMs      = $null
        minLatencyMs      = $null
        maxLatencyMs      = $null
        lastCheck         = $null
        lastSuccess       = $null
        lastChange        = $null
        downtimeStart     = $null
        totalDowntimeSec  = 0
        history           = [System.Collections.Generic.List[object]]::new()
        recentEvents      = [System.Collections.Generic.List[object]]::new()
    }
}

function Update-LatencyStats {
    param(
        [Parameter(Mandatory)]$Device
    )

    $latencies = @(
        $Device.history |
        Where-Object { $_.up -eq $true -and $null -ne $_.latencyMs } |
        ForEach-Object { [int]$_.latencyMs }
    )

    if ($latencies.Count -gt 0) {
        $Device.avgLatencyMs = [Math]::Round((($latencies | Measure-Object -Average).Average), 1)
        $Device.minLatencyMs = ($latencies | Measure-Object -Minimum).Minimum
        $Device.maxLatencyMs = ($latencies | Measure-Object -Maximum).Maximum
    }
    else {
        $Device.avgLatencyMs = $null
        $Device.minLatencyMs = $null
        $Device.maxLatencyMs = $null
    }
}

function Add-RecentEvent {
    param(
        [Parameter(Mandatory)]$Device,
        [Parameter(Mandatory)][string]$Message
    )

    $Device.recentEvents.Insert(0, [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        message   = $Message
    })

    while ($Device.recentEvents.Count -gt 10) {
        $Device.recentEvents.RemoveAt($Device.recentEvents.Count - 1)
    }
}

function Invoke-DeviceCheck {
    param(
        [Parameter(Mandatory)]$Device
    )

    $now = Get-Date
    $isUp = $false
    $latency = $null
    $detail = $null

    try {
        $pinger = [System.Net.NetworkInformation.Ping]::new()
        try {
            $reply = $pinger.Send($Device.target, $TimeoutMs)
        }
        finally {
            $pinger.Dispose()
        }

        if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
            $isUp = $true
            $latency = [int]$reply.RoundtripTime
            $detail = "Ping OK ($latency ms)"
        }
        else {
            $detail = "Ping failed: $($reply.Status)"
        }
    }
    catch {
        $detail = "Ping error: $($_.Exception.Message)"
    }

    $previousStatus = $Device.status
    $Device.totalChecks++
    $Device.lastCheck = $now.ToString("o")

    if ($isUp) {
        $Device.successCount++
        $Device.failCount = 0
        $Device.lastLatencyMs = $latency
        $Device.lastSuccess = $now.ToString("o")

        if ($Device.downtimeStart) {
            try {
                $downStart = [datetime]$Device.downtimeStart
                $downtimeSeconds = [int][Math]::Round(($now - $downStart).TotalSeconds)
                if ($downtimeSeconds -gt 0) {
                    $Device.totalDowntimeSec += $downtimeSeconds
                }
            }
            catch {}
            $Device.downtimeStart = $null
        }

        if ($previousStatus -ne "up") {
            $Device.status = "up"
            $Device.lastChange = $now.ToString("o")
            Add-RecentEvent -Device $Device -Message "Recovered and responding in $latency ms"
            Add-LogEntry -Level "INFO" -Target $Device.target -Message "Device UP. $detail"
        }
        else {
            $Device.status = "up"
        }
    }
    else {
        $Device.failureCount++
        $Device.failCount++

        if ($Device.failCount -ge $FailureThreshold) {
            if ($Device.status -ne "down") {
                $Device.status = "down"
                $Device.lastChange = $now.ToString("o")
                if (-not $Device.downtimeStart) {
                    $Device.downtimeStart = $now.ToString("o")
                }
                Add-RecentEvent -Device $Device -Message "ALERT: Device declared DOWN after $FailureThreshold failed pings"
                Add-LogEntry -Level "WARN" -Target $Device.target -Message "Device DOWN after $FailureThreshold failed pings. $detail"
            }
            else {
                $Device.status = "down"
            }
        }
        else {
            if ($Device.status -ne "warning") {
                $Device.status = "warning"
                $Device.lastChange = $now.ToString("o")
                Add-RecentEvent -Device $Device -Message "Warning: missed ping $($Device.failCount) of $FailureThreshold"
                Add-LogEntry -Level "WARN" -Target $Device.target -Message "Warning state. $detail"
            }
            else {
                $Device.status = "warning"
            }
        }
    }

    $Device.packetLossPercent = [Math]::Round((($Device.failureCount / [Math]::Max(1, $Device.totalChecks)) * 100), 1)
    $Device.uptimePercent = [Math]::Round((($Device.successCount / [Math]::Max(1, $Device.totalChecks)) * 100), 1)

    $Device.history.Add([pscustomobject]@{
        timestamp = $now.ToString("o")
        latencyMs = $latency
        up        = $isUp
        status    = $Device.status
        failCount = $Device.failCount
    })

    while ($Device.history.Count -gt $MaxHistory) {
        $Device.history.RemoveAt(0)
    }

    Update-LatencyStats -Device $Device
}

function Load-DevicesFromFile {
    $raw = Get-Content -LiteralPath $DevicesPath -Raw -Encoding UTF8
    $json = $raw | ConvertFrom-Json
    if (-not $json.devices) {
        throw "devices.json must contain a 'devices' array."
    }

    $normalizedDevices = [System.Collections.Generic.List[object]]::new()
    $skipped = 0

    foreach ($device in $json.devices) {
        $validation = Validate-DeviceConfig -Device $device
        if ($validation.Valid) {
            $normalizedDevices.Add($validation.Normalized)
        }
        else {
            $skipped++
            Add-LogEntry -Level "WARN" -Target "config" -Message ("Skipping invalid device: " + ($validation.Errors -join "; "))
        }
    }

    if ($normalizedDevices.Count -eq 0) {
        throw "No valid devices found in devices.json."
    }

    return [pscustomobject]@{
        Devices = $normalizedDevices
        Skipped = $skipped
    }
}

function Reload-Devices {
    param(
        [switch]$IsHotReload
    )

    $result = Load-DevicesFromFile
    $existing = @{}
    foreach ($device in $script:State.devices) {
        $existing[$device.target] = $device
    }

    $newList = [System.Collections.Generic.List[object]]::new()
    foreach ($normalized in $result.Devices) {
        if ($existing.ContainsKey($normalized.ip)) {
            $device = $existing[$normalized.ip]
            $device.hostname = $normalized.hostname
            $device.displayName = $normalized.hostname
            $device.location = $normalized.location
            $device.group = $normalized.group
            $device.notes = $normalized.notes
            $newList.Add($device)
        }
        else {
            $newList.Add((New-DeviceState -DeviceConfig $normalized))
        }
    }

    $script:State.devices = $newList
    $script:State.config.lastLoadedAt = (Get-Date).ToString("o")
    $script:State.config.lastReloadAt = (Get-Date).ToString("o")
    $script:State.config.deviceCount = $newList.Count
    $script:State.config.skippedCount = $result.Skipped
    $script:State.config.lastError = $null
    $script:DevicesFileLastWrite = [System.IO.File]::GetLastWriteTimeUtc($DevicesPath)

    if ($IsHotReload) {
        Add-LogEntry -Level "INFO" -Target "config" -Message "devices.json reloaded successfully."
    }
    else {
        Add-LogEntry -Level "INFO" -Target "config" -Message "devices.json loaded successfully."
    }
}

function Save-DevicesToFile {
    param(
        [Parameter(Mandatory)]$DevicesPayload
    )

    if (-not ($DevicesPayload -is [System.Collections.IEnumerable])) {
        throw "Payload must be an array of devices."
    }

    $normalizedDevices = [System.Collections.Generic.List[object]]::new()
    $errors = [System.Collections.Generic.List[string]]::new()
    $index = 0

    foreach ($device in $DevicesPayload) {
        $index++
        $validation = Validate-DeviceConfig -Device $device
        if ($validation.Valid) {
            $normalizedDevices.Add([ordered]@{
                ip       = $validation.Normalized.ip
                hostname = $validation.Normalized.hostname
                group    = $validation.Normalized.group
                location = $validation.Normalized.location
                notes    = $validation.Normalized.notes
            })
        }
        else {
            $errors.Add("Device #$index : " + ($validation.Errors -join "; "))
        }
    }

    if ($normalizedDevices.Count -eq 0) {
        throw "Cannot save empty device inventory."
    }

    if ($errors.Count -gt 0) {
        throw ($errors -join " | ")
    }

    $payload = [ordered]@{
        devices = @($normalizedDevices)
    }

    $json = $payload | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($DevicesPath, $json, [System.Text.UTF8Encoding]::new($false))
    $script:DevicesFileLastWrite = [System.IO.File]::GetLastWriteTimeUtc($DevicesPath)
    Reload-Devices -IsHotReload
}

function Check-ConfigReload {
    try {
        $currentWrite = [System.IO.File]::GetLastWriteTimeUtc($DevicesPath)
        if ($currentWrite -gt $script:DevicesFileLastWrite) {
            Reload-Devices -IsHotReload
        }
    }
    catch {
        $script:State.config.lastError = $_.Exception.Message
        Add-LogEntry -Level "ERROR" -Target "config" -Message ("Config reload failed: " + $_.Exception.Message)
    }
}

function Get-StateJson {
    return ($script:State | ConvertTo-Json -Depth 12 -Compress)
}

function Get-DevicesJson {
    $devices = @(
        $script:State.devices | ForEach-Object {
            [ordered]@{
                ip       = $_.target
                hostname = $_.hostname
                group    = $_.group
                location = $_.location
                notes    = $_.notes
            }
        }
    )
    return ([ordered]@{ devices = $devices } | ConvertTo-Json -Depth 6 -Compress)
}

function Write-HttpResponse {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][int]$StatusCode,
        [Parameter(Mandatory)][string]$ContentType,
        [Parameter(Mandatory)][byte[]]$Bytes
    )

    $response = $Context.Response
    $response.StatusCode = $StatusCode
    $response.ContentType = $ContentType
    $response.ContentLength64 = $Bytes.Length
    $response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $response.OutputStream.Close()
}

function Get-FileBytes {
    param(
        [Parameter(Mandatory)][string]$RelativePath
    )

    $fullPath = Join-Path $ScriptRoot $RelativePath
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        return [System.IO.File]::ReadAllBytes($fullPath)
    }
    return $null
}

function Get-ContentType {
    param(
        [Parameter(Mandatory)][string]$Path
    )

    switch -Regex ($Path.ToLowerInvariant()) {
        '\.html$' { return "text/html; charset=utf-8" }
        '\.css$'  { return "text/css; charset=utf-8" }
        '\.js$'   { return "application/javascript; charset=utf-8" }
        '\.json$' { return "application/json; charset=utf-8" }
        '\.mp3$'  { return "audio/mpeg" }
        '\.svg$'  { return "image/svg+xml" }
        '\.png$'  { return "image/png" }
        '\.jpg$'  { return "image/jpeg" }
        '\.jpeg$' { return "image/jpeg" }
        '\.ico$'  { return "image/x-icon" }
        default   { return "application/octet-stream" }
    }
}

function Read-RequestBodyJson {
    param(
        [Parameter(Mandatory)]$Request
    )

    $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
    try {
        $body = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }

    if ([string]::IsNullOrWhiteSpace($body)) {
        throw "Request body is empty."
    }

    return ($body | ConvertFrom-Json)
}

Reload-Devices

$listener = [System.Net.HttpListener]::new()
$prefix = if ($BindAddress -eq "*") { "http://+:$Port/" } else { "http://$BindAddress`:$Port/" }
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "NOC monitor running at $prefix" -ForegroundColor Green
Write-Host "Devices file: $DevicesPath" -ForegroundColor Cyan
Write-Host "Event log: $EventLogCsv" -ForegroundColor DarkCyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

if (-not $NoBrowser) {
    try {
        $launchUrl = if ($BindAddress -eq "*") { "http://localhost:$Port/" } else { "http://$BindAddress`:$Port/" }
        Start-Process $launchUrl | Out-Null
    }
    catch {}
}

$nextCheck = Get-Date
$asyncResult = $listener.BeginGetContext($null, $null)

try {
    while ($listener.IsListening) {
        Check-ConfigReload

        $now = Get-Date
        if ($now -ge $nextCheck) {
            foreach ($device in $script:State.devices) {
                Invoke-DeviceCheck -Device $device
            }
            $nextCheck = $now.AddSeconds($PingIntervalSeconds)
        }

        if ($asyncResult.AsyncWaitHandle.WaitOne(200)) {
            try {
                $context = $listener.EndGetContext($asyncResult)
            }
            catch {
                $asyncResult = $listener.BeginGetContext($null, $null)
                continue
            }

            $asyncResult = $listener.BeginGetContext($null, $null)
            $path = $context.Request.Url.AbsolutePath
            $method = $context.Request.HttpMethod.ToUpperInvariant()

            try {
                if ($path -eq "/api/state" -and $method -eq "GET") {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-StateJson))
                    Write-HttpResponse -Context $context -StatusCode 200 -ContentType "application/json; charset=utf-8" -Bytes $bytes
                    continue
                }

                if ($path -eq "/api/devices" -and $method -eq "GET") {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-DevicesJson))
                    Write-HttpResponse -Context $context -StatusCode 200 -ContentType "application/json; charset=utf-8" -Bytes $bytes
                    continue
                }

                if ($path -eq "/api/devices" -and $method -eq "PUT") {
                    $payload = Read-RequestBodyJson -Request $context.Request
                    if (-not $payload.devices) {
                        throw "Payload must contain a 'devices' array."
                    }

                    Save-DevicesToFile -DevicesPayload $payload.devices
                    Add-LogEntry -Level "INFO" -Target "config" -Message "Inventory updated from UI editor."

                    $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true}')
                    Write-HttpResponse -Context $context -StatusCode 200 -ContentType "application/json; charset=utf-8" -Bytes $bytes
                    continue
                }

                if ($path -eq "/") {
                    $path = "/index.html"
                }

                $relativeFile = $path.TrimStart("/")
                $fileBytes = Get-FileBytes -RelativePath $relativeFile
                if ($null -ne $fileBytes) {
                    $contentType = Get-ContentType -Path $relativeFile
                    Write-HttpResponse -Context $context -StatusCode 200 -ContentType $contentType -Bytes $fileBytes
                }
                else {
                    $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                    Write-HttpResponse -Context $context -StatusCode 404 -ContentType "text/plain; charset=utf-8" -Bytes $notFound
                }
            }
            catch {
                $message = $_.Exception.Message
                Add-LogEntry -Level "ERROR" -Target "api" -Message $message
                $bytes = [System.Text.Encoding]::UTF8.GetBytes(([ordered]@{ ok = $false; error = $message } | ConvertTo-Json -Compress))
                Write-HttpResponse -Context $context -StatusCode 400 -ContentType "application/json; charset=utf-8" -Bytes $bytes
            }
        }
    }
}
finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}