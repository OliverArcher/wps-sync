/**
 * kdocs-core.mjs — 从 songying2024/wps-cloud v2.8.1 提取的独立引擎层（去 DSH 依赖）
 *
 * 职责：
 *   1. wps_sid 会话管理（本地令牌文件 0600 + Windows 凭据管理器密钥链兜底）
 *   2. 受控浏览器一键登录（CDP 抓取 wps_sid，Edge/Chrome 自动探测）
 *   3. kdocs-cli.exe 引擎调用（定位/下载/子进程 JSON 协议解析/限流识别）
 *   4. 文件操作原语：list / info / download / upload / create / rename / move
 *
 * 零外部依赖：仅 Node 内置模块（需 Node >= 22，用全局 fetch/WebSocket）。
 * 参考源码：../wps-cloud-src/lib/index.js（MIT License, songying2024）
 */

import { createHash } from 'node:crypto'
import { spawn, spawnSync, execSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, renameSync,
  createWriteStream,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** kdocs-cli 下载地址（Windows amd64，金山官方 KS3 存储）。 */
export const KDOCS_CLI_DOWNLOAD =
  'https://solution.ks3-cn-beijing.ksyuncs.com/kdocs_cli/win/kdocs-cli.exe'
export const KDOCS_CLI_NAME = 'kdocs-cli.exe'

/** WPS 网页版入口（未登录自动跳 account.wps.cn 统一登录）。 */
export const LOGIN_PAGE = 'https://365.kdocs.cn/'

/**
 * 上传通道的扩展名白名单（2026-09-18 实测，M3 探测结论）。
 * upload_new_file / upload_file / upload-replace-file 三者一致，
 * 服务端按 name 后缀校验，不在名单内直接 code=400001 拒绝 —— .dwg 等 CAD 格式无法经本通道上行。
 */
export const UPLOAD_EXT_WHITELIST = [
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'md', 'txt', 'html',
  'zip', 'png', 'jpg', 'jpeg', 'csv', 'json', 'dps', 'et', 'wps', 'gif',
]

/** 扩展名是否在上传白名单内（空/无扩展名视为不在）。 */
export function isUploadableName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase()
  return Boolean(ext) && UPLOAD_EXT_WHITELIST.includes(ext)
}

/** 应用根目录（src/core/ 向上三级 = wps-sync/）。 */
function appDir() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

/** 应用数据目录：状态、kdocs-cli.exe 都放这里（便携、自包含）。 */
export function dataHome() {
  return process.env.WPS_SYNC_HOME || join(appDir(), 'data')
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n ?? '')
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 跨进程安全替换文件（Windows rename 到已存在目标会失败）。 */
function renameSafe(from, to) {
  try { rmSync(to, { force: true }) } catch { /* ignore */ }
  try { renameSync(from, to) } catch { renameSync(from, to) }
}

/* ------------------------------------------------------------------ */
/* 错误分类                                                            */
/* ------------------------------------------------------------------ */

/** 是否「未登录/会话失效」类错误。 */
export function isAuthError(error) {
  const text = String(error && error.message ? error.message : error)
  return /未登录|尚未登录|登录态|会话已?失效|token.*invalid|auth.*fail|请先登录|请重新登录|login.*required/i.test(text)
}

/** 是否「限流/每日配额用尽」类错误（kdocs-cli 429001，次日 08:00 恢复）。 */
export function isRateLimitError(error) {
  const text = String(error && error.message ? error.message : error)
  return /调用次数已达上限|次数上限|429|rate.?limit|quota|将于.*恢复/i.test(text)
}

/* ------------------------------------------------------------------ */
/* wps_sid 会话管理                                                    */
/* ------------------------------------------------------------------ */

/**
 * 从 Windows 凭据管理器读取 kdocs-cli 引擎保存的 wps_sid（与引擎同会话，
 * 是唯一能用于下载 URL 鉴权的凭证）。见同目录 read_keychain_sid.py。
 */
export function readKeychainSid(dataHomeOverride) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'read_keychain_sid.py')
  if (!existsSync(script)) return ''
  const pyCandidates = [
    process.env.WPS_SYNC_PYTHON || '',
    process.env.PYTHON || '',
    join(homedir(), 'AppData', 'Roaming', 'WPS 灵犀', 'python-env', 'python.exe'),
    'python',
    'python3',
    'py',
  ].filter(Boolean)
  for (const py of pyCandidates) {
    try {
      const out = execSync(`"${py}" "${script}"`, {
        timeout: 5000, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const sid = String(out || '').trim()
      if (sid && /^V02[A-Za-z0-9]{10,}/.test(sid)) return sid
    } catch { /* try next */ }
  }
  return ''
}

/** wps_sid 令牌存储（JSON 文件，0600）。 */
export class WpsSidAuth {
  constructor(stateFile) {
    this.stateFile = stateFile ? expandHome(stateFile) : join(dataHome(), 'auth.json')
    this.state = this.load()
  }

  load() {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) } catch { return {} }
  }

  save(patch = {}) {
    this.state = { ...this.state, ...patch }
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSafe(tmp, this.stateFile)
  }

  hasSid() { return Boolean(this.state.sid) }
  sid() { return this.state.sid || '' }
  driveId() { return this.state.driveId || '' }
  setDriveId(id) { if (id && id !== this.state.driveId) this.save({ driveId: id }) }

  clear() {
    this.save({ sid: undefined, savedAt: undefined, user: undefined, driveId: undefined, loggedOut: true })
  }

  loggedOut() { return Boolean(this.state.loggedOut) }
  clearLoggedOut() { if (this.state.loggedOut) this.save({ loggedOut: undefined }) }

  /** 从密钥链恢复 sid（用户显式退出过则不恢复）。成功返回 true。 */
  tryRestoreFromKeychain() {
    if (this.loggedOut()) return false
    const kcSid = readKeychainSid()
    if (!kcSid) return false
    // 密钥链 sid 与 kdocs-cli 引擎同会话，直接采信，不做下载验证（省配额、防误杀）
    if (kcSid !== this.sid()) this.save({ sid: kcSid, savedAt: Date.now() })
    return true
  }
}

/* ------------------------------------------------------------------ */
/* mcp-center 直连引擎（主路径，2026-09-18 M1 实测验证）                */
/* ------------------------------------------------------------------ */

/** 金山官方工具中心（kdocs-cli 底层实际请求的同一服务）。 */
export const SKILL_HUB_URL = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool'

/**
 * mcp-center skill_hub 直连客户端。
 * 协议：POST JSON {"tool":"<snake_name>","args":{...}}，鉴权 Cookie: wps_sid=<会话>。
 * 响应为 SSE（event:result + event:finish）或纯 JSON，统一解析出 data。
 * 优点：无需 kdocs-cli.exe / 密钥链，网页会话 sid 直接驱动全链路（列表/下载/上传实测通过）。
 */
export class McpCenterClient {
  constructor(opts = {}) {
    this.opts = opts
  }

  get sid() {
    return this.opts.auth ? this.opts.auth.sid() : (this.opts.sid || '')
  }

  /** run(service, action, params)：action 连字符转下划线即工具名，与 KdocsCli 接口对齐。 */
  async run(service, action, params = {}, options = {}) {
    const tool = String(action).replace(/-/g, '_')
    const timeout = options.timeout || this.opts.timeoutMs || 60000
    const res = await fetch(SKILL_HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `wps_sid=${this.sid}` },
      body: JSON.stringify({ tool, args: params || {} }),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    if (res.status === 401) {
      throw new Error('WPS: 会话已失效（引擎返回 401），请重新登录')
    }
    if (!res.ok && !text) {
      throw new Error(`WPS ${service}.${action}: HTTP ${res.status}`)
    }
    return this.parseOutput(text, `${service}.${action}`)
  }

  /** 解析响应：SSE（data: 行）或纯 JSON，code!=0 抛错，递归解包 {code,data}。 */
  parseOutput(text, labelStr) {
    let payload = null
    if (text.startsWith('{')) {
      try { payload = JSON.parse(text) } catch { payload = null }
    }
    if (!payload) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue
        let j
        try { j = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (j.code === 0 && j.data !== undefined) { payload = j; break }
        if (j.code !== undefined && j.code !== 0) { payload = j; break }
      }
    }
    if (!payload) {
      throw new Error(`WPS ${labelStr}: 响应无法解析（前 200 字符：${text.slice(0, 200)}）`)
    }
    if (payload.code !== 0) {
      throw new Error(`WPS ${labelStr} 失败（code=${payload.code}）：${payload.message || payload.msg || '未知错误'}`)
    }
    let data = payload.data
    while (data && typeof data === 'object' && typeof data.code === 'number' && data.code === 0 && data.data !== undefined) {
      data = data.data
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`WPS ${labelStr} 失败（内层 code=${data.code}）：${data.message || data.msg || '未知错误'}`)
    }
    return data
  }
}

/* ------------------------------------------------------------------ */
/* kdocs-cli 引擎（备用路径：mcp-center 直连不可用时切换）              */
/* ------------------------------------------------------------------ */

/** kdocs-cli 子进程封装：定位 / 下载 / run(service, action, params) → data。 */
export class KdocsCli {
  /**
   * @param {object} opts
   * @param {string}  [opts.cliPath]     显式指定 kdocs-cli.exe 路径
   * @param {object}  [opts.auth]        WpsSidAuth 实例（提供 sid/driveId）
   * @param {number}  [opts.timeoutMs]   默认超时
   */
  constructor(opts = {}) {
    this.opts = opts
  }

  get sid() {
    return this.opts.auth ? this.opts.auth.sid() : (this.opts.sid || '')
  }

  candidatePaths() {
    const paths = []
    if (this.opts.cliPath) paths.push(expandHome(this.opts.cliPath))
    if (process.env.KDOCS_CLI_PATH) paths.push(process.env.KDOCS_CLI_PATH)
    paths.push(join(dataHome(), KDOCS_CLI_NAME))
    // 灵犀桌面自带 kdocs-cli 兜底
    for (const drive of ['C', 'D']) {
      paths.push(join(drive + ':', 'Program Files', 'lingxi-desktop', 'resources', 'kdocs-cli', KDOCS_CLI_NAME))
    }
    paths.push(join(homedir(), 'AppData', 'Roaming', 'WPS 灵犀', 'serverdir', KDOCS_CLI_NAME))
    return [...new Set(paths.filter(Boolean))]
  }

  findCli() {
    for (const p of this.candidatePaths()) {
      try {
        if (existsSync(p) && statSync(p).isFile()) return p
      } catch { /* ignore */ }
    }
    return null
  }

  /**
   * 确保引擎可用；找不到时从金山官方 KS3 下载到 data 目录。
   * 注意：kdocs-cli.exe 约 10~40MB（以实际为准），首次使用需下载。
   */
  async ensureCli(downloadIfMissing = true, onProgress) {
    const found = this.findCli()
    if (found) return found
    if (!downloadIfMissing) {
      throw new Error(`WPS: 未找到 kdocs-cli。请把 kdocs-cli.exe 放到 ${dataHome()} 或配置 cliPath。`)
    }
    const dest = join(dataHome(), KDOCS_CLI_NAME)
    mkdirSync(dirname(dest), { recursive: true })
    const res = await fetch(KDOCS_CLI_DOWNLOAD)
    if (!res.ok) throw new Error(`下载 kdocs-cli 失败：HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
    onProgress?.(dest)
    return dest
  }

  /** 解析输出：code!=0 抛错；递归解包 {code,data} 嵌套。 */
  parseOutput(text, labelStr) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`WPS ${labelStr}: kdocs-cli 输出不是 JSON（前 200 字符：${text.slice(0, 200)}）`)
    }
    if (json.code !== 0) {
      throw new Error(`WPS ${labelStr} 失败（code=${json.code}）：${json.message || json.msg || '未知错误'}`)
    }
    let data = json.data
    while (data && typeof data === 'object' && typeof data.code === 'number' && data.code === 0 && data.data !== undefined) {
      data = data.data
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`WPS ${labelStr} 失败（内层 code=${data.code}）：${data.message || data.msg || '未知错误'}`)
    }
    return data
  }

  /**
   * 调用 kdocs-cli：`kdocs-cli.exe <service> <action> '<json>' --compact`
   * 关键：子进程环境注入 WPS_SID、清空 TMP_LX_UUID（防宿主灵犀会话覆盖）。
   */
  run(service, action, params = {}, options = {}) {
    const cli = this.ensureCliSync?.() || this.findCli()
    if (!cli) return Promise.reject(new Error(`WPS: 未找到 kdocs-cli（先调用 ensureCli 或手动放置）。`))
    const timeout = options.timeout || this.opts.timeoutMs || 60000
    const args = [service, action, JSON.stringify(params || {}), '--compact']
    const env = { ...process.env, WPS_SID: this.sid, TMP_LX_UUID: '' }
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = spawn(cli, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        rejectPromise(new Error(`WPS: 无法启动 kdocs-cli（${error.message}）`))
        return
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        rejectPromise(new Error(`WPS ${service}.${action}: 执行超时（${timeout}ms）`))
      }, timeout)
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectPromise(new Error(`WPS ${service}.${action}: 启动失败（${error.message}）`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 && !stdout) {
          rejectPromise(new Error(`WPS ${service}.${action}: 退出码 ${code}（${stderr.trim().slice(0, 200)}）`))
          return
        }
        try {
          resolvePromise(this.parseOutput(stdout, `${service}.${action}`))
        } catch (error) {
          rejectPromise(error)
        }
      })
    })
  }
}

/* ------------------------------------------------------------------ */
/* 受控浏览器一键登录（CDP）                                           */
/* ------------------------------------------------------------------ */

/** 最小 CDP 客户端（Node >= 22 全局 WebSocket）。支持 `cdp.on(method, fn)` 订阅事件。 */
export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
  }

  /** 订阅 CDP 事件（如 Network.requestWillBeSent）。 */
  on(method, fn) {
    this.handlers.set(method, fn)
    return this
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl)
    this.ws.addEventListener('message', (ev) => this.onMessage(ev))
    await new Promise((resolvePromise, rejectPromise) => {
      this.ws.addEventListener('open', () => resolvePromise(), { once: true })
      this.ws.addEventListener('error', () => rejectPromise(new Error('无法连接浏览器调试端口')), { once: true })
    })
  }

  onMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.method && this.handlers.has(msg.method)) {
      try { this.handlers.get(msg.method)(msg.params || {}) } catch { /* ignore */ }
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolvePromise, rejectPromise } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) rejectPromise(new Error(`CDP ${msg.error.message || 'error'}`))
      else resolvePromise(msg.result || {})
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolvePromise, rejectPromise })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() { try { this.ws?.close() } catch { /* ignore */ } }
}

/** 探测系统浏览器（Edge 优先，其次 Chrome）。 */
export function findBrowser(browserPath) {
  if (browserPath) {
    const p = expandHome(browserPath)
    if (existsSync(p)) return p
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const candidates = [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

function findWpsSid(cookies) {
  if (!Array.isArray(cookies)) return ''
  const sids = cookies.filter((c) => c.name === 'wps_sid' && c.value)
  if (!sids.length) return ''
  const kdocs = sids.filter((c) => /kdocs\.cn/i.test(c.domain || ''))
  return (kdocs[0] || sids[0]).value
}

function readNicknameCookie(cookies) {
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (['nickname', 'user_nickname', 'display_name'].includes(c.name) && c.value) {
      try { return decodeURIComponent(c.value) } catch { return c.value }
    }
  }
  return ''
}

function killBrowser(proc, userDataDir) {
  if (proc && proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* ignore */ }
  }
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * 受控浏览器登录：独立实例打开 WPS 网页版 → 轮询抓 wps_sid → 返回 {sid, nickname}。
 * 注意：浏览器 sid 只作身份凭证；最终持久化应优先密钥链同会话 sid（persistLoginSid）。
 */
export async function captureSidViaBrowser(browserPath, { loginTimeoutMs = 300000 } = {}) {
  const port = 9333 + Math.floor(Math.random() * 500)
  const userDataDir = join(tmpdir(), `wps-sync-login-${process.pid}-${Date.now()}`)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank',
  ]
  let proc
  try {
    proc = spawn(browserPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
  } catch (error) {
    throw new Error(`WPS: 无法启动浏览器（${error.message}）`)
  }
  let wsUrl = ''
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      const info = await res.json()
      if (info.webSocketDebuggerUrl) { wsUrl = info.webSocketDebuggerUrl; break }
    } catch { /* not ready */ }
    await sleep(250)
  }
  if (!wsUrl) {
    killBrowser(proc, userDataDir)
    throw new Error('WPS: 浏览器调试端口未就绪，请重试或改用手动回传 sid')
  }
  const cdp = new CdpConnection(wsUrl)
  await cdp.open()
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: LOGIN_PAGE, newWindow: true })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const deadline = Date.now() + loginTimeoutMs
    while (Date.now() < deadline) {
      const { cookies } = await cdp.send('Network.getAllCookies', {}, sessionId)
      const sid = findWpsSid(cookies)
      if (sid) {
        const nickname = readNicknameCookie(cookies)
        cdp.close()
        killBrowser(proc, userDataDir)
        return { sid, nickname }
      }
      await sleep(2000)
    }
  } catch (error) {
    cdp.close()
    killBrowser(proc, userDataDir)
    throw error
  }
  cdp.close()
  killBrowser(proc, userDataDir)
  throw new Error(`WPS: 等待登录超时（${Math.round(loginTimeoutMs / 1000)} 秒）。请登录后从浏览器 F12 → Cookies 复制 wps_sid 手动回传。`)
}

/* ------------------------------------------------------------------ */
/* 高层 API：WpsCloud（auth + cli + 文件操作 + path→id 映射）           */
/* ------------------------------------------------------------------ */

/** 文件列表条目投影（兼容扁平 / {file:{...}} 嵌套两种结构）。 */
export function projectItem(item) {
  const file = item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item
  if (!file || typeof file !== 'object') {
    return { name: '', size: 0, isFolder: false, id: '', driveId: '', parentId: '', mtime: null }
  }
  const isFolder = file.type === 'folder' || file.type === 'dir' || file.type === 'shortcut'
  return {
    name: file.name ?? '',
    size: Number(file.size) || 0,
    isFolder,
    id: file.id ?? '',
    driveId: file.drive_id ?? '',
    parentId: file.parent_id ?? '',
    mtime: file.mtime ?? null, // epoch 秒
    linkUrl: file.link_url ?? '',
    // 云端 sha1（实测：文件条目 hash.sum 有值，文件夹为空串）—— 精确比对与增量判定依赖它
    sha1: (file.hash && file.hash.sum) || '',
  }
}

/**
 * 带登录编排的云文档客户端。
 *   - ensureLogin(): 受控浏览器弹窗登录 → persistLoginSid
 *   - listDir(path) / downloadById() / uploadFile() 等同步原语
 *   - 引擎默认 mcp-center 直连（免 kdocs-cli.exe）；opts.engine='kdocs-cli' 切换备用路径
 */
export class WpsCloud {
  constructor(opts = {}) {
    this.auth = new WpsSidAuth(opts.stateFile)
    this.opts = { engine: 'mcp', ...opts }
    this.engine = this.opts.engine === 'kdocs-cli'
      ? new KdocsCli({ ...opts, auth: this.auth })
      : new McpCenterClient({ ...opts, auth: this.auth })
    this.cli = this.engine // 兼容 run(service, action, params) 调用形态
  }

  /** 登录编排：tryRestoreFromKeychain → captureSidViaBrowser → persistLoginSid。 */
  async ensureLogin({ interactive = true } = {}) {
    if (this.auth.hasSid()) return { sid: this.auth.sid(), restored: false }
    if (this.auth.tryRestoreFromKeychain()) return { sid: this.auth.sid(), restored: true }
    if (!interactive) throw new Error('WPS: 尚未登录（非交互模式，密钥链亦无可用会话）')
    const browser = findBrowser(this.opts.browserPath)
    if (!browser) throw new Error('WPS: 未找到 Edge/Chrome，无法弹窗登录；可手动回传 sid')
    const { sid: browserSid, nickname } = await captureSidViaBrowser(browser, this.opts)
    // 密钥链 sid 与引擎同会话（下载 URL 鉴权必须用它），浏览器 sid 仅身份凭证
    const kcSid = readKeychainSid()
    const finalSid = kcSid || browserSid
    this.auth.clearLoggedOut()
    this.auth.save({ sid: finalSid, savedAt: Date.now(), user: nickname || undefined })
    return { sid: finalSid, restored: false, via: kcSid ? 'keychain' : 'browser' }
  }

  /** 解析 drive_id（缓存）。 */
  async resolveDriveId() {
    if (this.auth.driveId()) return this.auth.driveId()
    const data = await this.cli.run('drive', 'list-my-files', { page_size: 1 })
    const driveId = data.drive_id || ''
    if (driveId) this.auth.setDriveId(driveId)
    return driveId
  }

  /** 列目录（根目录用 list-my-files，子目录用 list-files）。返回 {items, nextPageToken}。 */
  async listDir(parentId = '0', { pageSize = 100, pageToken = '' } = {}) {
    if (parentId === '0') {
      const data = await this.cli.run('drive', 'list-my-files', { page_size: pageSize })
      return { items: (data.items || []).map(projectItem), nextPageToken: data.next_page_token || '' }
    }
    const driveId = await this.resolveDriveId()
    const data = await this.cli.run('drive', 'list-files', {
      drive_id: driveId,
      parent_id: parentId,
      page_size: pageSize,
      ...(pageToken ? { page_token: pageToken } : {}),
    })
    return { items: (data.items || []).map(projectItem), nextPageToken: data.next_page_token || '' }
  }

  /** 按目录树递归列出全部条目（带相对路径）。 */
  async listAll(rootId = '0', maxPages = 200) {
    const all = []
    let pages = 0
    async function walk(cloud, id, pathName) {
      let pageToken = ''
      do {
        if (++pages > maxPages) throw new Error('翻页超限，终止以防配额耗尽')
        const { items, nextPageToken } = await cloud.listDir(id, { pageToken })
        pageToken = nextPageToken
        for (const f of items) {
          const rel = pathName ? `${pathName}/${f.name}` : f.name
          all.push({ ...f, path: rel })
          if (f.isFolder && f.id) await walk(cloud, f.id, rel)
        }
      } while (pageToken)
    }
    await walk(this, rootId, '')
    return all
  }

  /** 单文件/目录详情。 */
  async getFileInfo(fileId) {
    return this.cli.run('drive', 'get-file-info', { file_id: fileId, with_drive: true })
  }

  /** 下载文件（download-file 拿签名 URL → fetch + wps_sid Cookie → 流式落盘）。 */
  async downloadById(fileId, destPath) {
    const data = await this.cli.run('drive', 'download-file', { file_id: fileId, with_hash: true })
    const url = data.url || data.download_url || data.link_url || ''
    if (!url) throw new Error(`WPS download: 未返回下载地址（${JSON.stringify(data).slice(0, 200)}）`)
    const sid = this.auth.sid()
    const res = await fetch(url, {
      headers: {
        Referer: 'https://365.kdocs.cn/',
        Origin: 'https://365.kdocs.cn',
        ...(sid ? { Cookie: `wps_sid=${sid}; csrf=${sid}` } : {}),
      },
    })
    if (!res.ok) {
      throw new Error(`WPS 下载失败：HTTP ${res.status}${res.status === 403 ? '（下载 URL 需与引擎同会话的 wps_sid）' : ''}`)
    }
    mkdirSync(dirname(destPath), { recursive: true })
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
    return destPath
  }

  /** 上传本地文件（upload_new_file，base64 全量；v1 限制单文件大小）。 */
  async uploadFile(localPath, parentId = '0', { maxBytes = 50 * 1024 * 1024, name } = {}) {
    const stat = statSync(localPath)
    if (stat.size > maxBytes) {
      throw new Error(`文件 ${formatBytes(stat.size)} 超过上传上限 ${formatBytes(maxBytes)}（base64 全量通道限制）`)
    }
    const driveId = await this.resolveDriveId()
    // 显式 name 优先：WebDAV 层落盘到临时文件时必须保留原文件名
    const finalName = name || localPath.split(/[\\/]/).pop()
    if (!isUploadableName(finalName)) {
      throw new Error(`云端上传通道不支持后缀 .${String(finalName).split('.').pop()}（白名单：${UPLOAD_EXT_WHITELIST.join('/')}）；${finalName} 无法上行`)
    }
    const data = await this.cli.run('drive', 'upload-new-file', {
      drive_id: driveId,
      parent_id: parentId,
      name: finalName,
      content_base64: readFileSync(localPath).toString('base64'),
    }, { timeout: Math.max(this.opts.timeoutMs || 60000, 300000) })
    return {
      fileId: data.id || data.file_id || '',
      name: data.name || finalName,
      size: Number(data.size) || stat.size,
      sha1: (data.hash && data.hash.sum) || '',
    }
  }

  /**
   * 全量覆盖已有云端文件（upload-replace-file，需 file_id）。
   * 实测（2026-09-18）：同 id 覆盖、size/hash 随之更新，**不会**产生 "xxx(1).ext" 副本
   * —— 这是上行"更新"语义的唯一正确入口（直接 upload_new_file 同名会新建副本）。
   * 同样受扩展名白名单限制。
   */
  async replaceFile(fileId, localPath, parentId = '0', { maxBytes = 50 * 1024 * 1024 } = {}) {
    const stat = statSync(localPath)
    if (stat.size > maxBytes) {
      throw new Error(`文件 ${formatBytes(stat.size)} 超过上传上限 ${formatBytes(maxBytes)}（base64 全量通道限制）`)
    }
    const driveId = await this.resolveDriveId()
    const data = await this.cli.run('drive', 'upload-replace-file', {
      drive_id: driveId,
      parent_id: parentId,
      file_id: fileId,
      content_base64: readFileSync(localPath).toString('base64'),
    }, { timeout: Math.max(this.opts.timeoutMs || 60000, 300000) })
    return {
      fileId: data.id || fileId,
      name: data.name || '',
      size: Number(data.size) || stat.size,
      sha1: (data.hash && data.hash.sum) || '',
    }
  }

  /** 回收站列表（可据此检测"云端被删除"，虽无删除接口但可观测）。 */
  async listDeletedFiles({ pageSize = 100 } = {}) {
    const data = await this.cli.run('drive', 'list-deleted-files', { page_size: pageSize })
    return (data.items || []).map(projectItem)
  }

  /** 还原回收站文件到原位置。 */
  async restoreDeletedFile(fileId) {
    const driveId = await this.resolveDriveId()
    return this.cli.run('drive', 'restore-deleted-file', { drive_id: driveId, file_id: fileId })
  }

  /** 创建文件夹，返回 folderId。 */
  async createFolder(name, parentId = '0') {
    const driveId = await this.resolveDriveId()
    const data = await this.cli.run('drive', 'create-folder', {
      drive_id: driveId, parent_id: parentId, name, on_name_conflict: 'rename',
    })
    return data.id || data.file_id || ''
  }

  async rename(fileId, newName) {
    const driveId = await this.resolveDriveId()
    return this.cli.run('drive', 'rename-file', { drive_id: driveId || undefined, file_id: fileId, dst_name: newName })
  }

  async move(fileId, dstParentId) {
    const driveId = await this.resolveDriveId()
    return this.cli.run('drive', 'move-file', {
      drive_id: driveId, file_ids: [fileId], dst_drive_id: driveId, dst_parent_id: dstParentId,
    })
  }

  /**
   * 路径 → file_id 解析（含 dirIdCache；只增不改，rename 后 id 不变）。
   * cloudPath 形如 "" / "a" / "a/b"；不存在时 create=true 则逐级创建。
   */
  async resolvePath(cloudPath, { create = false } = {}) {
    this.dirCache = this.dirCache || new Map([['', '0']])
    if (this.dirCache.has(cloudPath)) return this.dirCache.get(cloudPath)
    const segments = cloudPath.split('/').filter(Boolean)
    let parentId = '0'
    let cur = ''
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg
      if (this.dirCache.has(cur)) { parentId = this.dirCache.get(cur); continue }
      const { items } = await this.listDir(parentId)
      const hit = items.find((f) => f.name === seg && f.isFolder)
      if (hit) {
        parentId = hit.id
      } else if (create) {
        parentId = await this.createFolder(seg, parentId)
      } else {
        throw new Error(`WPS: 云端目录不存在：${cur}`)
      }
      this.dirCache.set(cur, parentId)
    }
    return parentId
  }
}

export { createHash }
