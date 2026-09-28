Option Explicit
Dim shell, fso, base, nodeExe, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "node.exe"
launcher = fso.BuildPath(base, "launcher.mjs")
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & launcher & Chr(34) & " --launch"
shell.Run command, 0, False
