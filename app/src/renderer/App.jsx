import React, { useEffect, useState } from 'react'
import { Button, Text, tokens } from '@fluentui/react-components'
import Files from './pages/Files.jsx'
import Transfers from './pages/Transfers.jsx'
import Deletions from './pages/Deletions.jsx'
import Settings from './pages/Settings.jsx'

const NAV = [
  { key: 'files', label: '首页', icon: './icons/home.png' },
  { key: 'transfers', label: '传输', icon: './icons/sync.png' },
  { key: 'deletions', label: '删除日志', icon: './icons/trash.png' },
]

/** 窄侧边栏的图标按钮（样式见 index.html 的 .navbtn） */
function NavBtn({ icon, label, active, onClick }) {
  return (
    <button
      className={`navbtn${active ? ' active' : ''}`} title={label} aria-label={label}
      onClick={onClick}
    >
      <img src={icon} alt={label} />
    </button>
  )
}

export default function App() {
  const [page, setPage] = useState('files')
  const [auth, setAuth] = useState({ logged: false })
  const [cfg, setCfg] = useState(null)
  const [loggingIn, setLoggingIn] = useState(false)

  // 同步日志与运行状态放在 App 层：切页面不会丢，软件不退出就一直保留
  const [log, setLog] = useState('')
  const [syncRunning, setSyncRunning] = useState(false)
  const [syncMode, setSyncMode] = useState('')
  const [watch, setWatch] = useState({ on: false, pending: 0 })

  const refreshAuth = () => window.api.auth.status().then(setAuth).catch(() => setAuth({ logged: false }))
  const refreshCfg = () => window.api.config.get().then(setCfg).catch(() => setCfg(null))

  useEffect(() => {
    refreshAuth(); refreshCfg()
    // 全局监听只注册一次，切页不再解绑（避免事件丢失导致卡在"运行中"）
    const offLog = window.api.sync.onLog((s) => setLog((prev) => prev + s))
    const offDone = window.api.sync.onDone(() => { setSyncRunning(false); setSyncMode('') })
    const offWatch = window.api.watch?.onState?.((w) => setWatch(w))
    // 主进程缓冲着本次运行已经产生的传输日志：窗口关掉再打开时捞回来补齐，
    // 否则重开窗口会看到一片空白（日志只活在渲染进程里）。
    if (window.api.sync.history) {
      window.api.sync.history().then((h) => {
        if (!h) return
        const head = h.truncated ? '[…更早的日志已按缓冲上限滚动丢弃…]\n' : ''
        const text = head + (h.text || '')
        if (text) setLog((prev) => text + prev)
      }).catch(() => {})
    }
    return () => { offLog(); offDone(); offWatch?.() }
  }, [])

  const runSync = async (mode, title) => {
    setSyncRunning(true); setSyncMode(title)
    setLog((prev) => prev + `\n$ ${title}\n`)
    const r = await window.api.sync.run(mode)
    if (r?.error) {
      setLog((prev) => prev + `${r.error}\n`)
      setSyncRunning(false); setSyncMode('')
    }
  }

  const doLogin = async () => {
    if (auth.logged) {
      // 已登录：不重复登录，把登录详情追加到「传输」页日志里
      const lines = [
        '登录状态：已登录',
        `账号：${auth.user || '(未知)'}`,
        `会话前缀：${auth.hint || '-'}`,
        `云盘 ID：${auth.driveId || '-'}`,
        `会话文件：data/auth.json`,
        `保存时间：${auth.savedAt ? new Date(auth.savedAt).toLocaleString() : '-'}`,
      ]
      setLog((prev) => prev + `\n[${new Date().toLocaleTimeString()}]\n` + lines.map((l) => `  ${l}`).join('\n') + '\n')
      setPage('transfers')
      return
    }
    setLoggingIn(true)
    await window.api.auth.login()
    setLoggingIn(false)
    refreshAuth()
  }

  const openFolder = () => {
    const p = cfg?.pairs?.find((x) => x.enabled)?.localDir || cfg?.pairs?.[0]?.localDir
    window.api.shell.openFolder(p)
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: tokens.colorNeutralBackground1 }}>
      {/* 左侧：窄侧边栏（仅图标，撑满全高） */}
      <aside
        style={{
          width: 56, flexShrink: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'stretch', paddingTop: 10,
          background: tokens.colorNeutralBackground3,
          borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
        }}
      >
        <div title="wps-sync" style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <img src="./icons/cloud.png" width={26} height={26} alt="wps-sync" style={{ display: 'block' }} />
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map((n) => (
            <NavBtn key={n.key} icon={n.icon} label={n.label} active={page === n.key} onClick={() => setPage(n.key)} />
          ))}
        </nav>

        <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, paddingBottom: 8 }}>
          <NavBtn icon="./icons/settings.png" label="设置" active={page === 'settings'} onClick={() => setPage('settings')} />
        </div>
      </aside>

      {/* 右侧：标题栏 + 内容（内容区撑满剩余空间） */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
        <header
          style={{
            height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            // 右侧留出系统窗口按钮（最小化/最大化/关闭）的位置，避免被盖住
            padding: '0 148px 0 12px',
            background: tokens.colorNeutralBackground1,
            borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
            WebkitAppRegion: 'drag',
          }}
        >
          <Text weight="semibold">{NAV.find((n) => n.key === page)?.label || '设置'}</Text>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
            <Button size="small" appearance="outline" shape="rounded" onClick={openFolder}>打开文件夹</Button>
            <Button size="small" appearance="subtle" disabled={loggingIn} onClick={doLogin}>
              {auth.logged ? '已登录' : (loggingIn ? '登录中…' : '登录')}
            </Button>
          </div>
        </header>

        <div
          style={{
            flex: 1, minHeight: 0, overflow: 'hidden', padding: 12,
            background: tokens.colorNeutralBackground1,
          }}
        >
          {page === 'files' && <Files cfg={cfg} auth={auth} />}
          {page === 'transfers' && (
            <Transfers
              log={log} running={syncRunning} mode={syncMode} watch={watch}
              onRun={runSync}
              onClear={() => { setLog(''); if (window.api.sync.clear) window.api.sync.clear() }}
            />
          )}
          {page === 'deletions' && <Deletions />}
          {page === 'settings' && <Settings cfg={cfg} onChange={refreshCfg} />}
        </div>
      </main>
    </div>
  )
}
