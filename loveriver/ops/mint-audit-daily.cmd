@echo off
rem Daily chain audit for Windows Task Scheduler: every mint signed by the owner, and
rem issued - burned equal to totalSupply().
rem
rem Task Scheduler cannot redirect a task's output, so this wrapper runs the tool and appends
rem everything to logs\mint-audit.log with the exit code, then exits with that same code, which
rem is what "Last Result" in the Task Scheduler UI reports.
rem
rem It needs NO signing key: the audit only reads. That is the point of running it on a
rem schedule - the check that catches a stolen owner key must not itself hold one.
rem
rem Configuration comes from ops\topup.env, the file the top-up already uses, and the token
rem address from deployments.json, keyed by the chain id the RPC reports. Override the env file
rem with LOVERIVER_AUDIT_ENV if that ever stops being true. Only these are read:
rem
rem   RPC_URL=https://...
rem   NODE=C:\Program Files\nodejs\node.exe   (optional; node must be found otherwise)
rem
rem A failing run leaves logs\audit-failed.txt behind, so a failure is visible without reading
rem the log or the Task Scheduler UI at all. A passing run deletes it.
rem
rem   powershell -ExecutionPolicy Bypass -File ops\install-audit-task.ps1
setlocal EnableExtensions

rem %%~fI (not %%~dp0..) so the paths logged are clean.
for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
if defined LOVERIVER_AUDIT_ENV (set "ENV_FILE=%LOVERIVER_AUDIT_ENV%") else (set "ENV_FILE=%APP_DIR%\ops\topup.env")
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\mint-audit.log"
set "MARKER=%LOG_DIR%\audit-failed.txt"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%ENV_FILE%" goto :noenv

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do if not "%%B"=="" set "%%A=%%B"

if not defined RPC_URL goto :incomplete
if not defined NODE set "NODE=node"

pushd "%APP_DIR%"

echo ===== %DATE% %TIME% mint-audit --invariant>>"%LOG%"
"%NODE%" tools\mint-audit.mjs --invariant --rpc "%RPC_URL%">>"%LOG%" 2>&1
set "STATUS=%ERRORLEVEL%"

if not "%STATUS%"=="0" goto :failed

if exist "%MARKER%" del "%MARKER%"
echo ===== exit 0 >>"%LOG%"
popd
exit /b 0

:failed
rem The space before >> matters: "%STATUS%>>" would be read as a descriptor redirect.
echo ===== FAILED exit %STATUS% >>"%LOG%"
(echo %DATE% %TIME% mint-audit failed with exit %STATUS%. See logs\mint-audit.log>>"%MARKER%")
popd
exit /b %STATUS%

:noenv
echo %DATE% %TIME% no env file at %ENV_FILE%>>"%LOG%"
(echo %DATE% %TIME% mint-audit could not run: no env file at %ENV_FILE%>>"%MARKER%")
exit /b 2

:incomplete
echo %DATE% %TIME% env incomplete: RPC_URL is required in %ENV_FILE%>>"%LOG%"
(echo %DATE% %TIME% mint-audit could not run: RPC_URL missing in %ENV_FILE%>>"%MARKER%")
exit /b 2
