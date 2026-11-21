// 搜索结果归一化测试：结构不认识必须报错，不能默默返回空数组。
import test from 'node:test'
import assert from 'node:assert/strict'

const { normalizeSearchPayload, extractSearchItems, extractSearchCategories, SearchShapeError } = await import('@/lib/official-search')

test('裸数组：按 pid/eid 分类', () => {
  const result = normalizeSearchPayload([
    { pid: 'p1', title: '节目一', author: '主播' },
    { eid: 'e1', pid: 'p1', title: '单集一', duration: 60 },
  ])
  assert.equal(result.podcasts.length, 1)
  assert.equal(result.episodes.length, 1)
  assert.equal(result.podcasts[0].pid, 'p1')
  assert.equal(result.episodes[0].durationSeconds, 60)
  assert.equal(result.rawCount, 2)
})

test('{data:[...]} 与 {data:{data:[...]}} 都能识别，游标原样带出', () => {
  const flat = normalizeSearchPayload({ data: [{ pid: 'p1' }], loadMoreKey: 'k1' })
  assert.equal(flat.podcasts.length, 1)
  assert.equal(flat.loadMoreKey, 'k1')

  const nested = normalizeSearchPayload({ data: { data: [{ pid: 'p2' }], loadMoreKey: { page: 2 } } })
  assert.equal(nested.podcasts.length, 1)
  assert.deepEqual(nested.loadMoreKey, { page: 2 })
})

test('结构不认识时抛 SearchShapeError，而不是返回空数组', () => {
  for (const bad of [null, undefined, 0, 'text', true, {}, { data: 'nope' }, { data: { data: {} } }]) {
    assert.throws(() => normalizeSearchPayload(bad), SearchShapeError)
  }
})

test('结构正确但结果为空时，返回空列表而不是报错', () => {
  const result = normalizeSearchPayload({ data: [], loadMoreKey: null })
  assert.deepEqual(result.podcasts, [])
  assert.deepEqual(result.episodes, [])
  assert.equal(result.rawCount, 0)
})

test('条目缺字段时被丢弃，不影响其它条目', () => {
  const result = normalizeSearchPayload({ data: [{ title: '没有 id' }, { pid: 'p1' }] })
  assert.equal(result.podcasts.length, 1)
  assert.equal(result.rawCount, 2)
})

test('extractSearchItems 单独可用，便于诊断', () => {
  assert.deepEqual(extractSearchItems([1, 2]).items, [1, 2])
  assert.throws(() => extractSearchItems({ foo: 1 }), SearchShapeError)
})

// ── 分类（发现页入口）──────────────────────────────────────────
// 真实结构参考：{ type: 'SEARCHED_CATEGORY', category: { id, name, icon: { picUrl }, emoji } }

test('分类：从混合结果里只取 SEARCHED_CATEGORY，并保留图标', () => {
  const payload = {
    data: [
      { type: 'HEADER', title: '头部' },
      { type: 'SEARCHED_CATEGORY', category: { id: 'c1', name: '商业', icon: { picUrl: 'https://x.test/a.png' }, emoji: '💼' } },
      { type: 'PODCAST', pid: 'p1', title: '某节目' },
      { type: 'SEARCHED_CATEGORY', category: { id: 'c2', name: '科技', icon: { largePicUrl: 'https://x.test/b.png' } } },
      { type: 'FOOTER' },
    ],
  }
  const cats = extractSearchCategories(payload)
  assert.equal(cats.length, 2)
  assert.equal(cats[0].id, 'c1')
  assert.equal(cats[0].name, '商业')
  assert.equal(cats[0].iconUrl, 'https://x.test/a.png')
  assert.equal(cats[0].emoji, '💼')
  // picUrl 缺失时回退到 largePicUrl
  assert.equal(cats[1].iconUrl, 'https://x.test/b.png')
  assert.equal(cats[1].emoji, '')
})

test('分类：同 id 去重，缺 id 或 name 的条目被丢弃', () => {
  const payload = {
    data: [
      { type: 'SEARCHED_CATEGORY', category: { id: 'c1', name: '商业' } },
      { type: 'SEARCHED_CATEGORY', category: { id: 'c1', name: '商业（重复）' } },
      { type: 'SEARCHED_CATEGORY', category: { name: '没有 id' } },
      { type: 'SEARCHED_CATEGORY', category: { id: 'c3' } },
    ],
  }
  const cats = extractSearchCategories(payload)
  assert.equal(cats.length, 1)
  assert.equal(cats[0].name, '商业')
})

test('分类：结构不认识时返回空数组而不是抛错', () => {
  for (const bad of [null, undefined, 0, 'text', {}, { data: 'nope' }]) {
    assert.deepEqual(extractSearchCategories(bad), [])
  }
})

test('分类：非 http(s) 图标一律置空，避免把相对路径交给 <img>', () => {
  const payload = {
    data: [{ type: 'SEARCHED_CATEGORY', category: { id: 'c1', name: '商业', icon: { picUrl: '/relative.png' } } }],
  }
  assert.equal(extractSearchCategories(payload)[0].iconUrl, null)
})
