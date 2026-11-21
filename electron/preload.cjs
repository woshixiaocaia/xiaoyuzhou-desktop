const { contextBridge, ipcRenderer } = require('electron')

// 预加载脚本运行在「页面」和「主进程」之间，是唯一允许同时接触两边的位置。
//
// 注意：这里必须写成 CommonJS（.cjs）。
// 因为 sandbox: true 的预加载脚本不支持 ESM，而项目 package.json 里是 "type": "module"，
// 所以用 .cjs 后缀显式声明这是 CommonJS。
//
// contextIsolation: true 下，页面只能看到 exposeInMainWorld 显式暴露的东西，
// 拿不到 ipcRenderer 本体，也就无法自己伪造调用。
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /**
   * 抓取 RSS/Atom 源。
   *
   * 只转交一个字符串给主进程，不暴露 ipcRenderer 本体，
   * 因此页面无法调用任意 IPC 通道。
   * 非字符串入参会被置为 null 交给主进程判定，避免序列化任意对象。
   */
  fetchRss: (url) => ipcRenderer.invoke('rss:fetch', typeof url === 'string' ? url : null),

  // ── 官方账号 ────────────────────────────────────────────────
  // 同样只转交「字符串 / 分页游标」，不暴露 ipcRenderer。
  // 注意：这里没有任何读写凭据的方法——凭据只在主进程内使用，
  // 页面拿不到，也无法通过 IPC 请求它。
  officialAuthStart: () => ipcRenderer.invoke('official:auth-start'),
  officialAuthPoll: (id) => ipcRenderer.invoke('official:auth-poll', typeof id === 'string' ? id : null),
  officialAuthStatus: () => ipcRenderer.invoke('official:auth-status'),
  officialAuthLogout: () => ipcRenderer.invoke('official:auth-logout'),
  officialSubscriptions: (cursor) => ipcRenderer.invoke('official:subscriptions', cursor ?? null),
  officialEpisodes: (pid, cursor) =>
    ipcRenderer.invoke('official:episodes', typeof pid === 'string' ? pid : null, cursor ?? null),
  officialMediaUrl: (eid) => ipcRenderer.invoke('official:media', typeof eid === 'string' ? eid : null),
  officialSearch: (keyword, options) =>
    ipcRenderer.invoke(
      'official:search',
      typeof keyword === 'string' ? keyword : null,
      options && typeof options === 'object' ? options : null,
    ),
})
