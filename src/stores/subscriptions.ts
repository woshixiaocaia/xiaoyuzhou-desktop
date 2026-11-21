import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchRss } from '@/lib/desktop'
import { parseRss } from '@/lib/rss'
import type { RssFeed } from '@/lib/rss'

/**
 * 订阅状态仓库。
 *
 * 职责很窄：只负责「保存订阅列表 + 加载状态 + 错误状态」，
 * 以及把「拉取」和「解析」两件事串起来。
 *
 * 它**不**自己实现网络请求，也不自己解析 XML：
 *   - 网络请求走 lib/desktop.ts（内部经 preload/IPC 交给主进程）
 *   - XML 解析走 lib/rss.ts（纯函数）
 * 这样三层各管一件事，出问题时能立刻定位是哪一层。
 *
 * 持久化：**只保存 URL 字符串**，不保存节目内容。
 * 因为 RSS 内容会变，存下来很快就会过期；重启应用时用保存的 URL 重新拉一次，
 * 才是「最新」的。所以「恢复订阅」必然伴随一次网络请求。
 */

/** localStorage 的键名。带 v1 是为了以后改结构时能区分旧数据 */
const STORAGE_KEY = 'xiaoyuzhou.subscriptions.v1'

/** 写入失败时给用户看的提示（订阅本身在本次会话里仍然可用） */
const PERSISTENCE_FAILED_MESSAGE = '订阅已添加，但没能写入本地存储；刷新或重启应用后会丢失'

/**
 * 兜底提示：发生了我们没预料到的异常。
 * 刻意与"网络失败"区分开——不能把程序缺陷说成网络问题，否则排查方向就错了。
 */
const UNEXPECTED_ERROR_MESSAGE = '操作时出现意外错误，请重试；若反复出现请反馈'

/** 单个订阅的状态：加载中 / 已就绪 / 拉取失败 */
export type SubscriptionStatus = 'loading' | 'ready' | 'error'

/** 一条订阅 */
export interface Subscription {
  /** 用户输入的地址（去掉首尾空白后的原始字符串），同时作为唯一标识 */
  url: string
  status: SubscriptionStatus
  /** 解析成功后的节目数据；没有成功拉取过就是 null */
  feed: RssFeed | null
  /** 最近一次失败的中文提示；成功时为 null */
  error: string | null
  /** 最近一次成功拉取的时间戳（毫秒） */
  fetchedAt: number | null
}

/** addFromUrl 的返回值 */
export type AddSubscriptionResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: string; message: string }

/**
 * URL 比较规则（刻意保持极简）：
 * 只去掉首尾空白，其余一律**原样比较**，完全相同的字符串才算同一个订阅。
 * 也就是说下面这些都被视为**不同**的地址：
 *   http://a.com/f  vs  https://a.com/f
 *   http://a.com/f  vs  http://A.com/f
 *   http://a.com/f  vs  http://a.com/f/
 * 宁可让用户看到两条，也不擅自把不同地址判成同一个（错误合并更难排查）。
 */
function normalizeUrlKey(raw: string): string {
  return raw.trim()
}

/** 取 localStorage；拿不到（Node、隐私模式、被禁用）就返回 null，绝不抛错 */
function getStorage(): Storage | null {
  try {
    const globalObject = globalThis as unknown as { localStorage?: Storage }
    const storage = globalObject.localStorage
    if (!storage) return null
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
    return storage
  } catch {
    return null
  }
}

/**
 * 读取已保存的 URL 列表。
 * 任何异常（JSON 损坏、结构不对、元素类型不对）都退化成「空列表」，
 * 不抛错、也不主动清空用户的存储——避免把还能救的数据一起删掉。
 */
function readStoredUrls(): string[] {
  const storage = getStorage()
  if (!storage) return []

  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const urls: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const key = normalizeUrlKey(item)
    if (key.length === 0) continue
    if (urls.includes(key)) continue
    urls.push(key)
  }
  return urls
}

/**
 * 写入 URL 列表。
 * 返回是否真的写成功了——界面需要据此提示用户"这次没存上"，
 * 而不是让用户以为订阅已经保存。写失败不影响内存里的列表。
 */
function writeStoredUrls(urls: string[]): boolean {
  const storage = getStorage()
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(urls))
    return true
  } catch {
    /* 隐私模式 / 配额超限：放弃持久化，但不要让添加订阅失败 */
    return false
  }
}

/** 拉取 + 解析，两个失败来源收敛成同一种形状 */
type LoadedFeed = { ok: true; feed: RssFeed } | { ok: false; code: string; message: string }

async function loadFeed(url: string): Promise<LoadedFeed> {
  const fetched = await fetchRss(url)
  if (!fetched.ok) {
    return { ok: false, code: fetched.code, message: fetched.message }
  }
  const parsed = parseRss(fetched.text)
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: parsed.message }
  }
  return { ok: true, feed: parsed.feed }
}

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  // ── state ──────────────────────────────────────────────────
  const items = ref<Subscription[]>([])
  /** 正在添加（输入框那一侧用来禁用按钮） */
  const adding = ref(false)
  /** 最近一次添加失败的中文提示，成功或开始新一次添加时清空 */
  const addError = ref<string | null>(null)
  /** 正在从 localStorage 恢复并逐个重新拉取 */
  const restoring = ref(false)
  /** restore 是否已经跑过，保证只跑一次 */
  const restored = ref(false)
  /** 最近一次持久化失败的中文提示；null 表示存储正常 */
  const persistenceError = ref<string | null>(null)
  /** 是否正在执行「全部刷新」 */
  const refreshingAll = ref(false)

  // ── getters ────────────────────────────────────────────────
  const count = computed(() => items.value.length)
  const hasSubscriptions = computed(() => items.value.length > 0)

  // ── 内部工具 ────────────────────────────────────────────────
  function indexOf(url: string): number {
    const key = normalizeUrlKey(url)
    return items.value.findIndex((item) => item.url === key)
  }

  function persist(): boolean {
    return writeStoredUrls(items.value.map((item) => item.url))
  }

  // ── actions ────────────────────────────────────────────────
  /**
   * 添加一个订阅。
   * 只有「拉取成功 + 解析成功」才会真正加入列表并写入 localStorage；
   * 失败时列表不变，错误信息放在 addError 里，不伪造一条空订阅。
   */
  async function addFromUrl(rawUrl: string): Promise<AddSubscriptionResult> {
    const key = normalizeUrlKey(typeof rawUrl === 'string' ? rawUrl : '')
    addError.value = null
    // 上一轮的存储警告属于旧结果，新一次添加开始时清掉，避免新旧提示同时挂在那儿
    persistenceError.value = null

    if (key.length === 0) {
      addError.value = '请输入订阅地址'
      return { ok: false, code: 'INVALID_URL', message: addError.value }
    }
    if (indexOf(key) >= 0) {
      addError.value = '这个订阅已经添加过了'
      return { ok: false, code: 'DUPLICATE', message: addError.value }
    }

    adding.value = true
    try {
      const loaded = await loadFeed(key)
      if (!loaded.ok) {
        addError.value = loaded.message
        return { ok: false, code: loaded.code, message: loaded.message }
      }

      const subscription: Subscription = {
        url: key,
        status: 'ready',
        feed: loaded.feed,
        error: null,
        fetchedAt: Date.now(),
      }
      items.value.push(subscription)
      // 订阅已经生效；这里只关心"有没有存住"，没存住要让界面能提示用户
      persistenceError.value = persist() ? null : PERSISTENCE_FAILED_MESSAGE
      return { ok: true, subscription }
    } catch {
      // 兜底：不该发生，但真发生了也不能让异常冒出去变成未处理拒绝。
      // 单独用 UNEXPECTED_ERROR 标明，不伪装成网络错误。
      addError.value = UNEXPECTED_ERROR_MESSAGE
      return { ok: false, code: 'UNEXPECTED_ERROR', message: UNEXPECTED_ERROR_MESSAGE }
    } finally {
      adding.value = false
    }
  }

  /**
   * 从 localStorage 恢复订阅。
   *
   * 只恢复了 URL，节目内容必须重新拉一次才有（见文件顶部说明）。
   * 所以流程是：先按 URL 建出「加载中」的占位条目让界面有东西可显示，
   * 再逐个拉取——成功的变 ready，失败的变 error 但**保留在列表里**，
   * 这样用户能看见「哪个订阅挂了」，而不是它凭空消失。
   *
   * 同一个 store 实例只会真正执行一次；重复调用直接返回。
   */
  async function restore(): Promise<void> {
    if (restored.value) return
    restored.value = true

    const urls = readStoredUrls()
    if (urls.length === 0) return

    restoring.value = true
    try {
      for (const url of urls) {
        if (indexOf(url) >= 0) continue
        items.value.push({ url, status: 'loading', feed: null, error: null, fetchedAt: null })
      }

      // 顺序拉取而不是 Promise.all：避免一次并发太多请求
      for (const url of urls) {
        const index = indexOf(url)
        if (index < 0) continue
        const current = items.value[index]
        if (!current) continue
        // 已经成功加载过的订阅：既不重复拉取，也不允许被后来的结果覆盖成失败
        if (current.status === 'ready') continue

        let loaded: LoadedFeed
        try {
          loaded = await loadFeed(url)
        } catch {
          // 单个订阅的意外异常不该中断整批恢复，也不该冒充网络错误
          current.status = 'error'
          current.feed = null
          current.error = UNEXPECTED_ERROR_MESSAGE
          continue
        }

        if (loaded.ok) {
          current.status = 'ready'
          current.feed = loaded.feed
          current.error = null
          current.fetchedAt = Date.now()
        } else {
          current.status = 'error'
          current.feed = null
          current.error = loaded.message
        }
      }
    } finally {
      restoring.value = false
    }
  }

  /**
   * 刷新单个订阅：重新拉一次这个源的 RSS 并更新节目列表。
   *
   * 与 restore() 的区别：restore 会跳过已经加载好的订阅，而刷新是用户
   * 明确要求「再拉一次」，所以不管当前是什么状态都要重新请求。
   * 失败时保留条目并标明错误，不把订阅删掉。
   */
  async function refresh(url: string): Promise<void> {
    const index = indexOf(url)
    if (index < 0) return
    const item = items.value[index]
    if (!item) return

    item.status = 'loading'
    item.error = null

    let loaded: LoadedFeed
    try {
      loaded = await loadFeed(item.url)
    } catch {
      item.status = 'error'
      item.feed = null
      item.error = UNEXPECTED_ERROR_MESSAGE
      return
    }

    // 刷新期间条目可能已被替换，重新取一次再写，避免写到陈旧对象上
    const target = items.value.find((entry) => entry.url === url)
    if (!target) return
    if (loaded.ok) {
      target.status = 'ready'
      target.feed = loaded.feed
      target.error = null
      target.fetchedAt = Date.now()
    } else {
      target.status = 'error'
      target.feed = null
      target.error = loaded.message
    }
  }

  /** 刷新全部订阅：串行执行，避免同时向多个源发起请求 */
  async function refreshAll(): Promise<void> {
    if (refreshingAll.value || items.value.length === 0) return
    refreshingAll.value = true
    try {
      const urls = items.value.map((item) => item.url)
      for (const url of urls) {
        await refresh(url)
      }
    } finally {
      refreshingAll.value = false
    }
  }

  function remove(url: string): void {
    items.value = items.value.filter((item) => item.url !== url)
    persistenceError.value = persist() ? null : PERSISTENCE_FAILED_MESSAGE
  }

  return {
    remove,
    items,
    adding,
    addError,
    restoring,
    restored,
    refreshingAll,
    persistenceError,
    count,
    hasSubscriptions,
    addFromUrl,
    restore,
    refresh,
    refreshAll,
  }
})
