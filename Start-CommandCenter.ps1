<#
  Opens the Command Center. Starts the local server (node server.mjs, 127.0.0.1:<port>) if it is
  not running, restarts it cleanly through its own shutdown endpoint when its code or local config
  has changed since it started, then opens it as an Edge app window (or the default browser).
  The desktop shortcut "Command Center" runs this; Install-Shortcut.ps1 creates it.
#>
$ErrorActionPreference = 'Stop'
$cc = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4317
$cfgFile = Join-Path $cc 'local\config.json'
if (Test-Path $cfgFile) { $cfg = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json; if ($cfg.port) { $port = [int]$cfg.port } }
$url = "http://127.0.0.1:$port/"
$tokenFile = Join-Path $cc 'data\token'

function Test-Up {
  try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; return $true } catch { return $false }
}
function Get-Health {
  try {
    $tok = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    return Invoke-RestMethod -Uri "${url}api/health" -Headers @{ 'x-cc-token' = $tok } -TimeoutSec 3
  } catch { return $null }
}

if (Test-Up) {
  $h = Get-Health
  if ($h -and $h.stale -and -not $h.busy) {
    $tok = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    try { $null = Invoke-RestMethod -Method Post -Uri "${url}api/shutdown" -Headers @{ 'x-cc-token' = $tok } -TimeoutSec 3 } catch { }
    for ($i = 0; $i -lt 20 -and (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
  }
}

if (-not (Test-Up)) {
  $node = (Get-Command node -ErrorAction Stop).Source
  Start-Process -FilePath $node -ArgumentList @("`"$cc\server.mjs`"") -WorkingDirectory $cc -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
}

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Start-Process -FilePath $edge -ArgumentList @("--app=$url", "--window-size=1680,1050") | Out-Null }
else { Start-Process $url | Out-Null }
