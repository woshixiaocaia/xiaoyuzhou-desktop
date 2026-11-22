// 官方 API 契约层测试：全部使用本地构造的假数据，不发网络请求、不涉及账号。
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  OFFICIAL_ENDPOINTS,
  pickOfficialPage,
  normalizeOfficialPodcast,
  normalizeOfficialEpisode,
  pickOfficialPodcasts,
  pickOfficialEpisodes,
  pickOfficialFavoriteEpisodes,
} = await import('@/lib/official-contract')

// ── 分页：三种已知形状 ──────────────────────────────────────────

test('平铺分页：{ data: [...], loadMoreKey }', () => {
  const payload = {
    data: [{ pid: 'p1', title: '节目一' }, { pid: 'p2', title: '节目二' }],
    loadMoreKey: 'cursor-flat',
  }
  const page = pickOfficialPage(payload)
  assert.equal(page.items.length, 2)
  assert.equal(page.loadMoreKey, 'cursor-flat')
})

test('嵌套分页：{ data: { data: [...], loadMoreKey } }', () => {
  const payload = {
    data: { data: [{ pid: 'p3', title: '节目三' }], loadMoreKey: 'cursor-nested' },
  }
  const page = pickOfficialPage(payload)
  assert.equal(page.items.length, 1)
  assert.equal(page.loadMoreKey, 'cursor-nested')
})

test('裸数组：没有游标时返回 null', () => {
  const page = pickOfficialPage([{ pid: 'p4' }])
  assert.equal(page.items.length, 1)
  assert.equal(page.loadMoreKey, null)
})

// ── 分页游标必须原样透传 ────────────────────────────────────────

test('loadMoreKey 原样透传：字符串、对象、数字都不做转换', () => {
  const objectCursor = { ts: '2026-01-01T00:00:00Z', page: 3 }
  const withObject = pickOfficialPage({ data: [], loadMoreKey: objectCursor })
  assert.equal(withObject.loadMoreKey, objectCursor) // 同一引用，未被复制或改写

  const withNumber = pickOfficialPage({ data: [], loadMoreKey: 42 })
  assert.equal(withNumber.loadMoreKey, 42)

  const withEmpty = pickOfficialPage({ data: [] })
  assert.equal(withEmpty.loadMoreKey, null)
})

// ── 异常 payload 不得抛出未捕获异常 ────────────────────────────

test('异常 payload（null/undefined/数字/字符串/嵌套数组）一律安全降级', () => {
  const inputs = [null, undefined, 0, 123, 'not-an-object', true, [[]], [{ pid: 'x' }]]
  for (const input of inputs) {
    const page = pickOfficialPage(input)
    assert.ok(Array.isArray(page.items), 'items 必须是数组')
    if (input === undefined || input === null || typeof input !== 'object') {
      assert.equal(page.items.length, 0, `非对象输入应得到空列表: ${String(input)}`)
      assert.equal(page.loadMoreKey, null)
    }
  }

  // 明确检查几种典型坏输入
  assert.deepEqual(pickOfficialPage(null), { items: [], loadMoreKey: null })
  assert.deepEqual(pickOfficialPage('x'), { items: [], loadMoreKey: null })
  assert.deepEqual(pickOfficialPage({ data: 'oops' }), { items: [], loadMoreKey: null })
  assert.deepEqual(pickOfficialPage({ data: { data: 'oops' } }), { items: [], loadMoreKey: null })
})

test('normalizeOfficialPodcast / normalizeOfficialEpisode 对非对象输入返回 null', () => {
  for (const input of [null, undefined, 0, 'x', true, [], [{ pid: 'p' }]]) {
    assert.equal(normalizeOfficialPodcast(input), null)
    assert.equal(normalizeOfficialEpisode(input), null)
  }
})

// ── 节目字段缺失时的降级 ────────────────────────────────────────

test('节目只给 pid 时，其余字段全部安全降级', () => {
  const podcast = normalizeOfficialPodcast({ pid: 'p-min' })
  assert.ok(podcast)
  assert.equal(podcast.pid, 'p-min')
  assert.equal(podcast.title, '')
  assert.equal(podcast.author, '')
  assert.equal(podcast.brief, '')
  assert.equal(podcast.imageUrl, null)
  assert.equal(podcast.episodeCount, 0)
  assert.equal(podcast.subscriptionCount, 0)
  assert.equal(podcast.latestEpisodePubDate, null)
  assert.equal(podcast.starred, false)
})

test('节目字段类型错误时不污染结果（计数为负/NaN/字符串一律归零）', () => {
  const podcast = normalizeOfficialPodcast({
    pid: 'p-bad',
    title: 123,
    episodeCount: -5,
    subscriptionCount: Number.NaN,
    subscriptionStar: 'yes',
  })
  assert.ok(podcast)
  assert.equal(podcast.title, '')
  assert.equal(podcast.episodeCount, 0)
  assert.equal(podcast.subscriptionCount, 0)
  assert.equal(podcast.starred, false)
})

test('没有 pid 的节目条目被丢弃（无法被引用）', () => {
  assert.equal(normalizeOfficialPodcast({ title: '无 pid' }), null)
  assert.equal(normalizeOfficialPodcast({ pid: '' }), null)
})

// ── 单集：可播放地址 ────────────────────────────────────────────

test('单集优先取 media.source.url', () => {
  const episode = normalizeOfficialEpisode({
    eid: 'e1',
    pid: 'p1',
    title: '第一集',
    duration: 1234.7,
    pubDate: '2026-01-02T00:00:00Z',
    media: { source: { url: 'https://cdn.example.com/a.m4a', mimeType: 'audio/mp4' }, size: 10 },
  })
  assert.ok(episode)
  assert.equal(episode.audioUrl, 'https://cdn.example.com/a.m4a')
  assert.equal(episode.durationSeconds, 1234)
  assert.equal(episode.mimeType, 'audio/mp4')
  assert.equal(episode.isPrivate, false)
})

test('缺失 media.source.url 时 audioUrl 为 null，绝不伪装成可播放', () => {
  const noMedia = normalizeOfficialEpisode({ eid: 'e2', pid: 'p1', title: '无地址' })
  assert.ok(noMedia)
  assert.equal(noMedia.audioUrl, null)

  const emptySource = normalizeOfficialEpisode({
    eid: 'e3',
    media: { source: { url: '' } },
  })
  assert.ok(emptySource)
  assert.equal(emptySource.audioUrl, null)

  const nonHttpSource = normalizeOfficialEpisode({
    eid: 'e4',
    media: { source: { url: 'javascript:alert(1)' } },
  })
  assert.ok(nonHttpSource)
  assert.equal(nonHttpSource.audioUrl, null)
})

test('没有 media 时回退到 enclosure.url', () => {
  const episode = normalizeOfficialEpisode({
    eid: 'e5',
    enclosure: { url: 'https://cdn.example.com/b.mp3' },
  })
  assert.ok(episode)
  assert.equal(episode.audioUrl, 'https://cdn.example.com/b.mp3')
})

test('单集 pid 回退顺序：自身 pid → 内嵌 podcast.pid → 调用方给的 fallbackPid', () => {
  assert.equal(normalizeOfficialEpisode({ eid: 'a', pid: 'own' }, 'fb')?.pid, 'own')
  assert.equal(normalizeOfficialEpisode({ eid: 'b', podcast: { pid: 'inner' } }, 'fb')?.pid, 'inner')
  assert.equal(normalizeOfficialEpisode({ eid: 'c' }, 'fb')?.pid, 'fb')
  assert.equal(normalizeOfficialEpisode({ eid: 'd' })?.pid, '')
})

test('没有 eid 的单集被丢弃', () => {
  assert.equal(normalizeOfficialEpisode({ title: '无 eid' }), null)
  assert.equal(normalizeOfficialEpisode({ eid: '' }), null)
})

// ── 批量归一化 ──────────────────────────────────────────────────

test('批量：坏条目被跳过，好条目保留，游标仍然透传', () => {
  const podcastPage = pickOfficialPodcasts({
    data: [{ pid: 'p1', title: 'A' }, null, { title: '没有 pid' }, 'x', { pid: 'p2' }],
    loadMoreKey: 'next-1',
  })
  assert.equal(podcastPage.podcasts.length, 2)
  assert.deepEqual(podcastPage.podcasts.map((p) => p.pid), ['p1', 'p2'])
  assert.equal(podcastPage.loadMoreKey, 'next-1')

  const episodePage = pickOfficialEpisodes(
    { data: [{ eid: 'e1' }, { eid: '' }, 42, { eid: 'e2' }], loadMoreKey: 'next-2' },
    'p-fallback',
  )
  assert.equal(episodePage.episodes.length, 2)
  assert.deepEqual(episodePage.episodes.map((e) => e.eid), ['e1', 'e2'])
  assert.equal(episodePage.episodes[0].pid, 'p-fallback')
  assert.equal(episodePage.loadMoreKey, 'next-2')
})

// ── 端点常量 ────────────────────────────────────────────────────

test('端点常量与审计记录一致（仅 method/path，不含主机与凭据）', () => {
  assert.deepEqual(OFFICIAL_ENDPOINTS.getMe, { method: 'GET', path: '/web/user/get-me' })
  assert.deepEqual(OFFICIAL_ENDPOINTS.subscriptionList, {
    method: 'POST',
    path: '/v1/subscription/list',
  })
  assert.deepEqual(OFFICIAL_ENDPOINTS.episodeList, { method: 'POST', path: '/v1/episode/list' })
  assert.deepEqual(OFFICIAL_ENDPOINTS.episodeHistory, { method: 'POST', path: '/v1/episode-played/list-history' })
  assert.deepEqual(OFFICIAL_ENDPOINTS.playbackProgress, { method: 'POST', path: '/v1/playback-progress/list' })
  assert.deepEqual(OFFICIAL_ENDPOINTS.favorites, { method: 'POST', path: '/v1/favorite/list' })
  assert.deepEqual(OFFICIAL_ENDPOINTS.privateMediaGet, {
    method: 'GET',
    path: '/v1/private-media/get',
  })

  // 常量里不允许出现任何主机名或凭据字样
  const serialized = JSON.stringify(OFFICIAL_ENDPOINTS)
  assert.ok(!/http/i.test(serialized), '端点常量不应包含协议/主机')
  assert.ok(!/authorization/i.test(serialized))
  assert.ok(!/cookie/i.test(serialized))
})

test('收藏列表：展开单集实体，跳过被喜欢的播客和无效条目', () => {
  const result = pickOfficialFavoriteEpisodes({ data: [
    { type: 'EPISODE', episode: { eid: 'e1', pid: 'p1', title: '收藏单集' } },
    { type: 'PODCAST', podcast: { pid: 'p2', title: '播客' } },
    { type: 'EPISODE', episode: { pid: 'p1', title: '缺少 eid' } },
  ], loadMoreKey: 'next' })
  assert.deepEqual(result.episodes.map((episode) => episode.eid), ['e1'])
  assert.equal(result.loadMoreKey, 'next')
})
