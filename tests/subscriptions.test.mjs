// 订阅 store 测试：添加、去重、失败处理、持久化、恢复、刷新
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DOMParser: XmlDOMParser } = require('@xmldom/xmldom')

globalThis.DOMParser = class {
  parseFromString(xml, mimeType) {
    const problems = []
    const parser = new XmlDOMParser({
      errorHandler: { warning: () => {}, error: () => problems.push('e'), fatalError: () => problems.push('f') },
    })
    const doc = parser.parseFromString(xml, mimeType)
    if (problems.length > 0) {
      const err = new Error('malformed xml')
      err.code = 'MALFORMED_XML'
      throw err
    }
    return doc
  }
}

const { createPinia, setActivePinia } = await import('pinia')
const { useSubscriptionsStore } = await import('@/stores/subscriptions')

const KEY = 'xiaoyuzhou.subscriptions.v1'

class FakeStorage {
  constructor(initial) {
    this.map = new Map()
    this.failWrites = false
    if (initial !== undefined) this.map.set(KEY, initial)
  }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.map.set(k, String(v))
  }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
  get length() { return this.map.size }
  key(i) { return Array.from(this.map.keys())[i] ?? null }
  raw(k) { return this.map.get(k) ?? null }
}

function installStorage(storage) {
  globalThis.localStorage = storage
}

const feedXml = (title, epCount = 1) => `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>${title}</title><author>主播</author>
  ${Array.from({ length: epCount }, (_, i) => `
    <item><title>${title} 第 ${i + 1} 集</title>
      <pubDate>Mon, 0${i + 1} Jan 2024 10:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/${i}.mp3" type="audio/mpeg"/></item>`).join('')}
</channel></rss>`

let bridgeCalls = 0
function setBridge(impl) {
  bridgeCalls = 0
  globalThis.desktop = { fetchRss: async (url) => { bridgeCalls += 1; return impl(url) } }
}
const okPayload = (url, title = 'A 电台', epCount = 1) => ({
  ok: true, url, finalUrl: url, contentType: 'application/xml',
  bytes: 100, text: feedXml(title, epCount),
})
const failPayload = (code, message) => ({ ok: false, code, message })

function freshStore(storage = new FakeStorage()) {
  installStorage(storage)
  setActivePinia(createPinia())
  return useSubscriptionsStore()
}

test('添加成功：进入 ready 并把 URL 写入 localStorage', async () => {
  const storage = new FakeStorage()
  const store = freshStore(storage)
  setBridge(async (url) => okPayload(url, 'A 电台', 2))

  const r = await store.addFromUrl('https://a.example.com/feed.xml')
  assert.equal(r.ok, true)
  assert.equal(store.items.length, 1)
  assert.equal(store.items[0].status, 'ready')
  assert.equal(store.items[0].feed.title, 'A 电台')
  assert.equal(store.items[0].feed.episodes.length, 2)
  assert.equal(storage.raw(KEY), JSON.stringify(['https://a.example.com/feed.xml']))
})

test('完全相同的 URL 拒绝重复添加，且不再发起请求', async () => {
  const store = freshStore()
  setBridge(async (url) => okPayload(url))
  await store.addFromUrl('https://a.example.com/feed.xml')
  const callsAfterFirst = bridgeCalls

  const r2 = await store.addFromUrl('https://a.example.com/feed.xml')
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'DUPLICATE')
  assert.equal(store.items.length, 1)
  assert.equal(bridgeCalls, callsAfterFirst)
})

test('请求失败 / 解析失败都不产生订阅，也不写存储', async () => {
  const storage = new FakeStorage()
  const store = freshStore(storage)

  setBridge(async () => failPayload('TIMEOUT', '请求超时（15 秒），请检查网络或代理设置'))
  const r1 = await store.addFromUrl('https://slow.example.com/feed.xml')
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'TIMEOUT')
  assert.equal(store.items.length, 0)
  assert.equal(storage.raw(KEY), null)

  setBridge(async () => ({ ok: true, url: 'x', finalUrl: 'x', contentType: 'text/html', bytes: 10, text: '<html></html>' }))
  const r2 = await store.addFromUrl('https://notfeed.example.com/')
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'UNSUPPORTED_FORMAT')
  assert.equal(store.items.length, 0)
})

test('写入 localStorage 失败时给出提示，但订阅本身仍然可用', async () => {
  const storage = new FakeStorage()
  storage.failWrites = true
  const store = freshStore(storage)
  setBridge(async (url) => okPayload(url))

  const r = await store.addFromUrl('https://a.example.com/feed.xml')
  assert.equal(r.ok, true)
  assert.equal(store.items.length, 1)
  assert.ok(store.persistenceError)
  assert.ok(store.persistenceError.includes('没能写入本地存储'))
})

test('restore 从存储恢复：成功变 ready，失败保留为 error', async () => {
  const storage = new FakeStorage(
    JSON.stringify(['https://a.example.com/feed.xml', 'https://b.example.com/feed.xml']),
  )
  const store = freshStore(storage)
  setBridge(async (url) =>
    url.includes('a.example') ? okPayload(url, 'A 电台') : failPayload('HTTP_STATUS', '服务器返回了错误状态码'),
  )

  await store.restore()
  assert.equal(store.items.length, 2)
  assert.equal(store.items[0].status, 'ready')
  assert.equal(store.items[1].status, 'error')
  assert.equal(store.restored, true)
  assert.equal(store.restoring, false)
})

test('存储内容损坏时按空列表处理，不抛异常', async () => {
  const store = freshStore(new FakeStorage('not-a-json{{{{'))
  setBridge(async (url) => okPayload(url))
  await store.restore()
  assert.equal(store.items.length, 0)
  assert.equal(bridgeCalls, 0)
})

test('refresh 单独刷新一个订阅会拿到最新内容', async () => {
  const store = freshStore()
  setBridge(async (url) => okPayload(url, '旧标题'))
  await store.addFromUrl('https://a.example.com/feed.xml')
  assert.equal(store.items[0].feed.title, '旧标题')

  setBridge(async (url) => okPayload(url, '新标题', 3))
  await store.refresh('https://a.example.com/feed.xml')

  assert.equal(store.items[0].status, 'ready')
  assert.equal(store.items[0].feed.title, '新标题')
  assert.equal(store.items[0].feed.episodes.length, 3)
})

test('refresh 失败时把该条目标记为 error，条目本身保留', async () => {
  const store = freshStore()
  setBridge(async (url) => okPayload(url))
  await store.addFromUrl('https://a.example.com/feed.xml')

  setBridge(async () => failPayload('NETWORK_ERROR', '网络请求失败，请检查网络或代理设置'))
  await store.refresh('https://a.example.com/feed.xml')

  assert.equal(store.items.length, 1)
  assert.equal(store.items[0].status, 'error')
  assert.equal(store.items[0].error, '网络请求失败，请检查网络或代理设置')
})

test('refreshAll 逐个刷新全部订阅并复位 refreshingAll', async () => {
  const store = freshStore()
  setBridge(async (url) => okPayload(url))
  await store.addFromUrl('https://a.example.com/feed.xml')
  await store.addFromUrl('https://b.example.com/feed.xml')

  setBridge(async (url) => okPayload(url, '刷新后'))
  const pending = store.refreshAll()
  assert.equal(store.refreshingAll, true)
  await pending

  assert.equal(store.refreshingAll, false)
  assert.equal(bridgeCalls, 2)
  assert.deepEqual(store.items.map((i) => i.feed.title), ['刷新后', '刷新后'])
})
