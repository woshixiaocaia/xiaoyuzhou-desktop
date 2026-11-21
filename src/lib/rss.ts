/**
 * RSS 2.0 / Atom 解析层。
 *
 * 设计约束（重要）：
 *  - 本文件**零 import、零运行时依赖**，因此可以被 Node 直接加载做离线测试
 *    （Node 24 的类型擦除会把 TS 直接跑起来）。
 *  - 与网络层完全分离：不碰 fetch / IPC / Electron。
 *  - `parseRss` **永不 throw**，失败只返回 `{ ok:false, code, message }`；
 *    任何失败路径都**不会**返回部分 feed 数据。
 *  - 默认解析器是运行环境的全局 `DOMParser`（Electron 渲染进程里即 Chromium 的实现）。
 *    缺失时抛 `code='PARSER_UNAVAILABLE'` 的错误，**绝不降级到任何宽松实现**。
 *  - 绝不执行 HTML：只用文本节点与标签剥离，不 innerHTML、不 v-html。
 */

export const MAX_EPISODES = 300
export const MAX_DESCRIPTION_CHARS = 2000

// ── 对外类型 ────────────────────────────────────────────────────

export interface RssEpisode {
  /** 内部标识：guid → audioUrl → `ep-<序号>-<标题>` */
  id: string
  title: string
  /** 已转纯文本、已截断 */
  description: string
  publishedAt: Date | null
  durationSeconds: number | null
  /** 仅 http/https，否则 null */
  audioUrl: string | null
  link: string | null
  guid: string | null
}

export interface RssFeed {
  format: 'rss2' | 'atom'
  title: string
  description: string
  author: string | null
  imageUrl: string | null
  link: string | null
  /** 已按发布时间倒序、已截断到 maxEpisodes */
  episodes: RssEpisode[]
  /** 文档中实际解析到的条目总数（与 episodes.length 区分） */
  totalEpisodes: number
}

export type RssParseErrorCode =
  | 'EMPTY_INPUT'
  | 'MALFORMED_XML'
  | 'UNSUPPORTED_FORMAT'
  | 'MISSING_CHANNEL'
  | 'PARSER_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export type RssParseWarningCode =
  | 'MISSING_TITLE'
  | 'INVALID_DATE'
  | 'NO_AUDIO_URL'
  | 'UNSUPPORTED_CONTENT_TYPE'

export interface RssParseWarning {
  code: RssParseWarningCode
  count: number
}

export type RssParseResult =
  | { ok: true; feed: RssFeed; warnings: RssParseWarning[] }
  | { ok: false; code: RssParseErrorCode; message: string }

/**
 * 注入点契约（测试用）：
 * 实现**必须**在输入畸形时抛错，或返回含 `parsererror` 元素的文档；
 * **不得**返回部分解析树。测试脚手架必须遵守此契约。
 */
export type CreateDocument = (xml: string) => Document

export interface RssParseOptions {
  maxEpisodes?: number
  createDocument?: CreateDocument
}

const ERROR_MESSAGES: Record<RssParseErrorCode, string> = {
  EMPTY_INPUT: '订阅源内容为空',
  MALFORMED_XML: '订阅源不是合法的 XML，已停止解析',
  UNSUPPORTED_FORMAT: '该 XML 不是 RSS 2.0 或 Atom 订阅源',
  MISSING_CHANNEL: 'RSS 缺少 channel 节点，无法解析',
  PARSER_UNAVAILABLE: '当前环境缺少 XML 解析器，无法解析订阅源',
  INTERNAL_ERROR: '解析订阅源时发生未预期的内部错误',
}

// ── 标签集合 ────────────────────────────────────────────────────

/** 块级标签：其边界应产生分隔，避免相邻段落文字粘连 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** 整棵子树都不贡献正文的元素（也绝不抓取其 src） */
const SKIP_TEXT_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas',
  'math', 'video', 'audio', 'img', 'picture', 'source', 'template',
])

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
}

// ── 错误与默认解析器 ────────────────────────────────────────────

function parseError(code: RssParseErrorCode, cause?: unknown): Error & { code: RssParseErrorCode } {
  const e = new Error(ERROR_MESSAGES[code]) as Error & { code: RssParseErrorCode }
  e.code = code
  if (cause !== undefined) (e as Error & { cause?: unknown }).cause = cause
  return e
}

/**
 * 默认解析器：使用运行环境的全局 DOMParser。
 * Electron 渲染进程里这就是 Chromium 的实现。
 * 缺失时抛 PARSER_UNAVAILABLE —— 不做任何降级。
 */
function defaultCreateDocument(xml: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw parseError('PARSER_UNAVAILABLE')
  }
  return new DOMParser().parseFromString(xml, 'application/xml')
}

// ── DOM 小工具（兼容不同实现，不依赖 children/局部接口） ─────────

type AnyNode = {
  nodeType?: number
  nodeValue?: string | null
  localName?: string | null
  nodeName?: string | null
  childNodes?: ArrayLike<AnyNode> | null
  getAttribute?: (name: string) => string | null
  textContent?: string | null
}

function localNameOf(node: AnyNode | null | undefined): string {
  if (!node) return ''
  const ln = node.localName
  if (typeof ln === 'string' && ln.length > 0) return ln.toLowerCase()
  const nn = typeof node.nodeName === 'string' ? node.nodeName : ''
  const idx = nn.indexOf(':')
  return (idx >= 0 ? nn.slice(idx + 1) : nn).toLowerCase()
}

function childElements(el: AnyNode): AnyNode[] {
  const out: AnyNode[] = []
  const nodes = el.childNodes
  if (!nodes) return out
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]
    if (n && n.nodeType === 1) out.push(n)
  }
  return out
}

function childrenNamed(el: AnyNode, name: string): AnyNode[] {
  const want = name.toLowerCase()
  return childElements(el).filter((c) => localNameOf(c) === want)
}

function firstNamed(el: AnyNode, name: string): AnyNode | null {
  const list = childrenNamed(el, name)
  return list.length > 0 ? (list[0] as AnyNode) : null
}

function textOf(el: AnyNode | null | undefined): string {
  if (!el) return ''
  const t = el.textContent
  return typeof t === 'string' ? t : ''
}

function attrOf(el: AnyNode | null | undefined, name: string): string | null {
  if (!el || typeof el.getAttribute !== 'function') return null
  try {
    const v = el.getAttribute(name)
    return typeof v === 'string' && v.length > 0 ? v : null
  } catch {
    return null
  }
}

// ── 文本处理 ────────────────────────────────────────────────────

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const num = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return whole
      try {
        return String.fromCodePoint(num)
      } catch {
        return whole
      }
    }
    const mapped = ENTITY_MAP[body.toLowerCase()]
    return mapped === undefined ? whole : mapped
  })
}

/** 折叠所有空白为单个空格并去首尾（description 输出用） */
function collapseToLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/** 把 HTML 字符串转成纯文本（块级标签产生分隔，行内标签直接删除） */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  let s = html
  // 先去注释与整段无语义内容
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\s*(script|style|noscript|iframe|object|embed|svg|canvas|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
  // 再把剩余标签替换为分隔或空
  s = s.replace(/<[^>]*>/g, (tag: string) => {
    const m = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag)
    const name = m && m[1] ? m[1].toLowerCase() : ''
    return BLOCK_TAGS.has(name) ? '\n' : ''
  })
  s = decodeEntities(s)
  return collapseToLine(s)
}

/** 从 XHTML 子树里提取纯文本：块级元素插入分隔，跳过脚本/媒体子树 */
function xhtmlToPlainText(root: AnyNode): string {
  const walk = (node: AnyNode | null | undefined): string => {
    if (!node) return ''
    const type = node.nodeType
    if (type === 3 || type === 4) {
      const v = node.nodeValue
      return typeof v === 'string' ? v : ''
    }
    if (type !== 1) return ''
    const name = localNameOf(node)
    if (SKIP_TEXT_TAGS.has(name)) return ''
    let inner = ''
    const nodes = node.childNodes
    if (nodes) {
      for (let i = 0; i < nodes.length; i += 1) {
        inner += walk(nodes[i])
      }
    }
    return BLOCK_TAGS.has(name) ? inner + '\n' : inner
  }

  const children = childElements(root)
  const parts = children.length > 0 ? children.map((c) => walk(c)) : [walk(root)]
  return collapseToLine(decodeEntities(parts.join('')))
}

function truncate(input: string, max: number): string {
  return input.length > max ? input.slice(0, max) : input
}

function isHttpUrl(value: string | null): value is string {
  if (!value) return false
  return /^https?:\/\//i.test(value.trim())
}

// ── 字段解析 ────────────────────────────────────────────────────

function parsePubDate(raw: string): Date | null {
  const s = raw.trim()
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseDuration(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums: number[] = []
  for (const p of parts) {
    const t = p.trim()
    if (!/^\d+$/.test(t)) return null
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    nums.push(n)
  }
  const len = nums.length
  const a = len === 3 ? (nums[0] as number) : 0
  const b = len === 3 ? (nums[1] as number) : (nums[0] as number)
  const c = len === 3 ? (nums[2] as number) : (nums[1] as number)
  const total = a * 3600 + b * 60 + c
  return total > 0 ? total : null
}

/** 按类型从 Atom <content> 提取纯文本；不支持的形式返回 null 由调用方回退 */
function extractAtomContent(contentEl: AnyNode): { text: string | null; unsupported: boolean } {
  const src = attrOf(contentEl, 'src')
  if (src) return { text: null, unsupported: true } // 外链正文不抓取

  const rawType = attrOf(contentEl, 'type')
  const type = (rawType === null ? 'text' : rawType).trim().toLowerCase()

  if (type === 'text' || type === 'text/plain') {
    return { text: collapseToLine(decodeEntities(textOf(contentEl))), unsupported: false }
  }
  if (type === 'html' || type === 'text/html') {
    // 内容以纯文本形式给出 HTML 源码
    return { text: htmlToPlainText(textOf(contentEl)), unsupported: false }
  }
  if (type === 'xhtml' || type === 'application/xhtml+xml') {
    // 内容以内嵌 XHTML 元素给出
    return { text: xhtmlToPlainText(contentEl), unsupported: false }
  }
  // 二进制/其它 MIME：不当作正文
  return { text: null, unsupported: true }
}

// ── 主流程 ──────────────────────────────────────────────────────

interface WarningCounter {
  bump: (code: RssParseWarningCode) => void
  result: () => RssParseWarning[]
}

function createWarningCounter(): WarningCounter {
  const map = new Map<RssParseWarningCode, number>()
  return {
    bump(code) {
      map.set(code, (map.get(code) ?? 0) + 1)
    },
    result() {
      return Array.from(map.entries()).map(([code, count]) => ({ code, count }))
    },
  }
}

function buildEpisode(
  el: AnyNode,
  index: number,
  format: 'rss2' | 'atom',
  warnings: WarningCounter,
): RssEpisode {
  const titleEl = firstNamed(el, 'title')
  const title = collapseToLine(decodeEntities(textOf(titleEl)))
  if (!title) warnings.bump('MISSING_TITLE')

  // 简介：RSS description → content:encoded；Atom summary → content
  let descriptionRaw = ''
  if (format === 'rss2') {
    const desc = firstNamed(el, 'description')
    const encoded = firstNamed(el, 'encoded')
    descriptionRaw = htmlToPlainText(textOf(desc)) || htmlToPlainText(textOf(encoded))
  } else {
    // summary 优先；但无论是否用上 content，都要检查它是否属于不支持的形式并记录下来，
    // 否则「未支持的内容形式」会被静默忽略。
    const summary = firstNamed(el, 'summary')
    const summaryText = htmlToPlainText(textOf(summary))

    let contentText = ''
    const content = firstNamed(el, 'content')
    if (content) {
      const extracted = extractAtomContent(content)
      if (extracted.unsupported) warnings.bump('UNSUPPORTED_CONTENT_TYPE')
      if (extracted.text) contentText = extracted.text
    }

    descriptionRaw = summaryText || contentText
  }
  const description = truncate(descriptionRaw, MAX_DESCRIPTION_CHARS)

  // 时间
  let publishedAt: Date | null = null
  if (format === 'rss2') {
    const raw = textOf(firstNamed(el, 'pubDate'))
    if (raw.trim()) {
      publishedAt = parsePubDate(raw)
      if (!publishedAt) warnings.bump('INVALID_DATE')
    }
  } else {
    const candidates = ['published', 'updated']
    for (const name of candidates) {
      const raw = textOf(firstNamed(el, name))
      if (raw.trim()) {
        publishedAt = parsePubDate(raw)
        if (!publishedAt) warnings.bump('INVALID_DATE')
        break
      }
    }
  }

  // 时长
  const durationSeconds = parseDuration(textOf(firstNamed(el, 'duration')))

  // 音频
  let audioUrl: string | null = null
  if (format === 'rss2') {
    const enclosures = childrenNamed(el, 'enclosure')
    const audioFirst = enclosures.find((e) => (attrOf(e, 'type') ?? '').toLowerCase().startsWith('audio/'))
    const chosen = audioFirst ?? enclosures[0] ?? null
    const url = attrOf(chosen, 'url')
    audioUrl = isHttpUrl(url) ? url.trim() : null
  } else {
    const links = childrenNamed(el, 'link')
    const enclosureLink = links.find((l) => (attrOf(l, 'rel') ?? '').toLowerCase() === 'enclosure')
    const href = attrOf(enclosureLink ?? null, 'href')
    audioUrl = isHttpUrl(href) ? href.trim() : null
  }
  if (!audioUrl) warnings.bump('NO_AUDIO_URL')

  // 链接
  let link: string | null = null
  if (format === 'rss2') {
    const l = attrOf(firstNamed(el, 'link'), 'href') ?? textOf(firstNamed(el, 'link')).trim()
    link = isHttpUrl(l) ? l : null
  } else {
    const links = childrenNamed(el, 'link')
    const alt = links.find((l) => {
      const rel = (attrOf(l, 'rel') ?? '').toLowerCase()
      return rel === '' || rel === 'alternate'
    })
    const href = attrOf(alt ?? null, 'href')
    link = isHttpUrl(href) ? href.trim() : null
  }

  // guid / id
  const guidRaw = format === 'rss2' ? textOf(firstNamed(el, 'guid')).trim() : textOf(firstNamed(el, 'id')).trim()
  const guid = guidRaw ? guidRaw : null

  const id = guid ?? audioUrl ?? `ep-${index}-${title}`

  return { id, title, description, publishedAt, durationSeconds, audioUrl, link, guid }
}

function parseRss2(doc: Document, maxEpisodes: number, warnings: WarningCounter): RssFeed {
  const root = doc.documentElement as unknown as AnyNode
  const channel = firstNamed(root, 'channel')
  if (!channel) throw parseError('MISSING_CHANNEL')

  const title = collapseToLine(decodeEntities(textOf(firstNamed(channel, 'title'))))
  const descRaw =
    textOf(firstNamed(channel, 'description')) || textOf(firstNamed(channel, 'summary'))
  const description = truncate(htmlToPlainText(descRaw), MAX_DESCRIPTION_CHARS)

  const author =
    collapseToLine(decodeEntities(textOf(firstNamed(channel, 'author')))) ||
    collapseToLine(decodeEntities(textOf(firstNamed(channel, 'managingEditor')))) ||
    null

  // 封面：itunes:image 带 href；标准 image > url
  let imageUrl: string | null = null
  for (const img of childrenNamed(channel, 'image')) {
    const href = attrOf(img, 'href')
    if (isHttpUrl(href)) {
      imageUrl = href.trim()
      break
    }
  }
  if (!imageUrl) {
    for (const img of childrenNamed(channel, 'image')) {
      const url = textOf(firstNamed(img, 'url')).trim()
      if (isHttpUrl(url)) {
        imageUrl = url
        break
      }
    }
  }

  const linkText = textOf(firstNamed(channel, 'link')).trim()
  const link = isHttpUrl(linkText) ? linkText : null

  const items = childrenNamed(channel, 'item')
  const totalEpisodes = items.length
  const episodes = items.map((item, i) => buildEpisode(item, i, 'rss2', warnings))

  episodes.sort((a, b) => {
    const ta = a.publishedAt ? a.publishedAt.getTime() : Number.NEGATIVE_INFINITY
    const tb = b.publishedAt ? b.publishedAt.getTime() : Number.NEGATIVE_INFINITY
    return tb - ta
  })

  return {
    format: 'rss2',
    title,
    description,
    author,
    imageUrl,
    link,
    episodes: episodes.slice(0, maxEpisodes),
    totalEpisodes,
  }
}

function parseAtom(doc: Document, maxEpisodes: number, warnings: WarningCounter): RssFeed {
  const root = doc.documentElement as unknown as AnyNode

  const title = collapseToLine(decodeEntities(textOf(firstNamed(root, 'title'))))
  const subtitle = textOf(firstNamed(root, 'subtitle'))
  const description = truncate(htmlToPlainText(subtitle), MAX_DESCRIPTION_CHARS)

  let author: string | null = null
  const authorEl = firstNamed(root, 'author')
  if (authorEl) {
    const name = collapseToLine(decodeEntities(textOf(firstNamed(authorEl, 'name'))))
    author = name || null
  }

  let imageUrl: string | null = null
  for (const name of ['logo', 'icon']) {
    const raw = textOf(firstNamed(root, name)).trim()
    if (isHttpUrl(raw)) {
      imageUrl = raw
      break
    }
  }

  let link: string | null = null
  for (const l of childrenNamed(root, 'link')) {
    const rel = (attrOf(l, 'rel') ?? '').toLowerCase()
    if (rel === '' || rel === 'alternate') {
      const href = attrOf(l, 'href')
      if (isHttpUrl(href)) {
        link = href.trim()
        break
      }
    }
  }

  const entries = childrenNamed(root, 'entry')
  const totalEpisodes = entries.length
  const episodes = entries.map((entry, i) => buildEpisode(entry, i, 'atom', warnings))

  episodes.sort((a, b) => {
    const ta = a.publishedAt ? a.publishedAt.getTime() : Number.NEGATIVE_INFINITY
    const tb = b.publishedAt ? b.publishedAt.getTime() : Number.NEGATIVE_INFINITY
    return tb - ta
  })

  return {
    format: 'atom',
    title,
    description,
    author,
    imageUrl,
    link,
    episodes: episodes.slice(0, maxEpisodes),
    totalEpisodes,
  }
}

/**
 * 解析 RSS 2.0 / Atom。
 * **永不 throw**；失败返回结构化错误，绝不含部分 feed 数据。
 */
export function parseRss(xml: string, options: RssParseOptions = {}): RssParseResult {
  try {
    if (typeof xml !== 'string') {
      return { ok: false, code: 'EMPTY_INPUT', message: ERROR_MESSAGES.EMPTY_INPUT }
    }
    const input = xml.replace(/^\uFEFF/, '').trim()
    if (input.length === 0) {
      return { ok: false, code: 'EMPTY_INPUT', message: ERROR_MESSAGES.EMPTY_INPUT }
    }

    const maxEpisodes =
      typeof options.maxEpisodes === 'number' && options.maxEpisodes > 0
        ? Math.floor(options.maxEpisodes)
        : MAX_EPISODES

    // ── 解析器：只用默认实现或显式注入，不降级 ──
    const injected = options.createDocument
    if (injected !== undefined && typeof injected !== 'function') {
      return { ok: false, code: 'PARSER_UNAVAILABLE', message: ERROR_MESSAGES.PARSER_UNAVAILABLE }
    }
    const createDocument: CreateDocument = injected ?? defaultCreateDocument

    let doc: Document
    try {
      doc = createDocument(input)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      return code === 'PARSER_UNAVAILABLE'
        ? { ok: false, code: 'PARSER_UNAVAILABLE', message: ERROR_MESSAGES.PARSER_UNAVAILABLE }
        : { ok: false, code: 'MALFORMED_XML', message: ERROR_MESSAGES.MALFORMED_XML }
    }

    if (!doc || typeof doc !== 'object') {
      return { ok: false, code: 'PARSER_UNAVAILABLE', message: ERROR_MESSAGES.PARSER_UNAVAILABLE }
    }

    const docNode = doc as unknown as AnyNode & {
      documentElement?: AnyNode | null
      getElementsByTagName?: (name: string) => ArrayLike<AnyNode>
    }

    // 第二层：Chromium 对畸形 XML 会给出 parsererror 文档
    let hasParserError = false
    try {
      if (typeof docNode.getElementsByTagName === 'function') {
        hasParserError = docNode.getElementsByTagName('parsererror').length > 0
      }
    } catch {
      hasParserError = false
    }
    if (!hasParserError) {
      const de = docNode.documentElement
      if (de && localNameOf(de) === 'parsererror') hasParserError = true
    }
    if (hasParserError) {
      return { ok: false, code: 'MALFORMED_XML', message: ERROR_MESSAGES.MALFORMED_XML }
    }

    // 第三层：根元素判定
    const rootEl = docNode.documentElement
    if (!rootEl) {
      return { ok: false, code: 'MALFORMED_XML', message: ERROR_MESSAGES.MALFORMED_XML }
    }
    const rootName = localNameOf(rootEl)
    if (rootName !== 'rss' && rootName !== 'feed') {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', message: ERROR_MESSAGES.UNSUPPORTED_FORMAT }
    }

    const warnings = createWarningCounter()
    const feed = rootName === 'rss' ? parseRss2(doc, maxEpisodes, warnings) : parseAtom(doc, maxEpisodes, warnings)

    return { ok: true, feed, warnings: warnings.result() }
  } catch (err) {
    // 已结构化的错误（如 MISSING_CHANNEL）按原码返回，其余归为 INTERNAL_ERROR
    const code = (err as { code?: unknown } | null)?.code
    if (
      code === 'EMPTY_INPUT' ||
      code === 'MALFORMED_XML' ||
      code === 'UNSUPPORTED_FORMAT' ||
      code === 'MISSING_CHANNEL' ||
      code === 'PARSER_UNAVAILABLE'
    ) {
      return { ok: false, code, message: ERROR_MESSAGES[code] }
    }
    return { ok: false, code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR }
  }
}
