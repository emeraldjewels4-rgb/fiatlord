<#
.SYNOPSIS
  Registers (or removes) the daily Loveriver repository-backup task in Windows Task Scheduler.

.DESCRIPTION
  The repository has no remote, so the committed history lives on this laptop only. This
  registers a daily git bundle to D:\loveriver-backup, with the same two settings the audit and
  top-up tasks use so a sleeping laptop does not skip a day:

    StartWhenAvailable  a missed start runs as soon as the machine is available again.
    WakeToRun           the machine is woken at the scheduled time, for a shut lid.

  It runs ops\repo-backup-daily.vbs -> ops\repo-backup-daily.cmd -> tools\repo-backup.mjs,
  which writes a timestamped bundle, runs `git bundle verify`, then clones the bundle into a
  scratch directory and requires the same HEAD commit, tree, commit count, file count and
  branches before it reports success. The clone is not decoration: `git bundle verify` passes
  on a bundle truncated to half (proved by `node tools\repo-backup.mjs --selftest`).

  Exit codes surface in Task Scheduler's "Last Result" - 0 the bundle verifies and restores,
  1 a check failed, 2 it could not run - and a non-zero run also leaves
  logs\repo-backup-failed.txt, so a failure is visible without opening the scheduler.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\install-repo-backup-task.ps1
  powershell -ExecutionPolicy Bypass -File ops\install-repo-backup-task.ps1 -Time 08:10
  powershell -ExecutionPolicy Bypass -File ops\install-repo-backup-task.ps1 -WhatIfOnly
  powershell -ExecutionPolicy Bypass -File ops\install-repo-backup-task.ps1 -Uninstall
#>
param(
  [string]$TaskName = 'Loveriver repo backup',
  [string]$Time = '08:10',
  [switch]$NoWake,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$OpsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Split-Path -Parent $OpsDir
$Wrapper = Join-Path $OpsDir 'repo-backup-daily.vbs'
$Tool = Join-Path $AppDir 'tools\repo-backup.mjs'
$OutDir = if ($env:LOVERIVER_BACKUP_OUT) { $env:LOVERIVER_BACKUP_OUT } else { 'D:\loveriver-backup' }

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "  $TaskName is not registered; nothing to remove"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  removed task '$TaskName'"
  exit 0
}

if (-not (Test-Path -LiteralPath $Wrapper)) {
  Write-Error "  $Wrapper is missing; the task would have nothing to run"
  exit 2
}

if (-not (Test-Path -LiteralPath $Tool)) {
  Write-Error "  $Tool is missing; the wrapper would fail every night"
  exit 2
}

if ($Time -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') {
  Write-Error "  -Time '$Time' is not HH:mm"
  exit 2
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"{0}"' -f $Wrapper) -WorkingDirectory $AppDir

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settingsParams = @{
  StartWhenAvailable         = $true
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  ExecutionTimeLimit         = (New-TimeSpan -Hours 1)
  MultipleInstances          = 'IgnoreNew'
}
if (-not $NoWake) { $settingsParams['WakeToRun'] = $true }
$settings = New-ScheduledTaskSettingsSet @settingsParams

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

$description = 'Daily git bundle of the Loveriver repository to ' + $OutDir +
  ': verified with git bundle verify, then cloned to prove the history restores.'

if ($WhatIfOnly) {
  Write-Host "  would register '$TaskName' daily at $Time, wake=$(-not $NoWake), start-when-available=true"
  Write-Host "  action: wscript.exe `"$Wrapper`""
  Write-Host "  output: $OutDir (created on first run if absent)"
  exit 0
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $description -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$task = Get-ScheduledTask -TaskName $TaskName

Write-Host "  registered '$TaskName'"
Write-Host "    runs      wscript.exe `"$Wrapper`""
Write-Host "    daily at  $Time"
Write-Host "    next run  $($info.NextRunTime)"
Write-Host "    wake      $($task.Settings.WakeToRun)   start when available  $($task.Settings.StartWhenAvailable)"
Write-Host "    output    $OutDir"
if (-not (Test-Path -LiteralPath $OutDir)) {
  Write-Host ''
  Write-Host "  NOTE: $OutDir does not exist yet; the first run creates it."
}
