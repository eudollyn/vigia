@echo off
chcp 65001 >nul
echo Instalando o "Ligar o PC" do Vigia neste notebook...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
echo.
pause
