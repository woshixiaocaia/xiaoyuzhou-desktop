'use strict'

/**
 * RSS 抓取与 URL 校验（主进程专用）。
 *
 * ── 安全边界（务必阅读，不要夸大）────────────────────────────────
 * 本模块提供的是「主机层 + 逐跳重定向 + 体积/超时硬限制」防护，
 * **不是**完整的 SSRF 防护：
 *   - 请求走 Chromium 网络栈（net.request），会使用系统代理。
 *     因此代理背后的**真实连接目标 IP 无法由本应用观测或校验**。
 *   - DNS 重绑定无法防护；且本机环境使用 fake-IP DNS（域名解析到 198.18.0.x），
 *     解析结果对"是否公网"没有任何判断价值，所以这里**刻意不基于 DNS 做公网门禁**。
 *   - 能可靠做到的：协议白名单、拒绝 userinfo、IP 字面量与本地主机名拦截、
 *     每一跳重定向重新校验、15 秒总超时、16 MiB 流式硬限制。
 *
 * 说明：198.18.0.0/15 是需要**拒绝**的特殊地址段（IP 字面量场景），
 * 绝不可作为公网白名单使用。
 */

// 注意区分两个 net：
//   nodeNet  = Node 内置网络工具（isIP / BlockList），用于地址分类
//   electronNet = Electron 的 Chromium 网络栈（net.request），才会走系统代理
// 两者名字相同但完全不是一个东西，混用会导致 net.request 不存在。
const nodeNet = require('node:net')
const { net: electronNet } = require('electron')

const MAX_URL_LENGTH = 2048
const MAX_REDIRECTS = 5
const TOTAL_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 16 * 1024 * 1024
const SNIFF_HEAD_CHARS = 4096

/** 固定错误码 → 固定中文提示（对外只暴露这些，不透传内部异常或响应正文） */
const ERROR_MESSAGES = {
  INVALID_URL: '地址格式无效，请输入以 http:// 或 https:// 开头的链接',
  BLOCKED_TARGET: '该地址指向本机或内网，已按安全策略拒绝',
  TOO_MANY_REDIRECTS: '重定向次数过多（最多 5 次），已停止',
  TIMEOUT: '请求超时（15 秒），请检查网络或代理设置',
  HTTP_STATUS: '服务器返回了错误状态码',
  TOO_LARGE: '订阅源超过 16 MiB 上限，已停止读取',
  NOT_XML: '该地址返回的不是 RSS/Atom 订阅源',
  NETWORK_ERROR: '网络请求失败，请检查网络或代理设置',
}

function rssError(code, httpStatus) {
  const err = new Error(ERROR_MESSAGES[code] || '请求失败')
  err.code = code
  if (httpStatus !== undefined) err.httpStatus = httpStatus
  return err
}

/** 调试日志：只输出脱敏主机名与结果码，不输出路径参数、正文、凭据 */
function debugLog(fields) {
  if (process.env.RSS_DEBUG !== '1') return
  try {
    console.log('[rss-fetch]', JSON.stringify(fields))
  } catch {
    /* 忽略日志失败 */
  }
}

// ── 特殊用途网段 ────────────────────────────────────────────────
const BLOCKED_V4 = new nodeNet.BlockList()
const V4_RANGES = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档示例
  ['192.88.99.0', 24], // 6to4 中继（已废弃）
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试（本机代理 fake-IP 亦在此段，仅用于拒绝）
  ['198.51.100.0', 24], // 文档示例
  ['203.0.113.0', 24], // 文档示例
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255）
]
for (const [addr, prefix] of V4_RANGES) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4')

const BLOCKED_V6 = new nodeNet.BlockList()
const V6_RANGES = [
  ['::', 8], // 覆盖 ::、::1、IPv4-compatible 及 ::ffff:0:0/96 映射地址
  ['100::', 64], // 丢弃前缀
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // 基准测试
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // 文档示例
  ['2002::', 16], // 6to4
  ['3fff::', 20], // 文档示例（RFC 9637）
  ['5f00::', 16], // SRv6 SID
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // 唯一本地
  ['fe80::', 10], // 链路本地
  ['ff00::', 8], // 组播
]
for (const [addr, prefix] of V6_RANGES) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6')

/** 本地/内网常用主机名后缀（纯字符串判定，不做 DNS） */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'corp',
  'metadata.google.internal',
  'metadata',
]

/** IPv4-mapped IPv6 的规范化形式（如 ::ffff:7f00:1） */
const MAPPED_V6_RE = /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i

/**
 * 校验并规范化 URL。通过则返回 WHATWG URL 对象；否则抛出带 code 的错误。
 * 纯函数：不联网、不做 DNS 查询。
 */
function assertAllowedUrl(raw) {
  if (typeof raw !== 'string') throw rssError('INVALID_URL')
  const input = raw.trim()
  if (input.length === 0 || input.length > MAX_URL_LENGTH) throw rssError('INVALID_URL')

  let url
  try {
    // 必须用 WHATWG 归一化：它会把 2130706433 / 0x7f000001 / 0177.0.0.1 / 127.1
    // 等各种 IPv4 特殊写法统一还原成点分十进制，否则按字符串判断会被绕过。
    url = new URL(input)
  } catch {
    throw rssError('INVALID_URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw rssError('INVALID_URL')
  if (url.username !== '' || url.password !== '') throw rssError('INVALID_URL')

  const host = url.hostname
  if (host === '') throw rssError('INVALID_URL')

  // WHATWG URL 对 IPv6 字面量保留方括号（如 "[::1]"），而 net.isIP("[::1]") 返回 0，
  // 不剥方括号会被误判为域名而漏过检查。
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  const ipVersion = nodeNet.isIP(bareHost)

  if (ipVersion === 4) {
    if (BLOCKED_V4.check(bareHost, 'ipv4')) throw rssError('BLOCKED_TARGET')
    return url
  }

  if (ipVersion === 6) {
    // IPv4-mapped IPv6 一律拒绝（不做解映射放行，保守处理）
    if (MAPPED_V6_RE.test(bareHost)) throw rssError('BLOCKED_TARGET')
    if (BLOCKED_V6.check(bareHost, 'ipv6')) throw rssError('BLOCKED_TARGET')
    return url
  }

  const lowerHost = bareHost.toLowerCase().replace(/\.+$/, '')
  if (lowerHost === '') throw rssError('INVALID_URL')

  // 单标签主机名（如 intranet、router）不是公网 FQDN，保守拒绝
  if (!lowerHost.includes('.')) throw rssError('BLOCKED_TARGET')

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (lowerHost === suffix || lowerHost.endsWith('.' + suffix)) throw rssError('BLOCKED_TARGET')
  }

  return url
}

// ── 字符集处理 ──────────────────────────────────────────────────
const ALLOWED_CHARSETS = new Set([
  'utf-8',
  'utf8',
  'gbk',
  'gb18030',
  'gb2312',
  'big5',
  'big5-hkscs',
  'iso-8859-1',
  'windows-1252',
  'shift_jis',
  'euc-jp',
  'euc-kr',
])

/**
 * 探测编码：BOM → HTTP charset → XML 声明 → 回退 UTF-8。
 * 只接受白名单内的标签，避免信任任意来源的异常编码标签。
 */
function detectCharset(buffer, contentTypeHeader) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8'
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le'
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be'

  const headerMatch = /charset\s*=\s*"?([^\s;"]+)"?/i.exec(contentTypeHeader || '')
  if (headerMatch && headerMatch[1]) {
    const label = headerMatch[1].toLowerCase()
    if (ALLOWED_CHARSETS.has(label)) return label
  }

  const head = buffer.subarray(0, 200).toString('latin1')
  const declMatch = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)
  if (declMatch && declMatch[1]) {
    const label = declMatch[1].toLowerCase()
    if (ALLOWED_CHARSETS.has(label)) return label
  }

  return 'utf-8'
}

function decodeBuffer(buffer, contentTypeHeader) {
  const charset = detectCharset(buffer, contentTypeHeader)
  let text
  try {
    text = new TextDecoder(charset).decode(buffer)
  } catch {
    text = new TextDecoder('utf-8').decode(buffer)
  }
  // 去掉可能残留的 BOM 字符
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 仅做"像不像订阅源"的特征检查，**不等于完整的 XML/RSS 语法校验**。
 * 真正的解析在渲染进程（阶段 2/3）进行。
 */
function looksLikeFeed(text) {
  const head = text.slice(0, SNIFF_HEAD_CHARS)
  if (/<!doctype\s+html/i.test(head)) return false
  if (/<html[\s>]/i.test(head)) return false
  return /<(rss|feed)[\s>]/i.test(head)
}

// ── 单次请求 ────────────────────────────────────────────────────
/**
 * 发一次 GET。不做重定向跟随（redirect: 'manual'），遇到重定向就结算并交给调用方。
 * @returns {Promise<{kind:'redirect', location:string, statusCode:number} | {kind:'response', status:number, headers:object, buffer:Buffer, bytes:number}>}
 */
function requestOnce(urlObj, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      reject(rssError('TIMEOUT'))
      return
    }

    const chunks = []
    let totalBytes = 0
    let settled = false
    let timer = null
    let res = null

    const req = electronNet.request({
      url: urlObj.toString(),
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
      },
    })

    /** 统一结算点：先置 settled 并摘掉监听，再执行中止动作，避免二次结算 */
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      req.removeAllListeners()
      if (res) res.removeAllListeners()
      try {
        fn(value)
      } finally {
        // 结算后立即释放底层资源
        try {
          req.abort()
        } catch {
          /* 已经结束时会抛，忽略 */
        }
      }
    }

    const fail = (err) => settle(reject, err)
    const ok = (value) => settle(resolve, value)
    const abortQuietly = () => {
      try {
        req.abort()
      } catch {
        /* 忽略 */
      }
      try {
        if (res) res.destroy()
      } catch {
        /* 忽略 */
      }
    }

    // 总超时：覆盖连接、重定向与响应体读取（重定向共用同一个 deadline）
    timer = setTimeout(() => {
      abortQuietly()
      fail(rssError('TIMEOUT'))
    }, remaining)

    req.on('redirect', (statusCode, _method, location) => {
      ok({ kind: 'redirect', location: typeof location === 'string' ? location : '', statusCode })
    })

    req.on('response', (response) => {
      res = response
      const status = response.statusCode

      if (status < 200 || status >= 300) {
        ok({ kind: 'status', status })
        return
      }

      // Content-Length 仅用于"提前拒绝"，它可能是压缩后的长度（不可靠），
      // 因此不能作为唯一判据 —— 真正的判据是下面的流式计数。
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        ok({ kind: 'toolarge' })
        return
      }

      response.on('data', (chunk) => {
        if (settled) return
        totalBytes += chunk.length
        if (totalBytes > MAX_BODY_BYTES) {
          ok({ kind: 'toolarge' })
          return
        }
        chunks.push(chunk)
      })

      response.on('end', () => {
        ok({ kind: 'response', status, headers: response.headers, buffer: Buffer.concat(chunks), bytes: totalBytes })
      })

      response.on('error', () => fail(rssError('NETWORK_ERROR')))
    })

    req.on('error', () => fail(rssError('NETWORK_ERROR')))
    req.end()
  })
}

// ── 对外主函数 ──────────────────────────────────────────────────
/**
 * 抓取并粗校验一个 RSS/Atom 源。
 * 永不抛异常；失败时返回固定错误码与固定中文提示。
 */
async function fetchRss(rawUrl) {
  const started = Date.now()
  const deadline = started + TOTAL_TIMEOUT_MS
  let hostForLog = ''

  try {
    let current = assertAllowedUrl(rawUrl)
    hostForLog = current.hostname
    const originalUrl = current.toString()

    let hops = 0
    for (;;) {
      const result = await requestOnce(current, deadline)

      if (result.kind === 'redirect') {
        if (!result.location) throw rssError('HTTP_STATUS', result.statusCode)
        if (hops >= MAX_REDIRECTS) throw rssError('TOO_MANY_REDIRECTS')

        let nextUrl
        try {
          // 相对 Location 由 URL 构造器解析为绝对地址（Electron 的 redirect 事件
          // 实际已经给出绝对地址，这里再解析一次以兼容两种行为）
          nextUrl = new URL(result.location, current)
        } catch {
          throw rssError('INVALID_URL')
        }

        // 关键：每一跳都必须重新校验，不能只校验首个 URL
        current = assertAllowedUrl(nextUrl.toString())
        hops += 1
        continue
      }

      if (result.kind === 'status') throw rssError('HTTP_STATUS', result.status)
      if (result.kind === 'toolarge') throw rssError('TOO_LARGE')

      const contentType = String(result.headers['content-type'] || '')
      if (/text\/html/i.test(contentType)) throw rssError('NOT_XML')

      const text = decodeBuffer(result.buffer, contentType)
      if (!looksLikeFeed(text)) throw rssError('NOT_XML')

      debugLog({
        host: hostForLog,
        hops,
        status: result.status,
        bytes: result.bytes,
        ms: Date.now() - started,
        result: 'ok',
      })

      return {
        ok: true,
        url: originalUrl,
        finalUrl: current.toString(),
        contentType,
        bytes: result.bytes,
        text,
      }
    }
  } catch (err) {
    const code = err && typeof err.code === 'string' && ERROR_MESSAGES[err.code] ? err.code : 'NETWORK_ERROR'
    const failure = { ok: false, code, message: ERROR_MESSAGES[code] }
    if (err && err.httpStatus !== undefined) failure.httpStatus = err.httpStatus

    debugLog({
      host: hostForLog,
      code,
      httpStatus: failure.httpStatus,
      ms: Date.now() - started,
      result: 'fail',
    })

    return failure
  }
}

module.exports = {
  assertAllowedUrl,
  fetchRss,
  rssError,
  ERROR_MESSAGES,
  MAX_URL_LENGTH,
  MAX_REDIRECTS,
  TOTAL_TIMEOUT_MS,
  MAX_BODY_BYTES,
}
