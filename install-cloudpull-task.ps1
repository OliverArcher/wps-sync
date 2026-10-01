# install-cloudpull-task.ps1 - 注册/卸载「云端拉取守护」计划任务
#
# 做的事：登录时启动 cloudpull.vbs（无窗口），由 daemon.mjs 按
# config.json 的 cloudPull.intervalMin（当前 10 分钟）周期把
# 手机/网页端对云端的改动拉到本地。
#
#   powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1 -Interval 5
#
# 请用管理员身份运行（或直接双击同目录的 install-cloudpull-task.cmd，它会自动提权）。

param(
  [switch]$Uninstall,
  [switch]$NoStart,
  [int]$Interval = 0
)

$ErrorActionPreference = 'Stop'
$TaskName = 'wps-sync-cloudpull'
$Root = $PSScriptRoot
$Vbs  = Join-Path $Root 'resources\engine\cloudpull.vbs'
$Cfg  = Join-Path $Root 'config.json'
$Self = $MyInvocation.MyCommand.Path

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

function Get-Daemon {
  Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='wps-sync.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*daemon.mjs*' }
}

# ---- 卸载 ----
if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say "已注销计划任务 $TaskName" 'Green'
  } else {
    Say "计划任务 $TaskName 不存在，无需注销"
  }
  foreach ($p in Get-Daemon) {
    Say "结束守护进程 PID=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  return
}

# ---- 前置检查 ----
if (-not (Test-Path $Vbs)) { Say "找不到 $Vbs，安装目录不对？" 'Red'; exit 1 }
if (-not (Test-Path $Cfg)) { Say "找不到 $Cfg" 'Red'; exit 1 }

# ---- cloudpull.vbs 编码体检 ----
# wscript.exe 按 ANSI 代码页（简体中文 = GBK）读 .vbs，且不认「无 BOM 的 UTF-8」。
# 一旦文件里放了中文，字节流就会错位，最终在一行看着完全正常的代码上报
# 800A0005「无效的过程调用或参数」—— 报的行号还经常是空行，极难排查。
$bytes = [IO.File]::ReadAllBytes($Vbs)
$hi    = 0
foreach ($b in $bytes) { if ($b -gt 127) { $hi++ } }
$txt  = [Text.Encoding]::ASCII.GetString($bytes)
$lone = ([regex]::Matches($txt, "(?<!`r)`n")).Count
if ($hi -gt 0) {
  Say "[!] cloudpull.vbs 含 $hi 个非 ASCII 字节 —— wscript 会误读并报 800A0005。" 'Yellow'
  Say "    修正：把注释改成英文，用记事本「另存为 → 编码 ANSI」保存。" 'Yellow'
}
if ($lone -gt 0) {
  Say "[!] cloudpull.vbs 有 $lone 处裸 LF 换行 —— 请统一为 CRLF。" 'Yellow'
}
if ($hi -eq 0 -and $lone -eq 0) { Say "[OK] cloudpull.vbs 编码体检通过（纯 ASCII + CRLF）" 'DarkGray' }

# ---- 可选：改周期 ----
if ($Interval -gt 0) {
  Copy-Item $Cfg "$Cfg.bak-cloudpull" -Force
  $j = Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $j.cloudPull) {
    $j | Add-Member -NotePropertyName cloudPull -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $j.cloudPull | Add-Member -NotePropertyName enabled     -NotePropertyValue $true     -Force
  $j.cloudPull | Add-Member -NotePropertyName intervalMin -NotePropertyValue $Interval -Force
  ($j | ConvertTo-Json -Depth 20) | Set-Content $Cfg -Encoding UTF8
  Say "已把 cloudPull.intervalMin 改为 $Interval（原文件备份为 config.json.bak-cloudpull）" 'Green'
}

# ---- 注册 ----
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
# ExecutionTimeLimit = 0 → 不限制运行时长（守护是常驻进程，默认 3 天会被掐断）
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'WPS 云盘 云端到本地 自动拉取' -Force | Out-Null

# 避免重复启动：先清一次已有守护
foreach ($p in Get-Daemon) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

Say ''
Say "[OK] 计划任务 $TaskName 已注册（登录时启动，无窗口）" 'Green'
$shown = (Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json).cloudPull.intervalMin
Say "     拉取周期：$shown 分钟（config.json 的 cloudPull.intervalMin）"
Say "     日志：$Root\data\cloudpull.log"

if (-not $NoStart) {
  try {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    $running = Get-Daemon
    if ($running) {
      Say "[OK] 守护已在运行（PID $(($running | ForEach-Object { $_.ProcessId }) -join ','))" 'Green'
    } else {
      Say "[!] 已触发任务，但没看到守护进程；请查看 data\cloudpull.log" 'Yellow'
    }
  } catch {
    Say "启动任务失败：$($_.Exception.Message)" 'Yellow'
  }
}

Say ''
Say "卸载： powershell -ExecutionPolicy Bypass -File ""$Self"" -Uninstall" 'DarkGray'
