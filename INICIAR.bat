@echo off
chcp 65001 >nul
title Vigia
cd /d "%~dp0"
echo Iniciando o Vigia... (feche esta janela para parar)
node src\index.js
pause
