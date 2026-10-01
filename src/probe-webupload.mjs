#!/usr/bin/env node
/**
 * probe-webupload.mjs — 抓取 WPS 网页端「任意格式文件上传」协议（M3 上行方案 A 的验证脚本）
 *
 *   node src/probe-webupload.mjs [文件路径] [--show] [--url <页面地址>] [--wait 30]
 *
 * 做什么：
 *   1. 起一个独立浏览器实例（默认 --headless=new，--show 改为可见窗口）
 *   2. 在页面脚本执行前注入探针：伪造 File 对象 + 自动填充任何 input[type=file]
 *      + 兜底 polyfill window.showOpenFilePicker（新版网页可能不走 input）
 *   3. 注入 wps_sid Cookie → 打开云盘页面 → 点击「上传 文件」触发真实上传
 *   4. 全程记录 Network 请求 → 落盘 data/webupload-trace.json，打印疑似上传链路
 *
 * 目的：mcp-center 的上传接口有扩展名白名单（.dwg 被拒），网页端能传任意格式，
 * 这里把网页端用的真实接口抓出来，判断是否可复现为直连上传。
 *
 * 副作用：成功时会在云端留下一个测试文件（默认 tmp/webupload-probe.dwg，1KB），
 * 需到网页端手动删除。
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { findBrowser, CdpConnection } from './core/kdocs-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const SHOW = argv.includes('--show')
const urlArg = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'https://365.kdocs.cn/'
const waitSec = Number(argv.includes('--wait') ? argv[argv.indexOf('--wait') + 1] : 30)
const flagValues = new Set()
for (let i = 0; i < argv.length - 1; i += 1) {
  if (argv[i] === '--url' || argv[i] === '--wait') flagValues.add(argv[i + 1])
}
const fileArg = argv.find((a) => !a.startsWith('--') && !flagValues.has(a))
const UP_FILE = resolve(fileArg || join(ROOT, 'tmp', 'webupload-probe.dwg'))
const TRACE = join(ROOT, 'data', 'webupload-trace.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadSid() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'auth.json'), 'utf8')).sid || ''
  } catch {
    return ''
  }
}

/** 页面探针：构造 File → 自动填充 file input / polyfill showOpenFilePicker。 */
function probeScript(b64, filename) {
  return `(()=>{
  const b64='${b64}';
  function mkFile(){
    const bin=atob(b64); const u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    return new File([u], ${JSON.stringify(filename)}, {type:'application/octet-stream'});
  }
  window.__probeFile = mkFile();
  window.__probeFilled = [];
  function fill(el){
    try{
      const dt=new DataTransfer(); dt.items.add(window.__probeFile);
      el.files = dt.files;
      window.__probeFilled.push(el.id||el.className||'(anon)');
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.dispatchEvent(new Event('input',{bubbles:true}));
    }catch(e){ window.__probeErr=String(e); }
  }
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function(){
    if(this.type==='file'){ fill(this); return; }
    return origClick.apply(this, arguments);
  };
  window.showOpenFilePicker = async () => {
    const f = window.__probeFile;
    return [{ kind:'file', name:f.name, getFile: async()=>f }];
  };
  new MutationObserver(ms=>{
    for(const m of ms) for(const n of m.addedNodes){
      if(!n || n.nodeType!==1) continue;
      const list = (n.matches && n.matches('input[type=file]')) ? [n]
        : [...(n.querySelectorAll ? n.querySelectorAll('input[type=file]') : [])];
      for(const e of list) if(!e.__probed){ e.__probed=true; setTimeout(()=>fill(e),0); }
    }
  }).observe(document.documentElement,{childList:true,subtree:true});
})()`
}

async function main() {
  const sid = loadSid()
  if (!sid) throw new Error('未找到 wps_sid，先执行 node src/wpscli.mjs login')
  if (!existsSync(UP_FILE)) throw new Error(`待上传文件不存在：${UP_FILE}`)
  const browser = findBrowser()
  if (!browser) throw new Error('未找到 Edge/Chrome')
  const b64 = readFileSync(UP_FILE).toString('base64')
  const fname = UP_FILE.split(/[\\/]/).pop()

  const port = 9400 + Math.floor(Math.random() * 400)
  const userDataDir = join(tmpdir(), `wps-sync-web-${process.pid}-${Date.now()}`)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    ...(SHOW ? ['--new-window', 'about:blank'] : ['--headless=new']),
  ]
  const proc = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: true })
  console.log(`浏览器: ${browser}\n文件: ${UP_FILE}（${readFileSync(UP_FILE).length}B）`)

  // 注意：必须用 /json/list 里的 page 级 webSocketDebuggerUrl，
  // /json/version 给的是 browser 级端点，不支持 Network / DOM 域。
  let wsUrl = ''
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      const list = await res.json()
      const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch { /* not ready */ }
    await sleep(250)
  }
  if (!wsUrl) throw new Error('浏览器调试端口未就绪（未找到 page 级目标）')

  const cdp = new CdpConnection(wsUrl)
  await cdp.open()

  const reqs = new Map()
  cdp.on('Network.requestWillBeSent', (p) => {
    reqs.set(p.requestId, {
      url: p.request?.url, method: p.request?.method, type: p.type,
      headers: p.request?.headers || {}, postData: (p.request?.postData || '').slice(0, 3000),
      initiator: p.initiator?.url || '',
    })
  })
  cdp.on('Network.requestWillBeSentExtraInfo', (p) => {
    const r = reqs.get(p.requestId)
    if (r) r.extraHeaders = p.headers || {}
  })
  cdp.on('Network.responseReceived', (p) => {
    const r = reqs.get(p.requestId)
    if (r) { r.status = p.response?.status; r.mime = p.response?.mimeType }
  })
  // 上传相关请求的响应体要留档（create_update 会返回直传地址与鉴权头）
  const WANT_BODY = /pre_check|create_update|upload|\/api\/v\d+\/files\/file\b|ks3_compatible/
  cdp.on('Network.loadingFinished', (p) => {
    const r = reqs.get(p.requestId)
    if (!r || !WANT_BODY.test(r.url || '')) return
    cdp.send('Network.getResponseBody', { requestId: p.requestId })
      .then((res) => { r.responseBody = String(res.body || '').slice(0, 4000) })
      .catch(() => { /* ignore */ })
  })

  await cdp.send('Network.enable', { maxPostDataSize: 65536 })
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probeScript(b64, fname) })
  await cdp.send('Network.setCookie', { name: 'wps_sid', value: sid, domain: '.kdocs.cn', path: '/' })
  await cdp.send('Network.setCookie', { name: 'wps_sid', value: sid, domain: '.wps.cn', path: '/' })
  await cdp.send('Page.navigate', { url: urlArg })

  let ready = ''
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({s:document.readyState,u:location.href,t:document.title})',
        returnByValue: true,
      })
      const v = JSON.parse(r.result.value)
      ready = `${v.s} ${v.u} 「${v.t}」`
      if (v.s === 'complete') break
    } catch { /* ignore */ }
  }
  console.log(`页面: ${ready}`)
  await sleep(3000)

  /** 枚举可见的「上传/新建/文件」候选元素文本。 */
  const listCandidates = async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify([...document.querySelectorAll('button,a,div,span,li,[role=button],p')].filter(e=>{const t=(e.textContent||'').trim();return t.length<20&&/上传|新建|文件/.test(t)&&e.offsetParent!==null}).map(e=>e.textContent.trim().slice(0,14)))`,
      returnByValue: true,
    })
    return JSON.parse(r.result.value || '[]')
  }
  /** 取候选元素的中心坐标（用于真实鼠标事件）。 */
  const candidateRects = async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify([...document.querySelectorAll('button,a,div,span,li,[role=button],p')].filter(e=>{const t=(e.textContent||'').trim();const b=e.getBoundingClientRect();return t.length<20&&/上传|新建|^文件$|^文件夹$/.test(t)&&b.width>0&&b.height>0&&b.x>=0&&b.y>=0}).map(e=>{const b=e.getBoundingClientRect();return {t:e.textContent.trim().slice(0,14),x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}}))`,
      returnByValue: true,
    })
    return JSON.parse(r.result.value || '[]')
  }
  /** 真实鼠标点击（React/Vue 组件常只监听 pointer 事件，element.click() 不生效）。 */
  const mouseClick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const probeStateOf = async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({filled:window.__probeFilled||[],err:window.__probeErr||""})',
      returnByValue: true,
    })
    return JSON.parse(r.result.value || '{}')
  }

  // 每轮重新枚举（菜单展开后候选会变多）：优先点含「上传」的，否则逐个试「新建」
  for (let round = 0; round < 12; round += 1) {
    const rects = await candidateRects()
    const texts = rects.map((r) => r.t)
    // 优先级：菜单里的「文件」项 > 含「上传」的容器 > 「新建」（用于展开菜单）
    let target = rects.find((r) => r.t === '文件')
      || rects.find((r) => /上传/.test(r.t))
      || rects[round % Math.max(rects.length, 1)]
    if (!target) { console.log('  无候选元素'); break }
    await mouseClick(target.x, target.y)
    await sleep(1800)
    const st = await probeStateOf()
    console.log(`  [${round}] 候选:${JSON.stringify(texts)} → 点「${target.t}」@${target.x},${target.y} 已填充:${JSON.stringify(st.filled)}`)
    if ((st.filled || []).length) break
  }

  const probeState = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({filled:window.__probeFilled||[],err:window.__probeErr||""})',
    returnByValue: true,
  })
  console.log(`探针状态: ${probeState.result.value}`)

  const before = reqs.size
  for (let i = 0; i < waitSec; i += 1) {
    await sleep(1000)
    if (i > 10 && reqs.size === before) break
  }

  const list = [...reqs.values()]
  mkdirSync(dirname(TRACE), { recursive: true })
  writeFileSync(TRACE, JSON.stringify(list, null, 2))
  console.log(`\n共捕获 ${list.length} 条请求 → ${TRACE}`)

  const hit = list.filter((r) => /upload|ks3|ksyun|myqcloud|aliyuncs|oss-|\/api\/v\d+\/(files|file)\b|create|complete|put/i.test(r.url || ''))
  console.log('\n=== 疑似上传链路 ===')
  for (const r of hit.slice(0, 40)) {
    console.log(`${r.method} ${r.status || ''} ${(r.url || '').slice(0, 170)}`)
    const h = r.extraHeaders || r.headers || {}
    const ck = Object.entries(h).filter(([k]) => /^(cookie|authorization|x-|content-type)/i.test(k))
    if (ck.length) console.log(`    ${ck.map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`).join(' | ')}`)
    if (r.postData) console.log(`    body: ${r.postData.slice(0, 400)}`)
    if (r.responseBody) console.log(`    resp: ${r.responseBody.slice(0, 1200)}`)
  }

  const cookies = await cdp.send('Network.getCookies', { urls: ['https://www.kdocs.cn/', 'https://drive.kdocs.cn/'] })
  const csrf = (cookies.cookies || []).filter((c) => /csrf|token|sid/i.test(c.name))
  console.log('\n=== 相关 Cookie ===')
  for (const c of csrf) console.log(`${c.name} = ${String(c.value).slice(0, 40)}  (${c.domain})`)

  cdp.close()
  try {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch { /* ignore */ }
}

main().catch((e) => { console.error('错误:', e.message); process.exit(1) })
