@echo off
setlocal
title dsh-plugin-prompt-optimizer :: live check
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-live.ps1" %*
echo.
pause
endlocal
