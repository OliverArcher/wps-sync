#!/usr/bin/env node
/**
 * sync.mjs — wps-sync 同步执行器（配置驱动，目录不写死）
 *
 *   node src/sync.mjs --once          同步一次（下行 + 上行）
 *   node src/sync.mjs --dry-run       只演练，不写盘
 *   node src/sync.mjs --serve         仅启动 WebDAV 服务（前台）
 *   node src/sync.mjs --config path   指定配置文件（默认 ./config.json）
 *
 * 流程：确保会话 → 启动/复用 wpsdav → 写 rclone.conf → 对每个 pair 跑
 *   下行：rclone copy wps:<cloudPath> <localDir> --update
 *   上行：rclone copy <localDir> wps:<cloudPath> --update
 * 不传播删除（云端无删除接口，见 README 限制）。
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : join(ROOT, 'config.json')
const DRY = args.includes('--dry-run')
const ONCE = args.includes('--once') || DRY || args.includes('--serve')
const SERVE_ONLY = args.includes('--serve')

const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const PORT = cfg.davPort || 8386
const RCLONE = join(ROOT, 'tools', 'rclone.exe')
const CONF = join(ROOT, 'data', 'rclone.conf')
const NODE = process.execPath

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    mkdirSync(dirname(join(ROOT, cfg.logFile || 'data/sync.log')), { recursive: true })
    appendFileSync(join(ROOT, cfg.logFile || 'data/sync.log'), line + '\n')
  } catch { /* ignore */ }
}

/** 端口存活检测（复用已启动的 wpsdav）。 */
function davAlive() {
  try {
    const r = spawnSync(NODE, ['-e',
      `fetch('http://127.0.0.1:${PORT}/',{method:'OPTIONS'}).then(()=>process.exit(0),()=>process.exit(1));setTimeout(()=>process.exit(1),3000)`,
    ], { stdio: 'ignore', timeout: 5000 })
    return r.status === 0
  } catch {
    return false
  }
}

async function ensureSid() {
  const authFile = join(ROOT, 'data', 'auth.json')
  let has = false
  try {
    has = Boolean(JSON.parse(readFileSync(authFile, 'utf8')).sid)
  } catch { /* ignore */ }
  if (has) return
  log('未登录：请先执行 node src/wpscli.mjs login 完成一键登录')
  process.exit(2)
}

function ensureDav() {
  if (davAlive()) { log(`wpsdav 已在 ${PORT} 运行`); return null }
  const child = spawn(NODE, [join(ROOT, 'src', 'wpsdav.mjs'), String(PORT)], {
    cwd: ROOT, detached: !SERVE_ONLY, stdio: SERVE_ONLY ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  if (!SERVE_ONLY) child.unref()
  // 等待就绪
  for (let i = 0; i < 40; i += 1) {
    spawnSync(NODE, ['-e', `fetch('http://127.0.0.1:${PORT}/',{method:'OPTIONS'}).then(()=>process.exit(0),()=>process.exit(1));setTimeout(()=>process.exit(1),1500)`], { stdio: 'ignore', timeout: 3000 })
    if (davAlive()) { log(`wpsdav 已启动 :${PORT}`); return child }
  }
  throw new Error('wpsdav 启动超时')
}

function writeRcloneConf() {
  mkdirSync(dirname(CONF), { recursive: true })
  writeFileSync(CONF, `[wps]\ntype = webdav\nurl = http://127.0.0.1:${PORT}/\nvendor = other\n`)
}

function runRclone(cmdArgs) {
  const full = ['--config', CONF, ...cmdArgs]
  log(`rclone ${cmdArgs.join(' ')}`)
  const r = spawnSync(RCLONE, full, { encoding: 'utf8', windowsHide: true, cwd: ROOT })
  if (r.stdout) log(r.stdout.trim().split('\n').slice(-6).join(' | '))
  if (r.status !== 0 && r.stderr) log(`STDERR: ${r.stderr.trim().slice(0, 500)}`)
  return r.status === 0
}

/**
 * 比对模式（关键：云端 mtime 是“上传时间”，本地 mtime 是“修改时间”，二者相差数天，
 * 直接用 --update 会导致每轮全量重传 170G）。
 *   size-only（默认）：只看大小，安全、零重传；代价：内容变但大小不变的文件不触发同步
 *   update          ：按 mtime 判定（仅在你已确认两端 mtime 语义一致时使用）
 */
function modeArgs() {
  const mode = cfg.syncMode || 'size-only'
  if (mode === 'update') return ['--update']
  return ['--size-only']
}

function excludeArgs() {
  const ex = cfg.exclude || []
  return ex.flatMap((p) => ['--exclude', p])
}

async function main() {
  await ensureSid()
  const child = ensureDav()
  writeRcloneConf()
  if (SERVE_ONLY) return

  const flag = DRY ? ['--dry-run'] : []
  let failures = 0
  for (const pair of (cfg.pairs || []).filter((p) => p.enabled)) {
    log(`=== ${pair.name} ===`)
    const remote = `wps:${pair.cloudPath}`
    const okDown = runRclone(['copy', remote, pair.localDir, ...modeArgs(), '-v', ...flag, ...excludeArgs()])
    const okUp = runRclone(['copy', pair.localDir, remote, ...modeArgs(), '-v', ...flag, ...excludeArgs()])
    log(`结果：下行 ${okDown ? 'OK' : 'FAIL'} / 上行 ${okUp ? 'OK' : 'FAIL'}${(!okDown || !okUp) ? '（若为配额问题见 README 限制章节）' : ''}`)
    if (!okDown || !okUp) failures += 1
  }
  if (child) { try { child.kill() } catch { /* ignore */ } }
  log(`同步结束，失败 ${failures} 项`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { log(`异常：${e.message}`); process.exit(1) })
