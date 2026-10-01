#!/usr/bin/env node
/**
 * sync2.mjs — 基于快照的同步器（M3）
 *
 *   node src/sync2.mjs --build          建库：遍历云端 pair 目录 + 扫本地 → 写快照与删除台账
 *   node src/sync2.mjs --plan           只算计划（本地侧），不传输
 *   node src/sync2.mjs --once           执行：本地变更 → 覆盖/新建上传到云端
 *   node src/sync2.mjs --check          云端核对：重列云端，报告云端新增/变更/消失（不自动下载）
 *   node src/sync2.mjs --download       把云端核对出的新增/变更下载到本地
 *   node src/sync2.mjs --cloudsync      云端 → 本地：核对并直接下载（可 --path 限定子树；daemon 周期调用）
 *   node src/sync2.mjs --deletions      打印待处理的删除台账
 *
 * 设计要点（来自实测）：
 *   - 日常改动走 --once：本地扫描 3.2 秒（5.2 万文件），只哈希变更候选，
 *     覆盖上传直接用快照里的云端 file_id，**不需要列云端目录**
 *   - 云端核对（--check）必须遍历目录：实测云端 folder mtime 不随子项冒泡、
 *     无 delta 接口（/api/v5/roaming 是客户端漫游记录，不是变更日志），
 *     所以只能按配置的 pair 范围全量列，靠降低频率控制成本
 *   - 删除只记台账，两端都不自动删
 */

import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync, renameSync, appendFileSync } from 'node:fs'
import { readdirSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, relative, sep, resolve, isAbsolute, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDrive, hashFile } from './core/webdrive.mjs'
import {
  loadState, saveState, recordDeletion, pendingDeletions,
  loadDeletions, saveDeletions, setDeletionStatus,
} from './state.mjs'
import { acquireSyncLock } from './sync-lock.mjs'
import { loadScanAnomalies, saveScanAnomalies, classifyScanAnomalies, DEFAULT_GRACE_MS } from './scan-anomalies.mjs'

/* ---------------- 文件日志：把引擎输出同时落盘 ---------------- */
/**
 * 原来日志只通过 stdout 流给界面「传输」页，关窗即丢，config.json 里的 logFile 是死配置。
 * 这里把 console.* 同时写一份到 <用户数据目录>/data/sync.log，可 tail -f 实时看。
 * 超过 8MB 自动滚成 sync.log.1（只留一份，避免日志撑爆磁盘）。
 */
const LOG_FILE = join(
  process.env.WPS_SYNC_USER_ROOT
    || (() => {
      const engineRoot = dirname(dirname(fileURLToPath(import.meta.url)))
      const programRoot = dirname(dirname(engineRoot))
      return existsSync(join(programRoot, 'config.json')) ? programRoot : engineRoot
    })(),
  'data', 'sync.log'
)
try {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 8 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`)
} catch { /* 日志不可写绝不能影响同步 */ }
const teeWrite = (to, a) => {
  const line = a
    .map((v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()))
    .join(' ') + '\n'
  try { appendFileSync(LOG_FILE, line) } catch { /* ignore */ }
  to(line)
}
console.log = (...a) => teeWrite((s) => process.stdout.write(s), a)
console.info = (...a) => teeWrite((s) => process.stdout.write(s), a)
console.error = (...a) => teeWrite((s) => process.stderr.write(s), a)
console.warn = (...a) => teeWrite((s) => process.stderr.write(s), a)

const ENGINE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * 打包结构固定为 <root>/resources/engine。调用方即使漏传环境变量，也优先回到程序根；
 * 绝不能误用 engine/data 下的空快照（会把 5 万文件当成新文件重传）。
 */
const PROGRAM_ROOT = dirname(dirname(ENGINE_ROOT))
const ROOT = process.env.WPS_SYNC_USER_ROOT
  || (existsSync(join(PROGRAM_ROOT, 'config.json')) ? PROGRAM_ROOT : ENGINE_ROOT)
const args = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const SID = JSON.parse(readFileSync(join(ROOT, 'data', 'auth.json'), 'utf8')).sid
/**
 * 云端遍历的并发数与请求速率：默认保守值，避免把一次全树核对变成限流风暴。
 * 配置可以调低，但不建议在生产现场调高；真正的 HTTP 级调度仍待后续 rclone/WebDAV 迁移。
 */
const CONCURRENCY = Math.max(1, Math.min(8, Number(cfg.sync?.concurrency) || 4))
const MAX_QPS = Math.max(1, Math.min(12, Number(cfg.sync?.maxQps) || 8))
/** list 的总条目安全上限；webdrive.list 内部以 200 条/页用 offset 翻页。 */
const LIST_COUNT = Math.max(200, Math.min(10000, Number(cfg.sync?.listCount) || 2000))
/** 单轮云端拉取最多下载多少个文件（安全阀：防止一次拉爆带宽/磁盘，剩下的下一轮继续）。 */
const PULL_MAX_FILES = Math.max(1, Math.min(1000, Number(cfg.sync?.cloudPullMaxFiles) || 300))
/** 单轮云端拉取最多下载多少 MB。 */
const PULL_MAX_MB = Math.max(1, Math.min(10240, Number(cfg.sync?.cloudPullMaxMB) || 2048))
const PAIRS = (cfg.pairs || []).filter((p) => p.enabled)
/**
 * 兼容开关：true 时不判定已入快照文件的消失；false 时恢复删除台账。
 * 当前产品优先级是「记录删除、由用户确认两端删除」，因此生产配置必须显式为 false。
 * 仅保留此开关用于故障降级，不能再把它当默认业务模式。
 */
const IGNORE_OLD = cfg.sync?.ignoreOldFiles === true

/**
 * 「本地扫描读不到」的路径记录：用来区分"新出现的异常（值得重试）"和
 * "已经持续很久的异常（重试也不会好，只跳过）"。判定细节见 scan-anomalies.mjs。
 */
const SCAN_ANOMALY_FILE = join(ROOT, 'data', 'scan-anomalies.json')

/** 把一次扫描的异常路径转成跨轮可比较的 key（带 pair 前缀，避免不同 pair 的相对路径撞车）。 */
function anomalyKeysOf(pair, local) {
  return (local.errors || []).map(
    (e) => `${pair.name}\u0000${relative(pair.localDir, e.path).split(sep).join('/')}`,
  )
}

// 本地时间（原来用 toISOString 是 UTC，会比本地时间少 8 小时，容易看懵）
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`)

/** config.exclude 的 glob（只支持 * 通配）→ 正则，按 basename 匹配。 */
function makeExcluder(patterns) {
  const res = (patterns || []).map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'))
  return (name) => res.some((r) => r.test(name))
}
const isExcluded = makeExcluder(cfg.exclude)
/**
 * 路径级排除：相对路径的**任意一段**命中规则即跳过。
 * 必须要有这一层——某些第三方同步客户端（NAS 客户端等）会把索引库放在同步根的
 * 隐藏目录里（如 `.sync_temp_dir/state/*.sqlite`），每几秒改写一次；只按 basename 匹配挡不住，
 * 会导致该文件被反复上传（实测：4MB / 20 秒一轮，无限循环）。
 */
const isExcludedRel = (rel) => String(rel).split('/').some((seg) => isExcluded(seg))
/** --download：核对后把云端新增/变更同步到本地；--startup：启动一站式（核对 + 同步到本地） */
const DO_DOWNLOAD = args.includes('--download') || args.includes('--startup')

/* ---------------- 云端遍历（限速 + 429 重试 + 失败补列） ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 全局限速器：保证请求间隔 >= 1000/qps 毫秒。
 * 实测：并发 8 ≈ 22 次/秒时开始出现 429（约 10% 的目录被拒）。
 * 所以必须全局限速，光靠控制并发数不够。
 */
/** GET/list 的统一退避：429、超时、临时网络和 5xx 可重试；认证/业务错误立即抛。 */
async function listRetry(wd, id, count = LIST_COUNT, tries = 5) {
  let last
  for (let i = 0; i < tries; i += 1) {
    try {
      return await wd.list(id, { count })
    } catch (err) {
      last = err
      if (!err?.retryable) throw err
      const backoff = Math.min(30000, 1000 * 2 ** i) + Math.floor(Math.random() * 500)
      await sleep(Math.max(Number(err.retryAfterMs) || 0, backoff))
    }
  }
  throw last
}

/**
 * 并发 BFS 遍历云端目录树。失败的目录会在后续轮次以更低速率补列（最多 3 轮）。
 * @returns {Promise<{dirs:number, errors:string[]}>}
 */
async function walkCloud(wd, rootId, out, { concurrency = CONCURRENCY, rootPrefix = '' } = {}) {
  let queue = [{ id: rootId, prefix: rootPrefix }]
  const errors = [] // 历史尝试错误，仅用于诊断
  const unresolvedById = new Map() // 最终仍失败/截断的目录，才决定本轮是否完整
  let dirs = 0
  const started = Date.now()
  let lastReport = 0
  // 全量核对要跑十几分钟（8449 目录 / 限速 8/s），必须给进度，否则看起来像卡死
  const report = () => {
    const sec = (Date.now() - started) / 1000
    log(`  …已列 ${dirs} 目录 / ${out.size} 文件，${sec.toFixed(0)}s`)
  }
  for (let pass = 0; pass < 3 && queue.length; pass += 1) {
    const workers = Math.max(1, Math.floor(concurrency / (pass + 1)))
    const failed = []
    const run = async () => {
      while (queue.length) {
        const job = queue.shift()
        if (!job) return
        // HTTP 级限速由 WebDrive.req() 统一执行；这里不再对“目录任务”重复限速。
        let items
        try {
          items = await listRetry(wd, job.id, LIST_COUNT)
          // webdrive.list 已内建 offset 翻页（服务端单次硬截 200 条），正常不该撞上限；
          // 一旦 truncated 说明这个目录真的超过 LIST_COUNT 条，绝不能静默漏
          if (items.truncated) {
            const msg = `${job.prefix || '/'}: 目录清单不完整（${items.incompleteReason || `超过上限 ${LIST_COUNT}`}）`
            unresolvedById.set(job.id, { ...job, error: msg })
            errors.push(msg)
            log(`  ! ${msg}`)
          } else {
            unresolvedById.delete(job.id) // 前一轮失败、这一轮成功：从最终未解决集合移除
          }
        } catch (err) {
          failed.push(job)
          const msg = `${job.prefix || '/'}: ${err.message.slice(0, 100)}`
          unresolvedById.set(job.id, { ...job, error: msg })
          errors.push(msg)
          continue
        }
        dirs += 1
        for (const it of items) {
          const safeName = validateCloudSegment(it.name)
          const rel = job.prefix ? `${job.prefix}/${safeName}` : safeName
          if (it.isFolder) queue.push({ id: it.id, prefix: rel })
          else out.set(rel, { id: it.id, size: it.size, sha1: it.sha1, mtime: it.mtime })
        }
        if (dirs - lastReport >= 200) { lastReport = dirs; report() }
      }
    }
    await Promise.all(Array.from({ length: workers }, run))
    queue = failed
    if (failed.length) log(`  第 ${pass + 1} 轮后仍有 ${failed.length} 个目录未列出，降速重试`)
  }
  return { dirs, errors, unresolved: [...unresolvedById.values()] }
}

/* ---------------- 本地扫描 ---------------- */

/**
 * 本地目录扫描 → Map<相对路径, {abs, size, mtimeMs}>
 *
 * ⚠ Windows 上必须处理「类型不明的目录项」：
 * readdir(withFileTypes) 的 Dirent 对**非标准 reparse point** 会同时给出
 * isDirectory()=false 且 isFile()=false。实测：第三方同步客户端会给它纳管的目录
 * 打上自定义 reparse tag（数据段带产品标识），
 * 于是整棵子树被静默跳过 ——
 * 后果是新增文件永远传不上去（监听报了变更，引擎却「待上传 0」），
 * 存量文件还会被误判成「本地消失」写进删除台账（实测误报数千条）。
 * 所以类型不明时用 stat 复核；是目录就继续下钻，并用 realpath 去重防止软链成环。
 */
function scanLocal(dir, out = new Map()) {
  const base = dir // 相对路径必须始终相对根，递归时不能拿当前子目录当基准
  const seenDir = new Set()
  const errors = []
  let baseReal = base
  try { baseReal = realpathSync.native ? realpathSync.native(base) : realpathSync(base) } catch (err) {
    errors.push({ path: base, error: err.message })
  }
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const rootNorm = norm(baseReal)
  const insideRoot = (p) => {
    const n = norm(p)
    return n === rootNorm || n.startsWith(`${rootNorm}/`)
  }
  const walk = (d) => {
    let real = d
    try { real = realpathSync.native ? realpathSync.native(d) : realpathSync(d) } catch (err) {
      errors.push({ path: d, error: err.message })
      return
    }
    if (!insideRoot(real)) {
      errors.push({ path: d, error: `reparse target escapes sync root: ${real}` })
      return
    }
    if (seenDir.has(norm(real))) {
      errors.push({ path: d, error: '重复真实目录或目录环，本轮保留该子树快照' })
      return
    } // 防环时也必须保护被跳过的路径
    seenDir.add(norm(real))
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch (err) {
      errors.push({ path: d, error: err.message })
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      // 排除规则对目录和文件同一套（.sync_temp_dir / .git 等整棵子树不进）
      if (isExcluded(e.name)) continue
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (!isDir && !isFile) {
        // 类型不明：reparse point / 自定义 tag / 不报 DT_* 的网络文件系统 → stat 复核
        let s
        try { s = statSync(p) } catch (err) { errors.push({ path: p, error: err.message }); continue }
        isDir = s.isDirectory()
        isFile = s.isFile()
      }
      if (isDir) { walk(p); continue }
      if (!isFile) continue
      try {
        const s = statSync(p)
        out.set(relative(base, p).split(sep).join('/'), { abs: p, size: s.size, mtimeMs: Math.floor(s.mtimeMs) })
      } catch (err) { errors.push({ path: p, error: err.message }) }
    }
  }
  walk(dir)
  // 带 reparse 标记的目录（junction / 云盘挂载）会被正常下钻，属预期行为，不再打印 ——
  // 真正下钻失败会走上面的 errors → 计入「扫描异常」，那条才值得报。
  Object.defineProperty(out, 'errors', { value: errors, enumerable: false })
  const blocked = new Set(errors.map((e) => norm(relative(base, e.path))))
  const isBlocked = (rel) => {
    let p = norm(rel)
    for (;;) {
      if (blocked.has(p)) return true
      const slash = p.lastIndexOf('/')
      if (slash < 0) return blocked.has('')
      p = p.slice(0, slash)
    }
  }
  Object.defineProperty(out, 'rootFailed', { value: blocked.has(''), enumerable: false })
  Object.defineProperty(out, 'isBlocked', { value: isBlocked, enumerable: false })
  Object.defineProperty(out, 'complete', { value: errors.length === 0, enumerable: false })
  return out
}

/* ---------------- 各命令 ---------------- */

/**
 * 从云端清单里剔除排除项。
 * 早期版本在排除列表生效前，把 CAD 的锁文件（.dwl/.dwl2）与缓存（.cdc）误传到了云端；
 * 若不过滤，--check 会把它们当成"云端新增"再次同步回本地。
 * @returns 被剔除的条数
 */
function pruneCloudExcluded(cloud) {
  let n = 0
  for (const rel of [...cloud.keys()]) {
    if (isExcludedRel(rel)) { cloud.delete(rel); n += 1 }
  }
  return n
}

/** 云端名称/相对路径都视为不可信；落盘前必须确保仍在同步根内。 */
function validateCloudSegment(name) {
  const s = String(name || '')
  const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
  if (!s || s === '.' || s === '..' || /[\\/\0:]/.test(s) || /[. ]$/.test(s) || device.test(s)) {
    throw new Error(`云端条目名称不安全：${JSON.stringify(s)}`)
  }
  return s
}

function normalizeCloudSubpath(value) {
  const raw = String(value || '')
  if (!raw) return ''
  return raw.split('/').map(validateCloudSegment).join('/')
}

function workingPair(state, pair) {
  const old = state.pairs?.[pair.name]
  const ps = old ? structuredClone(old) : { builtAt: 0, cloudCheckedAt: 0, files: {} }
  ps.cloudPath = pair.cloudPath
  ps.localDir = pair.localDir
  ps.files = ps.files || {}
  return ps
}

function commitPair(state, pair, ps) {
  state.pairs = state.pairs || {}
  state.pairs[pair.name] = ps
}

function safeLocalPath(root, rel) {
  const parts = String(rel || '').split('/')
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || /[\\/\0]/.test(p))) {
    throw new Error(`不安全的相对路径：${rel}`)
  }
  const base = resolve(root)
  const target = resolve(base, ...parts)
  const back = relative(base, target)
  if (!back || isAbsolute(back) || back === '..' || back.startsWith(`..${sep}`)) {
    throw new Error(`路径超出同步根目录：${rel}`)
  }
  // 父目录若已存在，必须解析真实路径，防止 junction/reparse 把下载导向同步根外。
  let probe = dirname(target)
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe)
  const realRoot = realpathSync.native ? realpathSync.native(base) : realpathSync(base)
  const realParent = realpathSync.native ? realpathSync.native(probe) : realpathSync(probe)
  const realBack = relative(realRoot, realParent)
  if (isAbsolute(realBack) || realBack === '..' || realBack.startsWith(`..${sep}`)) {
    throw new Error(`真实父路径经 reparse point 越出同步根目录：${rel}`)
  }
  return target
}

/** 所有需要完整目录语义的调用统一走这里，禁止调用方不小心丢掉 truncated 标志。 */
async function listComplete(wd, parentId, count = LIST_COUNT) {
  const items = await listRetry(wd, parentId, count)
  if (items.truncated) {
    throw new Error(`云端目录清单不完整（${items.incompleteReason || 'unknown'}）`)
  }
  return items
}

async function build(wd) {
  const state = loadState()
  let incomplete = 0
  for (const pair of PAIRS) {
    log(`=== 建库：${pair.name} ===`)
    const ps = workingPair(state, pair)
    const rootId = await wd.resolvePath(pair.cloudPath)
    log(`云端根 id=${rootId}`)
    const cloud = new Map()
    const t0 = Date.now()
    const { dirs, unresolved } = await walkCloud(wd, rootId, cloud)
    const skipped = pruneCloudExcluded(cloud)
    log(`云端遍历完成：${dirs} 目录 / ${cloud.size} 文件，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，最终未解决 ${unresolved.length}`)
    if (skipped) log(`  忽略排除项 ${skipped} 个（CAD 锁文件 .dwl/.dwl2/.cdc 等，不参与同步）`)
    if (unresolved.length) log(`  未解决目录样例：${unresolved.slice(0, 3).map((x) => x.prefix || '/').join(' | ')}`)

    const local = scanLocal(pair.localDir)
    log(`本地扫描：${local.size} 文件${local.complete ? '' : `，错误 ${local.errors.length}`}`)

    if (!local.complete) {
      incomplete += 1
      log(`拒绝建库提交：本地扫描不完整（${local.errors.slice(0, 3).map((x) => x.path).join(' | ')}），保留原快照与删除台账`)
      continue
    }
    if (unresolved.length) {
      incomplete += 1
      log(`拒绝建库提交：仍有 ${unresolved.length} 个云端目录未完整列出，保留原快照与删除台账`)
      continue
    }
    const before = ps.files
    const nextFiles = {}
    let hashed = 0
    let both = 0
    for (const [rel, c] of cloud) {
      const l = local.get(rel)
      const entry = {
        id: c.id, size: c.size, sha1: c.sha1, mtime: c.mtime,
        localSize: l ? l.size : 0,
        localMtimeMs: l ? l.mtimeMs : 0,
        localSha1: '',
        syncedAt: 0,
        syncedSha1: '',
      }
      if (l && l.size === c.size) {
        // 两侧大小一致才算哈希，建立"已一致"基线
        const h = await hashFile(l.abs, { md5: false })
        entry.localSha1 = h.sha1
        hashed += 1
        if (h.sha1 === c.sha1) {
          entry.syncedAt = Date.now()
          entry.syncedSha1 = h.sha1
          both += 1
        }
      }
      // 只有两端逐字节一致，才把本地 size/mtime 写成“已处理基线”。
      // 已知不一致时保持 0，让下一次 --once / --cloudsync 必然重新处理，不能冻结差异。
      if (!entry.syncedSha1) {
        entry.localSize = 0
        entry.localMtimeMs = 0
      }
      nextFiles[rel] = entry
    }
    ps.files = nextFiles
    // 云端没有、本地有 → 待上传（不建云端条目，等 --once 处理）
    ps.builtAt = Date.now()
    ps.cloudCheckedAt = Date.now()

    // 删除台账：快照里有过，现在某一端没了
    let recLocal = 0
    let recCloud = 0
    for (const [rel, old] of Object.entries(before)) {
      // 排除列表里的文件不参与同步，不能算"消失"（典型：CAD 锁文件 .dwl/.dwl2/.cdc）
      if (isExcludedRel(rel)) continue
      if (!cloud.has(rel) && !local.has(rel)) {
        continue // 两端都已不存在，直接出库，不制造无意义待办
      } else if (!cloud.has(rel) && old.id) {
        recordDeletion(pair.name, rel, 'cloud', {
          size: old.size,
          fileId: old.id,
          expectedName: baseOf(rel),
          expectedCloudSha1: old.sha1 || '',
          expectedLocalSha1: old.localSha1 || old.syncedSha1 || '',
        })
        recCloud += 1
      } else if (!local.has(rel) && old.localSize) {
        recordDeletion(pair.name, rel, 'local', {
          size: old.localSize,
          fileId: old.id,
          expectedName: baseOf(rel),
          expectedCloudSha1: old.sha1 || '',
          expectedLocalSha1: old.localSha1 || old.syncedSha1 || '',
        })
        recLocal += 1
      }
    }
    commitPair(state, pair, ps)
    log(`建库结果：云端 ${cloud.size} / 本地 ${local.size} / 哈希 ${hashed} / 已一致 ${both}`)
    log(`删除台账新增：云端缺失 ${recCloud}，本地缺失 ${recLocal}`)
  }
  saveState(state)
  log(`快照已写入 data/state.json`)
  if (incomplete) throw new Error(`${incomplete} 个同步目录建库不完整，未提交对应快照；请修复后重试`)
}

async function plan(wd) {
  const state = loadState()
  for (const pair of PAIRS) {
    const ps = workingPair(state, pair)
    const local = scanLocal(pair.localDir)
    const uploads = []
    const unchanged = []
    const cloudOnly = []
    for (const [rel, l] of local) {
      const s = ps.files[rel]
      if (!s || !s.id) { uploads.push({ rel, abs: l.abs, size: l.size, reason: s ? '云端无此文件' : '新文件' }); continue }
      if (s.localSize === l.size && s.localMtimeMs === l.mtimeMs) { unchanged.push(rel); continue }
      const h = await hashFile(l.abs, { md5: false })
      if (h.sha1 === s.syncedSha1) { unchanged.push(rel); continue }
      uploads.push({ rel, abs: l.abs, size: l.size, sha1: h.sha1, fileId: s.id, reason: '本地已变更' })
    }
    for (const rel of Object.keys(ps.files)) if (!local.has(rel)) cloudOnly.push(rel)
    log(`待上传 ${uploads.length} 个 · 未变 ${unchanged.length} · 云端独有 ${cloudOnly.length}`)
    for (const u of uploads.slice(0, 20)) log(`  ↑ ${u.rel}（${(u.size / 1024 / 1024).toFixed(2)}MB）`)
    if (uploads.length > 20) log(`  …还有 ${uploads.length - 20} 个`)
  }
}

/** 上传冲突副本名：xxx.dwg → xxx (本地冲突 <sha前缀>).dwg，固定名保证幂等。 */
function localVersionName(p, sha1) {
  const slash = p.lastIndexOf('/')
  const dot = p.lastIndexOf('.')
  const tag = String(sha1 || 'unknown').slice(0, 10)
  return dot > slash ? `${p.slice(0, dot)} (本地冲突 ${tag})${p.slice(dot)}` : `${p} (本地冲突 ${tag})`
}

const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1)
const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')))

/** 云端路径：pair.cloudPath + 某个相对目录 */
const cloudDirOf = (pair, rel) => {
  const d = dirOf(rel)
  return d ? `${pair.cloudPath}/${d}` : pair.cloudPath
}

function assertLocalStable(it) {
  const st = statSync(it.abs)
  if (st.size !== it.size || Math.floor(st.mtimeMs) !== it.mtimeMs) {
    throw new Error('扫描后文件再次变化，保留原基线并等待下轮重试')
  }
}

async function once(wd) {
  const state = loadState({ strict: true })
  // 根目录不可读或对应快照缺失时，在任何上行/台账写入前停止。
  const scans = new Map()
  const anomalyKeys = []
  for (const pair of PAIRS) {
    if (!state.pairs[pair.name]) throw new Error(`${pair.name}：缺少对应快照，停止上行`)
    const local = scanLocal(pair.localDir)
    if (local.rootFailed) throw new Error(`${pair.name}：同步根不可访问，拒绝上传/删除判断，保留全部快照`)
    scans.set(pair.name, local)
    anomalyKeys.push(...anomalyKeysOf(pair, local))
  }
  let transferFailures = 0
  for (const pair of PAIRS) {
    const ps = workingPair(state, pair)
    const local = scans.get(pair.name)
    const failuresBefore = transferFailures
    let frozen = 0
    let protectedFiles = 0
    let unchanged = 0 // 未变文件数：仅内部统计（曾打印为「未变 51562」，纯噪音，不再显示）
    let ok = 0
    let conflicts = 0
    let sameSkipped = 0
    if (!local.complete) {
      log(`本地扫描异常 ${local.errors.length} 处：仅跳过异常文件/子树并保留快照，其余继续`)
    }
    // 面向用户的汇总：只报「做了什么 / 出了什么问题」，零值项不占位。
    // 传 ratio（`成功/计划`）表示本轮有待上传文件；不传表示无待上传。
    const report = (ratio) => {
      const fail = transferFailures - failuresBefore
      const skipped = protectedFiles + frozen + sameSkipped
      const parts = [ratio ? `上传 ${ratio}` : '无待上传']
      if (conflicts) parts.push(`冲突另存 ${conflicts}`)
      if (fail) parts.push(`失败 ${fail}`)
      if (skipped) parts.push(`跳过 ${skipped}`)
      if (local.errors.length) parts.push(`扫描异常 ${local.errors.length}`)
      log(`本轮：${parts.join(' · ')}`)
    }

    // 台账自愈：曾经记过「本地消失」的文件又回到本地了 → 撤销那条待办。
    // 必须做：一是扫描漏扫修好后存量误报要自动清掉，二是用户把文件从回收站还原时也不该再挂着
    // 「等你确认删除」。不撤销的危害是用户在界面上点「确认删除」，把云端好文件删了。
    // 一次性批量改（setDeletionStatus 每条都要重写整个 deletions.json，2534 条会很慢）。
    const backRels = new Set()
    for (const it of pendingDeletions()) {
      if (it.pair !== pair.name || it.side !== 'local') continue
      const l = local.get(it.relPath)
      if (!l) continue
      const s = ps.files[it.relPath] || {}
      // 同路径重新出现不代表原文件还原。必须与删除前/已同步基线 SHA 一致才自动撤销。
      const expected = new Set([s.localSha1, s.syncedSha1, s.sha1].filter(Boolean))
      if (!expected.size) continue
      try {
        const h = await hashFile(l.abs, { md5: false })
        if (expected.has(h.sha1)) backRels.add(it.key)
      } catch { transferFailures += 1 /* 读不到内容就继续冻结，不能冒险解冻 */ }
    }
    if (backRels.size) {
      const d = loadDeletions()
      let n = 0
      for (const it of d.items) {
        if (it.status !== 'pending' || !backRels.has(it.key)) continue
        it.status = 'ignored'
        it.handledAt = Date.now()
        it.note = '文件已回到本地，自动撤销待办'
        n += 1
      }
      saveDeletions(d)
      log(`台账自愈：${n} 条「本地消失」记录的文件已回到本地，自动撤销待办`)
    }

    const pendingKeys = new Set(
      pendingDeletions()
        .filter((it) => it.pair === pair.name)
        .map((it) => it.relPath),
    )
    const news = []      // 快照里没有云端条目（可能是重命名的新名字，也可能是真新增）
    const list = []      // 有云端 id 的内容变更
    let touched = 0      // mtime 变了但内容没变（典型：WPS 官方客户端重写同目录文件）
    for (const [rel, l] of local) {
      if (pendingKeys.has(rel)) { frozen += 1; continue } // 删除待确认期间冻结该路径，禁止上传把删除“复活”
      const s = ps.files[rel]
      if (!s || s.localSize !== l.size || s.localMtimeMs !== l.mtimeMs) {
        let h
        try {
          h = await hashFile(l.abs)
          assertLocalStable(l)
        } catch (err) {
          transferFailures += 1
          log(`  ! 哈希失败 ${rel}: ${err.message.slice(0, 120)}；保留原基线`)
          continue
        }
        if (s && h.sha1 === s.syncedSha1) {
          // 内容其实没变，只是时间戳被改写了 → 刷新快照记录，
          // 否则每轮同步都会把这批文件重新哈希一遍（实测曾累积到 100+ 个）
          s.localSize = l.size
          s.localMtimeMs = l.mtimeMs
          touched += 1
          continue
        }
        const item = {
          rel, abs: l.abs, size: l.size, mtimeMs: l.mtimeMs, sha1: h.sha1,
          fileId: s?.id || '', snapSha1: s?.sha1 || '', conflictPending: s?.conflictPending === true,
          conflictLocalSha1: s?.conflictLocalSha1 || '', conflictCloudSha1: s?.conflictCloudSha1 || '',
        }
        if (!s || !s.id) news.push(item)
        else list.push(item)
      } else { unchanged += 1 }
    }
    if (touched) log(`内容未变、仅时间戳变动 ${touched} 个，已跳过上传`)

    // 不再自动猜测重命名：新路径按新增上传，旧路径进入删除台账，由用户批量确认。
    // 这样不会因为同 SHA 候选、跨目录移动或中途失败破坏快照，也符合“监视上传 + 手动删除优先”。
    list.push(...news)

    // 本地缺失检测：快照里有、本地已不在 → 判定"本地删除"。
    // 以前只有 --check 才做这件事，导致监听自动跑 --once 时删除日志永远是空的。
    // --once 不遍历云端，所以按父目录**定向**查一次，区分两种情况：
    //   云端仍在   → 记台账，等你确认（默认不自动删云端）
    //   云端也没了 → 两端一致删除，直接从快照出库，不打扰你
    const goneCand = []
    let prunedExcluded = 0
    let ignoredOld = 0
    for (const [rel, s] of Object.entries(ps.files)) {
      if (local.isBlocked(rel)) { protectedFiles += 1; continue }
      if (pendingKeys.has(rel)) continue
      if (!s.localSize || !s.id) continue
      if (local.has(rel)) continue
      // 排除列表里的文件本来就不参与同步，快照里若残留这类条目（早期版本把 CAD 锁文件
      // .dwl/.dwl2/.cdc 一类误传上去了），直接出库，绝不能当成"本地删除"
      // —— 这一条与 ignoreOldFiles 无关，任何模式下都要做
      if (isExcludedRel(rel)) { delete ps.files[rel]; prunedExcluded += 1; continue }
      // ignoreOldFiles：老文件的"消失"一概不问。快照条目必须**保留**：
      // 一旦出库，下次云端核对会把它当成「云端新增」又下载回来，等于把删掉的文件请回来
      if (IGNORE_OLD) { ignoredOld += 1; continue }
      goneCand.push(rel)
    }
    if (prunedExcluded) log(`清理已排除目录的残留记录 ${prunedExcluded} 个`)
    if (ignoredOld) log(`本地消失 ${ignoredOld} 个：ignoreOldFiles=true，按约定不判定、不记台账（快照条目保留）`)
    if (goneCand.length) {
      const byGoneDir = new Map()
      for (const rel of goneCand) {
        const d = dirOf(rel)
        if (!byGoneDir.has(d)) byGoneDir.set(d, [])
        byGoneDir.get(d).push(rel)
      }
      let rec = 0
      let out = 0
      let unknown = 0
      const recNames = []
      // 这段以前没有任何限速和重试，一次要对 2600+ 个"消失"文件做云端核对，
      // 429/超时几乎必然发生（引擎自己的注释就写着建库时 798 个目录被 429 拒过）
      for (const [, rels] of byGoneDir) {
        let names
        try {
          const pid = await wd.resolvePath(cloudDirOf(pair, rels[0]))
          names = new Set((await listComplete(wd, pid)).map((f) => f.name))
        } catch (err) {
          // ⚠ 这里以前是 `catch { names = new Set() }`，把「查询失败」当成「云端也没了」，
          // 于是快照条目被直接出库；下一轮文件重新可见却"没记录"，被当成新文件上传，
          // 云端同名就被覆盖 —— 今天 278 个文件被无保护覆盖重传 3GB 正是这条路径。
          // 现在只有「目录确实不存在」才算两端都没了；其余（429/超时/网络）一律
          // 保留快照、记为未知、下一轮再判。宁可多查几轮，也不能丢记录。
          if (/云端目录不存在/.test(err.message)) {
            names = new Set()
          } else {
            unknown += rels.length
            transferFailures += rels.length
            continue
          }
        }
        for (const rel of rels) {
          if (names.has(baseOf(rel))) {
            recordDeletion(pair.name, rel, 'local', {
              size: ps.files[rel].localSize,
              fileId: ps.files[rel].id,
              expectedName: baseOf(rel),
              expectedCloudSha1: ps.files[rel].sha1 || '',
              expectedLocalSha1: ps.files[rel].localSha1 || ps.files[rel].syncedSha1 || '',
            })
            recNames.push(rel)
            rec += 1
          } else {
            delete ps.files[rel]
            out += 1
          }
        }
      }
      if (out) log(`两端均已删除 ${out} 个，已从快照移除`)
      if (unknown) log(`云端核对失败待下轮重判 ${unknown} 个（已保留快照记录，未做任何删除）`)
      if (rec) {
        // 必须列出文件名，否则用户只看到一条计数，根本不知道丢的是哪个文件
        log(`本地消失但云端仍在 ${rec} 个（已记台账，等你确认）：`)
        for (const r of recNames.slice(0, 10)) log(`  - ${r}`)
        if (recNames.length > 10) log(`  …还有 ${recNames.length - 10} 个`)
      }
    }

    log(`${PAIRS.length > 1 ? `${pair.name}：` : ''}待上传 ${list.length} 个`)
    if (!list.length) { report(); commitPair(state, pair, ps); continue }

    // 按父目录分组：每个目录只列一次，拿到云端当前的 sha1
    const byDir = new Map()
    for (const it of list) {
      const segs = it.rel.split('/')
      const dirRel = segs.length > 1 ? segs.slice(0, -1).join('/') : ''
      if (!byDir.has(dirRel)) byDir.set(dirRel, [])
      byDir.get(dirRel).push(it)
    }

    for (const [dirRel, arr] of byDir) {
      let parentId
      try {
        parentId = await wd.resolvePath(dirRel ? `${pair.cloudPath}/${dirRel}` : pair.cloudPath, { create: true })
      } catch (err) {
        transferFailures += arr.length
        for (const it of arr) log(`  ✗ ${it.rel}: 无法定位云端目录 ${err.message.slice(0, 80)}`)
        continue
      }
      let cloudMap = new Map()
      try {
        cloudMap = new Map((await listComplete(wd, parentId)).map((f) => [f.name, f]))
      } catch (err) {
        // 列目录失败 → 拿不到云端同名文件，后面的覆盖保护会失效。
        // 为安全起见整组跳过（下一轮再传），绝不在"看不见云端"的情况下写上去。
        transferFailures += arr.length
        for (const it of arr) log(`  ✗ ${it.rel}: 云端目录无法列出（${err.message.slice(0, 80)}），本轮跳过以免误覆盖`)
        continue
      }

      for (const it of arr) {
        const name = it.rel.split('/').pop()
        const cur = cloudMap.get(name)
        try {
          assertLocalStable(it)
          // ① 云端同名且内容与本地逐字节一致 → 根本没有要传的东西：
          //    补写快照后跳过（快照记录曾被误删时就走这条，避免"内容没变却全量重传"）。
          if (cur?.sha1 && it.sha1 && cur.sha1 === it.sha1) {
            ps.files[it.rel] = {
              id: cur.id, size: cur.size, sha1: cur.sha1, mtime: cur.mtime,
              localSize: it.size, localMtimeMs: it.mtimeMs,
              localSha1: it.sha1, syncedAt: Date.now(), syncedSha1: cur.sha1,
              conflictPending: false, conflictLocalSha1: '', conflictCloudSha1: '',
            }
            sameSkipped += 1
            log(`  = ${it.rel}：云端内容与本地一致，跳过上传（已补写快照）`)
            continue
          }
          // ② 覆盖必须"有据"：只有确认云端当前这一版就是本地上次同步过的那一版
          //    （快照记的 sha1 == 云端当前 sha1）才允许覆盖。
          //    拿不出依据（快照无记录 / 云端 sha1 已变）→ 一律另存副本，绝不覆盖云端。
          const knownSame = Boolean(
            cur && cur.id === it.fileId && it.snapSha1 && cur.sha1 && cur.sha1 === it.snapSha1,
          )
          // conflictPending 表示上一轮已把这一本地内容另存为冲突副本；只要原云端版本仍未变化，
          // 后续轮次直接视为已处理，避免重复创建副本或再次覆盖。
          if (cur && it.conflictPending && it.conflictLocalSha1 === it.sha1 && it.conflictCloudSha1 && cur.sha1 === it.conflictCloudSha1) {
            assertLocalStable(it)
            const s = ps.files[it.rel] || {}
            ps.files[it.rel] = {
              ...s, id: cur.id, size: cur.size, sha1: cur.sha1, mtime: cur.mtime,
              localSize: it.size, localMtimeMs: it.mtimeMs, localSha1: it.sha1,
              conflictPending: true, conflictLocalSha1: it.sha1, conflictCloudSha1: cur.sha1 || '',
            }
            log(`  = ${it.rel}：本地冲突版本已另存，等待用户处理；本轮不重复上传`)
            continue
          }
          if (cur && !knownSame) {
            const altName = localVersionName(name, it.sha1)
            const existingConflict = cloudMap.get(altName)
            if (existingConflict?.sha1 === it.sha1) {
              log(`  = 冲突副本已存在 ${it.rel} →「${altName}」，本轮不重复上传`)
            } else if (existingConflict) {
              throw new Error(`冲突副本名已被其他内容占用：${altName}`)
            } else {
              const r = await wd.upload(it.abs, parentId, { name: altName })
              if (r.sha1 !== it.sha1 || r.size !== it.size) throw new Error('上传内容与扫描版本不一致，保留原基线')
            }
            assertLocalStable(it)
            ps.conflicts = ps.conflicts || []
            const conflictKey = `${it.rel}|local|${it.sha1}|${cur.sha1 || ''}`
            if (!ps.conflicts.some((x) => x.key === conflictKey)) {
              ps.conflicts.push({
                key: conflictKey, rel: it.rel, conflictFile: altName, foundAt: Date.now(),
                cloudSha1: cur.sha1, localSha1: it.sha1,
                reason: it.snapSha1 ? '云端已被其他设备修改' : '快照无该文件记录，无法确认云端版本',
              })
            }
            // 把这一本地内容记下来；以后没有新变化时不再反复哈希/生成同一冲突副本。
            const s = ps.files[it.rel] || {}
            ps.files[it.rel] = {
              ...s, id: cur.id, size: cur.size, sha1: cur.sha1, mtime: cur.mtime,
              localSize: it.size, localMtimeMs: it.mtimeMs, localSha1: it.sha1,
              conflictPending: true, conflictLocalSha1: it.sha1, conflictCloudSha1: cur.sha1 || '',
            }
            conflicts += 1
            log(`  ⚠ 冲突 ${it.rel}：${it.snapSha1 ? '云端已被其他设备修改' : '快照无记录，无法确认云端版本'}，本地内容保存在「${altName}」，未覆盖云端`)
            continue
          }
          // 当前目录里没有同名对象时，快照里的旧 fileId 可能已经被云端移动/改名。
          // 没有当前云端对象证据时，绝不能拿旧 id 做覆盖更新，也不能直接新建同名副本。
          if (it.fileId && !cur) {
            transferFailures += 1
            log(`  ! ${it.rel}：云端当前目录找不到快照 fileId=${it.fileId}，本轮跳过，避免误建副本`)
            continue
          }
          const canOverwrite = Boolean(
            cur && cur.id === it.fileId && it.snapSha1 && cur.sha1 && cur.sha1 === it.snapSha1,
          )
          const fileId = canOverwrite ? cur.id : ''
          const r = await wd.upload(it.abs, parentId, { name, fileId: fileId || undefined })
          if (r.sha1 !== it.sha1 || r.size !== it.size) throw new Error('上传内容与扫描版本不一致，保留原基线')
          assertLocalStable(it)
          ps.files[it.rel] = {
            id: r.fileId, size: r.size, sha1: r.sha1, mtime: Math.floor(Date.now() / 1000),
            localSize: it.size, localMtimeMs: it.mtimeMs, localSha1: it.sha1,
            syncedAt: Date.now(), syncedSha1: r.sha1 || it.sha1,
            conflictPending: false, conflictLocalSha1: '', conflictCloudSha1: '',
          }
          ok += 1
          log(`  ✓ ${it.rel}（${(it.size / 1024 / 1024).toFixed(2)}MB${fileId ? ' · 更新' : ' · 新增'}）`)
        } catch (err) {
          transferFailures += 1
          log(`  ✗ ${it.rel}: ${err.message.slice(0, 120)}`)
        }
      }
    }
    report(`${ok}/${list.length}`)
    commitPair(state, pair, ps)
  }
  saveState(state)

  /* 扫描异常分级：只有"新出现/刚出现"的异常才值得让外壳重试整轮。
     持续读不到的路径（云占位符、内容不在本地等）每 5 分钟重试一次永远不会变好，
     只会把日志刷红、把变更事件一直扣在队列里；那类只跳过 + 保留原快照，不算本轮失败。
     删除安全由"内容判定一律基于完整扫描"保证，不依赖重试。 */
  const anomalyStore = loadScanAnomalies(SCAN_ANOMALY_FILE)
  const cls = classifyScanAnomalies({
    transferFailures,
    current: anomalyKeys,
    previous: anomalyStore.paths,
  })
  saveScanAnomalies(SCAN_ANOMALY_FILE, { paths: cls.next })
  if (cls.resolved.length) log(`扫描异常已恢复 ${cls.resolved.length} 处，重新纳入同步`)
  if (cls.fatal) {
    const parts = []
    if (transferFailures) parts.push(`${transferFailures} 个处理失败`)
    if (cls.retrying.length) parts.push(`${cls.retrying.length} 处扫描异常在重试窗口内（新出现或刚出现）`)
    throw new Error(`本轮有 ${parts.join('、')}；已保存成功项，失败/跳过项保留基线待重试`)
  }
  if (cls.settled.length) {
    log(`本轮无处理失败；${cls.settled.length} 处路径持续不可读已超过 ${Math.round(DEFAULT_GRACE_MS / 60000)} 分钟，仅跳过并保留原快照，不再阻塞本轮`)
  }
}

/** 冲突时云端版本的落盘名：按云端 SHA-1 固定命名，重复拉取不会制造多个时间戳副本。 */
function conflictName(p, sha1) {
  const parsed = parse(p)
  const tag = String(sha1 || 'unknown').slice(0, 10)
  return join(parsed.dir, `${parsed.name} (云端冲突 ${tag})${parsed.ext}`)
}

/**
 * 把一个云端文件同步到本地。
 * - 本地没有 → 直接下载
 * - 本地有且 sha1 相同 → 跳过
 * - 本地有且不同 → **冲突，保留双版本**：云端版本另存副本，本地原件不动（不覆盖、不删除）
 */
async function downloadOne(wd, pair, ps, rel, c) {
  const localAbs = safeLocalPath(pair.localDir, rel)
  let localSha1 = ''
  if (existsSync(localAbs)) {
    const s = statSync(localAbs)
    if (s.size === c.size) localSha1 = (await hashFile(localAbs, { md5: false })).sha1
  }
  if (localSha1 && localSha1 === c.sha1) {
    // 本地内容已与云端一致：顺手补写快照（尤其是快照里没有这条时），
    // 否则下一轮又要白哈希一遍这个文件
    const st = statSync(localAbs)
    const s = ps.files[rel] || {}
    ps.files[rel] = {
      ...s, id: c.id, size: c.size, sha1: c.sha1, mtime: c.mtime,
      localSize: st.size, localMtimeMs: Math.floor(st.mtimeMs), localSha1,
      syncedAt: Date.now(), syncedSha1: c.sha1,
    }
    return { rel, action: 'skip' }
  }

  let target = localAbs
  let conflict = false
  if (existsSync(localAbs)) {
    target = conflictName(localAbs, c.sha1)
    conflict = true
    if (existsSync(target)) {
      const existing = await hashFile(target, { md5: false })
      if (c.sha1 && existing.sha1 === c.sha1) {
        ps.conflicts = ps.conflicts || []
        const conflictFile = relative(pair.localDir, target).split(sep).join('/')
        const key = `${rel}|cloud|${c.sha1}|${localSha1 || ''}`
        if (!ps.conflicts.some((x) => x.key === key)) {
          ps.conflicts.push({ key, rel, conflictFile, foundAt: Date.now(), cloudSha1: c.sha1, localSha1 })
        }
        return { rel, action: 'conflict', ok: true, existing: true }
      }
      throw new Error(`云端冲突副本名已被其他内容占用：${target}`)
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.wps-sync.part-${process.pid}-${randomUUID()}`
  try {
    // 先写临时文件，校验通过后再原子改名；正式路径不能暴露半截下载。
    await wd.download(c.id, part)
    const h = await hashFile(part, { md5: false })
    if (c.sha1 && h.sha1 !== c.sha1) {
      throw new Error(`下载校验失败：期望 sha1=${c.sha1}，实际=${h.sha1}`)
    }
    renameSync(part, target)
    const st = statSync(target)
    if (!conflict) {
      const s = ps.files[rel] || {}
      ps.files[rel] = {
        ...s,
        id: c.id, size: c.size, sha1: c.sha1, mtime: c.mtime,
        localSize: st.size, localMtimeMs: Math.floor(st.mtimeMs), localSha1: h.sha1,
        syncedAt: Date.now(), syncedSha1: h.sha1,
      }
    } else {
      ps.conflicts = ps.conflicts || []
      const conflictFile = relative(pair.localDir, target).split(sep).join('/')
      const key = `${rel}|cloud|${c.sha1 || ''}|${localSha1 || ''}`
      if (!ps.conflicts.some((x) => x.key === key)) {
        ps.conflicts.push({ key, rel, conflictFile, foundAt: Date.now(), cloudSha1: c.sha1, localSha1 })
      }
    }
    return { rel, action: conflict ? 'conflict' : 'downloaded', ok: true }
  } catch (err) {
    try { rmSync(part, { force: true }) } catch { /* ignore cleanup error */ }
    throw err
  }
}

async function check(wd) {
  // --check-path <子路径>：只核对某个子目录（全量要十几分钟，局部核对用于快速验证）
  const onlyPath = args.includes('--check-path') ? normalizeCloudSubpath((args[args.indexOf('--check-path') + 1] || '').replace(/^\/+|\/+$/g, '')) : ''
  const inScope = (rel) => !onlyPath || rel === onlyPath || rel.startsWith(`${onlyPath}/`)
  const state = loadState()
  let incomplete = 0
  let downloadFailures = 0
  for (const pair of PAIRS) {
    const ps = workingPair(state, pair)
    const rootId = await wd.resolvePath(onlyPath ? `${pair.cloudPath}/${onlyPath}` : pair.cloudPath)
    const cloud = new Map()
    const t0 = Date.now()
    const { dirs, errors, unresolved } = await walkCloud(wd, rootId, cloud, { rootPrefix: onlyPath })
    const skipped = pruneCloudExcluded(cloud)
    log(`${PAIRS.length > 1 ? `${pair.name}：` : ''}云端核对${onlyPath ? `（${onlyPath}）` : ''}：${dirs} 目录 / ${cloud.size} 文件，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${unresolved.length ? `，${unresolved.length} 个目录未列出` : ''}`)
    if (skipped) log(`跳过排除项 ${skipped} 个（按配置不参与同步）`)

    // 本地也要扫：否则"本地删了文件"只会在 --build 时被发现，--check 会漏记
    const local = scanLocal(pair.localDir)
    if (!local.complete) {
      // 「删除判定必须基于完整扫描」这一条不动 —— 只要不完整就跳过该 pair 的删除/快照更新。
      // 但"持续读不到"不该被算成本轮失败：否则每次点「核对」/「启动同步」都报错，
      // 而重试并不会让云占位符变得可读。只有新出现/窗口内的异常才算失败。
      const aCls = classifyScanAnomalies({
        current: anomalyKeysOf(pair, local),
        previous: loadScanAnomalies(SCAN_ANOMALY_FILE).paths,
      })
      saveScanAnomalies(SCAN_ANOMALY_FILE, { paths: aCls.next })
      if (aCls.retrying.length) {
        incomplete += 1
        log(`本地扫描不完整：${local.errors.length} 处无法读取（其中 ${aCls.retrying.length} 处为新出现/重试窗口内）；跳过 check 的删除/快照更新`)
      } else {
        log(`本地扫描 ${local.errors.length} 处持续不可读（云占位符等）：跳过 check 的删除/快照更新，本轮不计失败`)
      }
      continue
    }
    if (unresolved.length) {
      incomplete += 1
      log(`本轮云端清单不完整，跳过 check 的删除/快照更新；保留现有状态，下一轮重试`)
      continue
    }
    const goneCand = []
    let prunedExcluded = 0
    for (const rel of Object.keys(ps.files)) {
      if (!inScope(rel)) continue
      if (!local.has(rel) && ps.files[rel].localSize) {
        // 排除列表内的（早期误传的 CAD 锁文件等）直接出库，不算删除
        if (isExcludedRel(rel)) { delete ps.files[rel]; prunedExcluded += 1; continue }
        if (IGNORE_OLD) continue // ignoreOldFiles：老文件的消失不问（快照条目保留，理由见常量注释）
        goneCand.push(rel)
      }
    }
    if (prunedExcluded) log(`清理已排除目录的残留记录 ${prunedExcluded} 个`)
    const localGone = goneCand
    // 云端也没有 → 两端一致地删除（典型：你在网页端删掉后，官方客户端把删除同步到本地），
    // 这种情况两端已一致，不需要人工处理，也就不该进台账
    const bothGone = localGone.filter((r) => !cloud.has(r))
    const localOnlyGone = localGone.filter((r) => cloud.has(r))
    for (const rel of bothGone) delete ps.files[rel]
    if (bothGone.length) log(`两端均已删除 ${bothGone.length} 个，已从快照移除`)
    for (const rel of localOnlyGone) {
      recordDeletion(pair.name, rel, 'local', {
        size: ps.files[rel].localSize,
        fileId: ps.files[rel].id,
        expectedName: baseOf(rel),
        expectedCloudSha1: ps.files[rel].sha1 || '',
        expectedLocalSha1: ps.files[rel].localSha1 || ps.files[rel].syncedSha1 || '',
      })
    }
    if (localOnlyGone.length) {
      log(`本地消失但云端仍在 ${localOnlyGone.length} 个（已记台账，等你确认）：`)
      for (const r of localOnlyGone.slice(0, 10)) log(`  - ${r}`)
      if (localOnlyGone.length > 10) log(`  …还有 ${localOnlyGone.length - 10} 个`)
    }

    // 云端消失待办若同路径已恢复，旧删除意图已经失效：自动撤销，不能继续冻结下载。
    const cloudRestored = new Set()
    for (const it of pendingDeletions()) {
      if (it.pair !== pair.name || it.side !== 'cloud' || !cloud.has(it.relPath)) continue
      setDeletionStatus(it.key, 'ignored', '云端同路径已恢复或重建，自动撤销待办')
      cloudRestored.add(it.relPath)
    }
    if (cloudRestored.size) log(`台账自愈：${cloudRestored.size} 条「云端消失」记录已恢复，自动撤销待办`)
    const pendingKeys = new Set(
      pendingDeletions()
        .filter((it) => it.pair === pair.name)
        .map((it) => it.relPath),
    )
    const added = []
    const changed = []
    const gone = []
    for (const [rel, c] of cloud) {
      if (pendingKeys.has(rel)) continue
      const s = ps.files[rel]
      if (!s || !s.id) { added.push(rel); continue }
      if (c.sha1 && s.sha1 && c.sha1 !== s.sha1) changed.push(rel)
    }
    // 只有完整列出当前范围，才能把快照中没看到的对象判为“云端消失”。
    if (!unresolved.length && !IGNORE_OLD) {
      for (const rel of Object.keys(ps.files)) {
        if (!inScope(rel)) continue
        if (!cloud.has(rel) && ps.files[rel].id) gone.push(rel)
      }
    }

    // 不自动猜测云端改名/移动：新路径按新增下载，旧路径记删除台账，等用户批量确认。

    if (unresolved.length) {
      log(`本轮云端清单不完整：${unresolved.length} 个目录未解决；不记录云端消失、不提交云端完整时间戳`)
    }
    for (const rel of gone) {
      recordDeletion(pair.name, rel, 'cloud', {
        size: ps.files[rel].size,
        fileId: ps.files[rel].id,
        expectedName: baseOf(rel),
        expectedCloudSha1: ps.files[rel].sha1 || '',
        expectedLocalSha1: ps.files[rel].localSha1 || ps.files[rel].syncedSha1 || '',
      })
    }
    // --check 只观察，不把未下载的远端版本写成“已同步基线”。
    // 否则先 check 再 cloudsync 时，新增/变更会被永久吞掉。
    // 带 --download 时由 downloadOne 对成功/跳过项逐条提交；失败项不推进基线。
    if (!unresolved.length) ps.cloudCheckedAt = Date.now()
    log(`云端新增 ${added.length} / 变更 ${changed.length} / 消失 ${gone.length}（已记台账）`)
    for (const r of changed.slice(0, 10)) log(`  ↺ ${r}`)
    for (const r of added.slice(0, 10)) log(`  + ${r}`)
    for (const r of gone.slice(0, 10)) log(`  - ${r}`)
    if (gone.length > 10) log(`  …消失项还有 ${gone.length - 10} 个`)

    if (DO_DOWNLOAD) {
      const targets = [...added, ...changed].map((rel) => rel)
      log(`开始同步到本地：${targets.length} 个`)
      let n = 0
      let conf = 0
      let bad = 0
      for (const rel of targets) {
        const c = cloud.get(rel)
        try {
          const r = await downloadOne(wd, pair, ps, rel, c)
          if (r.action === 'conflict') { conf += 1; log(`  ⚠ 冲突 ${rel} → 云端版本已另存，本地原件保留`) }
          else if (r.action === 'downloaded') { n += 1; if (!r.ok) { bad += 1; log(`  ✗ 校验失败 ${rel}`) } }
        } catch (err) {
          bad += 1
          log(`  ✗ ${rel}: ${err.message.slice(0, 120)}`)
        }
      }
      downloadFailures += bad
      log(`下载完成：${n} 个（失败 ${bad}），冲突保留双版本 ${conf} 个`)
    }
    commitPair(state, pair, ps)
  }
  saveState(state)
  if (incomplete || downloadFailures) throw new Error(`云端核对未完整完成：清单不完整 ${incomplete} 个同步目录，下载失败 ${downloadFailures} 个文件；已保存成功项，其余需重试`)
}

/**
 * --cloudsync：只做「云端 → 本地」的核对与下载（不做上行）。
 *
 * 为什么必须有这个命令：日常 `--once` 只上行，而桌面壳（main.cjs）里只有本地
 * fs.watch 做触发、**没有任何周期性定时器** —— 所以手机/网页端改了云端，
 * 这台机器永远不会知道。这正是"手机端改了这边同步不下来"的根因
 * （另一条路 `--check` 要全量列 8449 个目录，旧限速下 17 分钟，实际上没人会去点）。
 *
 * 云端没有变更订阅接口、目录 mtime 也不随子项冒泡（2026-09-20 均已实测否证：
 * 往深层目录上传文件后，从根到父目录的 mtime 一个都没变），所以只能周期性全量列目录。
 * 当前按 8 QPS 保守限速，并把周期设为至少 30 分钟，避免全量核对与首页浏览争用 API；
 * 后续由 rclone/WebDAV 影子链路验证成熟后再替换这段全树遍历。
 *
 * 用法：
 *   node src/sync2.mjs --cloudsync                  全量核对 + 下载
 *   node src/sync2.mjs --cloudsync --path <子目录>    只核对某个子树（秒级）
 *   node src/sync2.mjs --cloudsync --dry-run        只报告，不下载
 */
async function cloudsync(wd) {
  const onlyPath = args.includes('--path')
    ? normalizeCloudSubpath((args[args.indexOf('--path') + 1] || '').replace(/^\/+|\/+$/g, ''))
    : ''
  const dryRun = args.includes('--dry-run')
  const state = loadState()
  let incomplete = 0
  let downloadFailures = 0
  for (const pair of PAIRS) {
    const ps = workingPair(state, pair)
    let rootId
    try {
      rootId = await wd.resolvePath(onlyPath ? `${pair.cloudPath}/${onlyPath}` : pair.cloudPath)
    } catch (err) {
      if (/云端目录不存在/.test(err.message)) {
        incomplete += 1
        log(`=== ${pair.name}：云端路径不存在，本轮未完成（${err.message.slice(0, 80)}）`)
        continue
      }
      throw new Error(`${pair.name}：解析云端根路径失败：${err.message}`)
    }
    const cloud = new Map()
    const t0 = Date.now()
    const { dirs, errors, unresolved } = await walkCloud(wd, rootId, cloud, { rootPrefix: onlyPath })
    const skipped = pruneCloudExcluded(cloud)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    log(`${PAIRS.length > 1 ? `${pair.name}：` : ''}云端核对${onlyPath ? `（${onlyPath}）` : ''}：${dirs} 目录 / ${cloud.size} 文件，耗时 ${secs}s${unresolved.length ? `，${unresolved.length} 个目录未列出` : ''}`)
    if (skipped) log(`跳过排除项 ${skipped} 个（按配置不参与同步）`)

    // 云端同路径恢复后自动撤销“云端消失”待办；否则旧待办会永久阻止下载。
    const cloudRestored = new Set()
    for (const it of pendingDeletions()) {
      if (it.pair !== pair.name || it.side !== 'cloud' || !cloud.has(it.relPath)) continue
      setDeletionStatus(it.key, 'ignored', '云端同路径已恢复或重建，自动撤销待办')
      cloudRestored.add(it.relPath)
    }
    if (cloudRestored.size) log(`台账自愈：${cloudRestored.size} 条「云端消失」记录已恢复，自动撤销待办`)
    const pendingKeys = new Set(
      pendingDeletions()
        .filter((it) => it.pair === pair.name)
        .map((it) => it.relPath),
    )
    const added = []
    const changed = []
    for (const [rel, c] of cloud) {
      if (pendingKeys.has(rel)) continue // 删除待确认期间冻结，禁止下载把本地删除“复活”
      const s = ps.files[rel]
      if (!s || !s.id) { added.push(rel); continue }
      if (c.sha1 && s.sha1 && c.sha1 !== s.sha1) changed.push(rel)
    }

    // 云端删除：只在「本轮把范围完整列出」时才判定 —— 有目录没列出来就整片跳过，
    // 否则失败的目录会被当成"云端已删除"批量误记台账（这正是 8 QPS 时代的坑）
    // ignoreOldFiles 时干脆不做这个判定：快照条目静默保留，不记台账、不出库
    const gone = []
    if (!unresolved.length && !IGNORE_OLD) {
      for (const rel of Object.keys(ps.files)) {
        if (!ps.files[rel].id) continue
        if (cloud.has(rel)) continue
        if (onlyPath && rel !== onlyPath && !rel.startsWith(`${onlyPath}/`)) continue
        gone.push(rel)
      }
    }

    if (unresolved.length) incomplete += 1
    const goneNote = unresolved.length
      ? `（仍有 ${unresolved.length} 个目录未列出，已跳过「消失」判定）`
      : (IGNORE_OLD ? '（ignoreOldFiles=true，不判定云端消失）' : '')
    log(`云端新增 ${added.length} / 变更 ${changed.length} / 消失 ${gone.length}${goneNote}`)
    for (const r of added.slice(0, 10)) log(`  + ${r}`)
    if (added.length > 10) log(`  …新增还有 ${added.length - 10} 个`)
    for (const r of changed.slice(0, 10)) log(`  ↺ ${r}`)
    if (changed.length > 10) log(`  …变更还有 ${changed.length - 10} 个`)
    for (const r of gone.slice(0, 10)) log(`  - ${r}`)
    if (gone.length > 10) log(`  …消失还有 ${gone.length - 10} 个`)

    // 演练模式到此为止：不记台账、不写快照、不下载
    // （这几行原先排在「记台账」之后，导致 --dry-run 也会把"云端消失"写进台账）
    if (dryRun) continue

    // 云端消失只记台账（不自动删本地），与既定策略「删除仅记录」一致
    for (const rel of gone) {
      recordDeletion(pair.name, rel, 'cloud', {
        size: ps.files[rel].size,
        fileId: ps.files[rel].id,
        expectedName: baseOf(rel),
        expectedCloudSha1: ps.files[rel].sha1 || '',
        expectedLocalSha1: ps.files[rel].localSha1 || ps.files[rel].syncedSha1 || '',
      })
    }

    const targets = [...added, ...changed]
    if (targets.length) {
      // 安全阀：单轮限量下载，剩下的下一轮继续（每轮都会重新检出，天然支持续做）
      let budgetFiles = PULL_MAX_FILES
      let budgetBytes = PULL_MAX_MB * 1024 * 1024
      let n = 0
      let conf = 0
      let bad = 0
      let deferred = 0
      for (const rel of targets) {
        const c = cloud.get(rel)
      // 本轮尚未下载任何文件时允许一个超预算大文件，避免它每轮都被顺延、永久饥饿。
      if (budgetFiles <= 0 || (budgetBytes - (c.size || 0) < 0 && n + conf + bad > 0)) { deferred += 1; continue }
      budgetFiles -= 1
      budgetBytes -= c.size || 0
        try {
          const r = await downloadOne(wd, pair, ps, rel, c)
          if (r.action === 'conflict') { conf += 1; log(`  ⚠ 冲突 ${rel} → 云端版本已另存，本地原件保留`) }
          else if (r.action === 'downloaded') { n += 1; if (!r.ok) { bad += 1; log(`  ✗ 校验失败 ${rel}`) } }
        } catch (err) {
          bad += 1
          log(`  ✗ ${rel}: ${err.message.slice(0, 120)}`)
        }
      }
      downloadFailures += bad
      log(`下载完成：${n} 个（失败 ${bad}），冲突保留双版本 ${conf}${deferred ? `，超单轮限额外 ${deferred} 个顺延下轮` : ''}`)
    } else {
      log('本地已是最新，无需下载')
    }
    ps.cloudCheckedAt = Date.now()
    if (!dryRun) commitPair(state, pair, ps)
  }
  if (!dryRun) saveState(state)
  if (incomplete || downloadFailures) {
    throw new Error(`云端拉取未完整完成：清单不完整 ${incomplete} 个同步目录，下载失败 ${downloadFailures} 个文件；已保存成功项，其余下轮重试`)
  }
}

/**
 * 把某条台账记录对应的云端文件移入回收站，然后标记 handled。
 * 只处理 side='local'（本地删了、云端还在）的记录；side='cloud' 的文件云端已经不在了。
 * 注意：是移到**回收站**（可还原），不是彻底抹除。
 */
async function purgeCloud(wd, key) {
  const all = loadDeletions()
  const item = all.items.find((i) => i.key === key)
  if (!item) throw new Error(`未找到台账记录：${key}`)
  if (item.side !== 'local') throw new Error(`该记录是「云端消失」，不能执行云端删除`)
  if (!item.fileId) throw new Error(`该记录没有云端 fileId，无法删除`)

  const pair = PAIRS.find((p) => p.name === item.pair)
  if (!pair) throw new Error(`找不到 pair：${item.pair}`)
  const relDir = item.relPath.includes('/') ? item.relPath.split('/').slice(0, -1).join('/') : ''
  const parentId = await wd.resolvePath(relDir ? `${pair.cloudPath}/${relDir}` : pair.cloudPath)

  const r = await wd.remove([Number(item.fileId)], { srcParentId: Number(parentId) })
  let stillThere = true
  try {
    stillThere = (await listComplete(wd, parentId)).some((f) => f.id === String(item.fileId))
  } catch (err) {
    throw new Error(`删除结果未知：复核云端失败（${err.message.slice(0, 100)}）；台账保持 pending`)
  }
  if (!stillThere && r.ok) {
    setDeletionStatus(key, 'handled')
    log(`已把云端文件移入回收站并复核：${item.relPath}（fileId=${item.fileId}）→ 台账标记为已处理`)
    return
  }
  if (!stillThere) throw new Error(`云端原位置已无此 fileId，但删除任务未成功，去向未知；台账保持 pending`)
  throw new Error(r.error || '删除失败：复核时 fileId 仍在原目录')
}

/** 标记台账状态：handled（已处理）/ ignored（忽略）/ pending（重新待办）。 */
function markStatus(key, status) {
  if (!['handled', 'ignored', 'pending'].includes(status)) throw new Error('状态只能是 handled / ignored / pending')
  const r = setDeletionStatus(key, status)
  if (!r) throw new Error(`未找到记录：${key}`)
  log(`已标记 ${status}：${key}`)
}

function deletions() {
  const items = pendingDeletions()
  log(`待处理删除记录 ${items.length} 条`)
  for (const i of items.slice(0, 50)) {
    log(`  [${i.side === 'cloud' ? '云端消失' : '本地消失'}] ${i.relPath} (${(i.size / 1024 / 1024).toFixed(2)}MB) fileId=${i.fileId || '-'} @ ${new Date(i.foundAt).toISOString().slice(0, 16).replace('T', ' ')}`)
  }
  if (items.length > 50) log(`  …还有 ${items.length - 50} 条`)
}

/* ---------------- 进程互斥锁 ---------------- */

/** 写操作必须与 Electron 删除确认共用同一把跨进程锁。 */
const WRITE_MODES = ['--build', '--once', '--check', '--startup', '--download', '--cloudsync', '--purge-cloud', '--mark']
const LOCK_WAIT_MS = Number(process.env.WPS_SYNC_LOCK_WAIT_MS || 90000)
let releaseSyncLock = null

/* ---------------- 入口 ---------------- */

if (!cfg.driveId) {
  console.error('config.json 缺少 driveId（云盘 id）——请在「设置」页或配置文件中填写')
  process.exit(2)
}

const wd = new WebDrive({
  sid: SID,
  groupId: cfg.driveId,
  timeoutMs: 300000,
  requestQps: MAX_QPS, // 真正按每个 HTTP 请求限速（分页、resolvePath、重试都计入）
})
if (!SID) {
  console.error('未找到 wps_sid，请先登录')
  process.exit(2)
}
try {
  if (WRITE_MODES.some((m) => args.includes(m))) {
    try {
      releaseSyncLock = await acquireSyncLock({
        waitMs: LOCK_WAIT_MS,
        pollMs: 3000,
        owner: `sync2 ${args.join(' ')}`,
        onWait: (pid) => log(`另一个写任务正在进行（pid ${pid}），等待其结束…`),
      })
    } catch (err) {
      if (err.code === 'SYNC_LOCK_TIMEOUT') {
        log('等待超时，本次未执行任何写入，稍后会自动重试')
        process.exit(3)
      }
      throw err
    }
  }
  if (args.includes('--build')) await build(wd)
  else if (args.includes('--plan')) await plan(wd)
  // 启动一站式：先上传本地变更（这一步不列云端），再核对云端并同步到本地
  else if (args.includes('--startup')) { await once(wd); await check(wd) }
  else if (args.includes('--once')) await once(wd)
  else if (args.includes('--cloudsync')) await cloudsync(wd)
  else if (args.includes('--check') || DO_DOWNLOAD) await check(wd)
  else if (args.includes('--deletions')) deletions()
  else if (args.includes('--purge-cloud')) await purgeCloud(wd, args[args.indexOf('--purge-cloud') + 1])
  else if (args.includes('--mark')) markStatus(args[args.indexOf('--mark') + 1], args[args.indexOf('--mark') + 2])
  else console.log('用法: node src/sync2.mjs --build|--plan|--once|--check [--download] [--check-path <子路径>]|--cloudsync [--path <子路径>] [--dry-run]|--startup|--deletions|--purge-cloud <key>|--mark <key> <handled|ignored|pending>')
} catch (err) {
  console.error('错误:', err.message)
  process.exitCode = 1
} finally {
  if (releaseSyncLock) releaseSyncLock()
}
