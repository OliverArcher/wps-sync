import React, { useEffect, useState } from 'react'
import { Button, Input, Text, tokens } from '@fluentui/react-components'

const row = { display: 'flex', gap: 8, alignItems: 'center' }
const label = { width: 64, flexShrink: 0, color: tokens.colorNeutralForeground3, fontSize: 12 }

/** 设置：同步目录（系统选择器）、限速、排除规则 */
export default function Settings({ cfg, onChange }) {
  const [draft, setDraft] = useState(null)
  const [buildMsg, setBuildMsg] = useState('')

  useEffect(() => { if (cfg) setDraft(JSON.parse(JSON.stringify(cfg))) }, [cfg])

  if (!draft) return <Text>加载中…</Text>

  const setPair = (idx, patch) => {
    setDraft((d) => {
      const next = JSON.parse(JSON.stringify(d))
      next.pairs[idx] = { ...next.pairs[idx], ...patch }
      return next
    })
  }

  const save = async () => {
    await window.api.config.set(draft)
    onChange?.()
  }

  const card = {
    padding: 12, marginBottom: 12, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <Text weight="semibold" size={300}>同步目录</Text>
      <div style={{ marginTop: 8 }}>
        {(draft.pairs || []).map((p, idx) => (
          <div key={idx} style={card}>
            <div style={{ ...row, marginBottom: 8 }}>
              <input
                type="checkbox" checked={!!p.enabled} id={`pair-${idx}`}
                onChange={(e) => setPair(idx, { enabled: e.target.checked })}
                style={{ accentColor: tokens.colorBrandBackground, cursor: 'pointer' }}
              />
              <label htmlFor={`pair-${idx}`} style={{ cursor: 'pointer' }}>
                <Text size={200} weight="semibold">{p.name}</Text>
              </label>
            </div>
            <div style={row}>
              <span style={label}>本地目录</span>
              <Input size="small" style={{ flex: 1 }} value={p.localDir} readOnly />
              <Button
                size="small" onClick={async () => {
                  const dir = await window.api.shell.pickFolder(p.localDir)
                  if (dir) setPair(idx, { localDir: dir.replace(/\\/g, '/') })
                }}
              >
                浏览…
              </Button>
            </div>
            <div style={{ ...row, marginTop: 6 }}>
              <span style={label}>云端目录</span>
              <Input size="small" style={{ flex: 1 }} value={p.cloudPath}
                onChange={(_e, d) => setPair(idx, { cloudPath: d.value })} />
            </div>
          </div>
        ))}
      </div>

      <Text weight="semibold" size={300}>本地数据库</Text>
      <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', margin: '2px 0 8px' }}>
        本地快照记录了每个文件的云端 id、sha1 和同步基线。首次使用或快照损坏时需要重建
      </Text>
      <div style={{ ...row, marginBottom: 16 }}>
        <Button
          size="small" onClick={async () => {
            setBuildMsg('重建中…（约 20 分钟，期间勿重复操作）')
            const r = await window.api.sync.run('build')
            if (r?.error) setBuildMsg(r.error)
            else setBuildMsg('已开始重建，请到「传输」页查看进度')
          }}
        >
          重建本地数据库
        </Button>
        {buildMsg && <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>{buildMsg}</Text>}
      </div>

      <Text weight="semibold" size={300}>限速</Text>
      <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', margin: '2px 0 8px' }}>
        实测 22 次/秒会触发云端 429（约 10% 请求被拒），默认 8/s 可完整建库零错误，不要调高
      </Text>
      <div style={{ ...row, marginBottom: 16 }}>
        <span style={label}>并发</span>
        <Input
          size="small" style={{ width: 90 }} type="number"
          value={String(draft.sync?.concurrency ?? 8)}
          onChange={(_e, d) => setDraft((v) => ({ ...v, sync: { ...(v.sync || {}), concurrency: Number(d.value) } }))}
        />
        <span style={{ ...label, marginLeft: 16 }}>最大 QPS</span>
        <Input
          size="small" style={{ width: 90 }} type="number"
          value={String(draft.sync?.maxQps ?? 8)}
          onChange={(_e, d) => setDraft((v) => ({ ...v, sync: { ...(v.sync || {}), maxQps: Number(d.value) } }))}
        />
      </div>

      <Text weight="semibold" size={300}>排除规则</Text>
      <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', margin: '2px 0 8px' }}>
        逗号分隔，匹配文件名；如 *.tmp, *.bak, desktop.ini
      </Text>
      <Input
        size="small" style={{ width: '100%' }}
        value={(draft.exclude || []).join(', ')}
        onChange={(_e, d) => setDraft((v) => ({ ...v, exclude: d.value.split(',').map((s) => s.trim()).filter(Boolean) }))}
      />

      <div style={{ marginTop: 18, paddingBottom: 8 }}>
        <Button appearance="primary" onClick={save}>保存</Button>
      </div>
    </div>
  )
}
