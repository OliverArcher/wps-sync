/**
 * state.mjs — 同步快照与删除台账（M3）
 *
 * 快照 data/state.json：
 *   pairs[名称] = { cloudPath, localDir, builtAt, cloudCheckedAt,
 *                   files: { 相对路径: { id, size, sha1, mtime,           ← 云端
 *                                        localSize, localMtimeMs, localSha1,
 *                                        syncedAt, syncedSha1 } } }        ← 本地与基线
 *
 * 删除台账 data/deletions.json：
 *   [{ key, pair, relPath, side:'local'|'cloud', size, fileId, foundAt, status, note }]
 *   只记录、不执行删除（云端无删除接口）。status: pending | handled | ignored
 *
 * 判定原则：
 *   - 本地：size/mtime 任一变化 → 候选 → 算 sha1 → 与 syncedSha1 比，不同才是真变更
 *   - 云端：直接拿 listing 的 fsha(sha1) 比对，零下载成本
 *   - 两侧都不能用 mtime 互相比较（云端 mtime 是上传时间，实测与本地差数天）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * 数据目录（config.json / data/ 所在）。打包结构固定为 <root>/resources/engine，
 * 调用方即使漏传 WPS_SYNC_USER_ROOT，也必须优先回到程序根，不能误用 engine/data 空快照。
 */
const PROGRAM_ROOT = dirname(dirname(ENGINE_ROOT))
export const ROOT = process.env.WPS_SYNC_USER_ROOT
  || (existsSync(join(PROGRAM_ROOT, 'config.json')) ? PROGRAM_ROOT : ENGINE_ROOT)
export const STATE_FILE = join(ROOT, 'data', 'state.json')
export const DELETIONS_FILE = join(ROOT, 'data', 'deletions.json')

/**
 * 崩溃可恢复写入：新内容先 fsync 到唯一 tmp，旧文件保留为 .prev，再原子替换。
 * 绝不能先 rm 正式文件；rm 与 rename 之间掉电会把 28MB 快照直接变没。
 */
function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const prev = `${file}.prev`
  const text = JSON.stringify(obj, null, 2) + '\n'
  const fd = openSync(tmp, 'wx')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (existsSync(prev)) rmSync(prev, { force: true })
    if (existsSync(file)) renameSync(file, prev)
    renameSync(tmp, file)
  } catch (err) {
    // 第二次 rename 失败时尽量把旧正式文件恢复回来；不允许静默丢状态。
    try { if (!existsSync(file) && existsSync(prev)) renameSync(prev, file) } catch { /* 保留 prev 供启动恢复 */ }
    try { rmSync(tmp, { force: true }) } catch { /* ignore cleanup error */ }
    throw err
  }
}

function readJson(file, fallback) {
  const prev = `${file}.prev`
  if (!existsSync(file)) {
    if (existsSync(prev)) {
      try { return JSON.parse(readFileSync(prev, 'utf8')) } catch (err) {
        throw new Error(`状态主文件缺失且备份损坏：${file}（${err.message}）`)
      }
    }
    return fallback
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (existsSync(prev)) {
      try { return JSON.parse(readFileSync(prev, 'utf8')) } catch { /* fall through */ }
    }
    throw new Error(`状态文件损坏且无可用备份：${file}（${err.message}）`)
  }
}

export function loadState({ strict = false } = {}) {
  // 上行不能从空库或旧备份猜测基线；损坏时留给人工核实。
  let s
  if (strict) {
    try {
      s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
      if (!object(s) || s.version !== 1 || !object(s.pairs)) throw new Error('快照结构无效')
      for (const p of Object.values(s.pairs)) {
        if (!object(p) || !object(p.files) || Object.values(p.files).some((f) => !object(f))) {
          throw new Error('同步目录或文件条目结构无效')
        }
      }
    } catch (err) {
      throw new Error(`快照缺失或损坏，停止上行且不使用旧备份：${err.message}`)
    }
  } else {
    s = readJson(STATE_FILE, { version: 1, pairs: {} })
  }
  s.version = 1
  s.pairs = s.pairs || {}
  return s
}

export function saveState(state) {
  writeJson(STATE_FILE, state)
}

export function pairState(state, pair) {
  if (!state.pairs[pair.name]) {
    state.pairs[pair.name] = {
      cloudPath: pair.cloudPath,
      localDir: pair.localDir,
      builtAt: 0,
      cloudCheckedAt: 0,
      files: {},
    }
  }
  const p = state.pairs[pair.name]
  p.cloudPath = pair.cloudPath
  p.localDir = pair.localDir
  p.files = p.files || {}
  return p
}

/* ------------------------------------------------------------------ */
/* 删除台账                                                            */
/* ------------------------------------------------------------------ */

export function loadDeletions() {
  const d = readJson(DELETIONS_FILE, { items: [] })
  d.items = d.items || []
  return d
}

export function saveDeletions(d) {
  writeJson(DELETIONS_FILE, d)
}

/**
 * 记一条删除（幂等：同 pair+relPath+side 且仍为 pending 的不重复记）。
 * @param {'local'|'cloud'} side 哪一端消失了
 */
export function recordDeletion(pairName, relPath, side, extra = {}) {
  const d = loadDeletions()
  const key = `${pairName}|${side}|${relPath}`
  const existing = d.items.find((i) => i.key === key)
  if (existing) {
    if (existing.status === 'pending') {
      // 旧记录可能由升级前版本创建；只补缺失身份，不改写已记录的删除前证据。
      let changed = false
      for (const [field, value] of [
        ['expectedName', extra.expectedName || relPath.split('/').pop() || ''],
        ['expectedCloudSha1', extra.expectedCloudSha1 || ''],
        ['expectedLocalSha1', extra.expectedLocalSha1 || ''],
      ]) {
        if (!existing[field] && value) { existing[field] = value; changed = true }
      }
      if (changed) saveDeletions(d)
      return { added: false, item: existing }
    }
    // 同一路径再次发生删除时复用原记录，避免重复 key 导致 setDeletionStatus 改错旧记录。
    Object.assign(existing, {
      side,
      size: extra.size ?? 0,
      fileId: extra.fileId || '',
      expectedName: extra.expectedName || relPath.split('/').pop() || '',
      expectedCloudSha1: extra.expectedCloudSha1 || '',
      expectedLocalSha1: extra.expectedLocalSha1 || '',
      foundAt: Date.now(),
      status: 'pending',
      note: extra.note || '',
    })
    delete existing.handledAt
    saveDeletions(d)
    return { added: true, item: existing }
  }
  const item = {
    key,
    pair: pairName,
    relPath,
    side,
    size: extra.size ?? 0,
    fileId: extra.fileId || '',
    expectedName: extra.expectedName || relPath.split('/').pop() || '',
    expectedCloudSha1: extra.expectedCloudSha1 || '',
    expectedLocalSha1: extra.expectedLocalSha1 || '',
    foundAt: Date.now(),
    status: 'pending',
    note: extra.note || '',
  }
  d.items.push(item)
  saveDeletions(d)
  return { added: true, item }
}

/** 更新台账状态：pending / handled / ignored；可附带处理说明。 */
export function setDeletionStatus(key, status, note = undefined) {
  const d = loadDeletions()
  const item = d.items.find((i) => i.key === key)
  if (!item) return null
  item.status = status
  if (status === 'pending') delete item.handledAt
  else item.handledAt = Date.now()
  if (note !== undefined) item.note = String(note)
  saveDeletions(d)
  return item
}

export function pendingDeletions() {
  return loadDeletions().items.filter((i) => i.status === 'pending')
}

// ROOT 已在上面以 export const 导出，无需重复导出
