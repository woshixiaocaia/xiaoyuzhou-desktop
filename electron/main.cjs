// Electron 主进程用 CommonJS。
// 原因：npm 里的 electron 包本身是 CommonJS（index.js 导出的其实是 electron.exe 的路径，
// 运行时的 API 由 Electron 自己注入），用 ESM 命名导入 `import { app } from 'electron'`
// 在 Electron 45 + Node 24 下会报 "does not provide an export named 'BrowserWindow'"。
const { app, BrowserWindow, shell, ipcMain, session, safeStorage } = require('electron')
const path = require('node:path')
const { fetchRss } = require('./rss-fetch.cjs')
const { createTokenStore } = require('./token-store.cjs')
const { createOfficialClient } = require('./official-client.cjs')
const { createNetTransport } = require('./official-net.cjs')

// 开发模式下由 scripts/electron-dev.mjs 注入这个变量；
// 打包运行时不带它，于是走下面「加载本地文件」的分支。
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const dataDirectory = app.commandLine.getSwitchValue('user-data-dir') || (!app.isPackaged ? process.env.XIAOYUZHOU_USER_DATA : '')
if (dataDirectory) {
  app.setPath('userData', path.resolve(dataDirectory))
}


/** 创建并返回应用的主窗口 */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '小宇宙',
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'app.ico'),
    // 先隐藏，等首帧渲染完再显示，避免看到一闪而过的白屏
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 安全基線（三件套，缺一不可）：
      // contextIsolation 让预加载脚本和页面各用一套 JS 上下文
      // nodeIntegration 关掉，页面里没有 require / process
      // sandbox 让渲染进程跑在系统级沙箱里
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== win.webContents.getURL().split('#')[0]) event.preventDefault()
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // 页面里如果有 target="_blank" 或 window.open，
  // 交给系统默认浏览器打开，不在应用内部再开一个 Electron 窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (devServerUrl) {
    // 开发模式：加载 Vite 开发服务器，改代码有热更新
    win.loadURL(devServerUrl).catch((error) => {
      console.error('[main] 加载开发服务器失败：', error)
    })
  } else {
    // 生产模式：加载 vite build 产物，即 dist/index.html
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch((error) => {
      console.error('[main] 加载本地页面失败：', error)
    })
  }

  return win
}

// ── RSS 抓取通道 ────────────────────────────────────────────────
// 只暴露一个窄接口：接受一个字符串 URL，返回固定结构。
// 不暴露 ipcRenderer 本体，也不开放任意网络请求。
// 校验与错误处理全部在 rss-fetch.cjs 内完成，失败时返回固定错误码。
ipcMain.handle('rss:fetch', (_event, url) => fetchRss(typeof url === 'string' ? url : null))

// ── 官方账号通道 ────────────────────────────────────────────────
// 边界：凭据只存在于主进程（内存 + safeStorage 加密文件）。
// 渲染进程收到的永远是业务数据或错误码，不含 access/refresh 这类字段。
// 客户端惰性创建：app.getPath 需要应用就绪后调用才可靠。
let officialClient = null

function getOfficialClient() {
  if (officialClient !== null) return officialClient
  const store = createTokenStore({ safeStorage, dir: app.getPath('userData') })
  officialClient = createOfficialClient({ transport: createNetTransport(), storage: store })
  return officialClient
}

/** 统一的兜底：任何未预期异常都变成结构化错误，不让渲染进程收到异常对象 */
async function runOfficial(task) {
  try {
    return await task()
  } catch {
    return { ok: false, code: 'UNEXPECTED', message: '主进程处理官方请求时出现异常' }
  }
}

ipcMain.handle('official:auth-start', () => runOfficial(() => getOfficialClient().startLogin()))

ipcMain.handle('official:auth-poll', (_event, id) =>
  runOfficial(() => getOfficialClient().pollLogin(typeof id === 'string' ? id : '')),
)

ipcMain.handle('official:auth-status', () =>
  runOfficial(async () => {
    const store = createTokenStore({ safeStorage, dir: app.getPath('userData') })
    const client = getOfficialClient()
    const loggedIn = client.hasSession()
    return { ok: true, loggedIn, user: loggedIn ? client.currentUser() : null, storageAvailable: store.available() }
  }),
)

ipcMain.handle('official:auth-logout', () =>
  runOfficial(async () => {
    return getOfficialClient().logout()
  }),
)

ipcMain.handle('official:subscriptions', (_event, cursor) =>
  runOfficial(() => getOfficialClient().fetchSubscriptions(cursor ?? undefined)),
)

ipcMain.handle('official:episodes', (_event, pid, cursor) =>
  runOfficial(() =>
    getOfficialClient().fetchEpisodes(typeof pid === 'string' ? pid : '', cursor ?? undefined),
  ),
)

ipcMain.handle('official:listen-history', (_event, cursor) =>
  runOfficial(() => getOfficialClient().fetchListenHistory(cursor ?? undefined)),
)

ipcMain.handle('official:favorites', (_event, uid, cursor) =>
  runOfficial(() => {
    const user = getOfficialClient().currentUser()
    if (!user || typeof uid !== 'string' || uid === '' || uid !== user.uid) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '只能读取当前登录账号的收藏列表' }
    }
    return getOfficialClient().fetchFavorites(user.uid, cursor ?? undefined)
  }),
)

ipcMain.handle('official:media', (_event, eid) =>
  runOfficial(() => getOfficialClient().fetchMediaUrl(typeof eid === 'string' ? eid : '')),
)

// 搜索：参数逐个校验，渲染进程只能传字符串与白名单内的枚举
ipcMain.handle('official:search', (_event, keyword, options) =>
  runOfficial(() => {
    const opts = options && typeof options === 'object' ? options : {}
    return getOfficialClient().search(typeof keyword === 'string' ? keyword : '', {
      type: typeof opts.type === 'string' ? opts.type : 'ALL',
      limit: typeof opts.limit === 'number' ? opts.limit : 20,
      loadMoreKey: opts.loadMoreKey ?? undefined,
    })
  }),
)

/**
 * 记录一次脱敏的代理决策，便于排查"为什么拉不到源"。
 * 注意：resolveProxy 只反映会话的决策，不能单独证明请求确实经过了代理。
 */
async function logProxyDecision() {
  const probeUrl = 'https://changelog.com/podcast/feed'
  try {
    const decision = await session.defaultSession.resolveProxy(probeUrl)
    // 脱敏：去掉任何形如 //user:pass@ 的凭据片段
    const masked = String(decision).replace(/\/\/[^/@\s]*@/g, '//***@')
    console.log('[main] proxy decision for', new URL(probeUrl).host, '=>', masked)
  } catch {
    console.log('[main] proxy decision unavailable')
  }
}

// Windows 上必须设置 AppUserModelID，任务栏才会把小宇宙识别成一个独立应用，
// 而不是归到 electron.exe 名下
app.setAppUserModelId('com.xiaoyuzhou.desktop')

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  void logProxyDecision()
  createMainWindow()

  // macOS 惯例：点 Dock 图标且当前没有窗口时重建窗口。Windows 上不会触发
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Windows / Linux：关掉最后一个窗口就退出整个应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
