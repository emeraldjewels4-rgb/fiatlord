@echo off
rem Nightly deployments.json check, for Windows Task Scheduler.
rem
rem The pre-commit hook runs tools\record-deployment.mjs --check before every commit, which leaves
rem days with no commits uncovered: a redeploy nobody recorded stays stale for exactly as long as
rem nobody commits. This runs the same check on a fixed schedule, so the record is compared with the
rem newest broadcast whether or not any work happened that day.
rem
rem What the check reports: exit 0 means deployments.json matches the newest artifact (or there is
rem no artifact to be stale against, which it says out loud rather than passing silently), 1 means
rem the record is stale, 2 means the check could not run at all - node missing, no node_modules for
rem ethers, or an unreadable artifact. Anything non-zero is refused here, not swallowed: a nightly
rem task that reports success for a check it could not perform is worse than no task at all.
rem
rem Task Scheduler cannot redirect a task's output, so this wrapper appends everything to
rem logs\record-check.log with the exit code, then exits with that same code, which is what
rem "Last Result" in the Task Scheduler UI reports.
rem
rem A failing run leaves logs\record-check-failed.txt behind, so a failure is visible without
rem reading the log or the scheduler UI. A passing run deletes it.
rem
rem   powershell -ExecutionPolicy Bypass -File ops\install-record-check-task.ps1
setlocal EnableExtensions

rem %%~fI (not %%~dp0..) so the paths logged are clean.
for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
if not defined NODE set "NODE=node"
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\record-check.log"
set "MARKER=%LOG_DIR%\record-check-failed.txt"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

pushd "%APP_DIR%"

echo ===== %DATE% %TIME% record-deployment --check>>"%LOG%"
"%NODE%" tools\record-deployment.mjs --check>>"%LOG%" 2>&1
set "STATUS=%ERRORLEVEL%"

if not "%STATUS%"=="0" goto :failed

if exist "%MARKER%" del "%MARKER%"
echo ===== exit 0 >>"%LOG%"
popd
exit /b 0

:failed
rem The space before >> matters: "%STATUS%>>" would be read as a descriptor redirect.
echo ===== FAILED exit %STATUS% >>"%LOG%"
rem The documented contract is 0 current, 1 stale, 2 could not run. Anything that is not "stale" is
rem "could not run" - node missing is 9009, for instance - so the raw code stays in the log and the
rem marker while the task reports the code the installer documents and Task Scheduler can show.
set "CODE=2"
set "WHY=the check could not run; the log says why"
if "%STATUS%"=="1" set "CODE=1"
if "%STATUS%"=="1" set "WHY=deployments.json is stale against the newest broadcast"
rem No parentheses in this echo: a literal ) inside a ( ... ) block closes the block early.
(echo %DATE% %TIME% record check FAILED with exit %STATUS%, refused as %CODE%: %WHY%.>>"%MARKER%")
(echo See logs\record-check.log; record a fresh deploy with npm run deploy:record in loveriver.>>"%MARKER%")
popd
exit /b %CODE%
