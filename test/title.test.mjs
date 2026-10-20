/**
 * 提示词组装、标题清洗、转写裁剪的单元测试。
 *
 * 这三块是最容易被"顺手改坏"的地方：
 * - 系统提示词的底线规则不能被 customPrompt 顶掉；
 * - 模型输出必须洗成一行，否则两行 clamp 里会掺进 Markdown 残渣；
 * - 裁剪必须保住首条用户消息，否则长会话的标题会停在"帮我看看"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const prompt = require('../src/prompt.js')
const transcript = require('../src/transcript.js')

test('systemPrompt：没有自定义提示词时只有内置规则', () => {
  const text = prompt.systemPrompt({ customPrompt: '' })
  assert.equal(text.includes('附加要求'), false)
  assert.equal(text.split('\n').filter(Boolean).length, 5)
  assert.match(text, /一行纯文本/)
  assert.match(text, /不要 Markdown/)
})

test('systemPrompt：自定义提示词追加在末尾，内置规则仍在', () => {
  const text = prompt.systemPrompt({ customPrompt: '把需求编号【15474】放在标题最前面' })
  assert.match(text, /一行纯文本/)
  assert.match(text, /附加要求/)
  assert.ok(text.endsWith('把需求编号【15474】放在标题最前面'))
  // 追加而非替换
  assert.ok(text.indexOf('一行纯文本') < text.indexOf('附加要求'))
})

test('systemPrompt：customPrompt 只有空白视同为空', () => {
  assert.equal(prompt.systemPrompt({ customPrompt: '   \n  ' }).includes('附加要求'), false)
  assert.equal(prompt.systemPrompt(undefined).includes('附加要求'), false)
})

test('cleanTitle：去掉代码围栏、标题符、粗体、包裹引号与句末句号', () => {
  assert.equal(prompt.cleanTitle('```js\n# 需求 15474 优化\n```'), '需求 15474 优化')
  assert.equal(prompt.cleanTitle('"修复登录"'), '修复登录')
  assert.equal(prompt.cleanTitle('**加粗标题**。'), '加粗标题')
  assert.equal(prompt.cleanTitle('用 `npm run build` 打包'), '用 npm run build 打包')
  assert.equal(prompt.cleanTitle('「标题」'), '标题')
})

test('cleanTitle：只取第一个非空行', () => {
  assert.equal(prompt.cleanTitle('\n\n  真正的标题  \n补充说明'), '真正的标题')
  assert.equal(prompt.cleanTitle('标题\r\n第二行'), '标题')
})

test('cleanTitle：超长截断到硬上限，空输入返回空串', () => {
  const long = prompt.cleanTitle('x'.repeat(100))
  assert.equal(long.length, prompt.TITLE_MAX_CHARS)
  assert.ok(long.endsWith('…'))
  assert.equal(prompt.cleanTitle(''), '')
  assert.equal(prompt.cleanTitle(null), '')
  assert.equal(prompt.cleanTitle('   '), '')
})

test('fallbackTitle：压平空白、超长截断、空输入为空', () => {
  assert.equal(prompt.fallbackTitle('帮我  看看\n这个接口'), '帮我 看看 这个接口')
  assert.equal(prompt.fallbackTitle(''), '')
  const long = prompt.fallbackTitle('y'.repeat(100), 10)
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
})

test('messageText：只拼 text 块，折叠空白，忽略图片等非文本块', () => {
  assert.equal(
    transcript.messageText([
      { type: 'text', text: 'a  b' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'c' }
    ]),
    'a b c'
  )
  assert.equal(transcript.messageText(undefined), '')
  assert.equal(transcript.messageText([{ type: 'tool-call' }]), '')
})

test('collectTranscript：用户消息必须落在允许的 seq 快照里', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '越出快照' }] } }
  ]
  const allowed = new Set([1])

  assert.deepEqual(
    transcript.collectTranscript(events, allowed, true).map((item) => item.role),
    ['user', 'assistant']
  )
  assert.deepEqual(
    transcript.collectTranscript(events, allowed, false).map((item) => item.text),
    ['hi']
  )
  assert.equal(transcript.firstUserText(events, allowed), 'hi')
})

test('trimTranscriptItems：保住首条用户消息 + 优先最近上下文', () => {
  const items = [{ role: 'user', seq: 1, text: 'A'.repeat(1000) }]
  for (let index = 0; index < 40; index += 1) {
    items.push({ role: 'assistant', text: `第 ${index} 轮：${'B'.repeat(300)}` })
  }

  const maxInputBytes = 2000
  const budget = maxInputBytes - transcript.FRAME_OVERHEAD_BYTES
  const kept = transcript.trimTranscriptItems(items, maxInputBytes)

  assert.equal(kept[0].role, 'user', '首条用户消息必须保留')
  assert.equal(kept.at(-1).text, items.at(-1).text, '最近的上下文必须保留')
  assert.ok(kept.length < items.length, '应该发生了裁剪')
  assert.ok(Buffer.byteLength(kept[0].text, 'utf8') <= budget)

  const used = kept.reduce((sum, item) => sum + transcript.itemBytes(item), 0)
  assert.ok(used <= budget, `总字节 ${used} 超出预算 ${budget}`)
  // 顺序不能乱
  assert.deepEqual(
    kept.filter((item) => item.role === 'assistant').map((item) => item.text),
    [...kept.filter((item) => item.role === 'assistant').map((item) => item.text)].sort(
      (a, b) => Number(a.slice(2).split(' ')[0]) - Number(b.slice(2).split(' ')[0])
    )
  )
})

test('trimTranscriptItems：预算充足时原样保留', () => {
  const items = [
    { role: 'user', seq: 1, text: '第一句' },
    { role: 'assistant', text: '回复一' },
    { role: 'user', seq: 3, text: '第二句' }
  ]
  assert.deepEqual(transcript.trimTranscriptItems(items, 12000), items)
  assert.deepEqual(transcript.trimTranscriptItems([], 12000), [])
})

test('frameTranscript：JSON 封帧且带上写作指令', () => {
  const text = transcript.frameTranscript([
    { role: 'user', seq: 7, text: '做个大屏' },
    { role: 'assistant', text: '好的' }
  ])
  assert.match(text, /请为它写一行标题/)
  const jsonLine = text.split('\n')[1]
  assert.deepEqual(JSON.parse(jsonLine), [
    { role: 'user', seq: 7, text: '做个大屏' },
    { role: 'assistant', text: '好的' }
  ])
})

test('eventsOf：只走 snapshotEvents，取不到时退回空数组', () => {
  assert.deepEqual(transcript.eventsOf({ snapshotEvents: () => [{ a: 1 }] }), [{ a: 1 }])
  assert.deepEqual(transcript.eventsOf(null), [])
  assert.deepEqual(transcript.eventsOf({ snapshotEvents: () => { throw new Error('boom') } }), [])
  // 溢写后 events 已不是数组：必须靠 snapshotEvents
  assert.deepEqual(transcript.eventsOf({ events: { streamId: 'x' } }), [])
})
