/**
 * Electron 开发模式启动器。
 *
 * 做三件事，按顺序：
 *   1. 启动 Vite 开发服务器（绑到 127.0.0.1，避免 localhost 解析到 IPv6 后 Electron 连不上）
 *   2. 轮询等待服务器真正可访问（不是「进程起来了」就算好，要有 HTTP 响应）
 *   3. 启动 Electron，并通过环境变量把服务器地址传进主进程
 *
 * 关窗口 → Electron 退出 → 这里顺手把 Vite 一起收掉，不留后台进程。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '..')

const HOST = '127.0.0.1'
const PORT = Number(process.env.ELECTRON_DEV_PORT ?? 5173)
const devServerUrl = `http://${HOST}:${PORT}/`

/** 已启动的子进程，退出时统一清理 */
const children = []
let shuttingDown = false

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      child.kill()
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/** 轮询直到开发服务器返回 2xx；超时则报错，不无限等待 */
async function waitForDevServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shuttingDown) return
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // 服务器还没起来，属于正常现象，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Vite 开发服务器在 ${timeoutMs} ms 内没有就绪：${url}`)
}

// ── 1. 启动 Vite ───────────────────────────────────────────────
// 直接执行 node_modules 里的 vite 入口，而不是走 npm 脚本，
// 这样在 Windows 上不会遇到 .cmd shim 和引号转义的问题。
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const viteProcess = start(process.execPath, [
  viteEntry,
  '--host',
  HOST,
  '--port',
  String(PORT),
  '--strictPort',
])

let viteReady = false
viteProcess.on('exit', (code) => {
  if (!viteReady) {
    console.error(`\n[electron-dev] Vite 启动失败（退出码 ${code}）。`)
    console.error(`[electron-dev] 常见原因：端口 ${PORT} 已被占用（--strictPort 会让它直接退出）。`)
    console.error('[electron-dev] 换端口重试：$env:ELECTRON_DEV_PORT=5174; npm run electron:dev')
    shutdown(code ?? 1)
  }
})

// ── 2. 等待服务器就绪 ──────────────────────────────────────────
try {
  await waitForDevServer(devServerUrl)
} catch (error) {
  console.error('\n[electron-dev]', error.message)
  shutdown(1)
}

viteReady = true
console.log(`\n[electron-dev] Vite 已就绪：${devServerUrl}`)
console.log('[electron-dev] 正在打开 Electron 窗口…（关闭窗口即结束本次开发会话）\n')

// ── 3. 启动 Electron ──────────────────────────────────────────
// require('electron') 返回的不是模块，而是 electron.exe 的绝对路径字符串
const electronPath = require('electron')

const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl }
// 如果环境里带了这个变量，electron.exe 会退化成普通 Node 进程，
// 于是 require('electron') 拿到的是路径字符串而不是 API，报 app is undefined。
// 某些终端 / CI 会全局设置它，这里显式清掉，保证一定按 Electron 启动。
delete electronEnv.ELECTRON_RUN_AS_NODE

// 透传 Electron 自己的命令行参数，例如调试用：
//   npm run electron:dev -- --remote-debugging-port=9222
const extraArgs = process.argv.slice(2)

const electronProcess = start(electronPath, ['.', ...extraArgs], { env: electronEnv })

electronProcess.on('exit', (code) => {
  console.log(`\n[electron-dev] Electron 已退出（退出码 ${code ?? 0}），正在关闭 Vite…`)
  shutdown(code ?? 0)
})