// RSS / Atom 解析测试。DOM 由 @xmldom/xmldom 提供（Node 没有 DOMParser）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DOMParser: XmlDOMParser } = require('@xmldom/xmldom')

// 模拟渲染进程里 Chromium 提供的全局 DOMParser
globalThis.DOMParser = class {
  parseFromString(xml, mimeType) {
    const problems = []
    const parser = new XmlDOMParser({
      errorHandler: {
        warning: () => {},
        error: () => problems.push('e'),
        fatalError: () => problems.push('f'),
      },
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

const { parseRss } = await import('@/lib/rss')

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试电台</title>
  <author>测试主播</author>
  <description>节目简介</description>
  <item>
    <title>第二新的一集</title>
    <description>用 &lt;p&gt;标签写的&lt;/p&gt;简介</description>
    <pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate>
    <itunes:duration>01:02:03</itunes:duration>
    <guid>ep-2</guid>
    <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg" length="1"/>
  </item>
  <item>
    <title>旧的一集</title>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
  </item>
  <item>
    <title>没有音频的一集</title>
    <pubDate>Sun, 31 Dec 2023 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 电台</title>
  <author><name>Atom 主播</name></author>
  <entry>
    <title>原子集</title>
    <id>tag:example.com,2024:1</id>
    <published>2024-03-01T10:00:00Z</published>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example.com/atom.mp3"/>
  </entry>
</feed>`

test('解析 RSS 2.0：标题、作者、集数、时长、音频地址、按时间倒序', () => {
  const result = parseRss(RSS2)
  assert.equal(result.ok, true)
  const feed = result.feed
  assert.equal(feed.format, 'rss2')
  assert.equal(feed.title, '测试电台')
  assert.equal(feed.author, '测试主播')
  assert.equal(feed.totalEpisodes, 3)
  assert.equal(feed.episodes.length, 3)

  // 倒序：2024-01-02 → 2024-01-01 → 2023-12-31
  assert.deepEqual(
    feed.episodes.map((e) => e.title),
    ['第二新的一集', '旧的一集', '没有音频的一集'],
  )

  const first = feed.episodes[0]
  assert.equal(first.durationSeconds, 3723) // 01:02:03
  assert.equal(first.audioUrl, 'https://cdn.example.com/2.mp3')
  assert.equal(first.id, 'ep-2')
  // HTML 描述应被转成纯文本
  assert.ok(!first.description.includes('<p>'))
})

test('缺少 enclosure 的单集 audioUrl 为 null，并产生 NO_AUDIO_URL 警告', () => {
  const result = parseRss(RSS2)
  assert.equal(result.ok, true)
  const noAudio = result.feed.episodes.find((e) => e.title === '没有音频的一集')
  assert.ok(noAudio)
  assert.equal(noAudio.audioUrl, null)
  const warn = result.warnings.find((w) => w.code === 'NO_AUDIO_URL')
  assert.ok(warn)
  assert.equal(warn.count, 1)
})

test('解析 Atom：标题、作者、enclosure 链接', () => {
  const result = parseRss(ATOM)
  assert.equal(result.ok, true)
  const feed = result.feed
  assert.equal(feed.format, 'atom')
  assert.equal(feed.title, 'Atom 电台')
  assert.equal(feed.author, 'Atom 主播')
  assert.equal(feed.episodes.length, 1)
  assert.equal(feed.episodes[0].audioUrl, 'https://cdn.example.com/atom.mp3')
})

test('空输入、非订阅源、畸形 XML 分别给出固定错误码', () => {
  assert.equal(parseRss('').code, 'EMPTY_INPUT')
  assert.equal(parseRss('   ').code, 'EMPTY_INPUT')
  assert.equal(parseRss('<html><body>hi</body></html>').code, 'UNSUPPORTED_FORMAT')
  assert.equal(parseRss('<rss><channel>').ok, false)
})

test('缺少标题时 title 为空字符串并给出 MISSING_TITLE 警告', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>无标题测试</title>
    <item><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/x.mp3" type="audio/mpeg"/></item>
  </channel></rss>`
  const result = parseRss(xml)
  assert.equal(result.ok, true)
  assert.equal(result.feed.episodes[0].title, '')
  assert.ok(result.warnings.some((w) => w.code === 'MISSING_TITLE'))
})

test('单集数量受 maxEpisodes 限制，但 totalEpisodes 仍是真实总数', () => {
  const items = Array.from({ length: 5 }, (_, i) => `
    <item><title>第 ${i} 集</title><pubDate>Mon, 0${i + 1} Jan 2024 10:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/${i}.mp3" type="audio/mpeg"/></item>`).join('')
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
  const result = parseRss(xml, { maxEpisodes: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.feed.episodes.length, 2)
  assert.equal(result.feed.totalEpisodes, 5)
})
