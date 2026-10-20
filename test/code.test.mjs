/**
 * 编号算法与配置层的单元测试。
 *
 * 重点盯三件事：
 * 1. 双射：1296 格必须一一对应 1296 个编号，否则一天内会出现重号；
 * 2. 分散：相邻格子（约 67 秒）的编号在字符表上必须隔得远，否则"时间锚点"失去意义；
 * 3. 稳定：同一时间戳无论算多少次、隔多少天都得到同一个编号。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

// config.js 的落盘位置由 DSH_HOME 决定，必须在 require 之前指到临时目录，
// 免得测试把脏配置写进用户真实的 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'title-wheel-test-'))
process.env.DSH_HOME = home

const code = require('../src/code.js')
const config = require('../src/config.js')

const localAt = (hour, minute, second, day = 20) => new Date(2026, 9, day, hour, minute, second).getTime()

test('已知样例：17:16:11 → J7，17:17:11 → W0', () => {
  assert.equal(code.sessionCode(localAt(17, 16, 11)), 'J7')
  assert.equal(code.sessionCode(localAt(17, 17, 11)), 'W0')
})

test('零点与当天最后一格', () => {
  assert.equal(code.startOfLocalDay(localAt(0, 0, 0)), localAt(0, 0, 0))
  assert.equal(code.slotIndexFor(localAt(0, 0, 0)), 0)
  assert.equal(code.slotIndexFor(localAt(23, 59, 59)), 1295)
  assert.equal(code.codeForSlot(0), '1F')
  assert.equal(code.codeForSlot(1295), 'OM')
})

test('1296 格 → 1296 个互不相同的两位编号（双射）', () => {
  const seen = new Set()
  for (let index = 0; index < code.SLOTS_PER_DAY; index += 1) {
    const value = code.codeForSlot(index)
    assert.match(value, /^[A-Z0-9]{2}$/, `非法编号：${value}`)
    assert.equal(seen.has(value), false, `重号：${value}（第 ${index} 格）`)
    seen.add(value)
  }
  assert.equal(seen.size, 1296)
})

test('相邻格子的编号在字符表上相隔很远（分散性）', () => {
  const value = (string) => code.ALPHABET.indexOf(string[0]) * 36 + code.ALPHABET.indexOf(string[1])
  for (let index = 0; index < code.SLOTS_PER_DAY; index += 1) {
    const current = value(code.codeForSlot(index))
    const next = value(code.codeForSlot((index + 1) % code.SLOTS_PER_DAY))
    const distance = Math.min(Math.abs(next - current), 1296 - Math.abs(next - current))
    assert.ok(distance >= 100, `第 ${index} 格与下一格只差 ${distance}`)
  }
})

test('跨天：同一时刻编号相同，零点前后编号不同', () => {
  assert.equal(code.sessionCode(localAt(9, 30, 0, 20)), code.sessionCode(localAt(9, 30, 0, 21)))
  assert.notEqual(code.sessionCode(localAt(23, 59, 59, 20)), code.sessionCode(localAt(0, 0, 0, 21)))
})

test('非法时间戳返回空串（调用方据此不渲染前缀）', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 'abc', {}]) {
    assert.equal(code.sessionCode(bad), '', `应当为空：${String(bad)}`)
  }
})

test('洗牌参数归一化', () => {
  assert.equal(code.normalizeMultiplier(461), 461)
  assert.equal(code.normalizeMultiplier(5), 5)
  // 与 1296 不互质会让洗牌退化成非双射
  assert.equal(code.normalizeMultiplier(462), 461)
  assert.equal(code.normalizeMultiplier(1296), 461)
  assert.equal(code.normalizeMultiplier(0), 461)
  assert.equal(code.normalizeMultiplier('abc'), 461)
  assert.equal(code.normalizeSalt(-1), 1295)
  assert.equal(code.normalizeSalt(1296), 0)
  assert.equal(code.normalizeSalt('x'), 977)
})

test('自定义乘数时双射依然成立', () => {
  const seen = new Set()
  for (let index = 0; index < 1296; index += 1) seen.add(code.codeForSlot(index, { multiplier: 5, salt: 0 }))
  assert.equal(seen.size, 1296)
})

test('sanitize：空输入 → 默认值，未知键丢弃', () => {
  assert.deepEqual(config.sanitize({}), { ...config.DEFAULT_CONFIG })
  assert.deepEqual(config.sanitize(undefined), { ...config.DEFAULT_CONFIG })
  const out = config.sanitize({ legacyField: 'x', sessionCode: 0 })
  assert.equal('legacyField' in out, false)
  assert.equal(out.sessionCode, false)
})

test('sanitize：数值一律 clamp 取整，不会抛错', () => {
  const out = config.sanitize({
    titleLines: 9,
    maxInputBytes: 1,
    maxOutputTokens: 2,
    timeoutMs: 10_000_000,
    minIntervalMs: -5,
    codeMultiplier: 0,
    codeSalt: 9999
  })
  assert.equal(out.titleLines, 3)
  assert.equal(out.maxInputBytes, 512)
  assert.equal(out.maxOutputTokens, 16)
  assert.equal(out.timeoutMs, 600000)
  assert.equal(out.minIntervalMs, 0)
  assert.equal(out.codeMultiplier, 1)
  assert.equal(out.codeSalt, 1296)
  assert.equal(config.sanitize({ titleLines: Number.NaN }).titleLines, 2)
})

test('sanitize：字符串 trim，customPrompt 原样保留换行', () => {
  const out = config.sanitize({ provider: '  deepseek  ', model: ' v3 ', customPrompt: '第一行\n第二行' })
  assert.equal(out.provider, 'deepseek')
  assert.equal(out.model, 'v3')
  assert.equal(out.customPrompt, '第一行\n第二行')
})

test('writeConfig / readConfig 往返（原子写 + 磁盘读）', () => {
  config.__resetCache()
  const written = config.writeConfig({ titleLines: 3, sessionCode: false })
  assert.equal(written.titleLines, 3)
  assert.equal(existsSync(config.configFile()), true)

  // 清缓存强制走磁盘，确认真的落盘了
  config.__resetCache()
  const reloaded = config.readConfig()
  assert.equal(reloaded.titleLines, 3)
  assert.equal(reloaded.sessionCode, false)
  // 未涉及的字段保持默认
  assert.equal(reloaded.modelTitle, true)

  // 再写一次只改一个字段，其余字段不应被清空
  config.writeConfig({ customPrompt: '带上编号' })
  config.__resetCache()
  const again = config.readConfig()
  assert.equal(again.titleLines, 3)
  assert.equal(again.customPrompt, '带上编号')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
