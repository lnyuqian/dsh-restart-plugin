# restart-dsh-web.ps1 — unified dsh web restart entry.
#
# This file is a deployable TEMPLATE from dsh-restart-plugin docs/setup/.
# Before using it, replace every __PLACEHOLDER__ below with your own paths —
# or simply run install.ps1, which copies this template, fills in the
# placeholders and registers the scheduled task for you.
#
#   -Mode Grace      (default) wait N seconds so the ongoing agent turn can
#                    finish delivering its answer, then stop the server and
#                    boot a fresh one.
#   -Mode Immediate  stop the server right away and boot a fresh one.
#   -Seconds N       optional countdown override for Grace mode (e.g. 10 for
#                    the dsh-web-restart-20s task). Immediate ignores it.
#
# While counting down it writes a live marker (JSON) so the web client can
# render a countdown overlay; the marker is updated through the restart and
# finishes with a self-check verdict the next session can report.
#
# After boot it verifies the server is up. The probe route /modlens/paste is
# modlens's bundle route; if you do not have modlens installed, point the
# probe at any route YOUR environment reliably serves (e.g. this plugin's own
# /_dsh/dsh-restart/state).
#
# Runs detached via Task Scheduler so killing the old server cannot kill
# this script.
param(
  [ValidateSet('Grace', 'Immediate')]
  [string]$Mode = 'Grace',
  [int]$Seconds = 0
)

$ErrorActionPreference = 'Continue'
$log    = '__LOG_FILE__'
$status = '__STATUS_FILE__'
$live   = '__LIVE_FILE__'
$url    = 'http://127.0.0.1:3080'

function Write-Live([hashtable]$h) {
  try {
    $json = $h | ConvertTo-Json -Compress -Depth 5
    [System.IO.File]::WriteAllText($live, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Status ('live marker write failed: ' + $_.Exception.Message)
  }
}

function Write-Status([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $status -Value $line
}

Set-Content -Path $status -Value ('restart script started ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " mode=$Mode seconds=$Seconds")

# 1. Grace window (Grace mode only) so the ongoing agent turn can finish
#    delivering its answer. `-Seconds` overrides the default 30s countdown.
$delay = 0
if ($Mode -eq 'Grace') { $delay = if ($Seconds -gt 0) { $Seconds } else { 30 } }
if ($delay -gt 0) {
  $now = Get-Date
  Write-Live @{
    state = 'countdown'; mode = $Mode; countdown = $delay
    triggeredAt = $now.ToString('o'); deadline = $now.AddSeconds($delay).ToString('o')
  }
  Write-Status ("countdown $delay s started (deadline " + $now.AddSeconds($delay).ToString('HH:mm:ss') + ')')
  Start-Sleep -Seconds $delay
}
Write-Status "mode=$Mode, stopping old server"
Write-Live @{ state = 'stopping'; mode = $Mode; countdown = $delay; at = (Get-Date).ToString('o') }

# 2. Stop whatever listens on 127.0.0.1:3080.
$conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Status 'no listener on 3080 (already stopped?)' }
foreach ($c in $conns) {
  try {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
    Write-Status ("killed pid " + $c.OwningProcess)
  } catch {
    Write-Status ('kill failed: ' + $_.Exception.Message)
  }
}
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}
Write-Status 'port 3080 free'
Write-Live @{ state = 'booting'; mode = $Mode; at = (Get-Date).ToString('o') }

# 3. Boot the new server, output to log.
Start-Process -FilePath '__START_BAT__' -WindowStyle Hidden
Write-Status 'new dsh web started'

# 4. Wait for boot, then probe: the modlens bundle mounts GET /modlens/paste,
#    so any non-404 there means the plugin loaded.
$up = $false
for ($i = 0; $i -lt 150; $i++) {
  if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Seconds 1
}
Write-Status ('server listening: ' + $up)

$verdict = @{ state = 'done'; mode = $Mode; at = (Get-Date).ToString('o'); success = $false; checks = @{} }
if ($up) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri ($url + '/modlens/paste') -Method Get -TimeoutSec 10 -UseBasicParsing
    Write-Status ('GET /modlens/paste -> ' + $r.StatusCode + ' (route present = plugin loaded)')
    $verdict.checks.modlens = [int]$r.StatusCode
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Status ('GET /modlens/paste -> ' + $code + ' (404 = plugin NOT loaded)')
    $verdict.checks.modlens = if ($code) { [int]$code } else { -1 }
  }
  try {
    $r2 = Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing
    Write-Status ('GET / -> ' + $r2.StatusCode)
    $verdict.checks.root = [int]$r2.StatusCode
  } catch {
    # DSH 0.1.2-rc.1+ 的根路径带鉴权：401/403（乃至 3xx）都是 HTTP 栈在正常
    # 应答的证据，只是要求登录，不算失败；真正失败是连接不上（无 StatusCode）。
    $code2 = $_.Exception.Response.StatusCode.value__
    if ($code2) {
      Write-Status ('GET / -> ' + $code2 + ' (HTTP answered = server alive; 401/403 = auth required)')
      $verdict.checks.root = [int]$code2
    } else {
      Write-Status ('GET / failed: ' + $_.Exception.Message)
      $verdict.checks.root = -1
    }
  }
}
$verdict.success = ($up -and $verdict.checks.modlens -eq 200 -and $verdict.checks.root -gt 0)
Write-Live $verdict
Write-Status ('self-check verdict: ' + $(if ($verdict.success) { 'SUCCESS' } else { 'FAILED' }))
Write-Status 'done'