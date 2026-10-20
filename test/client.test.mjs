/**
 * 客户端 bundle 的装配测试。
 *
 * 这里不跑真实浏览器，只做两件最容易出错的事：
 * 1. `window.__ModuleLoader__.load({ id, factory })` 包装能被加载、能导出 `apply`；
 * 2. 两段关键 CSS（双行 clamp、编号 `::before`）生成正确。
 *
 * 双行与编号都是"改宿主样式"的实现，CSS 里一个 `nowrap` 或选择器写错，
 * 表现是"看着没变"，没有任何报错，所以只能用单测钉死文本。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 假 DOM：够插件注入 style 与监听事件即可。 */
function createDocument() {
  const nodes = new Map()
  const created = []
  const document = {
    hidden: false,
    head: {
      appendChild: (node) => {
        nodes.set(node.id, node)
        return node
      }
    },
    body: {},
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => {
      const node = { id: '', textContent: '' }
      created.push(node)
      return node
    },
    addEventListener: () => {}
  }
  return { document, nodes, created }
}

const fakeReact = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  Fragment: 'fragment'
}

const { document, nodes } = createDocument()
const loaded = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : {})))
    }
  }
}
globalThis.document = document
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
// 插件用 setInterval 轮询编号，测试里不能真的挂定时器（会让进程不退出）
globalThis.setInterval = () => 0
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

require('../client/bundle.js')

const bundle = loaded.get('dsh-title-wheel')

test('bundle 由 ModuleLoader 注册，导出 apply 与内部工具', () => {
  assert.ok(bundle, 'bundle 应该以包名注册到 __ModuleLoader__')
  assert.equal(bundle.name, 'title-wheel')
  assert.deepEqual(bundle.inject, ['slots'])
  assert.equal(typeof bundle.apply, 'function')
  for (const key of ['displayCss', 'codesCss', 'clampNumber', 'cssEscape']) {
    assert.equal(typeof bundle.__internals[key], 'function', `缺少 __internals.${key}`)
  }
})

test('双行样式：放开 nowrap、按行 clamp、行高自适应', () => {
  const css = bundle.__internals.displayCss(2)
  // 宿主原始规则是 `height:32px` + `white-space:nowrap`，两个都得覆盖
  assert.match(css, /\[class\*="_sessionRow"\]\{height:auto/)
  assert.match(css, /white-space:normal/)
  assert.match(css, /-webkit-line-clamp:2/)
  assert.match(css, /line-clamp:2/)
  // 有 clamp 就不该再有 ellipsis，否则会出现两个省略号
  assert.match(css, /text-overflow:clip/)
  assert.equal(css.includes('ellipsis'), false)
  // 单行时的横向跑马灯 mask 要关掉
  assert.match(css, /mask-image:none/)
})

test('行数夹在 1-3 之间', () => {
  assert.match(bundle.__internals.displayCss(1), /-webkit-line-clamp:1/)
  assert.match(bundle.__internals.displayCss(3), /-webkit-line-clamp:3/)
  assert.match(bundle.__internals.displayCss(9), /-webkit-line-clamp:3/)
  assert.match(bundle.__internals.displayCss(0), /-webkit-line-clamp:1/)
  assert.match(bundle.__internals.displayCss('x'), /-webkit-line-clamp:2/)
})

test('编号样式：挂在会话行的标题伪元素上', () => {
  const css = bundle.__internals.codesCss([
    { id: 's1', code: 'J7' },
    { id: 's2', code: 'W0' }
  ])
  assert.equal(
    css,
    '[data-row-key="session:s1"] [class*="_title"]::before{content:"J7· "}\n' +
      '[data-row-key="session:s2"] [class*="_title"]::before{content:"W0· "}'
  )
  assert.equal(bundle.__internals.codesCss([]), '')
  // 缺字段的条目不能让整段 CSS 变成 `content:"undefined· "`
  assert.equal(bundle.__internals.codesCss([{ id: 's3' }]), '')
})

test('编号样式：id 里的引号不会破坏 CSS', () => {
  const css = bundle.__internals.codesCss([{ id: 'a"b', code: 'J7' }])
  assert.equal(css.includes('a\\"b'), true)
})

test('apply：注入设置页样式并注册 settings.section', () => {
  const registered = []
  const ctx = {
    slots: {
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      }
    }
  }

  bundle.apply(ctx)

  const ui = nodes.get('title-wheel-ui-style')
  assert.ok(ui, '应该注入设置页样式')
  assert.match(ui.textContent, /\.tw-section/)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.section')
  assert.equal(registered[0].spec.id, 'title-wheel')
  assert.equal(registered[0].spec.order, 96)
  assert.equal(registered[0].spec.label(), '标题轮盘')
  assert.equal(typeof registered[0].component, 'function')
})
