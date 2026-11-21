'use strict'

/**
 * 小宇宙官方 API 客户端（主进程专用，**不依赖 electron**）。
 *
 * 分工：
 *   - 本文件只负责「构造请求 + 解析响应 + 维护会话」；
 *   - 真正的网络传输由注入的 transport 完成（生产用 electron 的 net，测试用假实现）；
 *   - 凭据由注入的 storage 落盘（生产用 safeStorage 加密存储）。
 *
 * 因此本文件可以在 Node 测试里被完整地离线验证。
 */

// 已审计源码中出现过的三个主机。账号中心负责二维码，其余走 app API。
const HOSTS = {
  accounts: 'https://accounts.xiaoyuzhoufm.com',
  api: 'https://api.xiaoyuzhoufm.com',
  webApi: 'https://web-api.xiaoyuzhoufm.com',
}

const ENDPOINTS = {
  // 二维码接口在 web-api 主机上（实测：POST 该路径返回 200，body 为 {id,url}）。
  // accounts.xiaoyuzhoufm.com 只用于 Origin/Referer 头，见 webHeaders()。
  qrCreate: { host: HOSTS.webApi, method: 'POST', path: '/v1/auth/qrcode/create' },
  qrPoll: { host: HOSTS.webApi, method: 'POST', path: '/v1/auth/qrcode/login' },
  refresh: { host: HOSTS.api, method: 'POST', path: '/app_auth_tokens.refresh' },
  me: { host: HOSTS.webApi, method: 'GET', path: '/web/user/get-me' },
  subscriptions: { host: HOSTS.api, method: 'POST', path: '/v1/subscription/list' },
  episodes: { host: HOSTS.api, method: 'POST', path: '/v1/episode/list' },
  episodeHistory: { host: HOSTS.api, method: 'POST', path: '/v1/episode-played/list-history' },
  playbackProgress: { host: HOSTS.api, method: 'POST', path: '/v1/playback-progress/list' },
  favorites: { host: HOSTS.api, method: 'POST', path: '/v1/pick/list-history' },
  media: { host: HOSTS.api, method: 'GET', path: '/v1/private-media/get' },
  // 依据第三方源码实现（cli-anything-xiaoyuzhoufm/utils/api_client.py），
  // 请求体为 {keyword, type, limit(字符串), loadMoreKey?}，需登录态。
  // 注意：当前账号尚未做过真实请求验证。
  search: { host: HOSTS.api, method: 'POST', path: '/v1/search/create' },
}

// 账号中心的网页客户端会带这个公开的 app id（从公开前端包里可读到，不是用户凭据）。
const MIDWAY_APP_ID = 'v6worU4NnWyL'

// 官方网页端的正常 UA；可在构造时覆盖，方便接口变动时调整。
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT_MS = 15000

function lowerHeaders(headers) {
  const out = {}
  if (headers === null || typeof headers !== 'object') return out
  for (const key of Object.keys(headers)) {
    out[String(key).toLowerCase()] = headers[key]
  }
  return out
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return typeof value === 'string' ? value : ''
}

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 统一错误形状，调用方不需要 try/catch */
function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {})
}

/**
 * @param {object} options
 * @param {(req: {url:string,method:string,headers:object,body?:string,timeoutMs:number}) => Promise<{status:number,headers:object,body:string}>} options.transport
 * @param {{ load(): object|null, save(s: object): {ok:boolean,code?:string,message?:string}, clear(): object }} options.storage
 * @param {string} [options.userAgent]
 */
function createOfficialClient({ transport, storage, userAgent }) {
  if (typeof transport !== 'function') throw new Error('需要 transport')
  if (!storage || typeof storage.load !== 'function') throw new Error('需要 storage')

  const ua = typeof userAgent === 'string' && userAgent !== '' ? userAgent : DEFAULT_UA

  /** 内存中的会话副本；令牌只在这里与加密文件里存在，绝不出主进程 */
  let session = storage.load()
  let authEpoch = 0
  let refreshInFlight = null

  function webHeaders() {
    return {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Origin: HOSTS.accounts,
      Referer: `${HOSTS.accounts}/`,
      'x-midway-app-id': MIDWAY_APP_ID,
      'User-Agent': ua,
    }
  }

  function appHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ua,
    }
    if (session && typeof session.access === 'string' && session.access !== '') {
      headers['x-jike-access-token'] = session.access
    }
    return headers
  }

  async function send(endpoint, { headers, body, query } = {}) {
    let url = endpoint.host + endpoint.path
    if (query !== undefined) {
      const search = new URLSearchParams()
      for (const key of Object.keys(query)) search.set(key, String(query[key]))
      url += `?${search.toString()}`
    }
    let response
    try {
      response = await transport({
        url,
        method: endpoint.method,
        headers: headers || {},
        body: typeof body === 'string' ? body : undefined,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
    } catch (error) {
      const timedOut = error && (error.code === 'ETIMEDOUT' || error.name === 'TimeoutError')
      return timedOut
        ? fail('TIMEOUT', '请求超时，请检查网络或代理设置')
        : fail('NETWORK', '网络请求失败，请检查网络或代理设置')
    }
    if (response === null || typeof response !== 'object' || typeof response.status !== 'number') {
      return fail('NETWORK', '网络响应异常')
    }
    return { ok: true, status: response.status, headers: lowerHeaders(response.headers), body: response.body }
  }

  function applySession(next) {
    session = next
    const saved = storage.save(next)
    if (!saved || saved.ok !== true) {
      // 存储失败不影响本次会话的内存态，但要让上层知道「重启后需要重新登录」
      return { ok: false, code: saved && saved.code ? saved.code : 'STORAGE_WRITE_FAILED', message: saved && saved.message ? saved.message : '登录状态保存失败' }
    }
    return { ok: true }
  }

  /** 从响应头里取令牌（官方二维码登录成功后令牌在响应头，不在 body） */
  function sessionFromResponse(headers, body, user) {
    const access =
      headerValue(headers, 'x-jike-access-token') ||
      (body && typeof body === 'object' && typeof body['x-jike-access-token'] === 'string' ? body['x-jike-access-token'] : '')
    const refresh =
      headerValue(headers, 'x-jike-refresh-token') ||
      (body && typeof body === 'object' && typeof body['x-jike-refresh-token'] === 'string' ? body['x-jike-refresh-token'] : '')
    if (access === '') return null
    return { access, refresh, user: user || null }
  }

  // ── 登录 ──────────────────────────────────────────────────────

  /** 创建二维码。返回 { ok, id, url } */
  async function startLogin() {
    authEpoch += 1
    const res = await send(ENDPOINTS.qrCreate, {
      headers: webHeaders(),
      body: JSON.stringify({ clientId: 'xyz-web' }),
    })
    if (!res.ok) return res
    if (res.status < 200 || res.status >= 300) {
      return fail('HTTP_STATUS', `创建登录二维码失败（HTTP ${res.status}）`, { status: res.status })
    }
    const data = parseJson(res.body)
    if (data === null || typeof data.id !== 'string' || data.id === '') {
      return fail('PARSE', '二维码响应格式无法识别')
    }
    const url =
      typeof data.url === 'string' && data.url !== ''
        ? data.url
        : `https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=${encodeURIComponent(data.id)}`
    return { ok: true, id: data.id, url }
  }

  /**
   * 轮询扫码状态。
   * 返回 { ok, status } 或 { ok:false, code }。
   * status: WAITTING | SCANNED | CONFIRMED | EXPIRED
   */
  async function pollLogin(id) {
    if (typeof id !== 'string' || id === '') return fail('INVALID_ARGUMENT', '缺少二维码标识')
    const epoch = authEpoch
    const res = await send(ENDPOINTS.qrPoll, {
      headers: webHeaders(),
      body: JSON.stringify({ id }),
    })
    if (!res.ok) return res
    if (epoch !== authEpoch) return fail('CANCELLED', '登录请求已取消')
    // 官方对「已消费 / 不存在 / 过期」的二维码返回 400 或 401，统一归一成 EXPIRED
    if (res.status === 400 || res.status === 401) {
      return { ok: true, status: 'EXPIRED' }
    }
    if (res.status < 200 || res.status >= 300) {
      return fail('HTTP_STATUS', `查询扫码状态失败（HTTP ${res.status}）`, { status: res.status })
    }
    const data = parseJson(res.body)
    const status = data && typeof data.status === 'string' ? data.status : ''
    if (status === 'USED' || status === 'CONFIRMED') {
      const next = sessionFromResponse(res.headers, data, null)
      if (next === null) return fail('PARSE', '登录成功但未取得凭据')
      // 先把会话落位，再取用户信息——否则 getMe 会因为「还没登录」而失败
      const saved = applySession(next)
      const me = await fetchMe()
      return { ok: true, status: 'CONFIRMED', user: me.ok ? me.user : null, storage: saved.ok ? 'ok' : saved.code }
    }
    if (status === 'EXPIRED' || status === 'WAITTING' || status === 'SCANNED') {
      return { ok: true, status: status === 'WAITTING' ? 'WAITTING' : status }
    }
    return { ok: true, status: 'WAITTING' }
  }

  // ── 会话 ──────────────────────────────────────────────────────

  function hasSession() {
    return Boolean(session && typeof session.access === 'string' && session.access !== '')
  }

  function currentUser() {
    return hasSession() ? (session.user || null) : null
  }

  /** 刷新访问凭据；成功返回 { ok:true } */
  async function performRefresh() {
    const epoch = authEpoch
    if (!session || typeof session.refresh !== 'string' || session.refresh === '') {
      return fail('NOT_LOGGED_IN', '登录状态已失效，请重新登录')
    }
    const headers = appHeaders()
    headers['x-jike-refresh-token'] = session.refresh
    const res = await send(ENDPOINTS.refresh, { headers })
    if (epoch !== authEpoch) return fail('AUTH_EXPIRED', '登录状态已改变，请重新登录')
    if (!res.ok) return res
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      storage.clear()
      session = null
      return fail('AUTH_EXPIRED', '登录状态已失效，请重新登录')
    }
    if (res.status < 200 || res.status >= 300) {
      return fail('HTTP_STATUS', `刷新登录状态失败（HTTP ${res.status}）`, { status: res.status })
    }
    const data = parseJson(res.body)
    const next = sessionFromResponse(res.headers, data, session.user)
    if (next === null) {
      return fail('PARSE', '刷新响应里没有新的凭据')
    }
    if (!next.refresh) next.refresh = session.refresh
    const saved = applySession(next)
    return saved.ok ? { ok: true } : { ok: false, code: saved.code, message: saved.message }
  }

  function refresh() {
    if (!refreshInFlight) refreshInFlight = performRefresh().finally(() => { refreshInFlight = null })
    return refreshInFlight
  }

  async function fetchMe() {
    if (!hasSession()) return fail('NOT_LOGGED_IN', '尚未登录')
    const res = await send(ENDPOINTS.me, { headers: appHeaders() })
    if (!res.ok) return res
    if (res.status === 401) return fail('AUTH_EXPIRED', '登录状态已失效，请重新登录')
    if (res.status < 200 || res.status >= 300) return fail('HTTP_STATUS', `获取账号信息失败（HTTP ${res.status}）`, { status: res.status })
    const data = parseJson(res.body)
    const user = data && data.data && typeof data.data === 'object' ? data.data : null
    if (user === null) return fail('PARSE', '账号信息格式无法识别')
    const normalized = {
      uid: typeof user.uid === 'string' ? user.uid : '',
      nickname: typeof user.nickname === 'string' ? user.nickname : '',
      avatar: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
    }
    if (session) {
      session.user = normalized
      storage.save(session)
    }
    return { ok: true, user: normalized }
  }

  function logout() {
    const cleared = storage.clear()
    if (cleared && cleared.ok === false) return cleared
    authEpoch += 1
    session = null
    return { ok: true }
  }

  // ── 数据接口 ──────────────────────────────────────────────────

  /**
   * 统一的「带会话的请求」：
   * 遇到 401 先尝试刷新一次，刷新失败则清空会话并返回 AUTH_EXPIRED。
   */
  async function authed(endpoint, { body, query } = {}) {
    if (!hasSession()) return fail('NOT_LOGGED_IN', '尚未登录')
    let res = await send(endpoint, {
      headers: appHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      query,
    })
    if (!res.ok) return res
    if (res.status === 401) {
      const refreshed = await refresh()
      if (!refreshed.ok) return refreshed
      res = await send(endpoint, {
        headers: appHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        query,
      })
      if (!res.ok) return res
      if (res.status === 401) {
        storage.clear()
        session = null
        return fail('AUTH_EXPIRED', '登录状态已失效，请重新登录')
      }
    }
    if (res.status === 403) return fail('FORBIDDEN', '该操作需要更高权限（HTTP 403）', { status: 403 })
    if (res.status < 200 || res.status >= 300) {
      return fail('HTTP_STATUS', `官方接口返回错误（HTTP ${res.status}）`, { status: res.status })
    }
    const data = parseJson(res.body)
    if (data === null) return fail('PARSE', '官方接口返回的内容无法解析')
    return { ok: true, payload: data }
  }

  /** 我的订阅（分页由调用方带游标） */
  async function fetchSubscriptions(loadMoreKey) {
    const body = { sortBy: 'subscribedAt' }
    if (loadMoreKey !== undefined && loadMoreKey !== null) body.loadMoreKey = loadMoreKey
    return authed(ENDPOINTS.subscriptions, { body })
  }

  /** 某个播客的单集列表 */  async function search(keyword, options) {
    const text = typeof keyword === 'string' ? keyword.trim() : ''
    if (text === '') return fail('INVALID_ARGUMENT', '请输入搜索关键词')
    const opts = options && typeof options === 'object' ? options : {}
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20
    const body = {
      keyword: text,
      type: typeof opts.type === 'string' && opts.type !== '' ? opts.type : 'ALL',
      // 第三方实现里 limit 是字符串，保持一致避免类型不符
      limit: String(limit),
    }
    if (opts.loadMoreKey !== undefined && opts.loadMoreKey !== null) body.loadMoreKey = opts.loadMoreKey
    return authed(ENDPOINTS.search, { body })
  }

  async function fetchEpisodes(pid, loadMoreKey) {
    if (typeof pid !== 'string' || pid === '') return fail('INVALID_ARGUMENT', '缺少节目标识')
    const body = { pid, order: 'desc' }
    if (loadMoreKey !== undefined && loadMoreKey !== null) body.loadMoreKey = loadMoreKey
    return authed(ENDPOINTS.episodes, { body })
  }

  /** 读取账号收听历史，并补齐官方记录的播放进度；此请求只读取账号数据。 */
  async function fetchListenHistory(loadMoreKey) {
    const body = {}
    if (loadMoreKey !== undefined && loadMoreKey !== null) body.loadMoreKey = loadMoreKey
    const result = await authed(ENDPOINTS.episodeHistory, { body })
    if (!result.ok) return result
    const root = result.payload && typeof result.payload === 'object' ? result.payload : null
    const nested = root?.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : null
    const items = Array.isArray(root?.data) ? root.data : Array.isArray(nested?.data) ? nested.data : null
    if (items === null) return fail('PARSE', '收听历史格式无法识别')
    const episodes = items.map((item) => item && typeof item.episode === 'object' && item.episode ? item.episode : item)
    const eids = [...new Set(episodes.map((episode) => episode && typeof episode.eid === 'string' ? episode.eid : '').filter(Boolean))]
    let progressById = new Map()
    if (eids.length > 0) {
      const progress = await authed(ENDPOINTS.playbackProgress, { body: { eids } })
      if (!progress.ok) return progress
      const progressData = progress.payload && Array.isArray(progress.payload.data) ? progress.payload.data : null
      if (progressData === null) return fail('PARSE', '收听进度格式无法识别')
      progressById = new Map(progressData.filter((entry) => entry && typeof entry.eid === 'string').map((entry) => [entry.eid, entry]))
    }
    const data = episodes.map((episode) => {
      const progress = episode && typeof episode.eid === 'string' ? progressById.get(episode.eid) : null
      return progress ? { ...episode, progress: progress.progress, playedAt: progress.playedAt ?? episode.playedAt } : episode
    })
    return { ok: true, payload: { data, loadMoreKey: nested?.loadMoreKey ?? root?.loadMoreKey ?? null } }
  }

  /** 读取个人主页的喜欢列表；只请求当前登录账号自己的公开 uid。 */
  async function fetchFavorites(uid, loadMoreKey) {
    if (typeof uid !== 'string' || uid === '') return fail('INVALID_ARGUMENT', '缺少账号标识')
    const body = { uid }
    if (loadMoreKey !== undefined && loadMoreKey !== null) body.loadMoreKey = loadMoreKey
    return authed(ENDPOINTS.favorites, { body })
  }

  /** 付费单集的媒体地址（普通单集的地址在单集对象里已带） */
  async function fetchMediaUrl(eid) {
    if (typeof eid !== 'string' || eid === '') return fail('INVALID_ARGUMENT', '缺少单集标识')
    const res = await authed(ENDPOINTS.media, { query: { eid, dubbing: 'false' } })
    if (!res.ok) return res
    const url = res.payload && res.payload.data && typeof res.payload.data.url === 'string' ? res.payload.data.url : ''
    if (url === '') return fail('NO_MEDIA', '该单集没有可用的音频地址')
    return { ok: true, url }
  }

  return {
    startLogin,
    pollLogin,
    hasSession,
    currentUser,
    refresh,
    fetchMe,
    logout,
    fetchSubscriptions,
    fetchEpisodes,
    fetchListenHistory,
    fetchFavorites,
    search,
    fetchMediaUrl,
    // 供测试观察，不参与业务
    _session: () => session,
  }
}

module.exports = { createOfficialClient, HOSTS, ENDPOINTS, MIDWAY_APP_ID, DEFAULT_UA }
