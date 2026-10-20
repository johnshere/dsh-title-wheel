/**
 * 宿主插件的装配测试：用假 ctx 跑一遍 apply()，把 provider 协议钉死。
 *
 * 为什么值得写：provider 的返回值比表面复杂——服务端会校验
 * `messageSeqs` 必须来自本次请求快照且严格递增，`model` 要么不给、要么是
 * `{provider, model}` 两个非空字符串，`title` 不能为空。这些约束错了不会崩，
 * 只会安静地"标题永远不更新"，非常难查。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'title-wheel-plugin-'))
process.env.DSH_HOME = home

const plugin = require('../src/index.js')
const config = require('../src/config.js')

/** 一条用户消息事件。 */
function userEvent(seq, text) {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }] } }
}

/** 假会话：只实现插件实际用到的那几个成员。 */
function createSession(id, createdAt, events) {
  return { id, header: { id, createdAt }, snapshotEvents: () => events }
}

/**
 * 假 ctx：记录注册结果，并把 llm 打成可控的流。
 * @param {object} [options] 覆盖项。
 */
function createCtx(options = {}) {
  const state = { provider: null, route: null, webServer: null, titleSnapshot: undefined }
  const ctx = {
    logger: () => ({ warn: () => {} }),
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sessionTitle: {
      register: (provider) => {
        state.provider = provider
        return () => {}
      },
      get: () => state.titleSnapshot,
      refresh: async () => {}
    },
    llm: {
      prepareCall: async (route) => {
        state.route = route
        return {
          config: { ...route },
          stream: async function* () {
            yield { type: 'text-delta', text: '```\n' }
            yield { type: 'text-delta', text: options.answer ?? '## 需求 15474 优化\n' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
      }
    },
    sessions: {
      list: () => options.sessions ?? []
    },
    webServer: {
      register: (spec) => {
        state.webServer = spec
        return () => {}
      }
    },
    connection: { requestRejection: () => undefined }
  }
  return { ctx, state }
}

test('插件导出：inject 必须是数组形式，且只有 sessionTitle 与 llm 两个硬依赖', () => {
  assert.equal(plugin.name, 'title-wheel')
  // 对象形式会被 cordis 当成「服务名 → 拦截配置」的映射，插件永远 pending，
  // 所以这里必须钉死是数组。
  assert.deepEqual(plugin.inject, ['sessionTitle', 'llm'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 后注册了唯一的 session-title provider', () => {
  const { ctx, state } = createCtx()
  plugin.apply(ctx)
  assert.equal(state.provider.id, 'title-wheel')
  assert.equal(state.provider.automatic, 'all-prompts')
  assert.equal(typeof state.provider.generate, 'function')
  assert.equal(state.webServer.path, '/title-wheel/api')
  assert.equal(state.webServer.kind, 'prefix')
})

test('generate：模型输出被洗成一行标题，messageSeqs 来自请求快照', async () => {
  const { ctx, state } = createCtx()
  config.__resetCache()
  config.writeConfig({ customPrompt: '', minIntervalMs: 0, modelTitle: true })
  plugin.apply(ctx)

  const session = createSession('s1', Date.now(), [
    userEvent(1, '帮我做一个大屏，要供应商统计维度'),
    userEvent(3, '再改一下配色')
  ])
  const result = await state.provider.generate({
    session,
    messages: [{ seq: 1 }, { seq: 3 }],
    route: { provider: 'deepseek', model: 'v3' },
    signal: new AbortController().signal
  })

  assert.equal(result.title, '需求 15474 优化')
  assert.deepEqual(result.messageSeqs, [1, 3])
  assert.equal('model' in result, false, 'model 只能要么不给、要么是 {provider, model}')
  assert.equal(state.route.provider, 'deepseek')
  assert.equal(state.route.maxTokens, config.readConfig().maxOutputTokens)
})

test('generate：modelTitle 关闭时把首条用户消息当标题，不调 LLM', async () => {
  const { ctx, state } = createCtx()
  config.__resetCache()
  config.writeConfig({ modelTitle: false })
  plugin.apply(ctx)

  const session = createSession('s2', Date.now(), [userEvent(1, '修复登录页白屏')])
  const result = await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  assert.equal(result.title, '修复登录页白屏')
  assert.deepEqual(result.messageSeqs, [1])
  assert.equal(state.route, null, '关闭模型标题后不应发起 LLM 调用')
})

test('generate：没有可用路由时退回兜底标题而不是抛错', async () => {
  const { ctx, state } = createCtx()
  config.__resetCache()
  config.writeConfig({ modelTitle: true, provider: '', model: '' })
  plugin.apply(ctx)

  const session = createSession('s3', Date.now(), [userEvent(1, '整理一下构建脚本')])
  const result = await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  assert.equal(result.title, '整理一下构建脚本')
})

test('generate：请求里没有源消息时抛错（服务要求 messageSeqs 非空）', async () => {
  const { ctx, state } = createCtx()
  plugin.apply(ctx)
  const session = createSession('s4', Date.now(), [])
  await assert.rejects(() =>
    state.provider.generate({ session, messages: [], signal: new AbortController().signal })
  )
})

test('generate：LLM 抛错时保住已有标题', async () => {
  const { ctx, state } = createCtx()
  ctx.llm.prepareCall = async () => ({
    config: {},
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 502' } } }
    }
  })
  state.titleSnapshot = { title: '已有的标题', messageSeqs: [1], source: { kind: 'provider' } }
  config.__resetCache()
  config.writeConfig({ modelTitle: true, minIntervalMs: 0, provider: 'p', model: 'm' })
  plugin.apply(ctx)

  const session = createSession('s5', Date.now(), [userEvent(1, '随便聊聊')])
  const result = await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  assert.equal(result.title, '已有的标题')
})

test('generate：服务塞的 fallback 标题不算"已有标题"，仍会重算', async () => {
  const { ctx, state } = createCtx({ answer: '整理构建脚本\n' })
  state.titleSnapshot = { title: '帮我看看', messageSeqs: [1], source: { kind: 'fallback' } }
  config.__resetCache()
  config.writeConfig({ modelTitle: true, minIntervalMs: 120000, provider: 'p', model: 'm' })
  plugin.apply(ctx)

  const session = createSession('s6', Date.now(), [userEvent(1, '帮我看看这个构建脚本怎么改')])
  const result = await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  assert.equal(result.title, '整理构建脚本')
})

test('节流窗口内不重复调用模型', async () => {
  const { ctx, state } = createCtx()
  config.__resetCache()
  config.writeConfig({ modelTitle: true, minIntervalMs: 120000, provider: 'p', model: 'm' })
  plugin.apply(ctx)

  const session = createSession('s7', Date.now(), [userEvent(1, '第一轮')])
  await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  const calls = () => state.route !== null
  assert.equal(calls(), true)

  // 第二轮：已有 provider 标题 + 在节流窗口内 → 直接返回原值，不再 prepareCall
  state.titleSnapshot = { title: '需求 15474 优化', messageSeqs: [1], source: { kind: 'provider' } }
  state.route = null
  const result = await state.provider.generate({ session, messages: [{ seq: 1 }], signal: new AbortController().signal })
  assert.equal(result.title, '需求 15474 优化')
  assert.equal(state.route, null, '节流窗口内不应发起新的 LLM 调用')
})

test('HTTP：status / sessions / settings 三个端点', async () => {
  const createdAt = new Date(2026, 9, 20, 17, 16, 11).getTime()
  const { ctx, state } = createCtx({ sessions: [createSession('s1', createdAt, []), createSession('s2', createdAt + 60000, [])] })
  config.__resetCache()
  config.writeConfig({ sessionCode: true })
  plugin.apply(ctx)

  const call = async (method, url, body) => {
    const response = { status: 0, headers: null, payload: null }
    const req = {
      method,
      url,
      on: (event, handler) => {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
        if (event === 'end') handler()
      },
      destroy: () => {}
    }
    const res = {
      writeHead: (status, headers) => {
        response.status = status
        response.headers = headers
      },
      end: (text) => {
        response.payload = text === undefined ? undefined : JSON.parse(text)
      }
    }
    await state.webServer.handler(req, res)
    return response
  }

  const status = await call('GET', '/title-wheel/api/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.settings.sessionCode, true)
  assert.ok(status.payload.configFile.endsWith('config.json'))

  const sessions = await call('GET', '/title-wheel/api/sessions')
  assert.deepEqual(
    sessions.payload.sessions.map((item) => item.code),
    ['J7', 'W0'],
    '编号必须与服务端的 code.js 保持一致'
  )

  const saved = await call('PUT', '/title-wheel/api/settings', { settings: { titleLines: 1 } })
  assert.equal(saved.payload.settings.titleLines, 1)
  assert.equal(config.readConfig().titleLines, 1)

  const missing = await call('GET', '/title-wheel/api/nope')
  assert.equal(missing.status, 404)
})

test('sessions 端点：优先用 sessionQuery 的全量语料，覆盖没打开的会话', async () => {
  const live = createSession('live-1', new Date(2026, 9, 20, 17, 16, 11).getTime(), [])
  const { ctx, state } = createCtx({ sessions: [live] })
  // 磁盘上的会话：只有 sessionQuery 拿得到，sessions.list() 看不见
  const persisted = [
    { id: 'disk-1', createdAt: new Date(2026, 9, 20, 9, 0, 0).getTime() },
    { id: 'disk-2', createdAt: new Date(2026, 9, 19, 23, 59, 0).getTime() }
  ]
  ctx.sessionQuery = {
    listSessions: async () => [...persisted, { id: 'live-1', createdAt: live.header.createdAt }].map((item) => ({ header: item, live: item.id === 'live-1', persisted: item.id !== 'live-1' }))
  }
  config.__resetCache()
  config.writeConfig({ sessionCode: true })
  plugin.apply(ctx)

  const response = { status: 0, payload: null }
  await state.webServer.handler(
    { method: 'GET', url: '/title-wheel/api/sessions', on: () => {}, destroy: () => {} },
    {
      writeHead: (status) => {
        response.status = status
      },
      end: (text) => {
        response.payload = JSON.parse(text)
      }
    }
  )

  const code = require('../src/code.js')
  const cfg = config.readConfig()
  const expected = [...persisted, { id: 'live-1', createdAt: live.header.createdAt }].map((item) => ({
    id: item.id,
    code: code.sessionCode(item.createdAt, cfg)
  }))
  assert.deepEqual(response.payload.sessions, expected, '编号必须来自全量语料，而不是只覆盖活会话')
})

test('可选服务只经 ctx.get 取：属性一读就抛的上下文也能装配', async () => {
  // 模拟真实 cordis 上下文：没写进 inject 的服务，属性访问直接抛
  // `cannot get property "x" without inject`，只有 ctx.get(name) 能拿到。
  const services = {
    sessions: { list: () => [createSession('s1', new Date(2026, 9, 20, 17, 16, 11).getTime(), [])] },
    webServer: {
      register: (spec) => {
        services.registered = spec
        return () => {}
      }
    },
    connection: { requestRejection: () => undefined }
  }
  const base = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sessionTitle: { register: () => () => {}, get: () => undefined, refresh: async () => {} },
    llm: { prepareCall: async () => ({ config: {}, stream: async function* () {} }) },
    get: (name) => services[name]
  }
  const forbidden = ['sessions', 'sessionQuery', 'webServer', 'connection', 'logger']
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (forbidden.includes(prop)) throw new Error(`cannot get property "${prop}" without inject`)
      return target[prop]
    }
  })

  config.__resetCache()
  config.writeConfig({ sessionCode: true })
  assert.doesNotThrow(() => plugin.apply(ctx), '缺 inject 的可选服务不能让装配抛错')
  assert.equal(services.registered.path, '/title-wheel/api')

  const response = { status: 0, payload: null }
  await services.registered.handler(
    { method: 'GET', url: '/title-wheel/api/sessions', on: () => {}, destroy: () => {} },
    {
      writeHead: (status) => {
        response.status = status
      },
      end: (text) => {
        response.payload = JSON.parse(text)
      }
    }
  )
  assert.equal(response.payload.sessions.length, 1, '编号表仍能通过 ctx.get 拿到活会话')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
