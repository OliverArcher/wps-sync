import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ROOT } from './state.mjs'

export const SYNC_LOCK_FILE = join(ROOT, 'data', '.sync.lock')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH' // EPERM 或未知错误不代表进程死亡，绝不删有效锁
  }
}

/**
 * 取得同步器与桌面删除操作共用的跨进程锁。
 * 返回 release()；调用方必须在 finally 中释放。
 */
export async function acquireSyncLock({
  waitMs = 90000,
  pollMs = 1000,
  owner = 'unknown',
  onWait = null,
} = {}) {
  const deadline = Date.now() + waitMs
  const token = randomUUID()
  let warned = false

  for (;;) {
    try {
      mkdirSync(dirname(SYNC_LOCK_FILE), { recursive: true })
      const fd = openSync(SYNC_LOCK_FILE, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token, owner, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      let holder = 0
      try {
        const info = JSON.parse(readFileSync(SYNC_LOCK_FILE, 'utf8'))
        const pid = Number(info.pid || 0)
        if (!Number.isInteger(pid) || pid <= 0) holder = '未知'
        else if (pidAlive(pid)) holder = pid
      } catch {
        // 另一个进程可能刚 wx 创建、尚未写完；无法确认死亡就只等待。
        holder = '未知'
      }

      if (!holder) {
        try { rmSync(SYNC_LOCK_FILE, { force: true }) } catch { /* 下一轮再抢 */ }
        continue
      }

      if (!warned) {
        warned = true
        if (onWait) onWait(holder)
      }
      if (Date.now() > deadline) {
        const timeout = new Error(`等待同步锁超时（持有进程 pid ${holder}）`)
        timeout.code = 'SYNC_LOCK_TIMEOUT'
        timeout.holderPid = holder
        throw timeout
      }
      await sleep(pollMs)
    }
  }

  let released = false
  const onExit = () => release()
  const release = () => {
    if (released) return
    released = true
    process.removeListener('exit', onExit)
    try {
      if (!existsSync(SYNC_LOCK_FILE)) return
      const info = JSON.parse(readFileSync(SYNC_LOCK_FILE, 'utf8'))
      if (info.pid === process.pid && info.token === token) rmSync(SYNC_LOCK_FILE, { force: true })
    } catch {
      // 已释放、已替换或损坏时不删除别人的锁。
    }
  }
  process.once('exit', onExit)
  return release
}
