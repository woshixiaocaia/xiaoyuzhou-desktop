/**
 * 渲染侧 RSS IPC 封装。
 *
 * 职责边界（刻意保持很窄）：
 *  - 只负责「调用 preload 暴露的桥」+「校验主进程返回结构」+「收敛错误形态」
 *  - 不解析 XML（在 lib/rss.ts），不访问 Node，不直接 fetch
 *  - 对外 API **永不 throw**，失败一律返回结构化结果
 *
 * 主进程错误码契约（electron/rss-fetch.cjs）**原样不动**；
 * 下面两个错误码只存在于渲染侧，主进程永远不会返回它们。
 */

/** 主进程可能返回的错误码（与 electron/rss-fetch.cjs 的 ERROR_MESSAGES 一一对应） */
export const MAIN_PROCESS_ERROR_CODES = [
  'INVALID_URL',
  'BLOCKED_TARGET',
  'TOO_MANY_REDIRECTS',
  'TIMEOUT',
  'HTTP_STATUS',
  'TOO_LARGE',
  'NOT_XML',
  'NETWORK_ERROR',
] as const

export type MainProcessErrorCode = (typeof MAIN_PROCESS_ERROR_CODES)[number]

/** 仅渲染侧产生的错误码 */
export type RendererOnlyErrorCode = 'NO_BRIDGE' | 'INVALID_RESPONSE'

export type RssFetchErrorCode = MainProcessErrorCode | RendererOnlyErrorCode

export interface FetchRssSuccess {
  ok: true
  url: string
  finalUrl: string
  contentType: string
  bytes: number
  /** 原始 XML 文本（未解析） */
  text: string
}

export interface FetchRssFailure {
  ok: false
  code: RssFetchErrorCode
  message: string
  httpStatus?: number
}

export type FetchRssResult = FetchRssSuccess | FetchRssFailure

/** preload 通过 contextBridge 暴露的桥（只声明用到的部分） */
export interface DesktopBridge {
  platform?: string
  versions?: {
    electron?: string
    chrome?: string
    node?: string
  }
  fetchRss: (url: string) => Promise<unknown>

  // 官方账号（全部可选：老版本 preload 或浏览器环境下不存在）
  officialAuthStart?: () => Promise<unknown>
  officialAuthPoll?: (id: string | null) => Promise<unknown>
  officialAuthStatus?: () => Promise<unknown>
  officialAuthLogout?: () => Promise<unknown>
  officialSubscriptions?: (cursor: unknown) => Promise<unknown>
  officialEpisodes?: (pid: string | null, cursor: unknown) => Promise<unknown>
  officialListenHistory?: (cursor: unknown) => Promise<unknown>
  officialFavorites?: (uid: string | null, cursor: unknown) => Promise<unknown>
  officialMediaUrl?: (eid: string | null) => Promise<unknown>
  officialSearch?: (keyword: string | null, options: unknown) => Promise<unknown>
}

const RENDERER_MESSAGES: Record<RendererOnlyErrorCode, string> = {
  NO_BRIDGE: '当前不在桌面应用中运行，无法请求订阅源',
  INVALID_RESPONSE: '与主进程通信返回了无法识别的结果',
}

const MAIN_CODE_SET = new Set<string>(MAIN_PROCESS_ERROR_CODES)

function failure(code: RssFetchErrorCode, message?: string, httpStatus?: number): FetchRssFailure {
  const result: FetchRssFailure = {
    ok: false,
    code,
    message: message && message.length > 0 ? message : (RENDERER_MESSAGES[code as RendererOnlyErrorCode] ?? '请求失败'),
  }
  if (httpStatus !== undefined) result.httpStatus = httpStatus
  return result
}

/** 取桥；非 Electron 环境或桥被删改时返回 null，绝不自行造一个 fetch */
function getBridge(): DesktopBridge | null {
  try {
    const globalObject = globalThis as unknown as { desktop?: unknown }
    const desktop = globalObject.desktop
    if (!desktop || typeof desktop !== 'object') return null
    const candidate = desktop as Partial<DesktopBridge>
    if (typeof candidate.fetchRss !== 'function') return null
    return candidate as DesktopBridge
  } catch {
    return null
  }
}

export function isDesktopBridgeAvailable(): boolean {
  return getBridge() !== null
}

/** 把主进程返回的未知结构收敛成可信的 FetchRssResult */
function normalizeResponse(raw: unknown): FetchRssResult {
  if (!raw || typeof raw !== 'object') {
    return failure('INVALID_RESPONSE')
  }
  const value = raw as Record<string, unknown>

  if (value.ok === true) {
    if (
      typeof value.text !== 'string' ||
      typeof value.bytes !== 'number' ||
      typeof value.url !== 'string' ||
      typeof value.finalUrl !== 'string' ||
      typeof value.contentType !== 'string'
    ) {
      return failure('INVALID_RESPONSE')
    }
    return {
      ok: true,
      url: value.url,
      finalUrl: value.finalUrl,
      contentType: value.contentType,
      bytes: value.bytes,
      text: value.text,
    }
  }

  if (value.ok === false) {
    const code = value.code
    if (typeof code !== 'string' || !MAIN_CODE_SET.has(code)) {
      return failure('INVALID_RESPONSE')
    }
    const message = typeof value.message === 'string' ? value.message : undefined
    const httpStatus = typeof value.httpStatus === 'number' ? value.httpStatus : undefined
    return failure(code as MainProcessErrorCode, message, httpStatus)
  }

  return failure('INVALID_RESPONSE')
}

/**
 * 抓取 RSS/Atom 源（经主进程）。
 * **永不 throw**。
 */
export async function fetchRss(url: string): Promise<FetchRssResult> {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return failure('INVALID_URL')
  }

  const bridge = getBridge()
  if (!bridge) {
    return failure('NO_BRIDGE')
  }

  let raw: unknown
  try {
    raw = await bridge.fetchRss(url)
  } catch {
    // IPC 层异常：不把内部信息抛给调用方
    return failure('NETWORK_ERROR', '与主进程通信失败，请重试')
  }

  try {
    return normalizeResponse(raw)
  } catch {
    // 结构归一化本身出错：不属于 IPC 失败，按「无法识别的结果」处理
    return failure('INVALID_RESPONSE')
  }
}

// ══════════════════════════════════════════════════════════════
// 官方账号通道
//
// 与 RSS 一样：**永不 throw**，失败返回结构化结果。
// 注意这里没有任何「读写凭据」的函数——凭据只在主进程里，
// 渲染进程既拿不到，也无法请求。
// ══════════════════════════════════════════════════════════════

export interface OfficialUser {
  uid: string
  nickname: string
  avatar: string
}

export type OfficialFailure = { ok: false; code: string; message: string }

export type OfficialStatusKind = 'WAITTING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED'

export type OfficialStartResult = { ok: true; id: string; url: string } | OfficialFailure
export type OfficialPollResult =
  | { ok: true; status: OfficialStatusKind; user: OfficialUser | null; storage: string }
  | OfficialFailure
export type OfficialStatusResult =
  | { ok: true; loggedIn: boolean; user: OfficialUser | null; storageAvailable: boolean }
  | OfficialFailure
export type OfficialPayloadResult = { ok: true; payload: unknown } | OfficialFailure
export type OfficialMediaResult = { ok: true; url: string } | OfficialFailure
export type OfficialSimpleResult = { ok: true } | OfficialFailure

/** 主进程/渲染侧共同可能出现的错误码，用于给用户一句人话 */
const OFFICIAL_MESSAGES: Record<string, string> = {
  NO_BRIDGE: '当前不在桌面应用中运行，无法使用账号功能',
  INVALID_RESPONSE: '与主进程通信返回了无法识别的结果',
  IPC_FAILED: '与主进程通信失败，请重试',
  NOT_LOGGED_IN: '尚未登录小宇宙账号',
  AUTH_EXPIRED: '登录状态已失效，请重新登录',
  NETWORK: '网络请求失败，请检查网络或代理设置',
  TIMEOUT: '请求超时，请稍后重试',
  HTTP_STATUS: '官方接口返回错误，请稍后重试',
  FORBIDDEN: '该操作需要更高权限',
  PARSE: '官方接口返回的内容无法解析',
  STORAGE_UNAVAILABLE: '当前系统不支持安全存储，无法保存登录状态',
  STORAGE_WRITE_FAILED: '登录状态保存失败',
  INVALID_ARGUMENT: '请求参数不完整',
  NO_MEDIA: '该单集没有可用的音频地址',
  UNEXPECTED: '主进程处理官方请求时出现异常',
}

/** 官方通道要求的最小桥面（比 DesktopBridge 更严格：方法必须存在） */
interface OfficialBridge {
  officialAuthStart: () => Promise<unknown>
  officialAuthPoll: (id: string | null) => Promise<unknown>
  officialAuthStatus: () => Promise<unknown>
  officialAuthLogout: () => Promise<unknown>
  officialSubscriptions: (cursor: unknown) => Promise<unknown>
  officialEpisodes: (pid: string | null, cursor: unknown) => Promise<unknown>
  officialListenHistory?: (cursor: unknown) => Promise<unknown>
  officialFavorites?: (uid: string | null, cursor: unknown) => Promise<unknown>
  officialMediaUrl: (eid: string | null) => Promise<unknown>
  officialSearch: (keyword: string | null, options: unknown) => Promise<unknown>
}

let authExpiredHandler: (() => void) | null = null
export function setAuthExpiredHandler(handler: (() => void) | null): void { authExpiredHandler = handler }

function officialFailure(code: string, message?: string): OfficialFailure {
  if (code === 'AUTH_EXPIRED' || code === 'NOT_LOGGED_IN') authExpiredHandler?.()
  return {
    ok: false,
    code,
    message: message !== undefined && message.length > 0 ? message : (OFFICIAL_MESSAGES[code] ?? '官方请求失败'),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getOfficialBridge(): OfficialBridge | null {
  try {
    const globalObject = globalThis as unknown as { desktop?: unknown }
    const desktop = globalObject.desktop
    if (!desktop || typeof desktop !== 'object') return null
    const candidate = desktop as Partial<OfficialBridge>
    if (typeof candidate.officialAuthStart !== 'function') return null
    if (typeof candidate.officialAuthPoll !== 'function') return null
    if (typeof candidate.officialAuthStatus !== 'function') return null
    if (typeof candidate.officialAuthLogout !== 'function') return null
    if (typeof candidate.officialSubscriptions !== 'function') return null
    if (typeof candidate.officialEpisodes !== 'function') return null
    if (typeof candidate.officialMediaUrl !== 'function') return null
    return candidate as OfficialBridge
  } catch {
    return null
  }
}

export function isOfficialBridgeAvailable(): boolean {
  return getOfficialBridge() !== null
}

function readUser(value: unknown): OfficialUser | null {
  const record = asRecord(value)
  if (record === null) return null
  return {
    uid: typeof record.uid === 'string' ? record.uid : '',
    nickname: typeof record.nickname === 'string' ? record.nickname : '',
    avatar: typeof record.avatar === 'string' ? record.avatar : '',
  }
}

/** 统一的调用包装：把 IPC 异常与未知结构都收敛成 OfficialFailure */
async function callOfficial(
  call: (bridge: OfficialBridge) => Promise<unknown>,
): Promise<Record<string, unknown> | OfficialFailure> {
  const bridge = getOfficialBridge()
  if (bridge === null) return officialFailure('NO_BRIDGE')
  let raw: unknown
  try {
    raw = await call(bridge)
  } catch {
    return officialFailure('IPC_FAILED')
  }
  const record = asRecord(raw)
  if (record === null) return officialFailure('INVALID_RESPONSE')
  if (record.ok === true) return record
  const code = typeof record.code === 'string' ? record.code : 'UNEXPECTED'
  const message = typeof record.message === 'string' ? record.message : undefined
  return officialFailure(code, message)
}

export async function officialAuthStart(): Promise<OfficialStartResult> {
  const result = await callOfficial((bridge) => bridge.officialAuthStart())
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  const value = result as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.url !== 'string') {
    return officialFailure('INVALID_RESPONSE')
  }
  return { ok: true, id: value.id, url: value.url }
}

export async function officialAuthPoll(id: string): Promise<OfficialPollResult> {
  if (typeof id !== 'string' || id === '') return officialFailure('INVALID_ARGUMENT')
  const result = await callOfficial((bridge) => bridge.officialAuthPoll(id))
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  const value = result as Record<string, unknown>
  const status = value.status
  if (status !== 'WAITTING' && status !== 'SCANNED' && status !== 'CONFIRMED' && status !== 'EXPIRED') {
    return officialFailure('INVALID_RESPONSE')
  }
  return {
    ok: true,
    status,
    user: readUser(value.user),
    storage: typeof value.storage === 'string' ? value.storage : 'ok',
  }
}

export async function officialAuthStatus(): Promise<OfficialStatusResult> {
  const result = await callOfficial((bridge) => bridge.officialAuthStatus())
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  const value = result as Record<string, unknown>
  return {
    ok: true,
    loggedIn: value.loggedIn === true,
    user: readUser(value.user),
    storageAvailable: value.storageAvailable === true,
  }
}

export async function officialAuthLogout(): Promise<OfficialSimpleResult> {
  const result = await callOfficial((bridge) => bridge.officialAuthLogout())
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  return { ok: true }
}

export async function officialSubscriptions(cursor?: unknown): Promise<OfficialPayloadResult> {
  const result = await callOfficial((bridge) => bridge.officialSubscriptions(cursor ?? null))
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  return { ok: true, payload: (result as Record<string, unknown>).payload }
}

export async function officialEpisodes(pid: string, cursor?: unknown): Promise<OfficialPayloadResult> {
  if (typeof pid !== 'string' || pid === '') return officialFailure('INVALID_ARGUMENT')
  const result = await callOfficial((bridge) => bridge.officialEpisodes(pid, cursor ?? null))
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  return { ok: true, payload: (result as Record<string, unknown>).payload }
}

export async function officialListenHistory(cursor?: unknown): Promise<OfficialPayloadResult> {
  const bridge = getOfficialBridge()
  if (bridge === null || typeof bridge.officialListenHistory !== 'function') return officialFailure('NO_BRIDGE')
  let raw: unknown
  try { raw = await bridge.officialListenHistory(cursor ?? null) } catch { return officialFailure('IPC_FAILED') }
  const value = asRecord(raw)
  if (value === null) return officialFailure('INVALID_RESPONSE')
  if (value.ok !== true) return officialFailure(typeof value.code === 'string' ? value.code : 'UNEXPECTED', typeof value.message === 'string' ? value.message : undefined)
  return { ok: true, payload: value.payload }
}

export async function officialFavorites(uid: string, cursor?: unknown): Promise<OfficialPayloadResult> {
  if (typeof uid !== 'string' || uid === '') return officialFailure('INVALID_ARGUMENT')
  const bridge = getOfficialBridge()
  if (bridge === null || typeof bridge.officialFavorites !== 'function') return officialFailure('NO_BRIDGE')
  let raw: unknown
  try { raw = await bridge.officialFavorites(uid, cursor ?? null) } catch { return officialFailure('IPC_FAILED') }
  const value = asRecord(raw)
  if (value === null) return officialFailure('INVALID_RESPONSE')
  if (value.ok !== true) return officialFailure(typeof value.code === 'string' ? value.code : 'UNEXPECTED', typeof value.message === 'string' ? value.message : undefined)
  return { ok: true, payload: value.payload }
}

export async function officialMediaUrl(eid: string): Promise<OfficialMediaResult> {  if (typeof eid !== 'string' || eid === '') return officialFailure('INVALID_ARGUMENT')
  const result = await callOfficial((bridge) => bridge.officialMediaUrl(eid))
  if ('ok' in result && result.ok === false) return result as OfficialFailure
  const url = (result as Record<string, unknown>).url
  if (typeof url !== 'string' || url === '') return officialFailure('NO_MEDIA')
  return { ok: true, url }
}

/**
 * 官方搜索。
 * 接口契约来源：第三方源码 cli-anything-xiaoyuzhoufm（未在当前账号验证），
 * 因此这里只做「搬运 + 错误收敛」，不猜测响应结构。
 */
export async function officialSearch(
  keyword: string,
  options?: { type?: string; limit?: number; loadMoreKey?: unknown },
): Promise<OfficialPayloadResult> {
  if (typeof keyword !== 'string' || keyword.trim() === '') return officialFailure('INVALID_ARGUMENT')
  const bridge = getOfficialBridge()
  if (bridge === null || typeof bridge.officialSearch !== 'function') return officialFailure('NO_BRIDGE')
  let raw: unknown
  try {
    raw = await bridge.officialSearch(keyword.trim(), options ?? {})
  } catch {
    return officialFailure('IPC_FAILED')
  }
  const record = asRecord(raw)
  if (record === null) return officialFailure('INVALID_RESPONSE')
  if (record.ok !== true) {
    const code = typeof record.code === 'string' ? record.code : 'UNEXPECTED'
    return officialFailure(code, typeof record.message === 'string' ? record.message : undefined)
  }
  return { ok: true, payload: record.payload }
}
