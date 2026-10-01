import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  Input, Spinner, Text, tokens,
} from '@fluentui/react-components'

const fmtSize = (n) => {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}
const fmtDate = (sec) => {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 命令栏图标按钮（纯图标圆角方形，title 简写） */
function Cmd({ icon, disabled, onClick, title }) {
  return (
    <button className="cmdbtn" disabled={disabled} onClick={onClick} title={title} aria-label={title}>
      <img src={icon} alt={title} />
    </button>
  )
}
const Div = () => <span className="cmdiv" />

/** BreadcrumbBar：根目录 › 一级 › 二级（每段可点击跳转） */
function Breadcrumb({ path, onNavigate }) {
  const segs = path.split('/').filter(Boolean)
  return (
    <nav className="breadcrumb" aria-label="路径">
      <button className={segs.length ? '' : 'bcur'} onClick={() => onNavigate('')}>根目录</button>
      {segs.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
          <span className="bsep">›</span>
          <button className={i === segs.length - 1 ? 'bcur' : ''} onClick={() => onNavigate(segs.slice(0, i + 1).join('/'))}>
            {s}
          </button>
        </span>
      ))}
    </nav>
  )
}

/**
 * 首页：云端文件列表。
 * 命令栏纯图标（Win11 工具栏风格）+ 复选框选择 + BreadcrumbBar 导航。
 */
export default function Files({ cfg, auth }) {
  const [path, setPath] = useState('')
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [clip, setClip] = useState(null)            // { mode:'cut'|'copy', ids, fromPath }
  const [renaming, setRenaming] = useState(null)    // { id, name }
  const [newFolder, setNewFolder] = useState(false)
  const [nfName, setNfName] = useState('')

  const load = useCallback(async (p) => {
    setBusy(true); setMsg('')
    try {
      const r = await window.api.cloud.list(p)
      if (r.error) setMsg(r.error)
      else { setItems(r.items || []); setPath(r.path || p || '') }
    } catch (e) { setMsg(String(e.message || e)) }
    setBusy(false)
  }, [])

  useEffect(() => { if (auth?.logged) load('') }, [auth?.logged, load])

  const enter = (p) => { setSelected(new Set()); load(p) }

  const act = async (fn, okMsg) => {
    setBusy(true); setMsg('')
    const r = await fn()
    if (r?.error) setMsg(r.error)
    else if (r?.canceled) { /* 取消，静默 */ }
    else if (okMsg) setMsg(okMsg)
    await load(path)
    setBusy(false)
    return r
  }

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const allChecked = items.length > 0 && items.every((f) => selected.has(f.id))
  const someChecked = items.some((f) => selected.has(f.id))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(items.map((f) => f.id)))

  const selItems = useMemo(() => items.filter((f) => selected.has(f.id)), [items, selected])
  const selIds = selItems.map((f) => f.id)
  const single = selItems.length === 1 ? selItems[0] : null
  const canDownload = single && !single.isFolder
  const localDir = cfg?.pairs?.find((x) => x.enabled)?.localDir || cfg?.pairs?.[0]?.localDir

  const parent = () => path.split('/').filter(Boolean).slice(0, -1).join('/')
  const child = (f) => (path ? `${path}/${f.name}` : f.name)

  if (!auth?.logged) {
    return <Text>请先点右上角「登录」——会打开一个独立的 Edge 窗口，登录完成后本页自动加载。</Text>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 路径行：BreadcrumbBar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginBottom: 4 }}>
        <Breadcrumb path={path} onNavigate={enter} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {busy && <Spinner size="tiny" />}
          {msg && <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>{msg}</Text>}
          {!msg && !busy && selIds.length > 0 && (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>已选 {selIds.length} 项</Text>
          )}
        </div>
      </div>

      {/* 命令栏 */}
      <div className="cmdbar" style={{ marginBottom: 6, flexShrink: 0 }}>
        <Cmd icon="./icons/up.png" title="上级" disabled={busy || !path} onClick={() => enter(parent())} />
        <Cmd icon="./icons/refresh.png" title="刷新" disabled={busy} onClick={() => load(path)} />
        <Div />
        <Cmd icon="./icons/new-folder.png" title="新建文件夹" disabled={busy} onClick={() => { setNfName(''); setNewFolder(true) }} />
        <Div />
        <Cmd icon="./icons/cut.png" title="剪切" disabled={busy || !selIds.length}
          onClick={() => { setClip({ mode: 'cut', ids: selIds, fromPath: path }); setMsg(`已剪切 ${selIds.length} 项`) }} />
        <Cmd icon="./icons/copy.png" title="复制" disabled={busy || !selIds.length}
          onClick={() => { setClip({ mode: 'copy', ids: selIds, fromPath: path }); setMsg(`已复制 ${selIds.length} 项`) }} />
        <Cmd icon="./icons/paste.png" title="粘贴" disabled={busy || !clip || clip.fromPath === path}
          onClick={() => {
            const fn = clip.mode === 'cut'
              ? () => window.api.cloud.move(clip.ids, clip.fromPath, path)
              : () => window.api.cloud.copy(clip.ids, clip.fromPath, path)
            act(fn, clip.mode === 'cut' ? '已移动' : '已复制').then(() => { if (clip.mode === 'cut') setClip(null) })
          }} />
        <Cmd icon="./icons/rename.png" title="重命名" disabled={busy || !single} onClick={() => setRenaming({ id: single.id, name: single.name })} />
        <Cmd icon="./icons/delete.png" title="删除" disabled={busy || !selIds.length}
          onClick={() => act(() => window.api.cloud.remove(selIds, path), '已移入云端回收站')} />
        <Div />
        <Cmd icon="./icons/download.png" title="下载" disabled={busy || !canDownload}
          onClick={() => act(() => window.api.cloud.download(single.id, single.name, localDir), '已下载')} />
      </div>

      {/* 列表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 40 }} />
            <col />
            <col style={{ width: 132 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr style={{ textAlign: 'left', color: tokens.colorNeutralForeground3 }}>
              <th style={{ ...th, padding: '6px 4px 6px 8px' }}>
                <Checkbox
                  aria-label="本页全选" checked={allChecked}
                  indeterminate={someChecked && !allChecked} onChange={toggleAll}
                />
              </th>
              <th style={th}>名称</th>
              <th style={{ ...th, width: 132 }}>修改日期</th>
              <th style={{ ...th, width: 90 }}>大小</th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id} style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke3}` }}>
                <td style={{ ...td, padding: '6px 4px 6px 8px', verticalAlign: 'middle' }}>
                  <Checkbox aria-label={f.name} checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                </td>
                <td style={{ ...td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>
                  {f.isFolder ? (
                    <button
                      onClick={() => enter(child(f))}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: tokens.colorBrandForeground1, fontSize: 13 }}
                    >
                      {f.name}/
                    </button>
                  ) : f.name}
                </td>
                <td style={{ ...td, color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' }}>{fmtDate(f.mtime)}</td>
                <td style={{ ...td, color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' }}>{f.isFolder ? '—' : fmtSize(f.size)}</td>
              </tr>
            ))}
            {!items.length && !busy && (
              <tr><td colSpan={4} style={{ padding: 16, color: tokens.colorNeutralForeground3 }}>（空目录）</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 新建文件夹（窄弹窗、无标题） */}
      <Dialog open={newFolder} onOpenChange={(_e, d) => { if (!d.open) setNewFolder(false) }}>
        <DialogSurface style={{ width: 300 }}>
          <DialogBody>
            <DialogContent>
              <Input
                autoFocus placeholder="文件夹名称" style={{ width: '100%' }}
                value={nfName} onChange={(_e, d) => setNfName(d.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && nfName.trim()) {
                    await act(() => window.api.cloud.mkdir(nfName.trim(), path), '已新建')
                    setNewFolder(false)
                  }
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setNewFolder(false)}>取消</Button>
              <Button appearance="primary" disabled={busy || !nfName.trim()}
                onClick={async () => {
                  await act(() => window.api.cloud.mkdir(nfName.trim(), path), '已新建')
                  setNewFolder(false)
                }}
              >
                确定
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* 重命名（窄弹窗、无标题） */}
      <Dialog open={Boolean(renaming)} onOpenChange={(_e, d) => { if (!d.open) setRenaming(null) }}>
        <DialogSurface style={{ width: 300 }}>
          <DialogBody>
            <DialogContent>
              <Input
                autoFocus style={{ width: '100%' }}
                value={renaming?.name || ''} onChange={(_e, d) => setRenaming((r) => ({ ...r, name: d.value }))}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && renaming?.name.trim()) {
                    await act(() => window.api.cloud.rename(renaming.id, renaming.name.trim()), '已重命名')
                    setRenaming(null)
                  }
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenaming(null)}>取消</Button>
              <Button appearance="primary" disabled={busy || !renaming?.name.trim()}
                onClick={async () => {
                  await act(() => window.api.cloud.rename(renaming.id, renaming.name.trim()), '已重命名')
                  setRenaming(null)
                }}
              >
                确定
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

const th = { padding: '6px 8px', fontWeight: 400, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, whiteSpace: 'nowrap' }
const td = { padding: '6px 8px' }
