<#
.SYNOPSIS
  Registers (or removes) the nightly Loveriver deployment-record check in Windows Task Scheduler.

.DESCRIPTION
  The pre-commit hook runs tools\record-deployment.mjs --check on every commit, so the record is only
  verified on days somebody commits. A redeploy nobody recorded - the failure the hook exists to
  catch - therefore sits stale until the next commit, which may be days. This registers the same
  check nightly, with the same two settings the audit, top-up and backup tasks use so a sleeping
  laptop does not skip the night:

      StartWhenAvailable  a missed start runs as soon as the machine is available again.
      WakeToRun           the machine is woken at the scheduled time, for a shut lid.

  It runs ops\record-check-nightly.vbs -> ops\record-check-nightly.cmd ->
  tools\record-deployment.mjs --check, which compares deployments.json with the newest Forge
  broadcast. The check reads an artifact only through ethers, so a machine that never ran npm
  install reports "could not run" instead of passing.

  Exit codes surface in Task Scheduler's "Last Result" - 0 the record matches the newest broadcast
  (or there is no broadcast to be stale against, said out loud), 1 the record is stale, 2 the check
  could not run - and a non-zero run also leaves logs\record-check-failed.txt, so a failure is
  visible without opening the scheduler.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\install-record-check-task.ps1
  powershell -ExecutionPolicy Bypass -File ops\install-record-check-task.ps1 -Time 21:30
  powershell -ExecutionPolicy Bypass -File ops\install-record-check-task.ps1 -WhatIfOnly
  powershell -ExecutionPolicy Bypass -File ops\install-record-check-task.ps1 -Uninstall
#>
param(
  [string]$TaskName = 'Loveriver record check',
  [string]$Time = '22:40',
  [switch]$NoWake,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$OpsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Split-Path -Parent $OpsDir
$Wrapper = Join-Path $OpsDir 'record-check-nightly.vbs'
$Tool = Join-Path $AppDir 'tools\record-deployment.mjs'
$Record = Join-Path $AppDir 'deployments.json'

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

if (-not (Test-Path -LiteralPath $Record)) {
  Write-Error "  $Record is missing; there would be no record to check"
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
  ExecutionTimeLimit         = (New-TimeSpan -Minutes 10)
  MultipleInstances          = 'IgnoreNew'
}
if (-not $NoWake) { $settingsParams['WakeToRun'] = $true }
$settings = New-ScheduledTaskSettingsSet @settingsParams

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

$description = 'Nightly check that deployments.json matches the newest Forge broadcast - the same ' +
  'check the pre-commit hook runs, for days with no commits. Refuses rather than passing when it ' +
  'cannot run.'

if ($WhatIfOnly) {
  Write-Host "  would register '$TaskName' daily at $Time, wake=$(-not $NoWake), start-when-available=true"
  Write-Host "  action: wscript.exe `"$Wrapper`""
  Write-Host "  checks: tools\record-deployment.mjs --check"
  Write-Host "  logs:   logs\record-check.log, failure marker logs\record-check-failed.txt"
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
Write-Host "    logs      logs\record-check.log"
