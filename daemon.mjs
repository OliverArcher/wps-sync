#!/usr/bin/env node
/**
 * daemon.mjs — 常驻守护：周期性把「云端变更」拉到本地
 *
 * 为什么需要它
 * ------------
 * 桌面壳（resources/app.asar 里的 src/main.cjs）只有**本地** fs.watch 做触发，
 * 没有任何周期性定时器；而引擎的 --once 只上行、不列云端。
 * 结果：手机 / 网页端改了云端，这台机器永远不知道 ——
 * 这就是「手机端改了这边同步不下来，除非全量重建记录」的根因。
 *
 * 引擎本身也不能自己定时（每次 --once 都是跑完即退的独立子进程），
 * 所以用这个常驻进程按周期调用 `--cloudsync`（只做云端 → 本地）。
 * 引擎源码在 asar 外面，所以**不需要重新打包桌面壳**。
 *
 * 用法
 * ----
 *   node daemon.mjs                 按 config.json 的 cloudPull.intervalMin 周期跑
 *   node daemon.mjs --interval 5    覆盖周期（分钟）
 *   node daemon.mjs --once          只跑一轮就退出（适合直接挂计划任务）
 *   node daemon.mjs --path <子目录>   只拉某个子树（秒级，适合做快捷方式）
 *
 * 无窗口启动（不依赖系统装 Node，用 Electron 自带的运行时当 node 使）
 * ----------------------------------------------------------------
 *   wscript.exe "<安装目录>\resources\engine\cloudpull.vbs"
 *
 * 与其他同步的并发
 * ----------------
 * 引擎自带文件锁；若这轮撞上界面正在同步，子进程会以退出码 3 结束（什么都没做），
 * 本守护会等一会儿重试，不会丢事件。
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))          // …/resources/engine
const SYNC2 = join(HERE, 'src', 'sync2.mjs')

/**
 * 程序根（config.json 与 data/ 所在）。
 *
 * ⚠ 绝不能退回 HERE（= resources/engine）：
 *   引擎自己的推导同样是「WPS_SYNC_USER_ROOT || 引擎目录」。ROOT 一旦指到
 *   engine，引擎读到的就是**内置模板配置** + engine/data 下的**空快照**，
 *   于是把全部本地文件当成"新文件"重传（真实踩过的数据事故）。
 *   程序结构固定为 <root>/resources/engine/，所以程序根 = HERE 的上两级。
 */
function pickRoot() {
  const env = process.env.WPS_SYNC_USER_ROOT
  if (env) return env                                          // 显式指定优先
  const cand = dirname(dirname(HERE))                          // 上两级 = 程序根
  return existsSync(join(cand, 'config.json')) ? cand : HERE
}
const ROOT = pickRoot()

const argv = process.argv.slice(2)
const once = argv.includes('--once')
const info = argv.includes('--info')
const pathArg = argv.includes('--path') ? (argv[argv.indexOf('--path') + 1] || '') : ''
const intervalArg = argv.includes('--interval') ? Number(argv[argv.indexOf('--interval') + 1]) : 0

/* ---------------- 日志（独立文件，避免和界面同步的 sync.log 混在一起） ---------------- */
const LOG = join(ROOT, 'data', 'cloudpull.log')
try {
  mkdirSync(dirname(LOG), { recursive: true })
  if (existsSync(LOG) && statSync(LOG).size > 4 * 1024 * 1024) renameSync(LOG, `${LOG}.1`)
} catch { /* 日志不可写不能影响拉取 */ }
const log = (m) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}\n`
  try { appendFileSync(LOG, line) } catch { /* ignore */ }
  process.stdout.write(line)
}

/* ---------------- 配置 ---------------- */
let intervalMin = 10
try {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  const cp = cfg.cloudPull || {}
  intervalMin = Number(cp.intervalMin) || intervalMin
  if (cp.enabled === false) {
    log('config.json 的 cloudPull.enabled = false，守护退出')
    process.exit(0)
  }
} catch (e) {
  log(`读取 config.json 失败（用默认周期 ${intervalMin} 分钟）：${e.message}`)
}
if (intervalArg > 0) intervalMin = intervalArg

const CONFIG = join(ROOT, 'config.json')
const STATE = join(ROOT, 'data', 'state.json')

/* ---------------- 自检：--info 只打印、不干活 ---------------- */
if (info) {
  const mark = (p) => (existsSync(p) ? 'OK' : '!! 不存在')
  console.log(`HERE   = ${HERE}`)
  console.log(`ROOT   = ${ROOT}    <- config.json 与 data/ 所在（必须是「程序根」）`)
  console.log(`SYNC2  = ${SYNC2}   ${mark(SYNC2)}`)
  console.log(`config = ${CONFIG}   ${mark(CONFIG)}`)
  console.log(`state  = ${STATE}   ${mark(STATE)}`)
  console.log(`log    = ${LOG}`)
  console.log(`周期   = ${intervalMin} 分钟${pathArg ? `，范围 ${pathArg}` : '（全量）'}`)
  process.exit(0)
}

/* ---------------- 护栏：没有快照就绝不拉取 ---------------- */
/*
 * 快照缺失 = 引擎眼里"云端什么都没有"，会把每个本地文件都当成新文件处理。
 * 那是 5 万文件级别的数据事故，宁可拒绝启动，让用户先跑一次界面同步。
 */
if (!existsSync(STATE)) {
  log(`拒绝启动：找不到快照 ${STATE}`)
  log('  含义：引擎会认为云端是空的，本轮可能把全部本地文件当成新文件重传。')
  log('  处理：先在 wps-sync 界面点一次同步（建立快照），再启动本守护。')
  process.exit(2)
}

/** 跑一轮引擎的 --cloudsync，等它结束。 */
let activeChild = null

function readCloudPull() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    return cfg.cloudPull || {}
  } catch (err) {
    log(`重新读取 cloudPull 配置失败：${err.message}`)
    return null
  }
}

function runOnce() {
  return new Promise((resolve) => {
    const args = [SYNC2, '--cloudsync']
    if (pathArg) args.push('--path', pathArg)
    const t0 = Date.now()
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WPS_SYNC_USER_ROOT: ROOT },
      windowsHide: true,
    })
    activeChild = p
    let tail = ''
    const onData = (buf) => {
      const s = String(buf)
      tail = (tail + s).slice(-4000)
      try { appendFileSync(LOG, s) } catch { /* ignore */ }
      process.stdout.write(s)
    }
    p.stdout?.on('data', onData)
    p.stderr?.on('data', onData)
    p.on('error', (err) => {
      activeChild = null
      log(`启动引擎失败：${err.message}`)
      resolve({ code: -1, ms: Date.now() - t0 })
    })
    p.on('exit', (code) => {
      if (activeChild === p) activeChild = null
      const ms = Date.now() - t0
      // 3 = 另一个同步正在跑（引擎明确表示"本轮什么都没做"），不算失败
      log(`—— 本轮结束：退出码 ${code}，耗时 ${(ms / 1000).toFixed(1)}s`)
      if (code === 3 && !/另一个同步正在进行/.test(tail)) log('  （退出码 3：与界面同步撞锁，稍后重试）')
      resolve({ code, ms })
    })
  })
}

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false })
log(`云端拉取守护启动：周期 ${intervalMin} 分钟${pathArg ? `，范围 ${pathArg}` : '（全量）'}`)
log(`  ROOT = ${ROOT}`)
log(`  引擎 = ${SYNC2}`)

let stopping = false
const stop = (sig) => {
  if (stopping) return
  stopping = true
  log(`收到 ${sig}，守护准备退出`)
  if (activeChild && !activeChild.killed) {
    try { activeChild.kill('SIGTERM') } catch { /* ignore */ }
    return
  }
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig))

/* ---------------- 主循环（串行：跑完再等，避免叠加） ---------------- */
if (once) {
  const r = await runOnce()
  process.exit(Number.isInteger(r.code) ? r.code : 1)
}

for (;;) {
  if (stopping) break
  const cp = readCloudPull()
  if (!cp || cp.enabled === false) { log('cloudPull 已停用或配置不可读，守护退出'); break }
  intervalMin = Number(cp.intervalMin) || intervalMin
  const r = await runOnce()
  if (stopping) break
  // 撞锁（退出码 3）时缩短等待，尽快补上这一轮；正常则按周期休息
  const waitMin = r.code === 3 ? 1 : intervalMin
  const next = new Date(Date.now() + waitMin * 60000)
  log(`下一轮 ${stamp()} 之后 ${waitMin} 分钟（约 ${next.toLocaleTimeString('zh-CN', { hour12: false })}）`)
  await new Promise((res) => setTimeout(res, waitMin * 60000))
}
