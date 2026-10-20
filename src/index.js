'use strict'

/**
 * 标题轮盘（title-wheel）—— DSH 宿主侧插件
 *
 * 三件事：
 * 1. **接管会话标题槽位**：注册唯一的 `sessionTitle` provider，用模型把整段对话
 *    总结成一行标题。槽位全局只允许一个提供方，所以 cordis.patch.yml 里把两个
 *    官方实现都停掉了 —— 我们不"避开"冲突，而是独占它。
 * 2. **时间轮盘编号**：按会话创建时间算出两位编号（见 code.js），经
 *    `/title-wheel/api/sessions` 交给客户端，由客户端用 CSS `::before` 挂在标题
 *    前面。编号不进标题数据，所以模型怎么改写标题都影响不到它。
 * 3. **HTTP 端点**：设置页读写配置、客户端拉编号、手动回填历史标题。
 *
 * 依赖策略：**只用 `ctx.*` 服务，不 import 任何 @deepseek-ai 包**。
 * 本插件以 link 方式装在 profile 之外，从插件目录往上找不到宿主的
 * node_modules（宿主是 Electron，模块压在 app.asar 里），裸 import 必失败。
 * 因此消息对象、chunk 归并都在本地实现——它们只是普通对象与机械累加。
 *
 * @module title-wheel
 */

const { randomUUID } = require('node:crypto')

const { sessionCode } = require('./code')
const { DEFAULT_CONFIG, configFile, readConfig, writeConfig, sanitize } = require('./config')
const { fallbackTitle, cleanTitle, systemPrompt } = require('./prompt')
const {
  collectTranscript,
  eventsOf,
  firstUserText,
  frameTranscript,
  trimTranscriptItems
} = require('./transcript')

const PLUGIN_ID = 'title-wheel'
const PROVIDER_ID = 'title-wheel'
const API_PREFIX = '/title-wheel/api'

/** HTTP 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 回填：一次最多刷新多少条会话。 */
const BACKFILL_MAX_SESSIONS = 20

/** 回填：两条之间的间隔，避免瞬间打满模型并发。 */
const BACKFILL_SPACING_MS = 500

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 安全取一个可选服务。
 *
 * cordis 的 `inject` 里写进去的依赖是**激活前置条件**（凑不齐插件就停在 pending，
 * 一声不响地不加载），所以可选服务不能写进 inject，只能按需取。又因为 cordis 的
 * 上下文是个 Proxy，直接 `ctx.sessions` 在没 inject 的情况下会抛
 * `cannot get property "sessions" without inject`，必须走 `ctx.get(name)`
 * ——它按文档就是"Read a service from the store without the inject requirement"，
 * 没提供时返回 undefined。
 *
 * @param {object} ctx 插件上下文。
 * @param {string} name 服务名。
 * @returns {any} 服务实例或 undefined。
 */
function serviceOf(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    // ctx.get 不存在或运行时未就绪：退回直接取属性
  }
  try {
    return ctx ? ctx[name] : undefined
  } catch {
    return undefined
  }
}

/**
 * 深冻结。宿主会把消息对象当作不可变值（服务层可能 freeze 校验），
 * 这里保持一致，避免下游意外改写我们的输入。
 * @param {any} value 任意值。
 * @returns {any} 同一个值。
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 本地构造一条 user 消息。
 *
 * 形状对齐 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * `{ id, role: 'user', content: [{type:'text', text}], source: {kind:'plugin', plugin} }`。
 * 不 import 那个包，是为了让插件在任意 profile / 打包形态下都能起来（见文件头）。
 *
 * @param {string} text 消息正文。
 * @returns {object} 冻结的 user 消息。
 */
function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID }
  })
}

/**
 * 增量归并流式 chunk，只关心「文本」和「结束原因」。
 *
 * 比官方的 BlockAssembler 少很多分支：标题只有一段文本，不需要 tool-call
 * 参数拼接、replay 元数据、max-tokens 裁剪。未知 chunk 类型直接忽略——
 * 适配器多吐一种事件不该让整次生成失败。
 */
class ChunkAssembler {
  constructor() {
    this.text = ''
    this.hasToolCall = false
    this.finish = { kind: 'stop' }
  }

  /**
   * 吃一个 chunk。
   * @param {object} chunk 流式事件。
   */
  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') this.text += chunk.text
        break
      case 'block-end': {
        const block = chunk.block
        if (block && block.type === 'tool-call') this.hasToolCall = true
        if (block && block.type === 'text' && !this.text && typeof block.text === 'string') this.text = block.text
        break
      }
      case 'tool-call-delta':
        this.hasToolCall = true
        break
      case 'finish':
        if (chunk.reason && typeof chunk.reason.kind === 'string') this.finish = chunk.reason
        break
      default:
        break
    }
  }
}

/** 归一化标题，用于"同题跳过"比较。 */
function normalizeTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 两个标题是否实质相同。 */
function sameTitle(a, b) {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  return left.length > 0 && left === right
}

/** 取会话 id 与创建时间，兼容 header 包一层与直接挂字段两种形状。 */
function sessionMeta(session) {
  const header = (session && session.header) || session || {}
  const id = typeof header.id === 'string' ? header.id : session && typeof session.id === 'string' ? session.id : ''
  const rawCreated = header.createdAt !== undefined ? header.createdAt : session && session.createdAt
  const createdAt = Number(rawCreated)
  return { id, createdAt: Number.isFinite(createdAt) ? createdAt : 0 }
}

/** 取"活着的会话"（宿主未挂 sessions 服务时返回空数组）。 */
function listLiveSessions(ctx) {
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions && typeof sessions.list === 'function') {
      const list = sessions.list()
      if (Array.isArray(list)) return list
    }
  } catch {
    // 会话服务尚未就绪：本轮没有编号可发，客户端下次轮询会补上
  }
  return []
}

/**
 * 取**全部**会话的元信息（含磁盘上没打开的），`[{id, createdAt}]`。
 *
 * 侧栏列的是历史全量会话，`sessions.list()` 只给本进程里活着的那些
 * （`dsh-session/lib/index.js` 的 `list()` = store 里的条目），拿它发编号会让
 * 重启后除当前会话外的行全都没有编号。`sessionQuery.listSessions()` 才是
 * "live + persisted 的完整语料"，记录形状 `{header:{id, createdAt, cwd, …}, live, persisted}`，
 * 按 createdAt 倒序返回。没有该服务时退回活会话。
 *
 * @param {object} ctx 插件上下文。
 * @returns {Promise<Array<{id:string, createdAt:number}>>} 会话元信息。
 */
async function listSessionMeta(ctx) {
  const query = serviceOf(ctx, 'sessionQuery')
  if (query && typeof query.listSessions === 'function') {
    try {
      const records = await query.listSessions()
      if (Array.isArray(records)) {
        return records
          .map((record) => {
            const header = (record && record.header) || {}
            const createdAt = Number(header.createdAt)
            return { id: typeof header.id === 'string' ? header.id : '', createdAt: Number.isFinite(createdAt) ? createdAt : 0 }
          })
          .filter((item) => item.id)
      }
    } catch {
      // 语料读取失败（持久化后端异常）：退回活会话，编号只覆盖当前进程
    }
  }
  return listLiveSessions(ctx).map((session) => sessionMeta(session)).filter((item) => item.id)
}

/**
 * 取"当前标题快照"：`{title, messageSeqs, source}`。
 *
 * 优先用 provider 请求里带的那份（服务已经按日志折叠好），没有再回读服务。
 * @param {object} ctx 插件上下文。
 * @param {object} request provider 请求。
 * @returns {object|null} 快照；没有标题时为 null。
 */
function currentSnapshot(ctx, request) {
  const fromRequest = request && request.currentTitle
  if (fromRequest && typeof fromRequest === 'object' && typeof fromRequest.title === 'string') return fromRequest
  try {
    const snapshot = ctx.sessionTitle.get(request.session)
    if (snapshot && typeof snapshot.title === 'string') return snapshot
  } catch {
    // 快照不可用：当作没有标题
  }
  return null
}

/** 显式路由覆盖优先，否则沿用服务记录的会话路由。 */
function resolveRoute(cfg, request) {
  const provider = typeof cfg.provider === 'string' ? cfg.provider.trim() : ''
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : ''
  if (provider && model) return { provider, model }
  if (request && request.route && request.route.provider && request.route.model) return request.route
  return null
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

/**
 * @param {object} ctx cordis 上下文。
 */
function apply(ctx) {
  /** 每个会话上次生成时间：节流用。进程内即可，重启后重新计。 */
  const lastGenerateAt = new Map()

  /** 回填进度（HTTP 只能先返回"已开始"，进度靠轮询 status）。 */
  const backfill = { running: false, done: 0, total: 0, failed: 0, startedAt: 0, finishedAt: 0 }

  const logger = (() => {
    try {
      const factoryOf = serviceOf(ctx, 'logger')
      return typeof factoryOf === 'function' ? factoryOf(PLUGIN_ID) : null
    } catch {
      return null
    }
  })()
  const warn = (message, detail) => {
    try {
      logger && typeof logger.warn === 'function' ? logger.warn(message, detail) : undefined
    } catch {
      // 日志失败绝不能影响标题生成
    }
  }

  /** 会话是否还在节流窗口内。 */
  const throttled = (sessionId, cfg) => {
    const at = lastGenerateAt.get(sessionId)
    if (!at) return false
    const gap = Number(cfg.minIntervalMs)
    if (!Number.isFinite(gap) || gap <= 0) return false
    return Date.now() - at < gap
  }

  /**
   * 发起一次标题补全并归并结果。
   * @param {object} params 生成参数。
   * @returns {Promise<string>} 标题文本（可能为空）。
   */
  async function streamTitle({ route, maxTokens, system, input, sessionId, signal, timeoutMs }) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const error = new Error(`${PLUGIN_ID}: title request timed out after ${timeoutMs}ms`)
      error.code = 'TITLE_WHEEL_TIMEOUT'
      controller.abort(error)
    }, timeoutMs)
    let combined = controller.signal
    try {
      if (signal && typeof signal.addEventListener === 'function' && typeof AbortSignal.any === 'function') {
        combined = AbortSignal.any([signal, controller.signal])
      }
    } catch {
      combined = controller.signal
    }

    try {
      const messages = [createUserMessage(input)]
      // 首选官方 prepareCall：它负责路由校验、reasoning 选择、附加请求日志。
      // 宿主版本没有这个方法时退回裸 stream（形状与官方 options 一致）。
      let stream
      let base = {}
      if (typeof ctx.llm.prepareCall === 'function') {
        const call = await ctx.llm.prepareCall(
          { provider: route.provider, model: route.model, maxTokens },
          combined,
          (controls) => controls
        )
        base = (call && call.config) || {}
        stream = (options) => call.stream(options)
      } else if (typeof ctx.llm.stream === 'function') {
        stream = (options) => ctx.llm.stream(options)
      } else {
        throw new Error(`${PLUGIN_ID}: llm service exposes neither prepareCall nor stream`)
      }

      const options = {
        ...base,
        provider: base.provider || route.provider,
        model: base.model || route.model,
        maxTokens: base.maxTokens || maxTokens,
        messages,
        system,
        sessionId,
        purpose: 'session-title',
        signal: combined
      }

      const assembler = new ChunkAssembler()
      for await (const chunk of stream(options)) assembler.push(chunk)
      const kind = assembler.finish && assembler.finish.kind
      if (kind === 'error' || kind === 'aborted') {
        const failure = assembler.finish.failure || {}
        throw new Error(`${PLUGIN_ID}: title stream finished with "${kind}"${failure.message ? `: ${failure.message}` : ''}`)
      }
      if (assembler.hasToolCall) throw new Error(`${PLUGIN_ID}: title output must be text only`)
      return assembler.text
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 生成一条标题。任何失败都不抛出：标题是装饰性功能，失败时安静退回到
   * 现有标题 / 首条消息兜底，而不是在侧栏弹一条"生成失败"。
   */
  async function generateTitle(request) {
    const cfg = readConfig()
    const session = request.session
    const meta = sessionMeta(session)
    const messages = Array.isArray(request.messages) ? request.messages : []
    const sourceSeqs = messages.map((message) => message && message.seq).filter((seq) => typeof seq === 'number')
    // 服务端要求 messageSeqs 必须是请求快照里的非空、严格递增子序列，
    // 一条都没有时任何返回都是非法结果 —— 直接抛错，让服务保留它自己的兜底标题。
    if (sourceSeqs.length === 0) throw new Error(`${PLUGIN_ID}: request carries no source messages`)

    const snapshot = currentSnapshot(ctx, request)
    // `fallback` 是服务在 provider 之前塞的临时标题，不能当作"已有标题"而跳过重算，
    // 否则第一条消息之后标题就永远停在那句兜底上了。
    const isFallback = Boolean(snapshot && snapshot.source && snapshot.source.kind === 'fallback')
    const existing = snapshot && !isFallback && typeof snapshot.title === 'string' ? snapshot.title : ''
    const allowedSeqs = new Set(sourceSeqs)
    const events = eventsOf(session)

    /** 统一出口：title 必须非空，messageSeqs 必须来自本次请求快照。 */
    const settle = (title) => {
      const text = String(title || '').trim()
      if (!text) throw new Error(`${PLUGIN_ID}: no usable title for this session`)
      return { title: text, messageSeqs: sourceSeqs.slice(0, 200) }
    }

    // ① 模型标题关闭：保留现有标题；没有标题才用首条用户消息兜底。
    if (cfg.modelTitle !== true) {
      return settle(existing || fallbackTitle(firstUserText(events, allowedSeqs)))
    }

    // ② 节流：窗口内且已有（非兜底）标题 → 原样返回，服务写入同值，侧栏零变化。
    if (existing && throttled(meta.id, cfg)) return settle(existing)

    const items = collectTranscript(events, allowedSeqs, cfg.includeAssistant !== false)
    const fallback = existing || fallbackTitle(firstUserText(events, allowedSeqs))
    if (items.length === 0) return settle(fallback)

    const route = resolveRoute(cfg, request)
    if (!route) {
      warn('no route available for title generation; keeping current title')
      return settle(fallback)
    }

    const trimmed = trimTranscriptItems(items, cfg.maxInputBytes)
    const input = frameTranscript(trimmed)
    lastGenerateAt.set(meta.id, Date.now())

    try {
      const raw = await streamTitle({
        route,
        maxTokens: cfg.maxOutputTokens,
        system: systemPrompt(cfg),
        input,
        sessionId: meta.id,
        signal: request.signal,
        timeoutMs: cfg.timeoutMs
      })
      const title = cleanTitle(raw)
      if (!title) return settle(fallback)
      if (sameTitle(title, existing)) return settle(existing)
      // 只声明真正进了提示词的用户消息，越界的 seq 会被服务判为无效结果。
      const usedSeqs = trimmed.filter((item) => item.role === 'user').map((item) => item.seq)
      return {
        title,
        messageSeqs: usedSeqs.length > 0 ? usedSeqs : sourceSeqs.slice(0, 200)
      }
    } catch (error) {
      warn('title generation failed', String((error && error.message) || error).slice(0, 300))
      // 失败别把已有标题冲掉：只有原本没有标题时才落到兜底。
      return settle(fallback)
    }
  }

  const provider = {
    id: PROVIDER_ID,
    // all-prompts：每次用户发消息后由服务调度重算。我们独占槽位，所以不再自己
    // 订阅 session/event 的 turn/end ——少一套并发控制，重复生成交给节流吸收。
    automatic: 'all-prompts',
    async generate(request) {
      return generateTitle(request)
    }
  }

  ctx.effect(() => ctx.sessionTitle.register(provider), `${PLUGIN_ID}: sessionTitle provider`)

  // ── HTTP ────────────────────────────────────────────────────────────────

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error(`${PLUGIN_ID}: request body exceeds ${MAX_BODY_BYTES} bytes`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  /**
   * 编号表：会话 id → 两位编号。
   * 覆盖历史全量会话（见 listSessionMeta），创建时间缺失的跳过。
   * @returns {Promise<Array<{id:string, code:string}>>} 编号表。
   */
  const sessionCodes = async () => {
    const cfg = readConfig()
    if (!cfg.sessionCode) return []
    const sessions = []
    for (const meta of await listSessionMeta(ctx)) {
      const code = sessionCode(meta.createdAt, cfg)
      if (!code) continue
      sessions.push({ id: meta.id, code })
    }
    return sessions
  }

  const statusPayload = () => ({
    settings: readConfig(),
    defaults: DEFAULT_CONFIG,
    configFile: configFile(),
    codeEnabled: readConfig().sessionCode,
    backfill: { ...backfill }
  })

  /**
   * 回填：把**本进程里活着的会话**立刻重刷一遍标题。
   *
   * 为什么只限活会话：`ctx.sessionTitle.refresh(session)` 内部会校验
   * `ctx.sessions.get(session.id) === session`（`dsh-session-title/lib/index.js`
   * 的 refresh 走 liveEntryFor），磁盘上没打开的会话直接抛错，没法在这里补标题。
   * 历史会话的标题会在它下次收到用户消息时由 `automatic: 'all-prompts'` 自动重算。
   */
  const runBackfill = async () => {
    if (backfill.running) return
    backfill.running = true
    backfill.done = 0
    backfill.failed = 0
    backfill.startedAt = Date.now()
    backfill.finishedAt = 0

    const targets = listLiveSessions(ctx)
      .map((session) => ({ session, meta: sessionMeta(session) }))
      .filter((item) => item.meta.id)
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
      .slice(0, BACKFILL_MAX_SESSIONS)
    backfill.total = targets.length

    for (const target of targets) {
      try {
        // 回填的意义就是绕过节流，否则刚打开开关时会一条都不刷。
        lastGenerateAt.delete(target.meta.id)
        await ctx.sessionTitle.refresh(target.session)
        backfill.done += 1
      } catch (error) {
        backfill.failed += 1
        warn('backfill failed for session', `${target.meta.id}: ${String((error && error.message) || error)}`.slice(0, 200))
      }
      if (BACKFILL_SPACING_MS > 0) await new Promise((resolve) => setTimeout(resolve, BACKFILL_SPACING_MS))
    }

    backfill.running = false
    backfill.finishedAt = Date.now()
  }

  const handle = async (req, res) => {
    try {
      const connection = serviceOf(ctx, 'connection')
      if (connection && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end()
          return
        }
      }
    } catch {
      // 宿主没有鉴权钩子：继续（本地桌面场景）
    }

    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (pathname === `${API_PREFIX}/status` && method === 'GET') {
        sendJson(res, 200, statusPayload())
        return
      }
      if (pathname === `${API_PREFIX}/sessions` && method === 'GET') {
        sendJson(res, 200, { sessions: await sessionCodes() })
        return
      }
      if (pathname === `${API_PREFIX}/settings` && method === 'PUT') {
        const body = await readJsonBody(req)
        const settings = writeConfig(body && body.settings ? body.settings : body)
        sendJson(res, 200, { settings })
        return
      }
      if (pathname === `${API_PREFIX}/backfill` && method === 'POST') {
        if (backfill.running) {
          sendJson(res, 200, { started: false, reason: 'running', backfill: { ...backfill } })
          return
        }
        runBackfill().catch((error) => warn('backfill crashed', String((error && error.message) || error)))
        sendJson(res, 200, { started: true, max: BACKFILL_MAX_SESSIONS })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: String((error && error.message) || error) })
    }
  }

  const webServer = serviceOf(ctx, 'webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
      `${PLUGIN_ID}: http routes`
    )
  } else {
    // 非 web 宿主（CLI/TUI）：设置页本来也不存在，编号与模型标题照样工作。
    warn('webServer service is not available; settings page is disabled')
  }

  // 便于单测与排查：不参与运行时逻辑
  apply.__internals = { ChunkAssembler, sessionMeta, normalizeTitle, sameTitle, resolveRoute, sessionCode, sanitize }
}

module.exports = {
  name: PLUGIN_ID,
  // 必须用**数组形式**：宿主自带的 cordis 把 inject 数组元素当作服务名，
  // 而对象形式会被当成「服务名 → 拦截配置」的映射（`Inject.resolve`），
  // 写 `{required, optional}` 会变成等两个叫 required / optional 的服务，
  // 插件永远停在 pending、一声不响地不加载。
  // 所以可选服务不写进 inject，统一走 serviceOf() 的 ctx.get()。
  inject: ['sessionTitle', 'llm'],
  apply
}
