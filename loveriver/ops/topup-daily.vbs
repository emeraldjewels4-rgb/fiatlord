' Runs ops/topup-daily.cmd with no console window, and hands its exit code to Task Scheduler.
'
' A scheduled task that starts a .cmd directly logs a console window every day. WScript.Shell.Run
' with a window style of 0 hides it, and the path comes from this script's own location so
' nothing absolute is hard-coded here.
'
' folder is a String, so it is assigned plainly. Using Set raises "Object required", which
' WScript answers with a modal error dialog - under a scheduled task that dialog is invisible
' and the task sits at "running" until the execution limit. That is how the ledger purge task
' was found hanging, and it applies here for the same reason.
'
' Run returns the child's exit code. Quitting with it means "Last Result" in Task Scheduler
' reports what the top-up actually did: 0 minted or nothing to do, 1 a check failed, 2 it
' could not run. Without this the task would report 0 for every failure, which is the one
' thing a scheduled money-mover must not do.
Dim shell, folder, command, status
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = """" & folder & "\topup-daily.cmd"""""
status = shell.Run(command, 0, True)
WScript.Quit status
