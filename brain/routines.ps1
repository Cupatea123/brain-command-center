<#
  Read-only state of the Windows scheduled tasks listed in routines.json, for the Command Center.
  Uses the Task Scheduler COM interface (much faster than Get-ScheduledTaskInfo per task).
  Usage: pwsh -NoProfile -File routines.ps1 -Config <routines.json> -OutFile <path>
#>
param([Parameter(Mandatory = $true)][string]$Config, [Parameter(Mandatory = $true)][string]$OutFile)

$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$states = @{ 0 = "Unknown"; 1 = "Disabled"; 2 = "Queued"; 3 = "Ready"; 4 = "Running" }
$rows = @()
$folder = $null
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $folder = $svc.GetFolder("\")
}
catch { }
foreach ($w in $cfg.windows) {
  $row = [ordered]@{ task = $w.task; found = $false; state = "missing"; lastRun = ""; lastResult = $null; nextRun = ""; repeatMinutes = $null }
  if ($folder) {
    try {
      $t = $folder.GetTask($w.task)
      $row.found = $true
      $row.state = $states[[int]$t.State]
      if ($t.LastRunTime -and ([datetime]$t.LastRunTime).Year -gt 2000) { $row.lastRun = ([datetime]$t.LastRunTime).ToString("s") }
      $row.lastResult = [int64]$t.LastTaskResult
      if ($t.NextRunTime -and ([datetime]$t.NextRunTime).Year -gt 2000) { $row.nextRun = ([datetime]$t.NextRunTime).ToString("s") }
      foreach ($tr in $t.Definition.Triggers) {
        $iv = $tr.Repetition.Interval
        if ($iv) { $row.repeatMinutes = [int]([System.Xml.XmlConvert]::ToTimeSpan($iv).TotalMinutes); break }
      }
    }
    catch { $row.state = "missing" }
  }
  $rows += $row
}
$json = [ordered]@{ pulled = (Get-Date).ToString("s"); tasks = $rows } | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
