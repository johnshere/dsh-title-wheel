#!/usr/bin/env node
/**
 * 把 `client/index.js`（普通 CommonJS 源码）包成宿主能加载的客户端 bundle。
 *
 * 宿主在浏览器里用 `window.__ModuleLoader__.load({ id, factory })` 注册客户端插件，
 * factory 收到一个 `require`，目前只提供 `react`（以及可选的
 * `@deepseek-ai/dsh-client-ui-primitives`）。所以这里不需要任何打包器：
 * 把源码原样塞进 factory 函数体，让它用宿主给的 require 即可。
 *
 * 产物 `client/bundle.js` 是构建输出，不要手改；改 `client/index.js` 后重跑
 * `npm run build`。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const entry = join(root, 'client', 'index.js')
const target = join(root, 'client', 'bundle.js')

const source = await readFile(entry, 'utf8')

/** 缩进一下源码，产物更好读（也避免行首 `//` 注掉包装代码）。 */
const indented = source
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map((line) => (line.length > 0 ? `    ${line}` : line))
  .join('\n')

const banner = [
  `/*! ${pkg.name} v${pkg.version} | MIT | 构建产物，请勿手改，源码见 client/index.js */`,
  ''
].join('\n')

const bundle = `${banner}window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${indented}
    return module.exports
  }
})
`

// 先做一次语法编译：包装代码本身写坏了要立刻失败，而不是等宿主加载时才报错。
new Script(bundle, { filename: target })

await writeFile(target, bundle, 'utf8')

const lines = bundle.split('\n').length
console.log(`built ${pkg.name} client -> client/bundle.js (${Buffer.byteLength(bundle)} bytes, ${lines} lines)`)
