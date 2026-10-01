import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程构建配置。开发时 Electron 直接连 http://localhost:5173，
// 打包后加载 dist/index.html（见 src/main.cjs）。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
