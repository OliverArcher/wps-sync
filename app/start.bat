@echo off
rem ---------------------------------------------------------------
rem  wps-sync launcher - double click this file to open the app.
rem  Uses the bundled electron.exe (no system node required).
rem  Clears ELECTRON_RUN_AS_NODE first: some editors/IDEs set it,
rem  and Electron would then start as plain Node and crash.
rem ---------------------------------------------------------------
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron not found. Run "npm install" in this folder first.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
