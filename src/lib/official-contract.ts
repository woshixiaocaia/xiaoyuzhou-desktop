/**
 * 小宇宙官方 API 的「数据契约」层（阶段 1）。
 *
 * 这里只做两件事：
 *   1. 用常量表达已审计源码里出现过的端点（method + path）；
 *   2. 把官方返回的原始 JSON 安全地归一化成前端可用的形状。
 *
 * 本文件刻意不包含任何网络、凭据、Electron 相关实现：
 *   - 没有请求函数，没有请求头，没有任何账号标识；
 *   - 端点常量只描述「方法 + 路径」，不代表接口当前可用；
 *   - 真正的调用与鉴权属于后续阶段，放在主进程里做。
 *
 * 设计原则：
 *   - 任何字段都可能缺失或类型不对，一律安全降级，不抛异常；
 *   - 分页游标原样透传，绝不自行推导；
 *   - 没有可播放地址的单集就保持 audioUrl = null，绝不伪装成可播放；
 *   - 媒体地址只是「待验证数据」，是否长期有效需要后续实测。
 */

/** 已审计源码中出现过的端点。主机归属由未来的主进程适配层决定，这里不写。 */
export const OFFICIAL_ENDPOINTS = {
  /** 当前账号信息 */
  getMe: { method: 'GET', path: '/web/user/get-me' },
  /** 我的订阅（订阅的播客列表） */
  subscriptionList: { method: 'POST', path: '/v1/subscription/list' },
  /** 某个播客的单集列表 */
  episodeList: { method: 'POST', path: '/v1/episode/list' },
  /** 付费单集的媒体地址 */
  privateMediaGet: { method: 'GET', path: '/v1/private-media/get' },
} as const

export type OfficialEndpointName = keyof typeof OFFICIAL_ENDPOINTS

/** 归一化后的播客（节目） */
export interface OfficialPodcast {
  pid: string
  title: string
  author: string
  brief: string
  imageUrl: string | null
  episodeCount: number
  subscriptionCount: number
  latestEpisodePubDate: string | null
  starred: boolean
}

/** 归一化后的单集。audioUrl 为 null 表示「没有可播放地址」，调用方不得当作可播放。 */
export interface OfficialEpisode {
  eid: string
  pid: string
  title: string
  description: string
  durationSeconds: number
  pubDate: string | null
  audioUrl: string | null
  mimeType: string
  isPrivate: boolean
  imageUrl: string | null
}

/** 分页结果。loadMoreKey 原样保留，可能是字符串、对象或 null，不做任何转换。 */
export interface OfficialPage {
  items: unknown[]
  loadMoreKey: unknown
}

// ── 最小辅助函数 ────────────────────────────────────────────────

/** 只接受「普通对象」，数组、null、原始值一律视为无效 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 字符串字段：非字符串一律降级为空串 */
function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 可空字符串：空串也归为 null，避免前端出现空标题的空白项 */
function toNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/** 计数字段：只接受有限的非负数，其余归零 */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** 布尔字段：只认 true */
function toFlag(value: unknown): boolean {
  return value === true
}

/**
 * 媒体/图片地址：只接受 http(s) 绝对地址。
 * 不是合法地址就返回 null —— 宁可当作「不可播放」，也不要把相对路径或
 * 其它协议的字符串交给播放器。
 */
function toHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null
}

/** 官方图片字段在不同接口里形状不一，这里按已知的几种依次尝试 */
function pickImage(value: unknown): string | null {
  const direct = toHttpUrl(value)
  if (direct !== null) return direct
  const record = asRecord(value)
  if (record === null) return null // 例如 []=图片，按缺失处理
  const picture = asRecord(record.picture)
  return toHttpUrl(picture?.picUrl) ?? toHttpUrl(record.picUrl) ?? toHttpUrl(record.url)
}

// ── 分页 ────────────────────────────────────────────────────────

/**
 * 兼容官方列表接口的两种已知形状：
 *   1. 平铺：{ data: [...], loadMoreKey }
 *   2. 嵌套：{ data: { data: [...], loadMoreKey } }
 * 另外也接受「直接就是一个数组」的情况。
 *
 * 任何无法识别的输入都返回空列表 + null 游标，绝不抛异常。
 * loadMoreKey 原样带出，不在本层推导下一页。
 */
export function pickOfficialPage(payload: unknown): OfficialPage {
  if (Array.isArray(payload)) {
    return { items: payload, loadMoreKey: null }
  }

  const root = asRecord(payload)
  if (root === null) {
    return { items: [], loadMoreKey: null }
  }

  const flat = root.data
  if (Array.isArray(flat)) {
    return { items: flat, loadMoreKey: root.loadMoreKey ?? null }
  }

  const nested = asRecord(flat)
  if (nested !== null) {
    const inner = nested.data
    if (Array.isArray(inner)) {
      return { items: inner, loadMoreKey: nested.loadMoreKey ?? root.loadMoreKey ?? null }
    }
  }

  return { items: [], loadMoreKey: null }
}

// ── 归一化 ──────────────────────────────────────────────────────

/** 播客：非对象输入返回 null，其余字段缺失时安全降级 */
export function normalizeOfficialPodcast(raw: unknown): OfficialPodcast | null {
  const record = asRecord(raw)
  if (record === null) return null

  const pid = toText(record.pid)
  if (pid === '') return null // 没有 pid 的条目无法被引用，直接丢弃

  return {
    pid,
    title: toText(record.title),
    author: toText(record.author),
    brief: toText(record.brief) || toText(record.description),
    imageUrl: pickImage(record.image),
    episodeCount: toCount(record.episodeCount),
    subscriptionCount: toCount(record.subscriptionCount),
    latestEpisodePubDate: toNullableText(record.latestEpisodePubDate),
    starred: toFlag(record.subscriptionStar),
  }
}

/**
 * 单集：非对象输入返回 null。
 *
 * 可播放地址依次尝试 media.source.url 与 enclosure.url，
 * 都拿不到（或不是 http(s)）就保持 null —— 上层据此显示「无音频」，
 * 不会把空地址当成可播放。
 */
export function normalizeOfficialEpisode(raw: unknown, fallbackPid = ''): OfficialEpisode | null {
  const record = asRecord(raw)
  if (record === null) return null

  const eid = toText(record.eid)
  if (eid === '') return null // 没有 eid 就无法定位单集

  const media = asRecord(record.media)
  const source = media === null ? null : asRecord(media.source)
  const enclosure = asRecord(record.enclosure)
  const nestedPodcast = asRecord(record.podcast)

  const audioUrl =
    toHttpUrl(source?.url) ?? toHttpUrl(media?.url) ?? toHttpUrl(enclosure?.url)

  return {
    eid,
    pid: toText(record.pid) || toText(nestedPodcast?.pid) || fallbackPid,
    title: toText(record.title),
    description: toText(record.description),
    durationSeconds: toCount(record.duration),
    pubDate: toNullableText(record.pubDate),
    audioUrl,
    mimeType: toText(source?.mimeType) || toText(media?.mimeType) || 'audio/mp4',
    isPrivate: toFlag(record.isPrivateMedia),
    imageUrl: pickImage(nestedPodcast?.image) ?? pickImage(record.image),
  }
}

/** 批量：把分页结果里的条目直接归一化成播客列表 */
export function pickOfficialPodcasts(payload: unknown): {
  podcasts: OfficialPodcast[]
  loadMoreKey: unknown
} {
  const page = pickOfficialPage(payload)
  const podcasts: OfficialPodcast[] = []
  for (const item of page.items) {
    const podcast = normalizeOfficialPodcast(item)
    if (podcast !== null) podcasts.push(podcast)
  }
  return { podcasts, loadMoreKey: page.loadMoreKey }
}

/** 批量：把分页结果里的条目直接归一化成单集列表 */
export function pickOfficialEpisodes(
  payload: unknown,
  fallbackPid = '',
): { episodes: OfficialEpisode[]; loadMoreKey: unknown } {
  const page = pickOfficialPage(payload)
  const episodes: OfficialEpisode[] = []
  for (const item of page.items) {
    const episode = normalizeOfficialEpisode(item, fallbackPid)
    if (episode !== null) episodes.push(episode)
  }
  return { episodes, loadMoreKey: page.loadMoreKey }
}
