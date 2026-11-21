// 发现页分类筛选条去重测试（BUG-05）
//
// 回归目标：连续切换同一/不同分类后，分类条目不得重复增长。
// 之前 store 用「只增不减」合并，且视图同时渲染固定关键词与接口分类，
// 导致同名条目重复出现。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createPinia, setActivePinia } = await import('pinia')
const { useOfficialStore } = await import('@/stores/official')

/** 用可控的假桥：每次调用都返回给定的分类条目 */
function installBridge(responses) {
  let call = 0
  globalThis.desktop = {
    officialAuthStart: async () => ({ ok: true, id: 'x', url: 'https://h5.y/z' }),
    officialAuthPoll: async () => ({ ok: true, status: 'WAITTING', user: null, storage: 'ok' }),
    officialAuthStatus: async () => ({ ok: true, loggedIn: true, user: null, storageAvailable: true }),
    officialAuthLogout: async () => ({ ok: true }),
    officialSubscriptions: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialEpisodes: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialMediaUrl: async () => ({ ok: true, url: 'https://cdn/x.m4a' }),
    officialSearch: async (keyword) => {
      const factory = responses[call % responses.length]
      call += 1
      return factory(keyword)
    },
  }
}

const fresh = () => {
  setActivePinia(createPinia())
  return useOfficialStore()
}

/** 播客结果（PODCAST 主请求用） */
const podcastsPage = () => ({
  ok: true,
  payload: { data: [{ type: 'PODCAST', pid: 'p1', title: '某节目', episodeCount: 3 }], loadMoreKey: null },
})

/** 分类结果（ALL 附加请求用） */
const categoriesPage = (cats) => ({
  ok: true,
  payload: {
    data: cats.map((c) => ({ type: 'SEARCHED_CATEGORY', category: c })),
    loadMoreKey: null,
  },
})

test('分类条目：同一分类反复切换不会累积', async () => {
  installBridge([
    podcastsPage,
    () => categoriesPage([{ id: 'c1', name: '商业', icon: { picUrl: 'https://x/a.png' } }]),
  ])
  const store = fresh()

  await store.browseCategory('商业')
  assert.equal(store.discoverCategories.length, 1)

  // 再切两次同样的分类：条目数不应增长
  await store.browseCategory('商业')
  await store.browseCategory('商业')
  assert.equal(store.discoverCategories.length, 1)
  assert.equal(store.discoverCategories[0].id, 'c1')
})

test('分类条目：不同 id 但同名只保留一个', async () => {
  installBridge([
    podcastsPage,
    () => categoriesPage([{ id: 'c1', name: '科技' }]),
    podcastsPage,
    () => categoriesPage([{ id: 'c2', name: '科技' }]),
  ])
  const store = fresh()

  await store.browseCategory('科技')
  await store.browseCategory('科技')

  assert.equal(store.discoverCategories.length, 1)
  assert.equal(store.discoverCategories[0].name, '科技')
})

test('分类条目：切换分类后按最新结果替换，不会保留旧分类', async () => {
  installBridge([
    podcastsPage,
    () => categoriesPage([{ id: 'c1', name: '商业' }]),
    podcastsPage,
    () => categoriesPage([{ id: 'c2', name: '心理' }]),
  ])
  const store = fresh()

  await store.browseCategory('商业')
  assert.deepEqual(
    store.discoverCategories.map((c) => c.name),
    ['商业'],
  )

  await store.browseCategory('心理')
  assert.deepEqual(
    store.discoverCategories.map((c) => c.name),
    ['心理'],
  )
})

test('分类请求失败时不影响播客内容，分类列表保持不变', async () => {
  let call = 0
  installBridge([
    podcastsPage,
    () => categoriesPage([{ id: 'c1', name: '商业' }]),
  ])
  globalThis.desktop.officialSearch = async () => {
    call += 1
    // 第 1 次(PODCAST)成功，第 2 次(ALL)失败
    if (call === 1) return podcastsPage()
    if (call === 2) return categoriesPage([{ id: 'c1', name: '商业' }])
    if (call === 3) return podcastsPage()
    return { ok: false, code: 'NETWORK', message: '网络错误' }
  }
  const store = fresh()

  await store.browseCategory('商业')
  const before = store.discoverCategories.length

  await store.browseCategory('心理')
  // 播客内容仍然更新成功
  assert.equal(store.discoverStatus, 'ready')
  assert.equal(store.discoverPodcasts.length, 1)
  // 分类请求失败时保留原有分类，不清空、也不追加
  assert.equal(store.discoverCategories.length, before)
})

test('resetDiscover 清空分类，避免跨会话残留', async () => {
  installBridge([
    podcastsPage,
    () => categoriesPage([{ id: 'c1', name: '商业' }]),
  ])
  const store = fresh()

  await store.browseCategory('商业')
  assert.ok(store.discoverCategories.length > 0)

  store.resetDiscover()
  assert.equal(store.discoverCategories.length, 0)
  assert.equal(store.discoverKeyword, '')
  assert.equal(store.discoverStatus, 'idle')
})
