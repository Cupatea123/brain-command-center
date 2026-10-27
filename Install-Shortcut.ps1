<#
  Puts a "Command Center" shortcut on the desktop that runs Start-CommandCenter.ps1 without a console window.
  Usage: pwsh -NoProfile -File Install-Shortcut.ps1
#>
$ErrorActionPreference = 'Stop'
$cc = Split-Path -Parent $MyInvocation.MyCommand.Path
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Command Center.lnk'
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = $pwsh
$sh.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$cc\Start-CommandCenter.ps1`""
$sh.WorkingDirectory = $cc
$sh.IconLocation = "$env:SystemRoot\System32\imageres.dll,190"
$sh.Description = 'Command Center: dashboard over the brain, with a Claude director'
$sh.Save()
Write-Output "Shortcut: $lnk"
