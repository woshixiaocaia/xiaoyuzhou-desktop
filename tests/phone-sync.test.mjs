// 手机历史同步测试：所有账号请求均由假 preload 桥响应，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createPinia, setActivePinia } = await import('pinia')
const { useHistoryStore } = await import('@/stores/history')

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

function installBridge(historyImpl) {
  globalThis.desktop = {
    officialAuthStart: async () => ({ ok: true, id: 'q', url: 'https://example.com/q' }),
    officialAuthPoll: async () => ({ ok: true, status: 'WAITTING', user: null, storage: 'ok' }),
    officialAuthStatus: async () => ({ ok: true, loggedIn: true, user: { uid: 'u1', nickname: 'test', avatar: '' }, storageAvailable: true }),
    officialAuthLogout: async () => ({ ok: true }),
    officialSubscriptions: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialEpisodes: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
    officialMediaUrl: async () => ({ ok: true, url: 'https://cdn.example.com/a.m4a' }),
    officialListenHistory: historyImpl,
  }
}

test('手机历史同步：转换服务器进度并合并本机历史', async () => {
  globalThis.localStorage.clear()
  installBridge(async () => ({ ok: true, payload: { data: [
    { eid: 'mobile-1', pid: 'pod-1', title: '手机听过的单集', duration: 180, progress: 45, playedAt: '2026-11-20T12:00:00Z', isFinished: false, podcast: { title: '手机播客' } },
  ], loadMoreKey: null } }))
  setActivePinia(createPinia())
  const history = useHistoryStore()
  history.record({ key: 'rss:local-1', source: 'rss', id: 'local-1', title: '本机历史', podcast: 'RSS', position: 20, duration: 90, force: true })

  await history.syncPhoneHistory()

  assert.equal(history.phoneSyncStatus, 'ready')
  assert.deepEqual(history.entries.map((entry) => entry.key).sort(), ['official:mobile-1', 'rss:local-1'])
  const entry = history.entries.find((item) => item.key === 'official:mobile-1')
  assert.equal(entry.title, '手机听过的单集')
  assert.equal(entry.podcast, '手机播客')
  assert.equal(entry.position, 45)
  assert.equal(entry.phoneSynced, true)
})

test('手机历史分页失败时保留已有记录并允许重试', async () => {
  storage.clear()
  let calls = 0
  installBridge(async () => {
    calls += 1
    if (calls === 1) return { ok: true, payload: { data: [{ eid: 'e1', pid: 'p1', title: '第一集', podcast: { title: '播客' } }], loadMoreKey: 'next' } }
    if (calls === 2) return { ok: false, code: 'NETWORK', message: '网络连接失败' }
    return { ok: true, payload: { data: [{ eid: 'e2', pid: 'p1', title: '第二集', podcast: { title: '播客' } }], loadMoreKey: null } }
  })
  setActivePinia(createPinia())
  const history = useHistoryStore()
  await history.syncPhoneHistory()
  await history.syncPhoneHistory(false)
  assert.equal(history.phoneSyncError, '网络连接失败')
  assert.equal(history.entries.length, 1)
  await history.syncPhoneHistory(false)
  assert.deepEqual(history.entries.map((entry) => entry.id).sort(), ['e1', 'e2'])
  assert.equal(history.phoneSyncStatus, 'ready')
})
