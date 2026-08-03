@echo off
rem MP3 合成器启动器 - 双击打开（带控制台窗口，可看日志）
cd /d "%~dp0"
echo 正在启动 MP3 合成器...
echo 关闭本窗口即退出服务
echo.
"E:\Reasonix\node.exe" merge-gui.js
if errorlevel 1 (
  echo.
  echo [启动失败] 尝试使用系统 node...
  node merge-gui.js
)
pause
