'use strict'

/**
 * 会话日志 → 标题提示词输入
 *
 * 事件形状（宿主 dsh-session 的持久化日志）：
 * - `user/message`：`data` 即一条 user 消息，`event.seq` 是它的归属序号；
 * - `assistant/message`：`data.message.content` 里是助手回复的 content 块。
 *
 * 两个必须遵守的约束：
 * 1. **取日志只走 `session.snapshotEvents()`**。裸读 `session.events` 在事件
 *    已经溢写到磁盘后不是数组，会静默拿到空转写、一条标题都生成不出来。
 * 2. **用户消息的 seq 必须落在 `request.messages` 快照里**。服务会校验
 *    「结果声明的 messageSeqs 越出快照」并把整次 generate 判为无效，所以
 *    凡是不在允许集里的历史 user 消息都要丢掉。
 *
 * @module title-wheel/transcript
 */

/** 单条转写条目在 JSON 里的大致开销（括号、逗号、键名），用于预算估算。 */
const FRAME_OVERHEAD_BYTES = 256

/**
 * 防御性取会话事件数组。
 * @param {object|null|undefined} session 会话对象。
 * @returns {Array<object>} 事件数组，取不到返回空数组。
 */
function eventsOf(session) {
  if (!session || typeof session !== 'object') return []
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    if (Array.isArray(events)) return events
  } catch {
    // 快照不可用（会话正在销毁等）：当作没有转写
  }
  return []
}

/**
 * 从 content 块数组里抽纯文本：只认 `type === 'text'` 的块，空白折叠成单空格。
 * 图片 / 工具调用等非文本块直接忽略——标题不需要它们。
 * @param {unknown} content 消息 content。
 * @returns {string} 折叠后的文本。
 */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

/**
 * 把事件流折叠成转写条目（保持日志顺序）。
 * @param {Array<object>} events 会话事件。
 * @param {Set<number>} allowedSeqs 允许的用户消息 seq 集合。
 * @param {boolean} includeAssistant 是否纳入助手回复。
 * @returns {Array<{role:'user',seq:number,text:string}|{role:'assistant',text:string}>} 转写条目。
 */
function collectTranscript(events, allowedSeqs, includeAssistant) {
  const items = []
  if (!Array.isArray(events)) return items
  const allowed = allowedSeqs instanceof Set ? allowedSeqs : new Set(allowedSeqs || [])
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data
    if (event.type === 'user/message') {
      const seq = event.seq
      if (typeof seq !== 'number' || !allowed.has(seq)) continue
      const text = messageText(data && data.content)
      if (text) items.push({ role: 'user', seq, text })
    } else if (event.type === 'assistant/message' && includeAssistant) {
      const text = messageText(data && data.message && data.message.content)
      if (text) items.push({ role: 'assistant', text })
    }
  }
  return items
}

/**
 * 按 UTF-8 字节硬截断，不破坏码点。
 * @param {string} text 原文本。
 * @param {number} maxBytes 字节上限。
 * @returns {string} 截断后的文本（带省略号）。
 */
function truncateTextUtf8(text, maxBytes) {
  const s = String(text)
  const limit = Math.max(0, Math.trunc(Number(maxBytes)) || 0)
  if (limit <= 0) return ''
  if (Buffer.byteLength(s, 'utf8') <= limit) return s
  let out = s
  while (out.length > 0 && Buffer.byteLength(`${out}…`, 'utf8') > limit) {
    out = out.slice(0, -1)
  }
  return out ? `${out}…` : ''
}

/** 单条条目的 JSON 字节数。 */
function itemBytes(item) {
  return Buffer.byteLength(JSON.stringify(item), 'utf8')
}

/**
 * 在字节预算内裁剪转写。
 *
 * 策略：**首条用户消息永远保留**（它承载最初的意图，是标题最强的锚点），
 * 余下预算从末尾往前回填（最近的上下文最能反映"当前在做什么"），放不下的
 * 从前往后丢。首条自己就超预算时按比例硬截断。
 *
 * 反例（为什么不能简单从头截）：一个跑了一百轮的会话，从头截只能看到开场白，
 * 标题会永远停在"帮我看看这个接口"，而实际早就跑到部署了。
 *
 * @param {Array<object>} items 转写条目。
 * @param {number} maxInputBytes 封帧前的字节预算。
 * @returns {Array<object>} 裁剪后的新数组。
 */
function trimTranscriptItems(items, maxInputBytes) {
  if (!Array.isArray(items) || items.length === 0) return []
  const budget = Math.max(512, Math.trunc(Number(maxInputBytes)) || 0) - FRAME_OVERHEAD_BYTES
  const anchorIndex = items.findIndex((item) => item.role === 'user')
  const anchor = anchorIndex >= 0 ? items[anchorIndex] : null
  const rest = items.filter((_, index) => index !== anchorIndex)

  const result = []
  let used = 0

  // 锚点最多占一半预算，另一半留给最近的上下文；放不下就截断正文，
  // 而不是挤掉后面所有的上下文（否则长会话标题只会看到开场白）。
  if (anchor) {
    const copy = { ...anchor }
    const cap = Math.floor(budget / 2)
    if (itemBytes(copy) > cap) {
      const overhead = itemBytes({ ...copy, text: '' }) + 4
      const textBudget = cap - overhead
      copy.text = textBudget > 0 ? truncateTextUtf8(copy.text, textBudget) : ''
    }
    if (copy.text) {
      result.push(copy)
      used += itemBytes(copy)
    }
  }

  const kept = []
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const item = rest[i]
    const cost = itemBytes(item)
    if (used + cost > budget) continue
    kept.unshift(item)
    used += cost
  }

  result.push(...kept)
  return result
}

/**
 * 把转写封帧成用户提示词。用 JSON 而非纯文本拼接：消息里出现「忽略以上指令」
 * 之类的文本时，JSON 结构让模型更容易把它当数据而不是指令。
 * @param {Array<object>} items 已裁剪的转写条目。
 * @returns {string} 提示词正文。
 */
function frameTranscript(items) {
  const framed = items.map((item) =>
    item.role === 'user' ? { role: 'user', seq: item.seq, text: item.text } : { role: 'assistant', text: item.text }
  )
  return `以下是这条会话的对话记录（JSON）：\n${JSON.stringify(framed)}\n\n请为它写一行标题。`
}

/**
 * 取首条用户消息的文本，用于"没有模型标题"时的确定性兜底。
 * @param {Array<object>} events 会话事件。
 * @param {Set<number>} allowedSeqs 允许的 seq 集合。
 * @returns {string} 文本，没有则空串。
 */
function firstUserText(events, allowedSeqs) {
  const items = collectTranscript(events, allowedSeqs, false)
  const first = items.find((item) => item.role === 'user')
  return first ? first.text : ''
}

module.exports = {
  FRAME_OVERHEAD_BYTES,
  eventsOf,
  messageText,
  collectTranscript,
  truncateTextUtf8,
  itemBytes,
  trimTranscriptItems,
  frameTranscript,
  firstUserText
}
