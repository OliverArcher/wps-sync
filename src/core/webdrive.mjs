/**
 * webdrive.mjs — WPS 网页端云盘 API 客户端（drive.kdocs.cn，2026-09-18 抓包复现）
 *
 * 为什么需要它：mcp-center（kdocs-core.mjs 的主路径）的上传接口有**扩展名白名单**，
 * `.dwg` 等 CAD 格式一律 code=400001 拒绝；网页端走的是另一套 API，可上传任意格式。
 * 本模块只用 `Cookie: wps_sid=<会话>`，**不需要 csrf / 不需要浏览器 / 不消耗 mcp-center 配额**。
 *
 * 已实测通过的四个能力：
 *   列目录  GET  /api/v3/groups/<groupid>/files?parentid=<id>&count=<n>
 *   下载    GET  /api/v3/groups/<groupid>/files/<fileId>/download      → {fileinfo:{url}}
 *   建目录  POST /api/v5/files/file  {name, ftype:'folder', …}
 *   上传    ①GET /api/v5/files/upload/pre_check
 *          ②PUT /api/v5/files/upload/create_update → 直传 url + 鉴权头
 *          ③PUT <直传 url>（文件字节）
 *          ④POST /api/v5/files/file → 落库，返回文件信息
 *
 * 注意：网页 API 用**数字 id**，与 mcp-center 的字符串 id 是两套体系，不要混用。
 * groupid 与 mcp-center 的 drive_id 同值（见 config.json 的 driveId）。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, statSync, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname } from 'node:path'

export const WEB_API = 'https://drive.kdocs.cn'
/** 空内容的 md5 / sha1（建目录时要填，服务端校验非空）。 */
export const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
export const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'

export class WebDriveError extends Error {
  constructor(message, { kind = 'api', status = 0, method = '', path = '', retryAfterMs = 0, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'WebDriveError'
    this.kind = kind
    this.status = status
    this.method = method
    this.path = path
    this.retryAfterMs = retryAfterMs
    this.retryable = retryable
  }
}

const parseRetryAfter = (value) => {
  if (!value) return 0
  const sec = Number(value)
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

/** 流式算 md5/sha1（大文件不进内存）。 */
export function hashFile(filePath, { md5 = true, sha1 = true } = {}) {
  const m = md5 ? createHash('md5') : null
  const s = sha1 ? createHash('sha1') : null
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('data', (d) => { if (m) m.update(d); if (s) s.update(d) })
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise({ md5: m ? m.digest('hex') : '', sha1: s ? s.digest('hex') : '' }))
  })
}

export class WebDrive {
  /**
   * @param {object} opts
   * @param {string} opts.sid      wps_sid 会话
   * @param {string|number} opts.groupId  云盘 id（= drive_id，见 config.json 的 driveId）
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    this.opts = opts
    this.sid = opts.sid || ''
    this.groupId = String(opts.groupId || '')
    this.timeoutMs = opts.timeoutMs || 120000
    this.requestQps = Math.max(0, Number(opts.requestQps) || 0)
    this.nextRequestAt = 0
    this.dirCache = new Map([['', '0']])
  }

  get cookie() { return `wps_sid=${this.sid}` }

  headers(json = false) {
    return {
      Cookie: this.cookie,
      Referer: 'https://www.kdocs.cn/',
      Origin: 'https://www.kdocs.cn',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  async gate() {
    if (!this.requestQps) return
    const interval = Math.ceil(1000 / this.requestQps)
    const slot = Math.max(Date.now(), this.nextRequestAt)
    this.nextRequestAt = slot + interval
    const delay = slot - Date.now()
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }

  async req(path, { method = 'GET', json, body, headers, raw = false } = {}) {
    await this.gate()
    let res
    try {
      res = await fetch(`${WEB_API}${path}`, {
        method,
        headers: { ...this.headers(Boolean(json)), ...(headers || {}) },
        body: json ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      const timeout = cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
      throw new WebDriveError(
        timeout ? `WPS 网页端请求超时：${method} ${path}` : `WPS 网页端网络错误：${method} ${path}（${cause?.message || cause}）`,
        { kind: timeout ? 'timeout' : 'network', method, path, retryable: true, cause },
      )
    }
    if (raw) return res
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    if (res.status === 401 || res.status === 403) {
      throw new WebDriveError(`WPS 网页端：会话失效（HTTP ${res.status}），请重新登录`, { kind: 'auth', status: res.status, method, path })
    }
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500
      throw new WebDriveError(
        `WPS 网页端 ${method} ${path} 失败（HTTP ${res.status}）：${text.slice(0, 200)}`,
        { kind: res.status === 429 ? 'rate-limit' : 'http', status: res.status, method, path, retryable, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) },
      )
    }
    if (data && data.result && data.result !== 'ok') {
      throw new WebDriveError(`WPS 网页端 ${method} ${path}：${data.result} ${data.msg || ''}`, { kind: 'api', method, path })
    }
    return data !== null ? data : text
  }

  /**
   * 列目录。返回 [{id, name, size, isFolder, sha1, mtime, ctime, parentId}]。
   * **本函数已内建 offset 翻页，返回的就是全量**；条目数若撞上 count 上限，
   * 返回值上会挂 `truncated = true`，调用方必须据此告警而不是静默漏掉。
   *
   * ⚠ 分页语义（2026-09-20 二次实测，**前一版注释是错的，别再照抄**）：
   *   - `count` 是**页大小**（本次取多少条），返回区间 [offset, offset+count)，count=0 → HTTP 403
   *   - `offset` 翻页**稳定可靠**：count=30 依次取 offset=0/30/60/90 → 30/30/30/21，
   *     精确枚举 111 项，不重不漏（旧注释说"off-by-one 不能完整枚举"是误判）
   *   - **服务端把单次响应硬截到 200 条**：实测 222 项的目录只回 200 条 —— 这才是
   *     「深层目录漏扫 / 云端看不见的文件被反复重传成 (1) 副本」的真正根因。
   *     旧注释假设"本库最大目录 178 项，2000 有充分余量"，与实际不符。
   *   - `start` 仍被服务端忽略，固定传 0
   */
  async list(parentId = '0', { count = 2000, offset = 0 } = {}) {
    const PAGE_MAX = 200 // 服务端单次响应硬上限，实测值，不要调大
    const limit = Math.max(1, Number(count) || 2000)
    const page = Math.min(limit, PAGE_MAX)
    const mapIt = (f) => ({
      id: String(f.id),
      name: f.fname || '',
      size: Number(f.fsize) || 0,
      isFolder: f.ftype === 'folder',
      sha1: f.fsha || '',
      mtime: f.mtime || 0,
      ctime: f.ctime || 0,
      parentId: String(f.parentid ?? ''),
    })
    const out = []
    const seen = new Set()
    for (let off = Math.max(0, Number(offset) || 0); ; off += page) {
      const qs = new URLSearchParams({ parentid: String(parentId), start: '0', count: String(page), offset: String(off) })
      const data = await this.req(`/api/v3/groups/${this.groupId}/files?${qs.toString()}`)
      const files = data.files || []
      if (!files.length) break                      // 取完了（自然的页尾）
      let added = 0
      for (const f of files) {
        const id = String(f.id)
        if (seen.has(id)) continue
        seen.add(id)
        added += 1
        out.push(mapIt(f))
      }
      if (files.length < page) break                // 最后一页不满 → 到底了
      if (added !== files.length) {                 // 分页期间发生重排/重叠，不能假装完整
        out.truncated = true
        out.incompleteReason = 'pagination-unstable'
        break
      }
      if (out.length >= limit) {
        // 恰好撞上限时多探测 1 条，区分“正好这么多”与“确实还有”。
        const probeQs = new URLSearchParams({ parentid: String(parentId), start: '0', count: '1', offset: String(off + page) })
        const probe = await this.req(`/api/v3/groups/${this.groupId}/files?${probeQs.toString()}`)
        if ((probe.files || []).length) { out.truncated = true; out.incompleteReason = 'max-items' }
        break
      }
    }
    return out
  }

  /** 取文件直链（短期有效）。 */
  async downloadUrl(fileId) {
    const data = await this.req(`/api/v3/groups/${this.groupId}/files/${fileId}/download`)
    return data.fileinfo?.url || data.url || ''
  }

  /** 下载到本地（流式，不进内存）。 */
  async download(fileId, destPath) {
    const url = await this.downloadUrl(fileId)
    if (!url) throw new Error(`WPS 网页端：未取到下载地址（fileId=${fileId}）`)
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error(`WPS 下载地址不是 HTTPS：${u.protocol}`)
    // 签名 URL 默认不需要 wps_sid；只对 kdocs.cn 自家域发送 Cookie，避免凭据泄给外部对象存储。
    const trusted = u.hostname === 'kdocs.cn' || u.hostname.endsWith('.kdocs.cn')
    const res = await fetch(url, {
      headers: { ...(trusted ? { Cookie: this.cookie } : {}), Referer: 'https://www.kdocs.cn/' },
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 15 * 60 * 1000)),
    })
    if (!res.ok) throw new Error(`WPS 下载失败：HTTP ${res.status}`)
    mkdirSync(dirname(destPath), { recursive: true })
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
    return destPath
  }

  /**
   * 建目录，返回数字 id。
   * 注意：`POST /api/v5/files/file` 是**建文件**（拿它建目录只会得到一个 0 字节文件），
   * 建目录必须用 `/api/v5/files/folder`（2026-09-18 实测）。
   */
  async mkdir(name, parentId = '0') {
    const data = await this.req('/api/v5/files/folder', {
      method: 'POST',
      json: { name, parentid: Number(parentId), groupid: Number(this.groupId) },
    })
    return String(data.id || data.fid || '')
  }

  /** 重名检查：'ok' | 'duplicated'（duplicated 时覆盖需显式传 fileId）。 */
  async preCheck(name, parentId = '0') {
    const path = `/api/v5/files/upload/pre_check?file_name=${encodeURIComponent(name)}`
      + `&group_id=${this.groupId}&parent_id=${parentId}`
    try {
      const data = await this.req(path)
      return data.result === 'ok' ? 'ok' : String(data.result || 'unknown')
    } catch (err) {
      if (/fileNameDuplicated/.test(err.message)) return 'duplicated'
      throw err
    }
  }

  /**
   * 上传本地文件（任意格式，含 .dwg）。
   * @param {string} localPath
   * @param {string} parentId  云端父目录（数字 id）
   * @param {object} [o]
   * @param {string} [o.name]  云端文件名
   * @param {string} [o.fileId] 已存在的云端文件 id → 走覆盖更新（否则同名会另存）
   * @param {boolean} [o.skipPut] 已知命中秒传时跳过 ③（默认 false）
   * @returns {Promise<{fileId:string, name:string, size:number, sha1:string}>}
   */
  async upload(localPath, parentId = '0', o = {}) {
    const name = o.name || localPath.split(/[\\/]/).pop()
    const size = statSync(localPath).size
    const { md5, sha1 } = await hashFile(localPath)

    const cu = await this.req('/api/v5/files/upload/create_update', {
      method: 'PUT',
      json: {
        groupid: Number(this.groupId),
        parentid: Number(parentId),
        parent_path: [],
        size,
        name,
        req_by_internal: false,
        client_stores: 'ks3,ks3sh',
        contenttype: 'application/octet-stream',
        startswithfilename: name,
        successactionstatus: 201,
        group_id: Number(this.groupId),
        parent_id: Number(parentId),
        file_id: o.fileId ? Number(o.fileId) : 0,
        with_rapid: true,
        tried_store: [],
        md5,
        sha1,
      },
    })

    let key = sha1
    let etag = `"${md5}"`
    if (!o.skipPut && cu.url) {
      // 流式直传：大文件不进内存。必须显式带 Content-Length（否则走 chunked，对象存储可能拒收）
      const stream = createReadStream(localPath)
      const putTimeout = Math.max(this.timeoutMs, Math.ceil(size / 1024 / 1024) * 1000 + 60000)
      const putUrl = new URL(cu.url)
      if (putUrl.protocol !== 'https:') throw new Error(`WPS 上传地址不是 HTTPS：${putUrl.protocol}`)
      const trusted = putUrl.hostname === 'kdocs.cn' || putUrl.hostname.endsWith('.kdocs.cn')
      let putRes
      try {
        putRes = await fetch(cu.url, {
          method: cu.method || 'PUT',
          headers: {
            ...(cu.request?.headers || {}),
            ...(trusted ? { Cookie: this.cookie } : {}),
            'Content-Length': String(size),
          },
          body: Readable.toWeb(stream),
          duplex: 'half',
          signal: AbortSignal.timeout(putTimeout),
        })
      } catch (err) {
        stream.destroy()
        throw new Error(`WPS 直传中断（${name}）：${err.message}`)
      }
      const expect = cu.response?.expect_code || [200]
      if (!putRes.ok && !expect.includes(putRes.status)) {
        throw new Error(`WPS 直传失败：HTTP ${putRes.status}`)
      }
      const keyHeader = String(cu.response?.args_key || '').replace(/^header\./, '')
      const etagHeader = String(cu.response?.args_etag || '').replace(/^header\./, '')
      key = (keyHeader && putRes.headers.get(keyHeader)) || sha1
      etag = (etagHeader && putRes.headers.get(etagHeader)) || `"${md5}"`
    }

    const done = await this.req('/api/v5/files/file', {
      method: 'POST',
      json: {
        key,
        groupid: Number(this.groupId),
        parentid: Number(parentId),
        parent_path: [],
        name,
        isUpNewVer: Boolean(o.fileId),
        etag,
        store: cu.store || 'ks3',
        size,
        sha1,
        apiErrorInfo: null,
      },
    })
    const fileId = String(done.id || '')
    const finalSize = Number(done.fsize) || size
    const finalSha1 = done.fsha || sha1
    if (!fileId) throw new WebDriveError(`WPS 上传落库响应缺少 fileId：${name}`, { kind: 'api', method: 'POST', path: '/api/v5/files/file' })
    if (finalSize !== size) throw new WebDriveError(`WPS 上传大小校验失败：${name}，本地 ${size} / 云端 ${finalSize}`, { kind: 'api' })
    if (finalSha1 && finalSha1 !== sha1) throw new WebDriveError(`WPS 上传 SHA-1 校验失败：${name}`, { kind: 'api' })
    return { fileId, name: done.fname || name, size: finalSize, sha1: finalSha1 }
  }

  /* ---------------------------------------------------------------- */
  /* 文件整理：重命名 / 移动 / 复制 / 删除（2026-09-19 抓包 + JS 反查实测） */
  /* ---------------------------------------------------------------- */

  /**
   * 提交一个批量任务，并轮询到结束。
   * @param {'move'|'copy'|'delete'|'file/recover'} operate
   * @param {object} body  { fileids:[数字id], groupid, parentid, dst_groupid?, dst_parentid? }
   */
  async batchTask(operate, body, { pollMs = 1200, maxPoll = 30 } = {}) {
    const r = await this.req(`/api/v5/files/batch/task/${operate}`, { method: 'POST', json: body })
    const uuid = r.taskuuid || ''
    if (!uuid) return { ok: r.result === 'ok', task: r }
    for (let i = 0; i < maxPoll; i += 1) {
      await new Promise((done) => setTimeout(done, pollMs))
      const p = await this.req(`/api/v5/files/batch/task/progress?taskuuid=${uuid}`)
      if (p.status === 'success') return { ok: true, task: r, progress: p }
      if (p.status === 'failed') return { ok: false, task: r, progress: p, error: p.err_msg }
    }
    return { ok: false, task: r, error: '轮询超时' }
  }

  /** 重命名（不受 mcp-center 的扩展名白名单限制）。 */
  async rename(fileId, newName) {
    return this.req(`/api/v3/groups/${this.groupId}/files/${fileId}`, {
      method: 'PUT', json: { fname: newName },
    })
  }

  /** 移动到目标目录（fileId 保持不变）。 */
  async move(fileIds, dstParentId, { srcParentId = 0 } = {}) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(Number)
    return this.batchTask('move', {
      fileids: ids, groupid: Number(this.groupId), parentid: Number(srcParentId),
      dst_groupid: Number(this.groupId), dst_parentid: Number(dstParentId),
      duplicated_name_model: 'rename',
    })
  }

  /** 复制到目标目录（产生新 fileId）。 */
  async copy(fileIds, dstParentId, { srcParentId = 0 } = {}) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(Number)
    return this.batchTask('copy', {
      fileids: ids, groupid: Number(this.groupId), parentid: Number(srcParentId),
      dst_groupid: Number(this.groupId), dst_parentid: Number(dstParentId),
      duplicated_name_model: 'rename',
    })
  }

  /** 删除（移入回收站，可还原）。不支持真正抹除，除非再调 purgeRecycle。 */
  async remove(fileIds, { srcParentId = 0 } = {}) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(Number)
    return this.batchTask('delete', {
      fileids: ids, groupid: Number(this.groupId), parentid: Number(srcParentId),
    })
  }

  /**
   * 回收站列表（全量）。
   *
   * ⚠ 与 list 同源的坑（2026-09-20 实测）：`/api/v5/recycles` **默认只返回 30 条**，
   *   且 `count` 参数有效（count=500 → 500 条；limit/num/size 无效，offset 有效）。
   *   不翻页就会看到「回收站只有 30 项」的假象 —— 别再用默认调用。
   */
  async listRecycle() {
    const PAGE = 200
    const MAX_PAGES = 10000
    const out = []
    const seen = new Set()
    for (let pageNo = 0, off = 0; pageNo < MAX_PAGES; pageNo += 1, off += PAGE) {
      const d = await this.req(`/api/v5/recycles?count=${PAGE}&offset=${off}`)
      const a = d.recycles || []
      if (!a.length) break
      let added = 0
      for (const f of a) {
        const id = String(f.fileid ?? f.id ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        added += 1
        out.push({
          id,
          name: f.fname || '',
          size: Number(f.fsize) || 0,
          isFolder: f.ftype === 'delfolder',
          deletedAt: f.mtime || 0,
          parentId: String(f.parentid ?? ''),
        })
      }
      if (a.length < PAGE) break
      if (added === 0) throw new WebDriveError('WPS 回收站分页停滞：服务端可能忽略 offset', { kind: 'pagination' })
      if (pageNo === MAX_PAGES - 1) throw new WebDriveError('WPS 回收站分页超过安全上限', { kind: 'pagination' })
    }
    return out
  }

  /** 从回收站还原（原位置）。 */
  async restore(fileIds) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(Number)
    return this.req('/api/v3/recycles/batch/recover', {
      method: 'POST', json: { fileids: ids, groupid: Number(this.groupId) },
    })
  }

  /** 彻底抹除回收站文件（不可还原，慎用）。 */
  async purgeRecycle(fileIds) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(Number)
    return this.req('/api/v3/recycles/batch/destory', {
      method: 'POST', json: { fileids: ids, groupid: Number(this.groupId) },
    })
  }

  /**
   * 路径 → 数字 id（如 "云端目录/子目录"）。create=true 时逐级建目录。
   * 注意：缓存只在本次实例内有效，重命名/移动后需重建实例。
   */
  async resolvePath(cloudPath, { create = false } = {}) {
    const parts = String(cloudPath || '').split('/').filter(Boolean)
    if (!parts.length) return '0'
    if (this.dirCache.has(cloudPath)) return this.dirCache.get(cloudPath)
    let parentId = '0'
    let cur = ''
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg
      if (this.dirCache.has(cur)) { parentId = this.dirCache.get(cur); continue }
      const items = await this.list(parentId)
      const hit = items.find((f) => f.name === seg && f.isFolder)
      if (items.truncated && !hit) {
        throw new WebDriveError(`WPS 网页端：目录清单不完整，不能断言「${seg}」不存在`, { kind: 'pagination', path: cur, retryable: true })
      }
      if (hit) {
        parentId = hit.id
      } else if (create) {
        parentId = await this.mkdir(seg, parentId)
      } else {
        throw new Error(`WPS 网页端：云端目录不存在：${cur}`)
      }
      this.dirCache.set(cur, parentId)
    }
    this.dirCache.set(cloudPath, parentId)
    return parentId
  }
}
