/**
 * scan-anomalies.mjs — 「本地扫描读不到」这类异常的持久化与分级判定
 *
 * 背景（实测）：
 *   同步根里某些老文件的「云占位符」属性没落盘：属性带 FILE_ATTRIBUTE_PINNED，
 *   内容已经不在本地（被第三方同步客户端标记为"仅云端"，
 *   常见于 OneDrive / NAS 同步客户端纳管的目录）。
 *   连非 Electron 的原生进程（PowerShell 的 File::OpenRead）打开都报「拒绝访问」，
 *   引擎扫描时对它们 stat 直接 EPERM。
 *
 *   旧逻辑把这种"扫描不完整"一律当成整轮失败 → 退出码 1 → 外壳 5 分钟后重试 →
 *   永久收敛不了：每 5 分钟刷一次红色错误、把变更事件一直扣在队列里，
 *   而"待上传 0"说明这轮其实什么都没干。这是实现问题，不是那些老文件的问题。
 *
 * 判定原则：
 *   - 值得重试的是"新出现"或"刚出现不久"的异常 —— 多半是文件被 CAD 短暂占用、稍后自愈。
 *   - 同一个路径持续读不到超过 graceMs，就说明它当前就是不可读的：再重试也不会好，
 *     只跳过它、保留它的原快照即可。删除安全由 fail-closed（内容判定一律基于完整扫描）
 *     保证，不依赖"用重试把它磨好"。
 *   - 路径一旦重新可读就从记录里消失；以后再出问题会重新算作"新异常"，照常重试。
 *
 * 记录落在 <程序根>/data/scan-anomalies.json，只用于诊断与判定；
 * 读不出来、写不进去都绝不能影响同步本身。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 异常持续超过这个时长，就不再触发整轮重试（默认 30 分钟）。 */
export const DEFAULT_GRACE_MS = 30 * 60 * 1000

/**
 * 读取上次的异常记录。
 * 首次运行、文件损坏、无权限等任何情况都退化成"没有记录"（于是本轮异常全算新出现）。
 * @returns {{paths: Record<string, {firstSeenAt:number,lastSeenAt:number,rounds:number}>}}
 */
export function loadScanAnomalies(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (j && j.paths && typeof j.paths === 'object') return { paths: j.paths }
  } catch { /* 当作没有记录 */ }
  return { paths: {} }
}

/** 写回记录；失败只返回 false（诊断文件写不了不能中断同步）。 */
export function saveScanAnomalies(file, store) {
  try {
    writeFileSync(file, `${JSON.stringify({ updatedAt: Date.now(), paths: (store && store.paths) || {} }, null, 2)}\n`)
    return true
  } catch { return false }
}

/**
 * 判定本轮扫描异常。
 *
 * @param {number} transferFailures 真正的传输失败数量（哈希/上传出错）——这类一律要重试
 * @param {string[]} current 本轮读不到的路径 key（带 pair 前缀，已去重）
 * @param {object} previous 上轮记录 { [key]: { firstSeenAt, lastSeenAt, rounds } }
 * @param {number} now 当前时间戳（便于测试注入）
 * @param {number} graceMs 重试窗口；超过它的异常不再触发整轮重试
 * @returns {{fatal:boolean, retrying:string[], settled:string[], resolved:string[], total:number, next:object}}
 *   fatal    —— 本轮是否应按失败处理（退出码 1 + 外壳重试）
 *   retrying —— 仍在窗口内的异常（新出现 / 刚出现不久）
 *   settled  —— 已持续超过窗口、只跳过不重试的异常
 *   resolved —— 上轮有、本轮没有的（说明已恢复可读）
 *   next     —— 本轮要写回的记录
 */
export function classifyScanAnomalies({
  transferFailures = 0,
  current = [],
  previous = {},
  now = Date.now(),
  graceMs = DEFAULT_GRACE_MS,
}) {
  const prev = previous && typeof previous === 'object' ? previous : {}
  const cur = new Set(current)
  const next = {}
  const retrying = []
  const settled = []
  for (const key of cur) {
    const p = prev[key] || {}
    // firstSeenAt 一经记录就保持不变：判定的依据是"这个问题第一次出现到现在多久"
    const firstSeenAt = Number(p.firstSeenAt) || now
    next[key] = {
      firstSeenAt,
      lastSeenAt: now,
      rounds: (Number(p.rounds) || 0) + 1,
    }
    ;(now - firstSeenAt < graceMs ? retrying : settled).push(key)
  }
  const resolved = Object.keys(prev).filter((k) => !cur.has(k))
  return {
    fatal: transferFailures > 0 || retrying.length > 0,
    retrying,
    settled,
    resolved,
    total: cur.size,
    next,
  }
}
