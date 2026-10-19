@echo off
setlocal
title restart DSH Desktop (load a freshly installed plugin build)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = @(Get-Process 'DSH Desktop' -ErrorAction SilentlyContinue);" ^
  "if ($p.Count -eq 0) { Write-Host 'DSH Desktop is not running; just start it normally.' -ForegroundColor Yellow; exit 0 }" ^
  "$exe = ($p | Where-Object { $_.Path } | Select-Object -First 1).Path;" ^
  "Write-Host ('stopping ' + $p.Count + ' process(es)…');" ^
  "$p | Stop-Process -Force -ErrorAction SilentlyContinue;" ^
  "Start-Sleep -Seconds 3;" ^
  "if ($exe) { Write-Host ('starting ' + $exe); Start-Process $exe } else { Write-Host 'could not resolve the executable path — start DSH Desktop from the Start menu.' -ForegroundColor Yellow }"
echo.
echo 会话记录保存在磁盘上；未提交的输入框草稿可能会丢。
pause
endlocal
