' Starts the Forest program with no console window. The shortcuts point here.
' Uses Windows Script Host (built into Windows) to run scripts\launch.mjs with Node, hidden.
Option Explicit
Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
' 0 = hidden window, False = don't wait.
shell.Run "node """ & root & "\scripts\launch.mjs""", 0, False
