/**
 * preload —— 受控地暴露 IPC 给渲染进程（contextIsolation: true，不开 nodeIntegration）
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (cfg) => ipcRenderer.invoke('config:set', cfg),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  shell: {
    openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
    pickFolder: (defaultPath) => ipcRenderer.invoke('shell:pickFolder', defaultPath),
  },
  cloud: {
    list: (p) => ipcRenderer.invoke('cloud:list', p),
    rename: (fileId, newName) => ipcRenderer.invoke('cloud:rename', fileId, newName),
    mkdir: (name, cloudPath) => ipcRenderer.invoke('cloud:mkdir', name, cloudPath),
    move: (fileIds, srcPath, dstPath) => ipcRenderer.invoke('cloud:move', fileIds, srcPath, dstPath),
    copy: (fileIds, srcPath, dstPath) => ipcRenderer.invoke('cloud:copy', fileIds, srcPath, dstPath),
    remove: (fileIds, srcPath) => ipcRenderer.invoke('cloud:remove', fileIds, srcPath),
    download: (fileId, name, preferDir) => ipcRenderer.invoke('cloud:download', fileId, name, preferDir),
  },
  deletions: {
    list: () => ipcRenderer.invoke('deletions:list'),
    purge: (key) => ipcRenderer.invoke('deletions:purge', key),
    purgeBatch: (keys) => ipcRenderer.invoke('deletions:purgeBatch', keys),
    mark: (key, status) => ipcRenderer.invoke('deletions:mark', key, status),
    markBatch: (keys, status) => ipcRenderer.invoke('deletions:markBatch', keys, status),
  },
  watch: {
    start: () => ipcRenderer.invoke('watch:start'),
    stop: () => ipcRenderer.invoke('watch:stop'),
    state: () => ipcRenderer.invoke('watch:state'),
    onState: (cb) => {
      const h = (_e, s) => cb(s)
      ipcRenderer.on('watch:state', h)
      return () => ipcRenderer.removeListener('watch:state', h)
    },
  },
  sync: {
    run: (mode) => ipcRenderer.invoke('sync:run', mode),
    /**
     * 本次运行期间已经产生的传输日志（窗口关掉再打开时补齐用）。
     * 返回值 { text, truncated }：truncated=true 表示更早的日志已被缓冲上限裁掉。
     */
    history: () => ipcRenderer.invoke('log:history'),
    /** 「清屏」：主进程缓冲一并清空，否则重开窗口会把刚清掉的日志又捞回来 */
    clear: () => ipcRenderer.invoke('log:clear'),
    /** 同步过程中的实时输出 */
    onLog: (cb) => {
      const h = (_e, s) => cb(s)
      ipcRenderer.on('sync:log', h)
      return () => ipcRenderer.removeListener('sync:log', h)
    },
    onDone: (cb) => {
      const h = (_e, r) => cb(r)
      ipcRenderer.on('sync:done', h)
      return () => ipcRenderer.removeListener('sync:done', h)
    },
  },
})
