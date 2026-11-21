import {
  normalizeOfficialEpisode,
  normalizeOfficialPodcast,
  type OfficialEpisode,
  type OfficialPodcast,
} from '@/lib/official-contract'

/**
 * 官方搜索结果归一化。
 *
 * 契约状态：**已用真实登录会话验证**（2026-10-26）。
 * 实测确认 POST /v1/search/create 返回扁平结构 { data: [...], loadMoreKey }，
 * data 是混合数组，每个条目自带 type 字段。
 * 接口仍可能变动，因此对响应结构保持严格策略：
 *   - 只接受三种已知形状：裸数组 / {data:[...]} / {data:{data:[...]}}；
 *   - 其它形状直接抛 SearchShapeError，绝不默认成空数组掩盖不匹配。
 */

export class SearchShapeError extends Error {
  readonly code = 'UNEXPECTED_SHAPE'
  constructor(message: string) {
    super(message)
    this.name = 'SearchShapeError'
  }
}

export interface OfficialSearchResult {
  podcasts: OfficialPodcast[]
  episodes: OfficialEpisode[]
  loadMoreKey: unknown
  /** 原始条目数（归一化前），用于诊断 */
  rawCount: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 取出条目数组与游标；结构不认识就抛错 */
export function extractSearchItems(payload: unknown): { items: unknown[]; loadMoreKey: unknown } {
  if (Array.isArray(payload)) return { items: payload, loadMoreKey: null }

  const root = asRecord(payload)
  if (root === null) {
    throw new SearchShapeError('搜索结果既不是数组也不是对象')
  }
  if (Array.isArray(root.data)) {
    return { items: root.data, loadMoreKey: root.loadMoreKey ?? null }
  }
  const inner = asRecord(root.data)
  if (inner !== null && Array.isArray(inner.data)) {
    return { items: inner.data, loadMoreKey: inner.loadMoreKey ?? root.loadMoreKey ?? null }
  }
  throw new SearchShapeError('搜索结果的 data 字段不是数组')
}

export function normalizeSearchPayload(payload: unknown): OfficialSearchResult {
  const { items, loadMoreKey } = extractSearchItems(payload)
  const podcasts: OfficialPodcast[] = []
  const episodes: OfficialEpisode[] = []

  for (const item of items) {
    const record = asRecord(item)
    if (record === null) continue

    // 真实响应核实（2026-10-25，已登录会话）：
    // data 是混合数组，条目自带 type 字段，取值为 HEADER / EPISODE / FOOTER / SEARCHED_USERS / PODCAST。
    // 头部、尾部、用户卡片不是内容，必须跳过，否则会被误当成搜索结果。
    const kind = typeof record.type === 'string' ? record.type : ''
    if (kind === 'HEADER' || kind === 'FOOTER' || kind === 'SEARCHED_USERS') continue

    if (kind === 'EPISODE') {
      const episode = normalizeOfficialEpisode(record, '')
      if (episode !== null) episodes.push(episode)
      continue
    }
    if (kind === 'PODCAST') {
      const podcast = normalizeOfficialPodcast(record)
      if (podcast !== null) podcasts.push(podcast)
      continue
    }

    // 没有 type 字段时的兜底：带 eid 的当单集，否则带 pid 的当节目
    if (typeof record.eid === 'string' && record.eid !== '') {
      const episode = normalizeOfficialEpisode(record, '')
      if (episode !== null) episodes.push(episode)
      continue
    }
    if (typeof record.pid === 'string' && record.pid !== '') {
      const podcast = normalizeOfficialPodcast(record)
      if (podcast !== null) podcasts.push(podcast)
    }
  }

  return { podcasts, episodes, loadMoreKey, rawCount: items.length }
}

// ── 分类（发现页入口）────────────────────────────────────────────
//
// 实测结构（2026-10-26，已登录会话，type=ALL 搜索时返回）：
//   { type: 'SEARCHED_CATEGORY', category: { id, name, icon: { picUrl, largePicUrl }, emoji } }
// 不同关键词会带出不同分类（例如「商业」→ 商业、「科技」→ 科技），
// 因此分类不是固定常量，而是随真实请求返回的数据。

export interface OfficialCategory {
  id: string
  name: string
  iconUrl: string | null
  emoji: string
}

/** 只接受 http(s) 绝对地址，其它一律当没有图标 */
function toIconUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : null
}

/** 归一化单个分类；缺少 id 或 name 视为无效 */
export function normalizeOfficialCategory(raw: unknown): OfficialCategory | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (id === '' || name === '') return null

  const icon = record.icon && typeof record.icon === 'object' && !Array.isArray(record.icon)
    ? (record.icon as Record<string, unknown>)
    : null

  return {
    id,
    name,
    iconUrl: toIconUrl(icon?.picUrl) ?? toIconUrl(icon?.largePicUrl),
    emoji: typeof record.emoji === 'string' ? record.emoji : '',
  }
}

/** 从搜索结果里抽出分类条目（按 id 去重） */
export function extractSearchCategories(payload: unknown): OfficialCategory[] {
  let items: unknown[] = []
  try {
    items = extractSearchItems(payload).items
  } catch {
    // 结构不认识时按「没有分类」处理，由调用方决定如何提示
    return []
  }

  const seen = new Set<string>()
  const categories: OfficialCategory[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type !== 'SEARCHED_CATEGORY') continue
    const category = normalizeOfficialCategory(record.category)
    if (category === null || seen.has(category.id)) continue
    seen.add(category.id)
    categories.push(category)
  }
  return categories
}
