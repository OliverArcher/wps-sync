#!/usr/bin/env node
/**
 * wpsdav.mjs — 把 WPS 云文档映射成本地 WebDAV 服务（路线 B 桥接层，M2 起点）
 *
 *   node src/wpsdav.mjs [端口]     （默认 127.0.0.1:8386）
 *
 * rclone 挂载示例（rclone.conf）：
 *   [wps]
 *   type = webdav
 *   url = http://127.0.0.1:8386/
 *   vendor = other
 *   user = wps
 *   pass = <任意，可关闭鉴权>
 *
 * 同步（不传播删除）：
 *   rclone copy wps: <本地目录> --update -v      # 下行
 *   rclone copy <本地目录> wps: --update -v      # 上行
 *
 * WebDAV 方法映射：
 *   PROPFIND → listDir/listAll（Depth:0/1/infinity）
 *   GET      → downloadById（流式）
 *   PUT      → uploadFile（Parent 目录解析 + 创建）
 *   MKCOL    → createFolder
 *   MOVE     → rename / move（Destination 头）
 *   DELETE   → 502（kdocs-cli 无删除接口，PLAN.md 功能边界 1）
 */

import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { WpsCloud, isRateLimitError, isAuthError } from './core/kdocs-core.mjs'

const PORT = Number(process.argv[2]) || 8386
const cloud = new WpsCloud({ timeoutMs: 120000 })

/* ---------------- 基础响应工具 ---------------- */

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'

function propfindEntry(href, name, isDir, size, mtimeSec) {
  const iso = new Date((mtimeSec || 0) * 1000).toUTCString()
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${escapeXml(name)}</D:displayname>` +
    `<D:getlastmodified>${iso}</D:getlastmodified>` +
    (isDir
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : `<D:resourcetype/><D:getcontentlength>${size || 0}</D:getcontentlength>` +
        `<D:getcontenttype>application/octet-stream</D:getcontenttype>`) +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}

function sendXml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1' })
  res.end(XML_HEAD + body)
}

function multistatus(entries) {
  return `<D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`
}

/* ---------------- 云端路径解析 ---------------- */

/** "/a/b/c" → { parentId, name }；根目录 → { parentId:'0', name:'' } */
async function splitPath(cloudPath, { createParents = false } = {}) {
  const parts = decodeURIComponent(cloudPath).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (!parts.length) return { parentId: '0', name: '' }
  const parentRel = parts.slice(0, -1).join('/')
  const name = parts[parts.length - 1]
  const parentId = parentRel
    ? await cloud.resolvePath(parentRel, { create: createParents })
    : '0'
  return { parentId, name }
}

/* ---------------- 请求处理 ---------------- */

async function handle(req, res) {
  const urlPath = req.url.split('?')[0]
  try {
    await cloud.ensureLogin()
    switch (req.method) {
      case 'PROPFIND': return await propfind(req, res, urlPath)
      case 'GET':
      case 'HEAD': return await get(req, res, urlPath)
      case 'PUT': return await put(req, res, urlPath)
      case 'MKCOL': return await mkcol(req, res, urlPath)
      case 'MOVE': return await move(req, res, urlPath)
      case 'DELETE': return plain(res, 502, 'WebDAV DELETE not supported: kdocs-cli has no delete API (see PLAN.md)')
      case 'OPTIONS': {
        res.writeHead(200, { Allow: 'OPTIONS, GET, HEAD, PUT, PROPFIND, MKCOL, MOVE', DAV: '1' })
        return res.end()
      }
      default: return plain(res, 405, 'method not allowed')
    }
  } catch (err) {
    const status = isRateLimitError(err) ? 429 : isAuthError(err) ? 401 : 500
    console.error(`[${new Date().toISOString()}] ${req.method} ${urlPath} → ${status}: ${err.message}`)
    if (!res.headersSent) plain(res, status, err.message)
    else res.destroy()
  }
}

function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

async function propfind(req, res, urlPath) {
  const depth = (req.headers.depth || '1').toLowerCase()
  const entries = []
  if (urlPath === '/' || urlPath === '') {
    entries.push(propfindEntry('/', '', true, 0, 0))
    if (depth !== '0') {
      const { items } = await cloud.listDir('0')
      for (const f of items) {
        entries.push(propfindEntry(`/${encodeURIComponent(f.name)}`, f.name, f.isFolder, f.size, f.mtime))
      }
    }
    return sendXml(res, 207, multistatus(entries))
  }
  const { parentId, name } = await splitPath(urlPath)
  const { items } = await cloud.listDir(parentId)
  const self = items.find((f) => f.name === name)
  if (!self) return plain(res, 404, 'not found')
  entries.push(propfindEntry(urlPath, name, self.isFolder, self.size, self.mtime))
  if (self.isFolder && depth !== '0') {
    const sub = await cloud.listDir(self.id)
    for (const f of sub.items) {
      entries.push(propfindEntry(`${urlPath.replace(/\/$/, '')}/${encodeURIComponent(f.name)}`, f.name, f.isFolder, f.size, f.mtime))
    }
  }
  sendXml(res, 207, multistatus(entries))
}

async function get(req, res, urlPath) {
  const { parentId, name } = await splitPath(urlPath)
  const { items } = await cloud.listDir(parentId)
  const file = items.find((f) => f.name === name && !f.isFolder)
  if (!file) return plain(res, 404, 'not found')
  const tmp = join(process.env.TEMP || '/tmp', `wpsdav-dl-${file.id}`)
  await cloud.downloadById(file.id, tmp)
  const size = existsSync(tmp) ? statSync(tmp).size : 0
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size })
  if (req.method === 'HEAD') return res.end()
  createReadStream(tmp).pipe(res)
}

async function put(req, res, urlPath) {
  const { parentId, name } = await splitPath(urlPath, { createParents: true })
  if (!name) return plain(res, 400, 'bad path')
  const tmp = join(process.env.TEMP || '/tmp', `wpsdav-up-${Date.now()}-${name}`)
  const { pipeline } = await import('node:stream/promises')
  const { createWriteStream } = await import('node:fs')
  await pipeline(req, createWriteStream(tmp))
  // 关键：同名已存在时必须走 upload-replace-file 覆盖，否则 upload_new_file 会新建
  // "xxx(1).ext" 副本，每轮同步都在云端堆积垃圾（且云端无删除接口，无法清理）。
  const { items } = await cloud.listDir(parentId)
  const existing = items.find((f) => f.name === name && !f.isFolder)
  const r = existing
    ? await cloud.replaceFile(existing.id, tmp, parentId)
    : await cloud.uploadFile(tmp, parentId, { name })
  console.log(`PUT ${urlPath} → ${existing ? 'replace' : 'create'} fileId=${r.fileId} sha1=${r.sha1 || '-'}`)
  plain(res, 201, 'created')
}

async function mkcol(req, res, urlPath) {
  const { parentId, name } = await splitPath(urlPath, { createParents: true })
  if (!name) return plain(res, 400, 'bad path')
  const id = await cloud.createFolder(name, parentId)
  console.log(`MKCOL ${urlPath} → folderId=${id}`)
  plain(res, 201, 'created')
}

async function move(req, res, urlPath) {
  const dest = decodeURIComponent(req.headers.destination || '')
  if (!dest) return plain(res, 400, 'missing Destination')
  const src = await splitPath(urlPath)
  const dst = await splitPath(new URL(dest, 'http://x').pathname, { createParents: true })
  const { items } = await cloud.listDir(src.parentId)
  const item = items.find((f) => f.name === src.name)
  if (!item) return plain(res, 404, 'not found')
  if (dst.parentId === src.parentId) {
    await cloud.rename(item.id, dst.name)
  } else {
    await cloud.move(item.id, dst.parentId)
  }
  plain(res, 201, 'moved')
}

/* ---------------- 启动 ---------------- */

const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { plain(res, 500, e.message) } catch { /* ignore */ } }) })
server.listen(PORT, '127.0.0.1', () => {
  console.log(`wpsdav 已启动: http://127.0.0.1:${PORT}/  （rclone remote: type=webdav, vendor=other）`)
})
