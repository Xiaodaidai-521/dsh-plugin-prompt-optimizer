@echo off
setlocal
title dsh-plugin-prompt-optimizer :: install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
endlocal
