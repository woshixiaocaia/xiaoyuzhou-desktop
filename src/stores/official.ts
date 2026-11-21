import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  officialEpisodes,
  officialFavorites,
  officialMediaUrl,
  officialSearch,
  officialSubscriptions,
} from '@/lib/desktop'
import {
  extractSearchCategories,
  normalizeSearchPayload,
  SearchShapeError,
  type OfficialCategory,
} from '@/lib/official-search'
import {
  pickOfficialEpisodes,
  pickOfficialFavoriteEpisodes,
  pickOfficialPodcasts,
  type OfficialEpisode,
  type OfficialPodcast,
} from '@/lib/official-contract'

/** 单个节目的单集列表状态 */
export interface EpisodeListState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: OfficialEpisode[]
  loadMoreKey: unknown
  error: string
  loadingMore: boolean
}

const EMPTY_LIST: EpisodeListState = {
  status: 'idle',
  items: [],
  loadMoreKey: null,
  error: '',
  loadingMore: false,
}

/**
 * 官方数据（订阅 + 单集）。
 *
 * 与 RSS 订阅完全分开：这里的数据不写入 localStorage，也不转成 RSS，
 * 每次打开页面按需拉取；页面只是「官方数据的一个视图」。
 */
export const useOfficialStore = defineStore('official', () => {
  const podcasts = ref<OfficialPodcast[]>([])
  const listStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const listError = ref('')
  /** 最近一次列表错误的错误码，界面据此区分「过期」和其它失败 */
  const listErrorCode = ref('')
  const loadMoreKey = ref<unknown>(null)
  const loadingMore = ref(false)

  const episodes = ref<Record<string, EpisodeListState>>({})
  const favoriteEpisodes = ref<OfficialEpisode[]>([])
  const favoriteStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const favoriteError = ref('')
  const favoriteLoadMoreKey = ref<unknown>(null)
  const favoriteLoadingMore = ref(false)
  let favoriteEpoch = 0
  const selectedPid = ref('')
  let sessionEpoch = 0
  let subscriptionsRequest = 0
  const episodeRequests = new Map<string, number>()

  const hasMore = computed(() => loadMoreKey.value !== null && loadMoreKey.value !== undefined)
  const count = computed(() => podcasts.value.length)
  const hasMoreFavorites = computed(() => favoriteLoadMoreKey.value !== null && favoriteLoadMoreKey.value !== undefined)

  const selectedPodcast = computed(
    () => podcasts.value.find((item) => item.pid === selectedPid.value) ?? null,
  )

  const selectedEpisodes = computed<EpisodeListState>(
    () => episodes.value[selectedPid.value] ?? EMPTY_LIST,
  )

  function setEpisodes(pid: string, patch: Partial<EpisodeListState>): void {
    const current = episodes.value[pid] ?? EMPTY_LIST
    episodes.value = { ...episodes.value, [pid]: { ...current, ...patch } }
  }

  /** 拉第一页订阅（reset=true 时清空重来） */
  async function loadSubscriptions(reset = true): Promise<void> {
    if (listStatus.value === 'loading') return
    const epoch = sessionEpoch
    const request = ++subscriptionsRequest
    listStatus.value = 'loading'
    if (reset) {
      listError.value = ''
      listErrorCode.value = ''
      loadMoreKey.value = null
    }
    const result = await officialSubscriptions(reset ? undefined : loadMoreKey.value)
    if (epoch !== sessionEpoch || request !== subscriptionsRequest) return
    if (!result.ok) {
      listStatus.value = 'error'
      listError.value = result.message
      listErrorCode.value = result.code
      return
    }
    const page = pickOfficialPodcasts(result.payload)
    podcasts.value = reset ? page.podcasts : [...podcasts.value, ...page.podcasts]
    loadMoreKey.value = page.loadMoreKey
    listStatus.value = 'ready'
  }

  /** 加载下一页（按钮触发） */
  async function loadMoreSubscriptions(): Promise<void> {
    if (loadingMore.value || !hasMore.value) return
    loadingMore.value = true
    try {
      await loadSubscriptions(false)
    } finally {
      loadingMore.value = false
    }
  }

  /** 拉某个节目的单集（refresh=true 时重新拉第一页） */
  async function loadEpisodes(pid: string, refresh = false): Promise<void> {
    if (pid === '') return
    const epoch = sessionEpoch
    const request = (episodeRequests.get(pid) ?? 0) + 1
    episodeRequests.set(pid, request)
    const current = episodes.value[pid]
    if (!refresh && current !== undefined && current.status === 'ready') return
    setEpisodes(pid, { status: 'loading', error: '', loadingMore: false, items: refresh ? [] : (current?.items ?? []), loadMoreKey: null })

    try {
      const result = await officialEpisodes(pid, undefined)
      if (epoch !== sessionEpoch || request !== episodeRequests.get(pid)) return
      if (!result.ok) {
        setEpisodes(pid, { status: 'error', error: result.message })
        return
      }
      const page = pickOfficialEpisodes(result.payload, pid)
      setEpisodes(pid, {
        status: 'ready',
        items: page.episodes,
        loadMoreKey: page.loadMoreKey,
        error: '',
      })
    } catch {
      if (epoch !== sessionEpoch || request !== episodeRequests.get(pid)) return
      setEpisodes(pid, { status: 'error', error: '加载播客单集失败，请重试。' })
    }
  }

  /** 单集列表的下一页 */
  async function loadMoreEpisodes(pid: string): Promise<void> {
    const current = episodes.value[pid]
    if (!current || current.loadingMore || current.loadMoreKey == null) return
    const epoch = sessionEpoch
    const request = (episodeRequests.get(pid) ?? 0) + 1
    episodeRequests.set(pid, request)
    setEpisodes(pid, { loadingMore: true, error: '' })
    try {
      const result = await officialEpisodes(pid, current.loadMoreKey)
      if (epoch !== sessionEpoch || request !== episodeRequests.get(pid)) return
      if (!result.ok) {
        setEpisodes(pid, { loadingMore: false, error: result.message })
        return
      }
      const page = pickOfficialEpisodes(result.payload, pid)
      const latest = episodes.value[pid] ?? current
      const existing = new Set(latest.items.map((episode) => episode.eid))
      const added = page.episodes.filter((episode) => !existing.has(episode.eid))
      if (added.length === 0 && page.loadMoreKey != null && Object.is(page.loadMoreKey, current.loadMoreKey)) {
        setEpisodes(pid, { loadingMore: false, loadMoreKey: null, error: '没有新的单集了。' })
        return
      }
      setEpisodes(pid, {
        loadingMore: false,
        items: [...latest.items, ...added],
        loadMoreKey: page.loadMoreKey,
        error: '',
      })
    } catch {
      if (epoch !== sessionEpoch || request !== episodeRequests.get(pid)) return
      setEpisodes(pid, { loadingMore: false, error: '加载更多单集失败，请重试。' })
    }
  }

  async function loadFavorites(uid: string, reset = true): Promise<void> {
    if (!uid) return
    if (favoriteLoadingMore.value || (!reset && !hasMoreFavorites.value)) return
    const request = ++favoriteEpoch
    if (reset) {
      favoriteStatus.value = 'loading'
      favoriteError.value = ''
      favoriteLoadMoreKey.value = null
    } else {
      favoriteLoadingMore.value = true
      favoriteError.value = ''
    }
    const result = await officialFavorites(uid, reset ? undefined : favoriteLoadMoreKey.value)
    if (request !== favoriteEpoch) return
    if (!result.ok) {
      favoriteStatus.value = 'error'
      favoriteError.value = result.message
      favoriteLoadingMore.value = false
      return
    }
    const page = pickOfficialFavoriteEpisodes(result.payload)
    const seen = new Set(reset ? [] : favoriteEpisodes.value.map((episode) => episode.eid))
    const incoming = page.episodes.filter((episode) => !seen.has(episode.eid))
    favoriteEpisodes.value = reset ? incoming : [...favoriteEpisodes.value, ...incoming]
    favoriteLoadMoreKey.value = page.loadMoreKey
    favoriteStatus.value = 'ready'
    favoriteError.value = ''
    favoriteLoadingMore.value = false
  }

  function select(pid: string): void {
    selectedPid.value = pid
  }

  /**
   * 解析单集的可播放地址。
   * 单集对象自带地址时直接用；付费单集没有地址时向主进程要一次。
   */
  async function resolveAudioUrl(episode: OfficialEpisode): Promise<string | null> {
    if (episode.audioUrl !== null && episode.audioUrl !== '') return episode.audioUrl
    if (!episode.isPrivate) return null
    const result = await officialMediaUrl(episode.eid)
    return result.ok ? result.url : null
  }

  // ── 发现页 ────────────────────────────────────────────
  // 没有官方「推荐/榜单」接口，因此发现页不伪造推荐内容：
  // 它用已验证的 search 接口，按分类关键词浏览真实播客。
  // 状态与搜索页完全分开，互不覆盖。
  const discoverStatus = ref<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  const discoverError = ref('')
  const discoverPodcasts = ref<OfficialPodcast[]>([])
  /**
   * 当前分类下的真实单集（来自 type=ALL 搜索里的 EPISODE 条目）。
   * 与 discoverPodcasts 并列，页面上分区展示，不互相冒充。
   */
  const discoverEpisodes = ref<OfficialEpisode[]>([])
  const discoverCategories = ref<OfficialCategory[]>([])
  /** 当前浏览的分类关键词；空串表示还没选分类 */
  const discoverKeyword = ref('')
  /** 发现页独立代次，防止旧请求覆盖新分类的结果 */
  let discoverEpoch = 0

  /**
   * 浏览某个分类（本质是一次真实 search 请求）。
   * 同时把响应里带回的 SEARCHED_CATEGORY 收集起来作为分类入口。
   */
  async function browseCategory(keyword: string): Promise<void> {
    const trimmed = keyword.trim()
    discoverKeyword.value = trimmed

    if (trimmed === '') {
      discoverEpoch += 1
      discoverStatus.value = 'idle'
      discoverPodcasts.value = []
      discoverEpisodes.value = []
      discoverError.value = ''
      return
    }

    const epoch = ++discoverEpoch
    discoverStatus.value = 'loading'
    discoverError.value = ''

    // 主请求用 PODCAST：实测部分关键词在 ALL 下只返回 EPISODE（例如「科技」45 条里 0 个播客）
    const result = await officialSearch(trimmed, { type: 'PODCAST', limit: 30 })
    if (epoch !== discoverEpoch) return // 已有更新的请求，丢弃本次结果

    if (!result.ok) {
      discoverStatus.value = 'error'
      discoverError.value = result.message
      discoverPodcasts.value = []
      discoverEpisodes.value = []
      return
    }

    try {
      const page = normalizeSearchPayload(result.payload)
      discoverPodcasts.value = page.podcasts
      discoverStatus.value = page.podcasts.length === 0 ? 'empty' : 'ready'
    } catch (error) {
      // 结构不认识要明确报错，不能静默当成「没有内容」
      discoverStatus.value = 'error'
      discoverError.value =
        error instanceof SearchShapeError ? '接口返回的结构无法识别，可能是接口已变更' : '内容解析失败'
      discoverPodcasts.value = []
      return
    }

    // 附加请求用 ALL：这一种才同时带回 EPISODE 单集与 SEARCHED_CATEGORY 分类。
    // 失败时静默跳过，不影响已经拿到的频道列表。
    const allResult = await officialSearch(trimmed, { type: 'ALL', limit: 30 })
    if (epoch !== discoverEpoch || !allResult.ok) return

    try {
      const allPage = normalizeSearchPayload(allResult.payload)
      // 单集只保留有 eid 的真实条目；归一化层已过滤 HEADER/FOOTER/用户卡片
      discoverEpisodes.value = allPage.episodes
    } catch {
      // 单集结构不认识时留空，不影响频道展示
      discoverEpisodes.value = []
    }

    // 分类列表按「最新一次结果」替换而不是无限追加（BUG-05 根因之一）。
    // 同时按名称去重：官方会用不同 id 返回同名分类，界面上只应出现一个。
    const incoming = extractSearchCategories(allResult.payload)
    const seenNames = new Set<string>()
    const deduped: typeof incoming = []
    for (const cat of incoming) {
      if (seenNames.has(cat.name)) continue
      seenNames.add(cat.name)
      deduped.push(cat)
    }
    discoverCategories.value = deduped
  }

  function resetDiscover(): void {
    discoverEpoch += 1
    discoverStatus.value = 'idle'
    discoverError.value = ''
    discoverPodcasts.value = []
    discoverEpisodes.value = []
    discoverCategories.value = []
    discoverKeyword.value = ''
  }

  // ── 搜索 ──────────────────────────────────────────────
  // 只开放已实测的两种 type：PODCAST（纯播客）、ALL（混合，需过滤 HEADER/FOOTER/SEARCHED_USERS）
  const searchKeyword = ref('')
  const searchType = ref<'EPISODE' | 'PODCAST' | 'ALL'>('EPISODE')
  const searchStatus = ref<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  const searchError = ref('')
  const searchPodcasts = ref<OfficialPodcast[]>([])
  const searchEpisodes = ref<OfficialEpisode[]>([])
  /** 递增序号：迟到的旧请求不得覆盖新关键词的结果 */
  let searchEpoch = 0

  async function runSearch(rawKeyword?: string, type?: 'EPISODE' | 'PODCAST' | 'ALL'): Promise<void> {
    const keyword = (rawKeyword ?? searchKeyword.value).trim()
    searchKeyword.value = keyword
    if (type !== undefined) searchType.value = type

    if (keyword === '') {
      searchEpoch += 1
      searchStatus.value = 'idle'
      searchPodcasts.value = []
      searchEpisodes.value = []
      searchError.value = ''
      return
    }

    const epoch = ++searchEpoch
    searchStatus.value = 'loading'
    searchError.value = ''

    // 官方只确认了 PODCAST 与 ALL；单集筛选使用 ALL 响应后在本地过滤。
    const result = await officialSearch(keyword, { type: searchType.value === 'PODCAST' ? 'PODCAST' : 'ALL' })
    if (epoch !== searchEpoch) return // 已有更新的请求，丢弃本次结果

    if (!result.ok) {
      searchStatus.value = 'error'
      searchError.value = result.message
      searchPodcasts.value = []
      searchEpisodes.value = []
      return
    }

    try {
      const page = normalizeSearchPayload(result.payload)
      searchPodcasts.value = searchType.value === 'EPISODE' ? [] : page.podcasts
      searchEpisodes.value = searchType.value === 'PODCAST' ? [] : page.episodes
      searchStatus.value = searchPodcasts.value.length + searchEpisodes.value.length === 0 ? 'empty' : 'ready'
    } catch (error) {
      // 结构不认识时明确报错，绝不静默当成空结果
      searchStatus.value = 'error'
      searchError.value =
        error instanceof SearchShapeError ? '搜索返回的结构无法识别，可能是接口已变更' : '搜索结果解析失败'
      searchPodcasts.value = []
      searchEpisodes.value = []
    }
  }

  function clearSearch(): void {
    searchEpoch += 1
    searchKeyword.value = ''
    searchStatus.value = 'idle'
    searchError.value = ''
    searchPodcasts.value = []
    searchEpisodes.value = []
  }

  function reset(): void {
    sessionEpoch += 1
    subscriptionsRequest += 1
    episodeRequests.clear()
    loadingMore.value = false
    clearSearch()
    resetDiscover()
    podcasts.value = []
    listStatus.value = 'idle'
    listError.value = ''
    listErrorCode.value = ''
    loadMoreKey.value = null
    episodes.value = {}
    favoriteEpoch += 1
    favoriteEpisodes.value = []
    favoriteStatus.value = 'idle'
    favoriteError.value = ''
    favoriteLoadMoreKey.value = null
    favoriteLoadingMore.value = false
    selectedPid.value = ''
  }

  return {
    podcasts,
    listStatus,
    listError,
    listErrorCode,
    loadMoreKey,
    loadingMore,
    episodes,
    favoriteEpisodes,
    favoriteStatus,
    favoriteError,
    favoriteLoadMoreKey,
    favoriteLoadingMore,
    hasMoreFavorites,
    selectedPid,
    hasMore,
    count,
    selectedPodcast,
    selectedEpisodes,
    loadSubscriptions,
    loadMoreSubscriptions,
    loadEpisodes,
    loadMoreEpisodes,
    loadFavorites,
    select,
    resolveAudioUrl,
    searchKeyword,
    searchType,
    searchStatus,
    searchError,
    searchPodcasts,
    searchEpisodes,
    runSearch,
    clearSearch,
    reset,
    // 发现页
    discoverStatus,
    discoverError,
    discoverPodcasts,
    discoverEpisodes,
    discoverCategories,
    discoverKeyword,
    browseCategory,
    resetDiscover,
  }
})
