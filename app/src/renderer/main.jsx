import React from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import App from './App.jsx'

// 只做浅色模式（用户明确要求），故固定 webLightTheme，不跟随系统
// 关键：FluentProvider 自身高度必须撑满，否则内部 height:100% 全部塌陷（框架填不满窗口的根因）
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FluentProvider theme={webLightTheme} style={{ height: '100vh' }}>
      <App />
    </FluentProvider>
  </React.StrictMode>,
)
