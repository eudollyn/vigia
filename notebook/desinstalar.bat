@echo off
chcp 65001 >nul
powershell.exe -NoProfile -Command "Unregister-ScheduledTask -TaskName 'Vigia - Ligar o PC' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item \"$env:LOCALAPPDATA\VigiaLigarPC\" -Recurse -Force -ErrorAction SilentlyContinue"
echo "Ligar o PC" removido deste notebook.
pause
