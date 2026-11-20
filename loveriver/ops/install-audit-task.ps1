<#
.SYNOPSIS
  Registers (or removes) the daily Loveriver chain-audit task in Windows Task Scheduler.

.DESCRIPTION
  The audit only means something if it runs without anyone remembering to run it: at audit
  time it is too late to catch a mint nobody authorised. This registers it daily, after the
  top-up, with the same two settings the top-up uses so a sleeping laptop does not skip a day:

    StartWhenAvailable  a missed start runs as soon as the machine is available again.
    WakeToRun           the machine is woken at the scheduled time, for a shut lid.

  It runs ops\mint-audit-daily.vbs -> ops\mint-audit-daily.cmd -> tools/mint-audit.mjs
  --invariant, which reads RPC_URL from ops\topup.env and the token address, deploy block and
  owner from the committed deployments.json by the chain id the RPC reports. It needs no
  signing key: the audit only reads.

  Exit codes surface in Task Scheduler's "Last Result" - 0 the chain and the logs agree, 1 an
  unsigned mint or a supply that does not add up, 2 it could not run - and a non-zero run also
  leaves logs\audit-failed.txt, so a failure is visible without opening the scheduler at all.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\install-audit-task.ps1
  powershell -ExecutionPolicy Bypass -File ops\install-audit-task.ps1 -Time 07:50
  powershell -ExecutionPolicy Bypass -File ops\install-audit-task.ps1 -WhatIfOnly
  powershell -ExecutionPolicy Bypass -File ops\install-audit-task.ps1 -Uninstall
#>
param(
  [string]$TaskName = 'Loveriver audit',
  [string]$Time = '07:50',
  [switch]$NoWake,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$OpsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Split-Path -Parent $OpsDir
$Wrapper = Join-Path $OpsDir 'mint-audit-daily.vbs'
$EnvFile = Join-Path $OpsDir 'topup.env'

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

if ($Time -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') {
  Write-Error "  -Time '$Time' is not HH:mm"
  exit 2
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"{0}"' -f $Wrapper) -WorkingDirectory $AppDir

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settingsParams = @{
  StartWhenAvailable         = $true
  RunOnlyIfNetworkAvailable  = $true
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  ExecutionTimeLimit         = (New-TimeSpan -Hours 1)
  MultipleInstances          = 'IgnoreNew'
}
if (-not $NoWake) { $settingsParams['WakeToRun'] = $true }
$settings = New-ScheduledTaskSettingsSet @settingsParams

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

$description = 'Daily Loveriver chain audit: every mint signed by the owner, and issued minus ' +
  'burned equal to totalSupply(). Read-only; config in ops\topup.env.'

if ($WhatIfOnly) {
  Write-Host "  would register '$TaskName' daily at $Time, wake=$(-not $NoWake), start-when-available=true"
  Write-Host "  action: wscript.exe `"$Wrapper`""
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
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host ''
  Write-Host "  NOTE: $EnvFile does not exist yet, so a run logs 'no env file' and exits 2,"
  Write-Host '        leaving logs\audit-failed.txt behind. The task is installed but inert.'
}
