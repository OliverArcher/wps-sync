#!/usr/bin/env node
/**
 * probe-fileops.mjs — 抓 WPS 网页端「重命名 / 移动 / 复制 / 删除」的真实请求
 *
 *   node src/probe-fileops.mjs [目标名关键字] [--show] [--ops 重命名,删除] [--wait 20]
 *
 * 做法：起独立 Edge（默认 --headless=new）→ 注入 wps_sid Cookie → 打开云盘页 →
 * 切到「我的云文档」→ 定位目标行右键 → 点上下文菜单项 → 弹窗里点确认 → 全程记录 Network。
 * 落盘 data/fileops-trace.json，打印疑似操作请求。
 *
 * 为什么需要它：`PUT /api/v5/files/file` 是上传落库专用（返回 fileNotUploaded）；
 * `/api/v5/files/{copy,move,rename,delete}` 与 `/api/v5/tasks/files/*` 全是 404/405。
 * 端点猜不出来，只能抓真实操作。
 *
 * 两个坑（踩过）：
 *   1. 文件名在页面里被文本混淆（innerText 乱序，如 `_wps-sync (除删体整可)测探`），
 *      必须用 innerHTML 匹配
 *   2. 用 closest() 找"行"会命中过大容器 → 点击坐标落到页面中央误触发别的面板。
 *      必须用「面积最小的匹配元素」策略精确定位
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { findBrowser, CdpConnection } from './core/kdocs-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const SHOW = argv.includes('--show')
const waitSec = Number(argv.includes('--wait') ? argv[argv.indexOf('--wait') + 1] : 20)
const opsArg = argv.includes('--ops') ? argv[argv.indexOf('--ops') + 1] : '重命名,移动,复制,删除'
const flagVals = new Set()
for (let i = 0; i < argv.length - 1; i += 1) if (argv[i] === '--wait' || argv[i] === '--ops') flagVals.add(argv[i + 1])
const TARGET = argv.find((a) => !a.startsWith('--') && !flagVals.has(a)) || '_wps-sync探测'
const OPS = opsArg.split(',').map((s) => s.trim()).filter(Boolean)
const TRACE = join(ROOT, 'data', 'fileops-trace.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const sid = JSON.parse(readFileSync(join(ROOT, 'data', 'auth.json'), 'utf8')).sid
  const browser = findBrowser()
  if (!browser) throw new Error('未找到 Edge/Chrome')

  const port = 9800 + Math.floor(Math.random() * 300)
  const userDataDir = join(tmpdir(), `wps-sync-ops-${process.pid}-${Date.now()}`)
  const proc = spawn(browser, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    ...(SHOW ? ['--new-window', 'about:blank'] : ['--headless=new']),
  ], { detached: true, stdio: 'ignore', windowsHide: true })

  let wsUrl = ''
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
      const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch { /* not ready */ }
    await sleep(250)
  }
  if (!wsUrl) throw new Error('浏览器调试端口未就绪')

  const cdp = new CdpConnection(wsUrl)
  await cdp.open()
  const reqs = new Map()
  cdp.on('Network.requestWillBeSent', (p) => {
    reqs.set(p.requestId, {
      url: p.request?.url, method: p.request?.method,
      postData: (p.request?.postData || '').slice(0, 2000), order: reqs.size,
    })
  })
  cdp.on('Network.responseReceived', (p) => {
    const r = reqs.get(p.requestId)
    if (r) r.status = p.response?.status
  })
  const WANT = /\/files\/|\/tasks\/|move|copy|rename|delete|trash|batch/i
  cdp.on('Network.loadingFinished', (p) => {
    const r = reqs.get(p.requestId)
    if (!r || !WANT.test(r.url || '')) return
    cdp.send('Network.getResponseBody', { requestId: p.requestId })
      .then((res) => { r.responseBody = String(res.body || '').slice(0, 1500) })
      .catch(() => { /* ignore */ })
  })

  await cdp.send('Network.enable', { maxPostDataSize: 65536 })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Network.setCookie', { name: 'wps_sid', value: sid, domain: '.kdocs.cn', path: '/' })
  await cdp.send('Page.navigate', { url: 'https://www.kdocs.cn/latest' })

  for (let i = 0; i < 45; i += 1) {
    await sleep(1000)
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (r.result.value === 'complete') break
  }
  await sleep(3500)

  const evalJs = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value
  const clickAt = async (x, y, button = 'left') => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }
  const esc = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }

  /** 面积最小的、innerHTML 含指定文本的元素（精确定位，避免命中大容器） */
  const findSmallest = async (text, maxArea = 900000) => JSON.parse(await evalJs(
    `JSON.stringify((()=>{let best=null;
      for(const e of document.querySelectorAll('div,span,li,td,button,a,p')){
        if(!(e.innerHTML||'').includes(${JSON.stringify(text)})) continue;
        const b=e.getBoundingClientRect();
        if(b.width<=0||b.height<=0||b.y<0||b.x<0) continue;
        const area=b.width*b.height; if(area>${maxArea}) continue;
        if(!best||area<best.area) best={area,x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),w:Math.round(b.width),h:Math.round(b.height)};
      } return best})())`,
  ) || 'null')

  // 切到「我的云文档」根目录列表
  const side = await findSmallest('我的云文档', 200000)
  if (side) { await clickAt(side.x, side.y); await sleep(4000) }
  console.log(`目标：${TARGET} | 操作序列：${OPS.join(' → ')}`)

  const row = await findSmallest(TARGET)
  if (!row) {
    console.log('未找到目标行。诊断：')
    console.log(`  URL: ${await evalJs('location.href')}`)
    console.log(`  innerHTML 含目标: ${await evalJs(`document.body.innerHTML.includes(${JSON.stringify(TARGET)})`)}`)
    console.log(`  页面文本: ${String(await evalJs('document.body.innerText.replace(/\\s+/g," ").slice(0,300)'))}`)
  } else {
    console.log(`定位到目标 @${row.x},${row.y} (${row.w}×${row.h})`)
    for (const op of OPS) {
      const n0 = reqs.size
      // 每次都重新定位并右键（菜单关闭后需重新打开）
      const r = await findSmallest(TARGET)
      if (!r) { console.log(`目标消失，停止（可能被上一个操作移走/删除）`); break }
      await clickAt(r.x, r.y, 'right')
      await sleep(1600)
      const item = await findSmallest(op, 60000)
      if (!item) { console.log(`菜单中未找到「${op}」`); await esc(); await sleep(500); continue }
      console.log(`\n>>> 右键「${TARGET}」→ 点「${op}」@${item.x},${item.y}`)
      await clickAt(item.x, item.y)
      await sleep(2200)

      // 弹窗：有输入框就填新名字
      const hasInput = await evalJs(`!!document.querySelector('input[type=text]:not([readonly]),textarea')`)
      if (hasInput) {
        await evalJs(`(()=>{const i=document.querySelector('input[type=text]:not([readonly]),textarea');
          if(i){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            s.call(i,'renamed-by-probe'); i.dispatchEvent(new Event('input',{bubbles:true}))} return 1})()`)
        await sleep(600)
      }
      // 点确认按钮
      const confirmRe = ['确定', '确认', '保存', '删除', '移动到此', '复制到此']
      let clicked = null
      for (const t of confirmRe) {
        const b = await findSmallest(t, 40000)
        if (b) { await clickAt(b.x, b.y); clicked = t; break }
      }
      if (clicked) console.log(`  点了确认按钮「${clicked}」`)
      else console.log('  未找到确认按钮（可能无弹窗或已直接生效）')
      await sleep(2500)

      const fresh = [...reqs.values()].filter((x) => x.order >= n0 && WANT.test(x.url || ''))
      console.log(`  新增候选请求 ${fresh.length} 条：`)
      for (const q of fresh.slice(0, 8)) {
        if (/\.(js|css|png|svg|woff2?)(\?|$)/.test(q.url || '')) continue
        console.log(`    ${q.method} ${q.status || ''} ${(q.url || '').replace('https://drive.kdocs.cn', '').slice(0, 130)}`)
        if (q.postData && q.postData.length < 500) console.log(`       body: ${q.postData}`)
        if (q.responseBody) console.log(`       resp: ${q.responseBody.slice(0, 220)}`)
      }
      await esc()
      await sleep(1000)
    }
  }

  const list = [...reqs.values()]
  mkdirSync(dirname(TRACE), { recursive: true })
  writeFileSync(TRACE, JSON.stringify(list, null, 2))
  console.log(`\n落盘 ${list.length} 条 → ${TRACE}`)

  cdp.close()
  try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
}

main().catch((e) => { console.error('错误:', e.message); process.exit(1) })
