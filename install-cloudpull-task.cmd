@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "PS1=%HERE%install-cloudpull-task.ps1"

if not exist "%PS1%" (
  echo [ERROR] not found: %PS1%
  pause
  exit /b 1
)

rem --- need administrator? fltmc fails when not elevated ---
fltmc >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
