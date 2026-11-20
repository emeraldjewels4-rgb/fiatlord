@echo off
rem Daily window-gated top-up for Windows Task Scheduler.
rem
rem Task Scheduler cannot redirect a task's output, so this wrapper runs the tool and appends
rem everything to logs\topup.log with the exit code, then exits with that same code.
rem
rem Secrets come from ops\topup.env (gitignored), never from the task definition, where they
rem would be visible in the Task Scheduler UI:
rem
rem   RPC_URL=https://...
rem   OWNER_KEY=0x...
rem (the token address is not here: deployments.json is keyed by the chain id the RPC reports)
rem   NODE=C:\Program Files\nodejs\node.exe   (optional; node must be found otherwise)
rem
rem Plain KEY=value lines, no quotes and no spaces around "=", because the POSIX wrapper
rem reads the same file the same way. A line with no "=" is a comment and is skipped.
rem
rem Register it with:
rem   schtasks /Create /TN "Loveriver top-up" /TR "\"C:\path\to\loveriver\ops\topup-daily.cmd\"" /SC DAILY /ST 07:20 /F
rem
rem --within-window gates the FULL stage only: outside a mint window this still restores the
rem half floor every day and leaves the top-up to the calendar. That is the intended split.
setlocal EnableExtensions

rem %%~fI (not %%~dp0..) so the paths logged are clean: "ops\..\ops\topup.env" is correct
rem but unreadable in a log line at 07:20 in the morning.
for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
if defined LOVERIVER_ENV (set "ENV_FILE=%LOVERIVER_ENV%") else (set "ENV_FILE=%APP_DIR%\ops\topup.env")
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\topup.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%ENV_FILE%" goto :noenv

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do if not "%%B"=="" set "%%A=%%B"

if not defined RPC_URL goto :incomplete
if not defined OWNER_KEY goto :incomplete
if not defined NODE set "NODE=node"

set "LOVERIVER_BROADCAST=yes"
pushd "%APP_DIR%"

echo ===== %DATE% %TIME% topup --within-window>>"%LOG%"
"%NODE%" tools\topup.mjs --within-window --rpc "%RPC_URL%" --broadcast>>"%LOG%" 2>&1
set "STATUS=%ERRORLEVEL%"
rem The space before >> matters: "%STATUS%>>" would be read as a descriptor redirect and the
rem exit code would vanish from the line.
echo ===== exit %STATUS% >>"%LOG%"

popd
exit /b %STATUS%

:noenv
echo %DATE% %TIME% no env file at %ENV_FILE%>>"%LOG%"
exit /b 2

:incomplete
echo %DATE% %TIME% env incomplete: RPC_URL and OWNER_KEY are required in %ENV_FILE%>>"%LOG%"
exit /b 2
