@echo off
rem One-minute mint-ledger expiry for Windows Task Scheduler.
rem
rem This is the only mechanism that keeps the ten-minute rule while nothing else is running:
rem topup.mjs spawns a purge for the run that minted, but that process dies with the machine.
rem A scheduled task does not — after a reboot it fires on the next tick.
rem
rem Paths are absolute because Task Scheduler has no working-directory setting, and it starts
rem the task in system32. The ledger path is derived from this file, so moving the project
rem needs the task re-registered.
rem
rem A successful run logs nothing at all — not "destroyed nothing" (noise once a minute) and
rem not "destroyed two" (a record of the deletions themselves). Only failures are logged.
setlocal EnableExtensions

set "APP_DIR=%~dp0.."
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\ledger-purge.log"
set "LEDGER=%APP_DIR%\mint-ledger.jsonl"
set "OUT=%TEMP%\lvr-ledger-purge.out"
if not defined NODE set "NODE=node"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

pushd "%APP_DIR%"
"%NODE%" tools\mint-ledger.mjs --purge --file "%LEDGER%" > "%OUT%" 2>&1
set "STATUS=%ERRORLEVEL%"
if not "%STATUS%"=="0" (
  echo ===== %DATE% %TIME% exit %STATUS%>>"%LOG%"
  type "%OUT%">>"%LOG%"
)
del "%OUT%" >nul 2>&1

rem One line, rewritten after each successful run: the evidence tools/purge-watch.mjs looks for
rem to tell a working scheduler from a dead one. A single file rather than a log line, so the
rem per-minute noise this wrapper avoids writing is still avoided - only its mtime matters.
if "%STATUS%"=="0" echo %DATE% %TIME%>"%LOG_DIR%\ledger-purge.heartbeat"

popd

exit /b %STATUS%
