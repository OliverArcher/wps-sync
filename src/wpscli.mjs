#!/usr/bin/env node
/**
 * wpscli.mjs — kdocs-cli 独立验证工具（M1 里程碑用）
 *
 * 不依赖 DSH，直接验证 kdocs-cli 各 action 在本机是否可用：
 *   node src/wpscli.mjs status          — 登录状态（不烧配额，无探活）
 *   node src/wpscli.mjs login           — 弹出浏览器一键登录
 *   node src/wpscli.mjs login --sid V02…— 手动回传 sid
 *   node src/wpscli.mjs ls [目录路径]    — 列目录
 *   node src/wpscli.mjs tree [目录路径]  — 递归列出（消耗配额，慎用）
 *   node src/wpscli.mjs down <fileId> <本地路径>
 *   node src/wpscli.mjs up   <本地路径> [云端目录路径]
 *
 * 运行前先把 kdocs-cli.exe 放到 data/ 目录（或让它自动从金山 KS3 下载）。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { WpsCloud, KdocsCli, isRateLimitError, dataHome } from './core/kdocs-core.mjs'

const [, , cmd, ...rest] = process.argv
const cloud = new WpsCloud({ timeoutMs: 60000 })

function fmtItem(f) {
  const time = f.mtime ? new Date(f.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''
  return `${f.isFolder ? '[D]' : '[F]'} ${f.name}${f.isFolder ? '' : ` (${f.size}B)`}  id=${f.id}  mtime=${time}`
}

async function main() {
  // 默认 mcp-center 直连引擎，无需 kdocs-cli.exe；engine=kdocs-cli 时才检查本地二进制
  const cliPath = cloud.opts.engine === 'kdocs-cli' ? cloud.cli.findCli() : 'mcp-center 直连（无需本地二进制）'
  if (!cliPath && cmd !== 'help') {
    console.error(`未找到 kdocs-cli.exe。请先下载并放到 ${dataHome()}，或设置 KDOCS_CLI_PATH。`)
    process.exit(2)
  }
  console.error(`引擎: ${cliPath}`)

  try {
    switch (cmd) {
      case 'status': {
        const has = cloud.auth.hasSid()
        console.log(has ? `已保存 sid: ${cloud.auth.sid().slice(0, 6)}…（不探活，有效性由实际调用判定）` : '未保存 sid')
        break
      }
      case 'login': {
        const sidArg = rest[0] === '--sid' ? rest[1] : ''
        if (sidArg) {
          cloud.auth.save({ sid: sidArg, savedAt: Date.now() })
          console.log('已保存手动回传 sid')
          break
        }
        const r = await cloud.ensureLogin()
        console.log(`登录完成：sid=${r.sid.slice(0, 6)}… via=${r.via || 'saved'}${r.restored ? '（密钥链恢复）' : ''}`)
        break
      }
      case 'ls': {
        await cloud.ensureLogin()
        const dirPath = rest[0] || ''
        const parentId = dirPath ? await cloud.resolvePath(dirPath) : '0'
        const { items, nextPageToken } = await cloud.listDir(parentId)
        items.forEach((f) => console.log(fmtItem(f)))
        if (nextPageToken) console.log(`（还有更多，pageToken=${nextPageToken}）`)
        break
      }
      case 'tree': {
        await cloud.ensureLogin()
        const rootPath = rest[0] || ''
        const rootId = rootPath ? await cloud.resolvePath(rootPath) : '0'
        const all = await cloud.listAll(rootId)
        all.forEach((f) => console.log(`${f.isFolder ? '[D]' : '[F]'} ${f.path}  id=${f.id}`))
        console.error(`共 ${all.length} 项`)
        break
      }
      case 'down': {
        await cloud.ensureLogin()
        const dest = await cloud.downloadById(rest[0], rest[1])
        console.log(`已下载: ${dest} (${statSync(dest).size}B)`)
        break
      }
      case 'up': {
        await cloud.ensureLogin()
        const parentPath = rest[1] || ''
        const parentId = parentPath ? await cloud.resolvePath(parentPath, { create: true }) : '0'
        const r = await cloud.uploadFile(rest[0], parentId)
        console.log(`已上传: ${r.name} fileId=${r.fileId}`)
        break
      }
      default:
        console.log(__doc__)
    }
  } catch (err) {
    const tag = isRateLimitError(err) ? '【今日配额已用尽，次日 08:00 恢复】' : ''
    console.error(`错误: ${err.message} ${tag}`)
    process.exit(1)
  }
}

const __doc__ = `
用法: node src/wpscli.mjs <status|login|ls|tree|down|up> [参数]
`

main()
