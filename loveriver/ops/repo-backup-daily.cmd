@echo off
rem Daily git-bundle backup of this repository, for Windows Task Scheduler.
rem
rem There is no remote, so the committed history exists only on this laptop. tools\repo-backup.mjs
rem writes a timestamped bundle, verifies it with git, and clones it to prove the history comes
rem back - the clone is the check that matters, because `git bundle verify` passes on a file
rem truncated to half (measured; see --selftest).
rem
rem Task Scheduler cannot redirect a task's output, so this wrapper appends everything to
rem logs\repo-backup.log with the exit code, then exits with that same code, which is what
rem "Last Result" in the Task Scheduler UI reports.
rem
rem Configuration, all optional - there is no env file to edit:
rem
rem   LOVERIVER_BACKUP_OUT   destination, default D:\loveriver-backup
rem   LOVERIVER_BACKUP_KEEP  how many bundles to retain, default 30, 0 keeps all
rem   NODE                   node.exe path, default "node" on PATH
rem
rem A failing run leaves logs\repo-backup-failed.txt behind, so a failure is visible without
rem reading the log or the scheduler UI. A passing run deletes it.
rem
rem   powershell -ExecutionPolicy Bypass -File ops\install-repo-backup-task.ps1
setlocal EnableExtensions

rem %%~fI (not %%~dp0..) so the paths logged are clean.
for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
if not defined LOVERIVER_BACKUP_OUT set "LOVERIVER_BACKUP_OUT=D:\loveriver-backup"
if not defined LOVERIVER_BACKUP_KEEP set "LOVERIVER_BACKUP_KEEP=30"
if not defined NODE set "NODE=node"
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\repo-backup.log"
set "MARKER=%LOG_DIR%\repo-backup-failed.txt"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

pushd "%APP_DIR%"

echo ===== %DATE% %TIME% repo-backup --out "%LOVERIVER_BACKUP_OUT%" --keep %LOVERIVER_BACKUP_KEEP%>>"%LOG%"
"%NODE%" tools\repo-backup.mjs --out "%LOVERIVER_BACKUP_OUT%" --keep "%LOVERIVER_BACKUP_KEEP%">>"%LOG%" 2>&1
set "STATUS=%ERRORLEVEL%"

if not "%STATUS%"=="0" goto :failed

if exist "%MARKER%" del "%MARKER%"
echo ===== exit 0 >>"%LOG%"
popd
exit /b 0

:failed
rem The space before >> matters: "%STATUS%>>" would be read as a descriptor redirect.
echo ===== FAILED exit %STATUS% >>"%LOG%"
(echo %DATE% %TIME% repo-backup failed with exit %STATUS%. See logs\repo-backup.log>>"%MARKER%")
popd
exit /b %STATUS%
