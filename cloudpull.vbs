' cloudpull.vbs -- start the cloud-pull daemon (daemon.mjs) with no console window
'
' Why this exists
' ---------------
' The Electron shell only watches LOCAL filesystem changes. Anything edited from
' the phone / web client therefore never reaches this PC. This script launches a
' resident daemon that calls the engine's --cloudsync every N minutes
' (config.json -> cloudPull.intervalMin, default 10).
'
' Register once (elevated PowerShell):
'   powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1
' or just double-click install-cloudpull-task.cmd
'
' Manual test (shows errors on the console instead of a popup):
'   cscript //nologo "C:\wps-sync\resources\engine\cloudpull.vbs"
'
' !! KEEP THIS FILE PURE ASCII AND CRLF !!
'   wscript.exe reads .vbs with the ANSI code page (GBK on zh-CN Windows) and
'   does NOT honour a missing UTF-8 BOM. Non-ASCII text gets mis-decoded, the
'   byte stream shifts, and the parser then reports errors such as
'   "800A0005 invalid procedure call or argument" on a line that looks fine
'   (e.g. an empty line). Diagnostics: check for CRLF and for bytes > 0x7F.
'   install-cloudpull-task.ps1 rewrites the two paths below on every run,
'   always writing back as ASCII + CRLF, so paths stay correct after a move.

Option Explicit

Dim sh, exePath, scriptPath, cmd

exePath    = "C:\wps-sync\wps-sync.exe"
scriptPath = "C:\wps-sync\resources\engine\daemon.mjs"

Set sh = CreateObject("WScript.Shell")

' ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as plain node
' (no window, no UI). Run(cmd, 0, False): 0 = hidden window, False = do not wait.
cmd = "cmd /c set ELECTRON_RUN_AS_NODE=1&& """ & exePath & """ """ & scriptPath & """"
sh.CurrentDirectory = "C:\wps-sync"
sh.Run cmd, 0, False
