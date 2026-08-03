' MP3 合成器启动器 - 双击打开（隐藏控制台窗口）
' 便携版：整个文件夹拷到任何电脑双击即用，无需安装任何东西。
' 查找 node 顺序：runtime\node.exe（内置）-> 同目录 node.exe -> 系统 PATH 中的 node
Option Explicit
Dim ws, fso, dir, node
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then
  node = dir & "\node.exe"
End If
If Not fso.FileExists(node) Then
  node = "node.exe"   ' 最后尝试系统 PATH
End If

ws.CurrentDirectory = dir
ws.Run """" & node & """ """ & dir & "\launcher.js""", 0, False
Set fso = Nothing
Set ws = Nothing
