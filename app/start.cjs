/**
 * 启动包装器 —— 为什么需要它：
 * 某些终端环境（例如从 Electron 应用内派生出来的 shell）会带上 ELECTRON_RUN_AS_NODE=1，
 * 这个变量会让 electron.exe 以「纯 Node」模式启动，主进程里 require('electron')
 * 拿到的就只是可执行文件路径字符串，解构出来的 app 是 undefined，直接崩。
 *
 * 这里显式删掉该变量再拉起 electron。node 模式下 require('electron') 返回的就是
 * electron.exe 的路径，正好拿来用。
 */
const { spawn } = require('node:child_process')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const electronPath = require('electron') // node 模式下返回 electron.exe 路径
// 透传额外参数，例如 --disable-gpu（无 GPU 的受限环境里 GPU 进程会崩，导致应用退出）
const args = ['.', ...process.argv.slice(2)]
const child = spawn(electronPath, args, { cwd: __dirname, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
