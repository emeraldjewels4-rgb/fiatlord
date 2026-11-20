' Runs ops/mint-audit-daily.cmd with no console window, and hands its exit code to Task Scheduler.
'
' Same shape as topup-daily.vbs, for the same reasons: a scheduled task that starts a .cmd
' directly flashes a console window every day, and WScript.Shell.Run with a window style of 0
' hides it. folder is a String, so it is assigned plainly - Set raises "Object required", which
' WScript answers with a modal dialog that is invisible under a scheduled task and leaves the
' task sitting at "running".
'
' Quitting with the child's exit code is the whole point: 0 the chain and the logs agree, 1 a
' check failed (an unsigned mint, or a supply that does not add up), 2 it could not run. A task
' that reported 0 for every failure would be worse than no task.
Dim shell, folder, command, status
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = """" & folder & "\mint-audit-daily.cmd" & """"
status = shell.Run(command, 0, True)
WScript.Quit status
