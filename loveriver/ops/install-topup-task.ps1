<#
.SYNOPSIS
  Registers (or removes) the daily Loveriver top-up task in Windows Task Scheduler.

.DESCRIPTION
  The floor rule only holds if something runs it, and a rule with a calendar on it that stops
  when the laptop sleeps is not a floor. This registers the task with the two settings that
  make sleep not matter:

    StartWhenAvailable  a start missed while the machine was off or asleep runs as soon as it
                        is available again, instead of being skipped until tomorrow.
    WakeToRun           the machine is woken for the task at the scheduled time, for the case
                        where the lid is shut rather than the machine off.

  It runs ops\topup-daily.vbs, which runs ops\topup-daily.cmd, which loads ops\topup.env and
  calls tools/topup.mjs --within-window --broadcast. Secrets stay in that env file: the task
  definition is visible in the Task Scheduler UI to anyone at the keyboard.

  Exit codes surface in Task Scheduler's "Last Result", because the wrapper exits with them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1
  powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1 -Time 07:20
  powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1 -NoWake
  powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1 -Uninstall
#>
param(
  [string]$TaskName = 'Loveriver top-up',
  [string]$Time = '07:20',
  [switch]$NoWake,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$OpsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Split-Path -Parent $OpsDir
$Wrapper = Join-Path $OpsDir 'topup-daily.vbs'
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

# The action runs wscript.exe rather than the .cmd, so no console window appears. The wrapper
# takes its own path from WScript.ScriptFullName, so the argument is just the path in quotes.
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

# Interactive, as the current user: the task needs no stored password, and its network access
# comes from the user's own token. It fires whether the screen is locked or not.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

$description = 'Daily Loveriver top-up: refills any admin below half straight to the full ' +
  'mark, and fills the rest to the mark inside a mint window. Args and secrets live in ' +
  'ops\topup.env.'

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
Write-Host "    network   $($task.Settings.RunOnlyIfNetworkAvailable)   on batteries  $(-not $task.Settings.DisallowStartIfOnBatteries)"
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host ''
  Write-Host "  NOTE: $EnvFile does not exist yet, so a run logs 'no env file' and exits 2."
      Write-Host '        Copy ops\topup.env.example to ops\topup.env and fill in RPC_URL and'
    Write-Host '        OWNER_KEY (the token address is in deployments.json). Until then the task'
    Write-Host '        is installed but inert.'
}
