@echo off
setlocal
title dsh-plugin-prompt-optimizer :: uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
endlocal
