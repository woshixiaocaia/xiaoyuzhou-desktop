// 搜索 store 测试：状态机、结构与竞态。全部离线，用假桥。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createPinia, setActivePinia } = await import('pinia')
const { useOfficialStore } = await import('@/stores/official')

function installBridge(searchImpl) {
  globalThis.desktop = {
    officialAuthStart: async () => ({ ok: true, id: 'x', url: 'https://h5.y/z' }),
    officialAuthPoll: async () => ({ ok: true, status: 'WAITTING', user: null, storage: 'ok' }),
    officialAuthStatus: async () => ({ ok: true, loggedIn: true, user: null, storageAvailable: true }),
    officialAuthLogout: async () => ({ ok: true }),
    officialSubscriptions: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialEpisodes: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialMediaUrl: async () => ({ ok: true, url: 'https://cdn/x.m4a' }),
    officialSearch: searchImpl,
  }
}

const fresh = () => {
  setActivePinia(createPinia())
  return useOfficialStore()
}

test('搜索成功：ALL 混合结果里跳过 HEADER/FOOTER，只保留内容条目', async () => {
  installBridge(async () => ({
    ok: true,
    payload: {
      data: [
        { type: 'HEADER', title: '分组头', readTrackInfo: { searchId: 's1' } },
        { type: 'PODCAST', pid: 'p1', title: '播客一', episodeCount: 3 },
        { type: 'EPISODE', eid: 'e1', pid: 'p1', title: '单集一', duration: 60 },
        { type: 'FOOTER', title: '分组尾' },
        { type: 'SEARCHED_USERS', title: '用户' },
      ],
    },
  }))
  const official = fresh()
  await official.runSearch('测试', 'ALL')
  assert.equal(official.searchStatus, 'ready')
  assert.equal(official.searchPodcasts.length, 1)
  assert.equal(official.searchEpisodes.length, 1)
  assert.equal(official.searchPodcasts[0].pid, 'p1')
})

test('单集搜索默认显示篇目，不把播客合集混进结果', async () => {
  const calls = []
  installBridge(async (_keyword, options) => {
    calls.push(options)
    return { ok: true, payload: { data: [
      { type: 'PODCAST', pid: 'p1', title: '节目合集' },
      { type: 'EPISODE', eid: 'e1', pid: 'p1', title: '匹配的单集' },
    ] } }
  })
  const official = fresh()
  await official.runSearch('标题里的词')
  assert.deepEqual(calls, [{ type: 'ALL' }])
  assert.deepEqual(official.searchPodcasts, [])
  assert.deepEqual(official.searchEpisodes.map((episode) => episode.eid), ['e1'])
  assert.equal(official.searchType, 'EPISODE')
})

test('空结果进入 empty，而不是 error', async () => {
  installBridge(async () => ({ ok: true, payload: { data: [] } }))
  const official = fresh()
  await official.runSearch('不存在')
  assert.equal(official.searchStatus, 'empty')
})

test('未登录时进入 error 并保留可读原因', async () => {
  installBridge(async () => ({ ok: false, code: 'NOT_LOGGED_IN', message: '尚未登录小宇宙账号' }))
  const official = fresh()
  await official.runSearch('测试')
  assert.equal(official.searchStatus, 'error')
  assert.match(official.searchError, /尚未登录/)
})

test('结构不认识时明确报错，不静默变成空结果', async () => {
  installBridge(async () => ({ ok: true, payload: { unexpected: true } }))
  const official = fresh()
  await official.runSearch('测试')
  assert.equal(official.searchStatus, 'error')
  assert.match(official.searchError, /结构/)
  assert.equal(official.searchPodcasts.length, 0)
})

test('旧请求的迟到响应不覆盖新关键词结果', async () => {
  const pending = []
  installBridge((keyword) =>
    new Promise((resolve) => {
      pending.push({ keyword, resolve })
    }),
  )
  const official = fresh()

  const first = official.runSearch('旧词', 'PODCAST')
  const second = official.runSearch('新词', 'PODCAST')
  assert.equal(pending.length, 2)

  // 先返回「新词」的结果，再让「旧词」迟到
  pending[1].resolve({ ok: true, payload: { data: [{ type: 'PODCAST', pid: 'new', title: '新' }] } })
  await second
  pending[0].resolve({ ok: true, payload: { data: [{ type: 'PODCAST', pid: 'old', title: '旧' }] } })
  await first

  assert.equal(official.searchKeyword, '新词')
  assert.equal(official.searchPodcasts.length, 1)
  assert.equal(official.searchPodcasts[0].pid, 'new')
})

test('空关键词不发请求并回到 idle', async () => {
  let calls = 0
  installBridge(async () => {
    calls += 1
    return { ok: true, payload: { data: [] } }
  })
  const official = fresh()
  await official.runSearch('   ')
  assert.equal(calls, 0)
  assert.equal(official.searchStatus, 'idle')
})
