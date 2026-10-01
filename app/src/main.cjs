/**
 * wps-sync 桌面外壳 —— Electron 主进程
 *
 * 职责：窗口 / 系统托盘 / IPC 桥接。业务逻辑全部复用项目根目录下已验证的 Node 模块
 * （src/core/webdrive.mjs、src/state.mjs）与 CLI（src/sync2.mjs），不在 Electron 里重写协议。
 *
 * 运行：cd app && npm run dev（另开终端 npm start），或 npm run build && npm start
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')

/**
 * 显式指定应用名：决定 %APPDATA% 下的用户数据目录名。
 * 不设的话 Electron 用 package.json 的 name（wps-sync-ui），与 productName 不一致。
 * ⚠️ 必须在**任何** app.getPath('userData') 之前调用 —— 该路径一旦取过就会被缓存。
 */
app.setName('wps-sync')

/**
 * 引擎根目录：打包后在 resources/engine —— 不能塞进 asar，
 * 因为同步是 spawn 子进程直接跑 src/sync2.mjs，子进程读不了 asar 内的文件。
 */
const ENGINE = app.isPackaged
  ? path.join(process.resourcesPath, 'engine')
  : path.resolve(__dirname, '..', '..')

/** Electron 默认的用户数据目录（%APPDATA%/wps-sync），已受 setName 影响。 */
const APP_DATA = app.getPath('userData')

/**
 * 可变数据（config.json、data/）放哪，按优先级：
 * ① 便携版：electron-builder 的 portable 启动器会设 PORTABLE_EXECUTABLE_DIR
 * ② 绿色版：exe 所在目录可写就用它 —— 数据跟着程序走，整个文件夹复制到哪都能用
 * ③ 其他（装在 Program Files 等只读位置）→ %APPDATA%/wps-sync
 * 目标都是「便携」：不往 C:\Users 里写业务数据。
 */
function dirWritable(dir) {
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function pickUserRoot() {
  if (!app.isPackaged) return ENGINE
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir && dirWritable(portableDir)) return portableDir
  const exeDir = path.dirname(process.execPath)
  if (dirWritable(exeDir)) return exeDir
  return APP_DATA
}
const USER_ROOT = pickUserRoot()
// 主进程内动态 import 的 state.mjs 也必须与子进程使用同一数据根，不能靠各自猜测。
process.env.WPS_SYNC_USER_ROOT = USER_ROOT
process.env.WPS_SYNC_HOME = path.join(USER_ROOT, 'data')

// 便携模式：连 Chromium 的缓存也放到 exe 旁边（.runtime），不往用户目录里写东西
if (app.isPackaged && USER_ROOT !== APP_DATA) {
  try { app.setPath('userData', path.join(USER_ROOT, '.runtime')) } catch { /* ignore */ }
}
// 开发模式：独立的缓存目录，避免和打包版抢同一个 %APPDATA%/wps-sync
if (!app.isPackaged) {
  app.setPath('userData', path.join(ENGINE, '.devdata'))
}

const CONFIG = path.join(USER_ROOT, 'config.json')
const AUTH = path.join(USER_ROOT, 'data', 'auth.json')
const SYNC2 = path.join(ENGINE, 'src', 'sync2.mjs')
const WDCLI = path.join(ENGINE, 'src', 'wpscli.mjs')
const APP_ICON = path.join(ENGINE, 'icons', 'cloud.png')

/* ---------------- 单实例限制 ---------------- */

/**
 * 同一时间只允许一个实例：多开会抢同一份快照与同步锁。
 *
 * 两个坑：
 * ① Electron 自带的 `requestSingleInstanceLock()` 在便携版上实测不可靠
 *    （第二个实例照样启动），所以这里自己用锁文件兜底。
 * ② 锁**不能**放在 USER_ROOT —— 便携版的 USER_ROOT 取决于 PORTABLE_EXECUTABLE_DIR，
 *    不同实例可能算出来不一样，锁就形同虚设（实测踩过）。
 *    放到固定的 %APPDATA%/wps-sync 下才可靠。
 * 锁里记 pid，进程死了自动视为过期，避免崩溃后残留把程序锁死。
 */
const LOCK_FILE = path.join(APP_DATA, '.instance.lock')

/**
 * 只在「拦下重复启动」或「锁文件异常」时记一行日志，便于排查
 * “双击没反应”这类问题（正常启动不写，避免日志无谓增长）。
 */
function lockLog(msg) {
  try {
    fs.appendFileSync(path.join(APP_DATA, '.instance.log'), `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`)
  } catch { /* ignore */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function acquireInstanceLock() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (info.pid && info.pid !== process.pid && pidAlive(info.pid)) {
      lockLog(`已有实例在运行（pid=${info.pid}），本次退出`)
      return false
    }
    lockLog(`清理过期锁（pid=${info.pid} 已不存在）`)
  } catch (e) {
    if (e.code !== 'ENOENT') lockLog(`锁文件读取异常：${e.code || e.message}`)
  }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now(), userRoot: USER_ROOT }))
  } catch (e) {
    lockLog(`锁文件写入失败（${e.code || e.message}），放行`)
    return true // 写不进去就不拦，总比打不开强
  }
  const release = () => { try { fs.rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ } }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130) })
  return true
}

const IS_FIRST_INSTANCE = acquireInstanceLock()

/**
 * 首次运行：把打包时带进来的配置与登录状态复制到用户数据目录。
 * 「带登录状态的 exe」就靠这一步——之后重新登录会直接覆盖 userData 里的那份。
 */
function ensureUserData() {
  if (!app.isPackaged) return
  try {
    fs.mkdirSync(path.join(USER_ROOT, 'data'), { recursive: true })
    for (const [target, tpl] of [
      [CONFIG, path.join(ENGINE, 'config.json')],
      [AUTH, path.join(ENGINE, 'data', 'auth.json')],
    ]) {
      if (!fs.existsSync(target) && fs.existsSync(tpl)) fs.copyFileSync(tpl, target)
    }
  } catch (err) {
    console.error('初始化用户数据目录失败：', err.message)
  }
}
/**
 * 开发模式：只有显式设 WPS_SYNC_DEV=1 才连 vite dev server（http://localhost:5173）；
 * 否则一律加载已构建的 dist/index.html。这样即使忘了起 dev server 也不会白屏。
 */
const IS_DEV = process.env.WPS_SYNC_DEV === '1'

let win = null
let tray = null
/** 正在跑的同步子进程（同一时刻只允许一个） */
let running = null
/** 删除确认事务期间阻止手动同步，并让监听事件继续留在队列。支持并发 IPC 计数。 */
let deletionBusyCount = 0
const deletionBusy = () => deletionBusyCount > 0

/* ---------------- 配置与状态 ---------------- */

const readJson = (f, fb) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fb }
}
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`
  const prev = `${f}.prev`
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', 'utf8')
  try {
    if (fs.existsSync(prev)) fs.rmSync(prev, { force: true })
    if (fs.existsSync(f)) fs.renameSync(f, prev)
    fs.renameSync(tmp, f)
  } catch (err) {
    try { if (!fs.existsSync(f) && fs.existsSync(prev)) fs.renameSync(prev, f) } catch { /* 保留 prev 供手动恢复 */ }
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore cleanup error */ }
    throw err
  }
}

const clampInt = (value, fallback, min, max) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback
}

/**
 * UI 配置不能绕过生产安全上限。尤其不能再把并发/QPS 调回昨夜的 16/32。
 * 未识别字段原样保留，避免设置页保存时误删未来配置。
 */
function sanitizeConfig(input) {
  const current = readJson(CONFIG, {})
  const next = { ...current, ...(input && typeof input === 'object' ? input : {}) }
  if (Array.isArray(next.exclude) && !next.exclude.every((x) => typeof x === 'string' && x.length <= 200)) {
    throw new Error('排除规则必须是长度不超过 200 的字符串数组')
  }
  if (Array.isArray(next.pairs)) {
    const names = new Set()
    for (const p of next.pairs) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name || names.has(p.name)) throw new Error('同步目录名称不能为空且必须唯一')
      if (typeof p.localDir !== 'string' || !path.isAbsolute(p.localDir)) throw new Error(`同步目录必须是绝对路径：${p.name}`)
      if (typeof p.cloudPath !== 'string' || !p.cloudPath || /(^|\/)\.\.?($|\/)|[\\\0]/.test(p.cloudPath)) throw new Error(`云端路径不合法：${p.name}`)
      names.add(p.name)
    }
  }
  const sync = { ...(current.sync || {}), ...(next.sync || {}) }
  next.sync = {
    ...sync,
    concurrency: clampInt(sync.concurrency, 4, 1, 4),
    maxQps: clampInt(sync.maxQps, 8, 1, 8),
    listCount: clampInt(sync.listCount, 2000, 200, 10000),
    cloudPullMaxFiles: clampInt(sync.cloudPullMaxFiles, 300, 1, 1000),
    cloudPullMaxMB: clampInt(sync.cloudPullMaxMB, 2048, 1, 10240),
    // 删除台账是最高优先级功能；自动重命名仍停用，直到 rclone 迁移后重新设计。
    ignoreOldFiles: false,
    followRename: false,
  }
  const cp = { ...(current.cloudPull || {}), ...(next.cloudPull || {}) }
  next.cloudPull = { ...cp, enabled: cp.enabled === true, intervalMin: clampInt(cp.intervalMin, 30, 30, 1440) }
  if (!Array.isArray(next.pairs)) next.pairs = current.pairs || []
  if (!Array.isArray(next.exclude)) next.exclude = current.exclude || []
  return next
}

/* ---------------- 会话日志（「传输」页） ---------------- */

/**
 * 「传输」页的日志在渲染进程里只是一段字符串，窗口一关就随渲染进程一起销毁。
 * 所以在主进程留一份**本次运行（进程生命周期）**的环形缓冲：
 * ① 窗口关着的时候（托盘后台监听上传、定时任务）日志照样进缓冲，不再整段丢；
 * ② 窗口重开后渲染进程 invoke('log:history') 取回历史，与之后的实时推流无缝衔接。
 * 只放内存、不落盘：跨重启要看 <程序目录>\data\sync.log（引擎自己 tee 的文件）。
 */
const LOG_MAX_CHARS = 400000
/** [{ seq, text }]，seq 单调递增，用来判断有没有被裁掉过 */
let logChunks = []
let logChars = 0
let logSeq = 0
/**
 * 渲染进程是否已完成 history 拉取。
 * 没完成就直推 = 推给一个还没注册监听的页面 → 这几行永久丢失，所以宁可不推（只进缓冲）。
 */
let logSinkReady = false
/**
 * 已经交给**当前这个页面**的最大 seq。
 * history 只返回比它新的部分：同一页面重复调用不会出现重复行，
 * 而窗口重开（did-finish-load 把它清零）时又能拿到整段会话日志。
 */
let logDeliveredSeq = 0

function pushLog(text) {
  if (text == null) return
  const s = String(text)
  if (!s) return
  logSeq += 1
  logChunks.push({ seq: logSeq, text: s })
  logChars += s.length
  // 超上限从最老的开始丢，保证长时间运行不涨内存
  while (logChars > LOG_MAX_CHARS && logChunks.length > 1) logChars -= logChunks.shift().text.length
  if (!logSinkReady) return
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try { win.webContents.send('sync:log', s); logDeliveredSeq = logSeq } catch { /* 窗口正在销毁，忽略 */ }
  }
}

ipcMain.handle('log:history', () => {
  const pending = logChunks.filter((c) => c.seq > logDeliveredSeq)
  const text = pending.map((c) => c.text).join('')
  // 这个页面已经看到的最后一条与现存最老一条之间有断裂 → 中间的日志被上限裁掉了
  const truncated = logChunks.length > 0 && logChunks[0].seq > logDeliveredSeq + 1
  logDeliveredSeq = logSeq
  // 先置位再返回：本函数返回之后产生的日志才走直推，不会与这段历史重复
  logSinkReady = true
  return { text, truncated }
})

ipcMain.handle('log:clear', () => {
  logChunks = []
  logChars = 0
  /**
   * 序号一起归零，否则「清空 → 关窗 → 再开」时，
   * history 会看到 logChunks[0].seq 远大于 logDeliveredSeq 而**误报**「更早的日志已按上限丢弃」——
   * 实际是用户主动清的。归零后重开得到的就是干净的 truncated=false。
   */
  logSeq = 0
  logDeliveredSeq = 0
  return { ok: true }
})

/* ---------------- 窗口 ---------------- */

function createWindow() {
  win = new BrowserWindow({
    // 默认尺寸 = 最小尺寸（用户要求：拖拽缩放的下限就作为默认大小）
    width: 880,
    height: 560,
    minWidth: 880,
    minHeight: 560,
    title: 'wps-sync',
    icon: APP_ICON,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    // 去掉标题栏：隐藏系统标题条，但保留右上角最小化/最大化/关闭按钮（Win11 风格）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#242424', height: 46 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const url = IS_DEV ? 'http://localhost:5173' : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault()
  })
  win.loadURL(url)
  /**
   * 每次（重新）加载页面：新渲染进程还没拿到历史，先只缓冲、不直推，
   * 等它 invoke('log:history') 后再置位（见 pushLog / logSinkReady）。
   * 兜底：页面若 3 秒内没来取（例如换回了没打补丁的旧页面），恢复直推，
   * 避免出现「日志一个字都不出」这种更糟的退化。
   */
  win.webContents.on('did-finish-load', () => {
    logSinkReady = false
    logDeliveredSeq = 0 // 新页面从零开始，history 会把它要的全量给它
    setTimeout(() => { logSinkReady = true }, 3000)
  })
  win.on('closed', () => { win = null; logSinkReady = false; logDeliveredSeq = 0 })
}

function createTray() {
  // 托盘用 cloud 图标（缩到 16×16，避免托盘区撑开）
  let icon = nativeImage.createFromPath(APP_ICON)
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('wps-sync')
  tray.on('double-click', () => {
    if (!win) createWindow()
    else if (win.isMinimized()) win.restore()
    win.focus()
  })
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => { if (!win) createWindow(); else { win.show(); win.focus() } },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.exit(0) } },
  ]))
}

/* ---------------- IPC ---------------- */

ipcMain.handle('config:get', () => readJson(CONFIG, {}))
ipcMain.handle('config:set', (_e, cfg) => {
  const previous = readJson(CONFIG, {})
  try {
    const safe = sanitizeConfig(cfg)
    writeJson(CONFIG, safe)
    // 监听层在 startWatch() 时编译 exclude/pairs；候选监听全部成功后才替换旧监听。
    if (app.isReady() && watchRequested) {
      const r = startWatch()
      if (r.error) {
        writeJson(CONFIG, previous)
        return { error: `配置未生效，监听重建失败：${r.error}` }
      }
    }
    return safe
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('auth:status', () => {
  const a = readJson(AUTH, {})
  const sid = a.sid || ''
  return {
    logged: Boolean(sid),
    hint: sid ? `${sid.slice(0, 6)}…` : '',
    savedAt: a.savedAt || 0,
    user: a.user || '',
    driveId: a.driveId || '',
  }
})

/** 登录：调 wpscli.mjs login（独立 Edge 实例弹登录页，自动抓 wps_sid）。 */
ipcMain.handle('auth:login', () => new Promise((resolve) => {
  const p = runNode([WDCLI, 'login'], resolve, { trackSync: false })
  p.on('error', () => resolve({ ok: false, code: -1, out: '启动失败' }))
}))

ipcMain.handle('shell:openFolder', (_e, p) => shell.openPath(p || USER_ROOT))

/** 拉起系统目录选择窗口。 */
ipcMain.handle('shell:pickFolder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || undefined,
    title: '选择本地同步目录',
  })
  return r.canceled ? null : r.filePaths[0]
})

/**
 * 云盘 id 必须显式配置：不内置任何默认值 —— 否则用户漏配时会静默连到别人的盘，
 * 拿到 401/403 也看不出原因。缺配置就抛明确错误。
 */
function requireDriveId(cfg) {
  const id = cfg?.driveId
  if (!id) throw new Error('config.json 缺少 driveId（云盘 id），请先在「设置」页填写')
  return String(id)
}

/** 列云端目录（直接复用 WebDrive，不走 CLI）。 */
ipcMain.handle('cloud:list', async (_e, cloudPath) => {
  try {
    const cfg = readJson(CONFIG, {})
    const sid = readJson(AUTH, {}).sid
    if (!sid) return { error: '未登录' }
    const { WebDrive } = await import(pathToFileURL(path.join(ENGINE, 'src', 'core', 'webdrive.mjs')).href)
    const wd = new WebDrive({ sid, groupId: requireDriveId(cfg) })
    const id = cloudPath ? await wd.resolvePath(cloudPath) : '0'
    const items = await wd.list(id)
    if (items.truncated) return { error: '云端目录清单不完整，请稍后刷新；不影响本地监听上传' }
    return { path: cloudPath || '', items }
  } catch (err) {
    const busy = err?.kind === 'rate-limit' || err?.status === 429 || err?.retryable
    return {
      error: busy
        ? '云端浏览暂时不可用，请稍后刷新；不影响本地监听上传'
        : `云端浏览失败：${err?.message || err}`,
    }
  }
})

/** 造一个 WebDrive 实例（复用根目录已验证的模块）。 */
async function makeWd() {
  const cfg = readJson(CONFIG, {})
  const sid = readJson(AUTH, {}).sid
  if (!sid) throw new Error('未登录')
  const { WebDrive } = await import(pathToFileURL(path.join(ENGINE, 'src', 'core', 'webdrive.mjs')).href)
  return { wd: new WebDrive({ sid, groupId: requireDriveId(cfg) }), cfg }
}

/* ---- 文件操作（重命名 / 移动 / 复制 / 删除 / 新建文件夹 / 下载） ---- */

ipcMain.handle('cloud:rename', async (_e, fileId, newName) => {
  try {
    const { wd } = await makeWd()
    await wd.rename(fileId, newName)
    return { ok: true }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('cloud:mkdir', async (_e, name, cloudPath) => {
  try {
    const { wd } = await makeWd()
    const parentId = cloudPath ? await wd.resolvePath(cloudPath, { create: true }) : '0'
    const id = await wd.mkdir(name, parentId)
    return { ok: true, id }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('cloud:move', async (_e, fileIds, srcPath, dstPath) => {
  try {
    const { wd } = await makeWd()
    const src = srcPath ? await wd.resolvePath(srcPath) : '0'
    const dst = await wd.resolvePath(dstPath, { create: true })
    const r = await wd.move(fileIds, dst, { srcParentId: src })
    return r.ok ? { ok: true } : { error: r.error || '移动失败' }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('cloud:copy', async (_e, fileIds, srcPath, dstPath) => {
  try {
    const { wd } = await makeWd()
    const src = srcPath ? await wd.resolvePath(srcPath) : '0'
    const dst = await wd.resolvePath(dstPath, { create: true })
    const r = await wd.copy(fileIds, dst, { srcParentId: src })
    return r.ok ? { ok: true } : { error: r.error || '复制失败' }
  } catch (err) { return { error: err.message } }
})

/** 删除 = 移入云端回收站（可还原），不是彻底抹除。 */
ipcMain.handle('cloud:remove', async (_e, fileIds, srcPath) => {
  try {
    const { wd } = await makeWd()
    const src = srcPath ? await wd.resolvePath(srcPath) : '0'
    const r = await wd.remove(fileIds, { srcParentId: src })
    return r.ok ? { ok: true } : { error: r.error || '删除失败' }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('cloud:download', async (_e, fileId, name, preferDir) => {
  try {
    const defaultPath = preferDir ? path.join(preferDir, name) : name
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, title: '下载到' })
    if (canceled || !filePath) return { canceled: true }
    const { wd } = await makeWd()
    await wd.download(fileId, filePath)
    return { ok: true, path: filePath }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('deletions:list', async () => {
  const { loadDeletions } = await import(pathToFileURL(path.join(ENGINE, 'src', 'state.mjs')).href)
  return loadDeletions().items
})

function ledgerPathParts(relPath) {
  const raw = String(relPath || '')
  if (!raw || path.isAbsolute(raw) || /[\\\0]/.test(raw)) throw new Error('台账路径不是安全的相对路径')
  const parts = raw.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('台账路径包含不安全路径段')
  return parts
}

function assertInside(root, target, label) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error(`${label}超出允许根目录`)
}

function realInside(root, target) {
  const rr = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root)
  const rt = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target)
  const rel = path.relative(rr, rt)
  return Boolean(rel) && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/**
 * 删除台账执行器。每一项都在持有跨进程锁后重新读取，并按当前双端状态复核。
 * side=local：本地已消失 → 验证云端对象身份后移入 WPS 回收站。
 * side=cloud：云端已消失 → 确认仍缺失，验证本地内容身份，再备份并进 Windows 回收站。
 */
async function executeDeletion(key, cfg, mods, batchId) {
  const current = mods.state.loadDeletions().items.find((i) => i.key === key)
  if (!current) return { error: '未找到最新台账记录' }
  if (current.status !== 'pending') return { error: '该记录已不再是待处理状态' }
  const item = current
  const { setDeletionStatus } = mods.state
  const pair = (cfg.pairs || []).find((p) => p.name === item.pair)
  if (!pair) return { error: '找不到同步目录配置' }
  let parts
  try { parts = ledgerPathParts(item.relPath) } catch (err) { return { error: `拒绝删除：${err.message}` } }

  const sid = readJson(AUTH, {}).sid
  if (!sid) return { error: '未登录，无法在删除前复核云端状态' }
  const wd = new mods.WebDrive({
    sid,
    groupId: requireDriveId(cfg),
    requestQps: Math.min(4, Number(cfg.sync?.maxQps) || 4),
  })
  const relDir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
  const cloudDir = relDir ? `${pair.cloudPath}/${relDir}` : pair.cloudPath
  let parentId = ''
  let listed = []
  try {
    parentId = await wd.resolvePath(cloudDir)
    listed = await wd.list(String(parentId))
    if (listed.truncated) return { error: '删除前复核失败：云端目录清单不完整；未执行任何删除' }
  } catch (err) {
    if (!/云端目录不存在/.test(err.message)) return { error: `删除前复核云端失败：${err.message}；未执行任何删除` }
    parentId = ''
    listed = []
  }

  const expectedName = item.expectedName || parts[parts.length - 1]
  const currentById = listed.find((f) => f.id === String(item.fileId || ''))
  const currentByName = listed.find((f) => f.name === expectedName)

  if (item.side === 'cloud') {
    // 云端同路径已经恢复或重建：旧删除已失效，绝不能继续删本地。
    if (currentByName) {
      setDeletionStatus(item.key, 'ignored', '云端同路径已恢复或重建，自动撤销删除待办')
      return { error: '云端同路径已恢复或重建，已撤销这条删除待办；本地未删除' }
    }

    const root = path.resolve(pair.localDir)
    const localPath = path.resolve(root, ...parts)
    try { assertInside(root, localPath, '本地文件') } catch (err) { return { error: `拒绝删除：${err.message}` } }
    if (!fs.existsSync(localPath)) {
      setDeletionStatus(item.key, 'handled', '两端均已不存在')
      return { ok: true, msg: '本地也已无此文件' }
    }
    if (fs.statSync(localPath).isDirectory()) return { error: '当前只允许按文件确认删除，不自动删除目录' }
    if (!realInside(root, localPath)) return { error: '拒绝删除：真实路径经 reparse point 越出同步根目录' }
    if (!item.expectedLocalSha1) return { error: '台账缺少删除前的本地 SHA-1，无法安全确认；请重新核对生成待办' }
    let localHash
    try { localHash = await mods.hashFile(localPath, { md5: false }) } catch (err) { return { error: `无法校验本地文件内容：${err.message}` } }
    if (localHash.sha1 !== item.expectedLocalSha1) {
      setDeletionStatus(item.key, 'ignored', '本地文件内容已变化，旧删除待办失效')
      return { error: '本地文件在等待确认期间已变化，已撤销旧待办；未删除文件' }
    }

    const pairId = createHash('sha256').update(`${item.pair}\0${pair.localDir}`).digest('hex').slice(0, 16)
    const backupRoot = path.join(USER_ROOT, 'data', 'deletion-backups', batchId, pairId)
    const backup = path.resolve(backupRoot, ...parts)
    try { assertInside(backupRoot, backup, '备份文件') } catch (err) { return { error: err.message } }
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    try { fs.copyFileSync(localPath, backup, fs.constants.COPYFILE_EXCL) } catch (err) { return { error: `备份失败：${err.message}` } }
    if (!fs.existsSync(backup) || fs.statSync(backup).size !== fs.statSync(localPath).size) return { error: `备份校验失败：${backup}` }
    await shell.trashItem(localPath)
    if (fs.existsSync(localPath)) return { error: `移入回收站失败；备份已保留：${backup}` }
    setDeletionStatus(item.key, 'handled', `本地已备份：${backup}`)
    return { ok: true, msg: `本地已备份并移入回收站（备份：${backup}）` }
  }

  if (!/^\d+$/.test(String(item.fileId || ''))) return { error: '该记录没有合法的云端 fileId，不能执行删除' }
  const root = path.resolve(pair.localDir)
  const localPath = path.resolve(root, ...parts)
  try { assertInside(root, localPath, '本地文件') } catch (err) { return { error: `拒绝删除：${err.message}` } }
  if (fs.existsSync(localPath)) {
    setDeletionStatus(item.key, 'ignored', '本地同路径已恢复或重建，自动撤销删除待办')
    return { error: '本地同路径已恢复或重建，已撤销这条删除待办；云端未删除' }
  }
  if (!currentById) {
    let recycled = false
    try { recycled = (await wd.listRecycle()).some((f) => f.id === String(item.fileId)) } catch (err) {
      return { error: `云端对象已不在原目录，且回收站复核失败：${err.message}；台账保持待处理` }
    }
    if (recycled) {
      setDeletionStatus(item.key, 'handled', '云端对象已在 WPS 回收站')
      return { ok: true, msg: '云端对象已在 WPS 回收站，已完成复核' }
    }
    return { error: '云端对象已不在原目录且回收站未找到，去向未知；台账保持待处理' }
  }
  if (currentById.name !== expectedName) return { error: '云端 fileId 当前名称已变化，拒绝按旧台账删除' }
  if (!item.expectedCloudSha1 || !currentById.sha1 || currentById.sha1 !== item.expectedCloudSha1) {
    setDeletionStatus(item.key, 'ignored', '云端文件内容已变化，旧删除待办失效')
    return { error: '云端文件在等待确认期间已变化，已撤销旧待办；未删除文件' }
  }

  let removeResult = null
  let removeError = null
  try {
    removeResult = await wd.remove([Number(item.fileId)], { srcParentId: Number(parentId) })
  } catch (err) {
    removeError = err
  }

  // 无论删除调用返回还是抛错，都执行 postflight，避免“服务端已删、客户端超时”悬空。
  try {
    const after = await wd.list(String(parentId))
    if (after.truncated) return { error: '删除后原目录复核不完整；台账保持待处理' }
    if (after.some((f) => f.id === String(item.fileId))) {
      return { error: removeError?.message || removeResult?.error || '删除后复核时 fileId 仍在原目录' }
    }
    const recycle = await wd.listRecycle()
    if (recycle.some((f) => f.id === String(item.fileId))) {
      setDeletionStatus(item.key, 'handled', '云端已移入 WPS 回收站并完成双重复核')
      return { ok: true, msg: '云端已移入 WPS 回收站并复核完成' }
    }
    return { error: '云端原目录与回收站都找不到此 fileId，结果未知；台账保持待处理' }
  } catch (err) {
    return { error: `删除结果未知，postflight 复核失败：${err.message}；台账仍保持待处理` }
  }
}

async function deletionModules() {
  const [state, webdrive, lock] = await Promise.all([
    import(pathToFileURL(path.join(ENGINE, 'src', 'state.mjs')).href),
    import(pathToFileURL(path.join(ENGINE, 'src', 'core', 'webdrive.mjs')).href),
    import(pathToFileURL(path.join(ENGINE, 'src', 'sync-lock.mjs')).href),
  ])
  return {
    state,
    WebDrive: webdrive.WebDrive,
    hashFile: webdrive.hashFile,
    acquireSyncLock: lock.acquireSyncLock,
  }
}

async function withDeletionLock(mods, fn) {
  deletionBusyCount += 1
  let release = null
  try {
    release = await mods.acquireSyncLock({
      waitMs: 90000,
      pollMs: 1000,
      owner: 'electron deletion confirmation',
      onWait: (pid) => {
        pushLog(`[${nowTime()}] [删除] 等待同步任务 pid ${pid} 结束…\n`)
      },
    })
    return await fn()
  } catch (err) {
    return { error: err.code === 'SYNC_LOCK_TIMEOUT' ? '另一个同步任务仍在运行，删除确认未执行，请稍后重试' : err.message }
  } finally {
    if (release) release()
    deletionBusyCount = Math.max(0, deletionBusyCount - 1)
    if (!deletionBusy() && watching && pendingChanges.size) scheduleUpload()
  }
}

ipcMain.handle('deletions:purge', async (_e, key) => {
  const cfg = readJson(CONFIG, {})
  const mods = await deletionModules()
  const item = mods.state.loadDeletions().items.find((i) => i.key === key)
  if (!item) return { error: '未找到记录' }
  const local = item.side === 'cloud'
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    title: local ? '确认删除本地文件' : '确认删除云端文件',
    message: local ? '云端已消失，是否备份后把本地文件移入 Windows 回收站？' : '本地已消失，是否把对应云端文件移入 WPS 回收站？',
    detail: item.relPath,
    buttons: ['取消', local ? '备份并移入回收站' : '移入云端回收站'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (confirm.response !== 1) return { canceled: true }
  return withDeletionLock(mods, () => executeDeletion(item.key, cfg, mods, randomUUID()))
})

ipcMain.handle('deletions:purgeBatch', async (_e, keys) => {
  const unique = [...new Set(Array.isArray(keys) ? keys.map(String) : [])]
  if (!unique.length) return { error: '没有选中待处理记录' }
  const cfg = readJson(CONFIG, {})
  const mods = await deletionModules()
  const byKey = new Map(mods.state.loadDeletions().items.map((i) => [i.key, i]))
  const items = unique.map((k) => byKey.get(k)).filter((i) => i && i.status === 'pending')
  if (!items.length) return { error: '选中记录已不再是待处理状态' }
  const detail = items.map((i) => `[${i.side === 'cloud' ? '删本地' : '删云端'}] ${i.relPath}`).join('\n')
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    title: `批量确认删除 ${items.length} 项`,
    message: '⚠️ 此操作非常危险，可能导致不可逆的数据丢失！',
    detail: `你正在确认把以下 ${items.length} 项的删除同步到另一端：\n\n${detail}\n\n风险：文件会从正常目录消失。本地文件会先备份再进 Windows 回收站；云端文件进入 WPS 回收站。每批最多处理 10 个，逐项复核，遇到失败立即停止。`,
    buttons: ['取消', `确认处理 ${items.length} 项`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (confirm.response !== 1) return { canceled: true }

  const batchId = randomUUID()
  let done = 0
  const errors = []
  // 用户可一次全选任意数量；内部每 10 项取得一次共享锁，逐项读取最新台账、复核并执行。
  for (let start = 0; start < items.length; start += 10) {
    const batch = items.slice(start, start + 10)
    const result = await withDeletionLock(mods, async () => {
      for (const selected of batch) {
        try {
          const r = await executeDeletion(selected.key, cfg, mods, batchId)
          if (!r.ok) return { error: `${selected.relPath}: ${r.error || '未知失败'}` }
          done += 1
        } catch (err) {
          return { error: `${selected.relPath}: ${err.message}` }
        }
      }
      return { ok: true }
    })
    if (!result.ok) {
      errors.push(result.error || '批次处理失败')
      break
    }
  }
  return { ok: errors.length === 0, done, total: items.length, errors, msg: errors.length ? `已处理 ${done}/${items.length}，遇错已停止` : `已处理 ${done} 项` }
})

ipcMain.handle('deletions:markBatch', async (_e, keys, status) => {
  if (status !== 'ignored') return { error: '批量操作只允许把待处理记录标记为 ignored' }
  const unique = [...new Set(Array.isArray(keys) ? keys.map(String) : [])]
  if (!unique.length) return { error: '没有选中记录' }
  const mods = await deletionModules()
  return withDeletionLock(mods, async () => {
    const d = mods.state.loadDeletions()
    const wanted = new Set(unique)
    let done = 0
    for (const item of d.items) {
      if (!wanted.has(item.key) || item.status !== 'pending') continue
      item.status = status
      item.handledAt = Date.now()
      done += 1
    }
    mods.state.saveDeletions(d)
    return { ok: true, done }
  })
})

ipcMain.handle('deletions:mark', async (_e, key, status) => {
  if (!['ignored', 'pending'].includes(status)) return false
  const mods = await deletionModules()
  const result = await withDeletionLock(mods, () => ({ ok: Boolean(mods.state.setDeletionStatus(String(key), status)) }))
  return Boolean(result.ok)
})

/**
 * 跑一次同步（spawn src/sync2.mjs）。stdout 实时转发给渲染进程，供「传输」页显示。
 * 用 ELECTRON_RUN_AS_NODE 让 electron 可执行文件当 node 用，避免依赖系统 node。
 */
function runNode(args, onDone, { trackSync = true } = {}) {
  const p = spawn(process.execPath, args, {
    cwd: USER_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WPS_SYNC_USER_ROOT: USER_ROOT,
      // kdocs-core 的 dataHome()：状态与 auth.json 都落在这里
      WPS_SYNC_HOME: path.join(USER_ROOT, 'data'),
    },
    windowsHide: true,
  })
  let out = ''
  let settled = false
  const finish = (code) => {
    if (settled) return // exit 与 close 都会触发，只处理一次，避免重复/漏发
    settled = true
    if (trackSync) {
      if (running === p) running = null
      snapIndex = null // 同步已改写快照，下次预检必须重新载入
      if (win) win.webContents.send('sync:done', { code })
    }
    if (onDone) onDone({ ok: code === 0, code, out })
  }
  p.stdout.on('data', (d) => {
    out += d.toString()
    pushLog(d.toString())
  })
  p.stderr.on('data', (d) => {
    out += d.toString()
    pushLog(d.toString())
  })
  p.on('error', (err) => {
    pushLog(`启动失败：${err.message}\n`)
    finish(-1)
  })
  p.on('exit', (code) => finish(code))
  p.on('close', (code) => finish(code))
  return p
}

ipcMain.handle('sync:run', (_e, mode) => {
  if (deletionBusy()) return { error: '删除确认正在进行，请等当前批次完成' }
  if (running) return { error: '已有同步任务在跑' }
  const map = {
    startup: ['--startup'],
    once: ['--once'],
    check: ['--check'],
    build: ['--build'],
    plan: ['--plan'],
  }
  if (!Object.prototype.hasOwnProperty.call(map, mode)) return { error: '不支持的同步模式' }
  const args = [SYNC2, ...map[mode]]
  running = runNode(args, (r) => {
    // 退出码 3：另一个同步（例如后台重建库）占着锁，本次什么都没做
    if (r.code === 3) {
      pushLog(`\n[${nowTime()}] 另一个同步任务正在进行，本次未执行，请稍后重试\n`)
    }
  })
  return { started: true, mode }
})

/* ---------------- 本地文件监听（变更即传） ---------------- */

const watchers = []
let watching = false
let watchRequested = false
let watchTimer = null
let watchRetryTimer = null
let watchGeneration = 0
let watchFailures = []
let pendingChanges = new Set()
let retryFullScan = true // 启动补扫，靠未推进的失败基线恢复重试，不依赖旧进程内存事件
/** absPath → "size:mtime"，用来识别 fs.watch 的假事件 */
const watchSeen = new Map()

const nowTime = () => new Date().toTimeString().slice(0, 8)
const pushWatchState = () => {
  if (win) {
    win.webContents.send('watch:state', {
      on: watching,
      pending: pendingChanges.size,
      degraded: watchRequested && !watching && watchFailures.length > 0,
      failures: watchFailures.slice(0, 10),
    })
  }
}

/** 超过这个事件数就不做逐文件预检，直接全量同步 */
const PRECHECK_MAX = 400
/** abs 路径 → 上次同步基线（来自 data/state.json），用于预检 */
let snapIndex = null
let snapLoadedAt = 0
let hashFileFn = null

/**
 * 载入快照索引（60 秒内复用）。同步跑完会强制失效，因为快照已被改写。
 */
function loadSnapIndex() {
  if (snapIndex && Date.now() - snapLoadedAt < 60000) return snapIndex
  const idx = new Map()
  const st = readJson(path.join(USER_ROOT, 'data', 'state.json'), { pairs: {} })
  for (const ps of Object.values(st.pairs || {})) {
    if (!ps || !ps.localDir || !ps.files) continue
    for (const [rel, s] of Object.entries(ps.files)) {
      if (!s || !s.localSize) continue
      idx.set(path.join(ps.localDir, ...rel.split('/')), s)
    }
  }
  snapIndex = idx
  snapLoadedAt = Date.now()
  return idx
}

/**
 * 变更预检：判断这些路径是否真的需要同步。
 *
 * 为什么需要：fs.watch 只能看到"文件被动过"，看不到"内容有没有变"。
 * 实测遇到的情况——WPS 官方客户端在处理删除时重写了同目录 100+ 个文件，
 * mtime 全变成当前时间、内容一字未改。不预检的话，这 100 个事件会触发一次
 * 全量同步，跑完却是"待上传 0"，日志里刷满噪声。
 *
 * 判定顺序：快照里没有 → 要同步；size 不同 → 要同步；
 * mtime 相同 → 丢弃；mtime 不同且 size 相同 → 哈希一次，与已同步基线一致就丢弃。
 */
async function precheck(absList) {
  const idx = loadSnapIndex()
  const need = []
  let same = 0
  for (const abs of absList) {
    const e = idx.get(abs)
    let st = null
    try { st = fs.statSync(abs) } catch (err) {
      if (err.code !== 'ENOENT') { need.push(abs); continue }
      st = null
    }

    if (!st) {
      // 已消失：快照里有（可能是删除/改名）才交给同步器；快照里没有 = 临时文件来去，忽略
      if (e) need.push(abs)
      else same += 1
      continue
    }
    if (st.isDirectory()) continue
    if (!e) { need.push(abs); continue } // 真·新文件
    if (st.size !== e.localSize) { need.push(abs); continue }
    if (Math.floor(st.mtimeMs) === e.localMtimeMs) { same += 1; continue }
    // size 相同、mtime 变了 → 唯一的可能是内容被改写或被 touch，哈希确认
    if (e.syncedSha1) {
      try {
        if (!hashFileFn) {
          const mod = await import(pathToFileURL(path.join(ENGINE, 'src', 'core', 'webdrive.mjs')).href)
          hashFileFn = mod.hashFile
        }
        const h = await hashFileFn(abs, { md5: false })
        if (h.sha1 === e.syncedSha1) { same += 1; continue }
      } catch { /* 哈希失败就当需要同步，交给同步器处理 */ }
    }
    need.push(abs)
  }
  return { need, same }
}

/** 排除项（与 config.exclude 同规则），监听层先挡一遍，避免临时文件刷屏 */
function makeExcluder(patterns) {
  const res = (patterns || []).map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'))
  return (name) => res.some((r) => r.test(name))
}

/**
 * fs.watch 的"变更"很多是假事件（WPS/AutoCAD 的临时文件、缩略图缓存、目录元数据）。
 * 这里做两道过滤：① 排除项 ② stat 后 size+mtime 与上次记录对比，没实质变化就丢弃。
 */
function onWatchEvent(root, filename, isExcluded) {
  const rel = String(filename)
  const base = rel.split(/[\\/]/).pop() || rel
  if (isExcluded(base)) return
  const abs = path.join(root, rel)
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    // 文件被删除/改名 → 也算变更（同步器会处理）
    if (!pendingChanges.has(abs)) { pendingChanges.add(abs); pushWatchState(); scheduleUpload() }
    return
  }
  if (st.isDirectory()) return
  const sig = `${st.size}:${Math.floor(st.mtimeMs)}`
  if (watchSeen.get(abs) === sig) return // 无实质变化，丢弃
  watchSeen.set(abs, sig)
  // 防内存膨胀：分批淘汰最旧的一半（直接 clear() 会让所有文件重新"首见即变更"）
  if (watchSeen.size > 100000) {
    let n = 0
    for (const k of watchSeen.keys()) {
      watchSeen.delete(k)
      if (++n >= 50000) break
    }
  }
  if (!pendingChanges.has(abs)) { pendingChanges.add(abs); pushWatchState(); scheduleUpload() }
}

/**
 * 跑一次上传。若被别的同步占用（sync2 退出码 3 = 它什么都没做），
 * 必须把这些变更**还回队列**再延后重试——否则用户的操作会被静默丢弃。
 * （实测踩过：重建库占锁 20 分钟，期间用户剪切的文件既没同步、删除日志也没写）
 */
function runUpload(absList) {
  retryFullScan = false
  running = runNode([SYNC2, '--once'], (r) => {
    if (r.code === 0) return
    retryFullScan = true
    // 任何失败都必须把事件还回队列。成功项已经写进快照，下轮会自动跳过；失败项会重试。
    for (const a of absList) pendingChanges.add(a)
    pushWatchState()
    const delay = r.code === 3 ? 60000 : 5 * 60 * 1000
    pushLog(
      r.code === 3
        ? `\n[${nowTime()}] [监听] 另一个写任务占用中，${absList.length} 处变更已排队，60 秒后自动重试\n`
        : `\n[${nowTime()}] [监听] 本轮上传未完整成功（退出码 ${r.code}），${absList.length} 处变更已保留，5 分钟后重试\n`,
    )
    // 新变更已经有短延时任务时，不用失败退避覆盖它；重试也不能被预检吞掉。
    if (!watchTimer) scheduleUpload(delay)
  })
}

/** 变更防抖：静默 delay 毫秒后先做预检，确认真有内容变化才跑同步；正在跑就顺延 */
function scheduleUpload(delay = 8000) {
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = setTimeout(async () => {
    watchTimer = null
    if (!watching) return
    if (running || deletionBusy() || !sidExists()) { scheduleUpload(); return }
    const absList = [...pendingChanges]
    pendingChanges = new Set()
    pushWatchState()
    if (retryFullScan) { runUpload(absList); return }
    if (!absList.length) return

    const note = (m) => pushLog(`\n[${nowTime()}] [监听] ${m}\n`)

    // 事件太多时不做预检（逐个哈希可能很慢），直接交给同步器
    if (absList.length > PRECHECK_MAX) {
      note(`${absList.length} 处变更（超过预检上限），开始上传`)
      runUpload(absList)
      return
    }
    let res
    try {
      res = await precheck(absList)
    } catch {
      res = { need: absList, same: 0 }
    }
    if (!res.need.length) {
      // 全部是"时间戳变了、内容没变"（WPS 官方客户端重写文件时常见）→ 静默忽略，不刷日志
      return
    }
    note(`${res.need.length} 处变更，开始上传${res.same ? `（另忽略 ${res.same} 处内容未变）` : ''}`)
    runUpload(absList)
  }, delay)
}

const sidExists = () => Boolean(readJson(AUTH, {}).sid)

function stopWatch({ keepPending = false, keepRequested = false } = {}) {
  watching = false
  if (!keepRequested) watchRequested = false
  watchGeneration += 1
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
  if (watchRetryTimer) { clearTimeout(watchRetryTimer); watchRetryTimer = null }
  for (const w of watchers) { try { w.close() } catch { /* ignore */ } }
  watchers.length = 0
  watchFailures = []
  if (!keepPending) pendingChanges = new Set()
  pushWatchState()
}

function scheduleWatchRetry(delay = 60000) {
  if (!watchRequested || watchRetryTimer) return
  watchRetryTimer = setTimeout(() => {
    watchRetryTimer = null
    if (!watchRequested) return
    const r = startWatch({ recovery: true })
    if (r.error) scheduleWatchRetry(Math.min(5 * 60 * 1000, delay * 2))
  }, delay)
}

function handleWatchFailure(generation, dir, err) {
  if (generation !== watchGeneration || !watchRequested) return
  watchFailures = [`${dir}: ${err.message}`]
  watching = false
  for (const w of watchers) { try { w.close() } catch { /* ignore */ } }
  watchers.length = 0
  pushWatchState()
  pushLog(`[${nowTime()}] [监听] ${dir} 运行时失效：${err.message}；进入降级状态并自动重试\n`)
  scheduleWatchRetry()
}

function startWatch({ recovery = false } = {}) {
  watchRequested = true
  const cfg = readJson(CONFIG, {})
  let isExcluded
  try { isExcluded = makeExcluder(cfg.exclude) } catch (err) { return { error: `排除规则无效：${err.message}` } }
  const desiredDirs = (cfg.pairs || [])
    .filter((p) => p.enabled && p.localDir)
    .map((p) => path.resolve(p.localDir))

  // 零启用目录是合法配置：明确关闭监听，而不是把设置回滚。
  if (!desiredDirs.length) {
    stopWatch({ keepPending: true })
    return { started: false, stopped: true, dirs: [] }
  }

  const failures = desiredDirs.filter((d) => !fs.existsSync(d)).map((d) => `${d}: 目录不存在`)
  const nextWatchers = []
  const nextGeneration = watchGeneration + 1
  for (const d of desiredDirs) {
    if (!fs.existsSync(d)) continue
    try {
      const w = fs.watch(d, { recursive: true }, (_ev, filename) => {
        if (!filename) return
        try { onWatchEvent(d, filename, isExcluded) } catch { /* ignore */ }
      })
      w.on('error', (err) => handleWatchFailure(nextGeneration, d, err))
      nextWatchers.push(w)
    } catch (err) {
      failures.push(`${d}: ${err.message}`)
    }
  }

  // 任一启用根缺失/失败，都不切走旧的完整 watcher 集合；若本来就没有，则进入 degraded。
  if (failures.length || nextWatchers.length !== desiredDirs.length) {
    for (const w of nextWatchers) { try { w.close() } catch { /* ignore */ } }
    watchFailures = failures.length ? failures : ['监听建立不完整']
    if (!watchers.length) watching = false
    pushWatchState()
    scheduleWatchRetry()
    return { error: `监听建立不完整：${watchFailures.join(' | ')}`, degraded: true, failures: watchFailures }
  }

  if (watchRetryTimer) { clearTimeout(watchRetryTimer); watchRetryTimer = null }
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
  for (const w of watchers) { try { w.close() } catch { /* ignore */ } }
  watchers.length = 0
  watchers.push(...nextWatchers)
  watchGeneration = nextGeneration
  watching = true
  watchFailures = []
  watchSeen.clear()
  pushWatchState()
  if (pendingChanges.size || retryFullScan) scheduleUpload()
  if (recovery && !running && !deletionBusy() && sidExists()) {
    // watcher 恢复后用一次全量 --once 补扫故障窗口内漏掉的事件。
    pushLog(`[${nowTime()}] [监听] 已恢复，开始全量补扫本地变更\n`)
    runUpload([])
  }
  return { started: true, dirs: desiredDirs, failures: [] }
}

ipcMain.handle('watch:start', () => startWatch())

ipcMain.handle('watch:stop', () => { stopWatch(); return { stopped: true } })
ipcMain.handle('watch:state', () => ({
  on: watching,
  pending: pendingChanges.size,
  degraded: watchRequested && !watching && watchFailures.length > 0,
  failures: watchFailures.slice(0, 10),
}))

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  if (!IS_FIRST_INSTANCE) {
    // 已有实例在跑：提示一下然后自行退出（非阻塞，免得用户不点就挂着）
    dialog
      .showMessageBox({
        type: 'info',
        title: 'wps-sync',
        message: 'wps-sync 已经在运行了',
        detail: '同一时间只能开一个。请点任务栏右下角的托盘图标（云朵）打开已运行的窗口。',
        buttons: ['知道了'],
      })
      .finally(() => app.exit(0))
    setTimeout(() => app.exit(0), 8000)
    return
  }
  ensureUserData() // 打包后首次运行：把内置的 config.json 与登录状态复制到用户数据目录
  createWindow()
  createTray()
  // 变更即传：启动即开启监听（已登录才有意义）。CLI 在子进程里跑，界面不会卡
  if (sidExists()) {
    const r = startWatch()
    if (r.error || r.reason) console.warn('[watch]', r.error || r.reason)
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  // 托盘常驻：关窗口不退出，只有托盘右键「退出」才结束
  if (process.platform !== 'darwin') { /* 保持运行 */ }
})
