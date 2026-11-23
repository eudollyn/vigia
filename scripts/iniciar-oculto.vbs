' Inicia o Vigia sem abrir janela (usado pela tarefa que roda quando você entra no Windows).
Set fso = CreateObject("Scripting.FileSystemObject")
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = raiz
sh.Run "cmd /c node src\index.js >> dados\saida.log 2>&1", 0, False
