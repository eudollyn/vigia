@echo off
chcp 65001 >nul
title Vigia - assistente de configuracao
cd /d "%~dp0"
if not exist node_modules (
  echo Primeiro rode o INSTALAR.bat.
  pause
  exit /b 1
)
echo Abrindo o assistente de configuracao no navegador...
echo (deixe esta janela aberta enquanto configura; feche quando terminar)
node src\configurar.js
pause
