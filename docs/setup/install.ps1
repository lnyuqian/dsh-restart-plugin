#Requires -Version 5.1
<#
install.ps1 - one-shot deployment of the dsh-restart-plugin host script chain.

What it does:
  1. Copies the three docs/setup templates (restart-dsh-web.ps1,
     restart-dsh-web-silent.vbs, dsh-web-restart-start.bat) into -InstallDir
     and fills in every __PLACEHOLDER__ with your actual paths
     (UTF-8 with BOM, so Windows PowerShell 5.1 / wscript read them correctly).
  2. Registers the scheduled task (schtasks /Create) that fires
     wscript.exe "installDir\restart-dsh-web-silent.vbs".
  3. Patches the path constants in lib/index.js (LIVE / STATUS / TASK /
     SECONDS / cwd) to match this deployment; the original file is backed up
     as lib/index.js.bak next to it.

Example:
  powershell -ExecutionPolicy Bypass -File docs\setup\install.ps1 `
    -InstallDir "$env:USERPROFILE\.dsh-restart" -Seconds 10
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.dsh-restart'),
  [int]$Seconds = 10,
  [string]$TaskName = 'dsh-web-restart-20s',
  [switch]$SkipIndexJsPatch,
  [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'
$templateDir = $PSScriptRoot
if (-not $PluginDir) { $PluginDir = Split-Path -Parent (Split-Path -Parent $templateDir) }
$indexJs = Join-Path $PluginDir 'lib\index.js'
if (-not (Test-Path $indexJs)) {
  throw "lib/index.js not found under '$PluginDir'. Pass -PluginDir <repoRoot>."
}

$installDir = $InstallDir.TrimEnd('\', '/')
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$ps1    = Join-Path $installDir 'restart-dsh-web.ps1'
$vbs    = Join-Path $installDir 'restart-dsh-web-silent.vbs'
$bat    = Join-Path $installDir 'dsh-web-restart-start.bat'
$log    = Join-Path $installDir 'dsh-web.log'
$status = Join-Path $installDir 'dsh-web-restart-status.txt'
$live   = Join-Path $installDir '.dsh-restart-live.json'

$dshCmd = (Get-Command dsh.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $dshCmd) { $dshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd' }
if (-not (Test-Path $dshCmd)) { Write-Warning "dsh.cmd not found at '$dshCmd' -- edit '$bat' afterwards" }

Write-Host '==> 1/3 copying templates and filling placeholders'
function Copy-Template([string]$from, [string]$to, [hashtable]$map, [ValidateSet('utf8bom', 'gbk')][string]$encoding) {
  $text = Get-Content -LiteralPath $from -Raw -Encoding UTF8
  foreach ($k in $map.Keys) { $text = $text.Replace($k, [string]$map[$k]) }
  if ($encoding -eq 'gbk') {
    # cmd.exe and wscript parse their files with the system ANSI code page
    # (GBK on zh-CN Windows), so .bat/.vbs must be written in GBK when the
    # filled-in paths contain non-ASCII characters (e.g. a CJK username).
    try {
      $enc = [System.Text.Encoding]::GetEncoding(936)
    } catch {
      $enc = New-Object System.Text.UTF8Encoding($true)  # fallback (UTF-8 BOM is also honoured by wscript)
    }
  } else {
    # PowerShell 5.1 reads a UTF-8 BOM correctly, so the .ps1 deployment
    # target is always saved with BOM.
    $enc = New-Object System.Text.UTF8Encoding($true)
  }
  [System.IO.File]::WriteAllText($to, $text, $enc)
  Write-Host "     wrote $to"
}

Copy-Template (Join-Path $templateDir 'restart-dsh-web.ps1') $ps1 @{
  '__LOG_FILE__'    = $log
  '__STATUS_FILE__' = $status
  '__LIVE_FILE__'   = $live
  '__START_BAT__'   = $bat
} 'utf8bom'
Copy-Template (Join-Path $templateDir 'restart-dsh-web-silent.vbs') $vbs @{
  '__PS1_FILE__' = $ps1
  '__SECONDS__'  = $Seconds
} 'gbk'
Copy-Template (Join-Path $templateDir 'dsh-web-restart-start.bat') $bat @{
  '__DSH_CMD__'  = $dshCmd
  '__LOG_FILE__' = $log
} 'gbk'

Write-Host "==> 2/3 registering scheduled task '$TaskName'"
$tr = 'wscript.exe "' + $vbs + '"'
& schtasks.exe /Create /F /TN $TaskName /TR $tr /SC ONCE /ST 00:00 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "schtasks exited with $LASTEXITCODE -- register the task manually (Action: $tr)"
} else {
  Write-Host "     task '$TaskName' -> $tr"
}

if (-not $SkipIndexJsPatch) {
  Write-Host "==> 3/3 patching lib/index.js constants (backup: $indexJs.bak)"
  if (-not (Test-Path "$indexJs.bak")) { Copy-Item $indexJs "$indexJs.bak" }
  $jsText = [System.IO.File]::ReadAllText($indexJs)
  $jsEscape = { param($p) return $p.Replace('\', '\\') }
  $jsLive   = $jsEscape.Invoke($live)
  $jsStatus = $jsEscape.Invoke($status)
  $jsTask   = $jsEscape.Invoke($TaskName)
  $jsDir    = $jsEscape.Invoke($installDir)

  $patches = @(
    @{ label = 'const LIVE';   re = "const LIVE = '[^']*'";                   rep = "const LIVE = '$jsLive'" },
    @{ label = 'const STATUS'; re = "const STATUS = '[^']*'";                 rep = "const STATUS = '$jsStatus'" },
    @{ label = 'const TASK';   re = "const TASK = '[^']*'";                   rep = "const TASK = '$jsTask'" },
    @{ label = 'const SECONDS'; re = 'const SECONDS = \d+';                   rep = "const SECONDS = $Seconds" },
    @{ label = 'cwd';          re = "cwd: '[^']*'";                           rep = "cwd: '$jsDir'" },
    @{ label = 'desc STATUS';  re = 'E:\\\\pi-windows\\\\dsh-web-restart-status\.txt'; rep = $jsStatus },
    @{ label = 'desc LIVE';    re = 'D:\\\\dsh-web\\\\做项目\\\\.dsh-restart-live\.json'; rep = $jsLive },
    @{ label = 'desc task';    re = 'dsh-web-restart-20s';                    rep = $TaskName },
    @{ label = 'desc seconds'; re = '10 秒';                                  rep = "$Seconds 秒" }
  )
  foreach ($p in $patches) {
    if ($jsText -match $p.re) {
      $jsText = [regex]::Replace($jsText, $p.re, [System.Text.RegularExpressions.MatchEvaluator]{
        param($m) return $p.rep
      })
      Write-Host "     patched $($p.label)"
    }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($indexJs, $jsText, $utf8NoBom)
}

Write-Host ''
Write-Host 'Deployment summary:'
Write-Host "  scripts dir : $installDir"
Write-Host "  task name   : $TaskName  (run: schtasks /Run /TN `"$TaskName`")"
Write-Host "  live marker : $live"
Write-Host "  status log  : $status"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart dsh web, then Ctrl+Shift+R in the browser.'
Write-Host "  2. Check the host route:  Invoke-RestMethod http://127.0.0.1:3080/_dsh/dsh-restart/state"
Write-Host "  3. Click the sidebar [restart] button (or say `"restart`" to the model),"
Write-Host '     wait for the countdown, the page auto-reloads and shows the success toast.'
Write-Host "  4. Inspect: Get-Content `"$status`" | Select-Object -Last 12"