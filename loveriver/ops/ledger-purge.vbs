' Runs ops/ledger-purge.cmd with no console window.
'
' A scheduled task that starts a .cmd directly flashes a console window once a minute, which
' on a desktop is unusable. WScript.Shell.Run with a window style of 0 hides it, and the path
' is taken from this script's own location so no absolute path is hard-coded here.
'
' folder is a String, so it is assigned plainly. Using Set here raises "Object required",
' which WScript answers with a modal error dialog — under a scheduled task that dialog is
' invisible and the task hangs at "running" instead of failing, which is how this was found.
Dim shell, folder, command
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = """" & folder & "\ledger-purge.cmd"""
shell.Run command, 0, True
