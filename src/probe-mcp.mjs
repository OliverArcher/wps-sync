#!/usr/bin/env node
/**
 * probe-mcp.mjs — mcp-center skill_hub 直连验证（M1 侦查脚本）
 * 用法: node src/probe-mcp.mjs <list|down> [参数]
 */
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const sid = JSON.parse(readFileSync(join(ROOT, 'data/auth.json'), 'utf8')).sid
const URL = 'https://mcp-center.wps.cn/skill_hub/api/v1/tool'

/** 调用 skill_hub 工具：SSE 响应中取 event:result 的 data JSON。 */
export async function callTool(tool, args, { timeoutMs = 60000 } = {}) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `wps_sid=${sid}` },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (res.status !== 0 && res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  // SSE 或纯 JSON 兼容解析
  let payload = null
  if (text.startsWith('{')) {
    payload = JSON.parse(text)
  } else {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const j = JSON.parse(line.slice(5).trim())
        if (j.code === 0 && j.data !== undefined) { payload = j; break }
        if (j.code !== undefined && j.code !== 0) payload = j
      }
    }
  }
  if (!payload) throw new Error(`无法解析响应：${text.slice(0, 300)}`)
  if (payload.code !== 0) throw new Error(`code=${payload.code}: ${payload.message || payload.msg}`)
  // data 可能是 {code,data} 再包一层
  let d = payload.data
  while (d && typeof d === 'object' && typeof d.code === 'number' && d.code === 0 && d.data !== undefined) d = d.data
  return d
}

const [, , cmd, ...rest] = process.argv
try {
  if (cmd === 'list') {
    const [parentId, driveId] = rest
    const d = await callTool('list_files', { parent_id: parentId, ...(driveId ? { drive_id: driveId } : {}), page_size: 20 })
    const items = d.items || []
    items.forEach((f) => console.log(`${f.type === 'folder' || f.type === 'dir' ? '[D]' : '[F]'} ${f.name}  id=${f.id}  size=${f.size}`))
    console.error(`drive_id=${d.drive_id || driveId || '?'}  共 ${items.length} 项`)
  } else if (cmd === 'down') {
    const [fileId, dest] = rest
    const d = await callTool('download_file', { file_id: fileId, with_hash: true })
    const url = d.url || d.download_url || d.link_url || ''
    console.error('download meta:', JSON.stringify(d).slice(0, 400))
    if (!url) throw new Error('未返回下载地址')
    const res = await fetch(url, {
      headers: { Referer: 'https://365.kdocs.cn/', Origin: 'https://365.kdocs.cn', Cookie: `wps_sid=${sid}; csrf=${sid}` },
    })
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    readFileSync // noop
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    console.log(`已下载 ${dest} (${buf.length}B)`)
  } else {
    console.log('用法: node src/probe-mcp.mjs list <parent_id> [drive_id] | down <file_id> <dest>')
  }
} catch (e) {
  console.error('错误:', e.message)
  process.exit(1)
}
