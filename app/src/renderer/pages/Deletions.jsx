import React, { useCallback, useEffect, useState } from 'react'
import { Button, Text, tokens } from '@fluentui/react-components'

const fmtSize = (n) => {
  if (!n) return '—'
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—')

/** 台账状态 → 中文（与 src/state.mjs 的 pending/handled/ignored 对应） */
const STATUS_TEXT = { pending: '待处理', handled: '已删除', ignored: '已忽略' }
const STATUS_COLOR = {
  pending: tokens.colorPaletteRedForeground1,
  handled: tokens.colorNeutralForeground3,
  ignored: tokens.colorNeutralForeground3,
}

/** 批量操作的忙碌哨兵：与单条操作的 key 区分开，任何忙碌都锁住全表 */
const BATCH_BUSY = '__batch__'

/**
 * 删除记录：两端都不自动删除，只记账。
 * - 本地已消失但云端仍在 → 可把云端文件移入回收站（可还原）
 * - 云端已消失但本地仍有 → 可把本地文件备份后移入回收站
 * - 可多选后一次性处理；主进程内部每 10 个一组逐项复核，遇错立即停止
 * 列表保留本次运行期间的全部记录（含已处理），不会因为切页而清空。
 */
export default function Deletions() {
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      const list = await window.api.deletions.list()
      if (!Array.isArray(list)) throw new Error('删除台账返回格式错误')
      setLoadError('')
      // 待处理排前面；同组内按修改时间倒序
      setItems(
        [...list].sort((a, b) => {
          const pa = a.status === 'pending' ? 0 : 1
          const pb = b.status === 'pending' ? 0 : 1
          return pa - pb || (b.foundAt || 0) - (a.foundAt || 0)
        }),
      )
      // 台账重读后，勾选只保留「仍然待处理」的项，避免选中已被处理掉的 key
      setSelected((prev) => {
        const pendingKeys = new Set(list.filter((i) => i.status === 'pending').map((i) => i.key))
        const next = new Set()
        for (const k of prev) if (pendingKeys.has(k)) next.add(k)
        return next
      })
    } catch (e) {
      setLoadError(`删除台账读取失败：${(e && e.message) || e}`)
    }
  }, [])

  useEffect(() => {
    load()
    // 同步跑完后台账可能新增记录 → 自动重新读取，省掉手动「刷新」按钮
    // （只是重读本地 data/deletions.json，不发任何网络请求）
    return window.api.sync.onDone(() => load())
  }, [load])

  const purge = async (key) => {
    setBusy(key)
    setMsg('')
    try {
      const r = await window.api.deletions.purge(key)
      setMsg(r?.error ? r.error : (r?.msg || '已处理'))
      await load()
    } catch (e) {
      setMsg(`操作失败：${(e && e.message) || e}`)
    } finally {
      setBusy('')
    }
  }

  const mark = async (key, status) => {
    setBusy(key)
    setMsg('')
    try {
      const ok = await window.api.deletions.mark(key, status)
      setMsg(ok ? '已忽略' : '标记失败')
      await load()
    } catch (e) {
      setMsg(`操作失败：${(e && e.message) || e}`)
    } finally {
      setBusy('')
    }
  }

  const pendingItems = items.filter((i) => i.status === 'pending')
  const doneCount = items.length - pendingItems.length
  const allSelected = pendingItems.length > 0 && pendingItems.every((i) => selected.has(i.key))

  const toggleOne = (key) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(pendingItems.map((i) => i.key)))

  /**
   * 批量处理已勾选的项。
   * delete = 确认同步删除（把另一端也送进回收站）；ignore = 批量忽略。
   */
  const runBatch = async (mode) => {
    const keys = [...selected]
    if (!keys.length) return
    setMsg('')
    setBusy(BATCH_BUSY)
    try {
      const r = mode === 'delete'
        ? await window.api.deletions.purgeBatch(keys)
        : await window.api.deletions.markBatch(keys, 'ignored')
      setMsg(r?.error ? r.error : (r?.msg || `已处理 ${r?.done || 0} 项`))
      setSelected(new Set())
      await load()
    } catch (e) {
      setMsg(`批量操作失败：${(e && e.message) || e}`)
    } finally {
      setBusy('')
    }
  }

  const locked = !!busy || !!loadError

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Text weight="semibold" size={300}>待处理 {pendingItems.length}</Text>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>已处理 {doneCount}</Text>
        {selected.size > 0 && <Text size={200}>已选 {selected.size} 项</Text>}
        {selected.size > 0 && (
          <Button
            size="small"
            appearance="primary"
            disabled={locked}
            onClick={() => runBatch('delete')}
          >
            确认同步删除
          </Button>
        )}
        {selected.size > 0 && (
          <Button
            size="small"
            appearance="subtle"
            disabled={locked}
            onClick={() => runBatch('ignore')}
          >
            批量忽略
          </Button>
        )}
      </div>
      <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginBottom: 8 }}>
        同步不会自动删除任何一端；可多选后一次确认。内部每 10 个一组逐项复核，遇错立即停止；本地先备份再进回收站。
      </Text>
      {loadError && (
        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, marginBottom: 8 }}>{loadError}</Text>
      )}
      {msg && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground2, marginBottom: 8 }}>{msg}</Text>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 38 }} />
            <col style={{ width: 84 }} />
            <col />
            <col style={{ width: 82 }} />
            <col style={{ width: 148 }} />
            <col style={{ width: 152 }} />
          </colgroup>
          <thead>
            <tr style={{ textAlign: 'left', color: tokens.colorNeutralForeground3 }}>
              <th style={th}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={!!loadError}
                  onChange={toggleAll}
                  aria-label="全选待处理"
                />
              </th>
              <th style={th}>状态</th>
              <th style={th}>文件</th>
              <th style={th}>大小</th>
              <th style={th}>修改时间</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const pending = i.status === 'pending'
              return (
                <tr key={i.key} style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, opacity: pending ? 1 : 0.62 }}>
                  <td style={td}>
                    {pending ? (
                      <input
                        type="checkbox"
                        checked={selected.has(i.key)}
                        disabled={!!loadError}
                        onChange={() => toggleOne(i.key)}
                        aria-label={`选择 ${i.relPath}`}
                      />
                    ) : null}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: STATUS_COLOR[i.status] || undefined }}>
                    {STATUS_TEXT[i.status] || i.status}
                  </td>
                  <td
                    style={{ ...td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={`${i.relPath}\n${i.side === 'cloud' ? '云端已消失（本地仍有）' : '本地已消失（云端仍有）'}`}
                  >
                    {i.relPath}
                  </td>
                  <td style={{ ...td, color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' }}>{fmtSize(i.size)}</td>
                  <td style={{ ...td, color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' }}>{fmtTime(i.foundAt)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {pending ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        {((i.side === 'local' && i.fileId) || i.side === 'cloud') && (
                          <Button
                            size="small"
                            appearance="primary"
                            style={btnStyle}
                            disabled={locked}
                            onClick={() => purge(i.key)}
                          >
                            {i.side === 'local' ? '删除云端' : '删除本地'}
                          </Button>
                        )}
                        <Button size="small" appearance="subtle" style={btnStyle} disabled={locked} onClick={() => mark(i.key, 'ignored')}>
                          忽略
                        </Button>
                      </div>
                    ) : (
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>—</Text>
                    )}
                  </td>
                </tr>
              )
            })}
            {!items.length && !loadError && (
              <tr><td colSpan={6} style={{ padding: 16, color: tokens.colorNeutralForeground3 }}>暂无记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const th = { padding: '8px 10px', fontWeight: 400, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, whiteSpace: 'nowrap' }
const td = { padding: '7px 10px' }
const btnStyle = { minWidth: 0, padding: '2px 8px' }
