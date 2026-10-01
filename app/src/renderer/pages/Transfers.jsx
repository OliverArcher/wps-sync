import React, { useEffect, useRef } from 'react'
import { Spinner, Text, tokens } from '@fluentui/react-components'

// 启动同步（sync-1）本身已包含"上传本地变更"，所以不再单独放上传按钮
const MODES = [
  { key: 'startup', icon: './icons/sync-1.png', title: '启动同步' },
  { key: 'check', icon: './icons/check.png', title: '核对' },
]

/**
 * 传输：日志与运行状态由 App 持有（切页不丢、退出不清）。
 */
export default function Transfers({ log, running, mode, watch, onRun, onClear, seed, onSeedConsumed }) {
  const boxRef = useRef(null)

  // 外部注入的内容（顶栏点「已登录」）
  useEffect(() => {
    if (!seed) return
    const head = `\n[${new Date(seed.at).toLocaleTimeString()}]\n`
    onSeedConsumed?.()
    return undefined
  }, [seed, onSeedConsumed])

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [log])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 10 }}>
      <div className="cmdbar" style={{ flexShrink: 0 }}>
        {MODES.map((m) => (
          <button
            key={m.key} className="cmdbtn" title={m.title} aria-label={m.title}
            disabled={running} onClick={() => onRun(m.key, m.title)}
          >
            <img src={m.icon} alt={m.title} />
          </button>
        ))}
        <span className="cmdiv" />
        <button className="cmdbtn" title="清屏" aria-label="清屏" disabled={running} onClick={onClear}>
          <span style={{ fontSize: 14, lineHeight: '18px' }}>×</span>
        </button>
        {running && (
          <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colorNeutralForeground2 }}>
            <Spinner size="tiny" /> {mode}中…
          </span>
        )}
        {!running && watch?.on && (
          <span style={{ marginLeft: 8, fontSize: 12, color: tokens.colorNeutralForeground3 }}>
            监听中{watch.pending ? ` · 待传 ${watch.pending}` : ''}
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        style={{
          flex: 1, minHeight: 160, overflow: 'auto', padding: 10,
          background: tokens.colorNeutralBackground1,
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: tokens.borderRadiusMedium,
          fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {log || (
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            点上方按钮运行；输出会实时刷新到这里，切页面、关窗口都不会丢失（本次运行内）。
          </Text>
        )}
      </div>
    </div>
  )
}
