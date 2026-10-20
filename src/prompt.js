'use strict'

/**
 * 标题提示词与输出清洗
 *
 * 这一层只有两个职责：把「内置规则 + 用户自定义提示词」拼成系统提示词，
 * 以及把模型输出洗成一行能直接塞进侧栏的标题。
 *
 * 自定义提示词的定位：**追加在末尾的附加要求**，不是替换整段提示词。
 * 这样即使用户写坏了（比如只写了"带上需求编号"），内置的"一行、纯文本、
 * 用对话语言"这些底线仍然生效，标题不会变成一段解释性文字。
 *
 * @module title-wheel/prompt
 */

/** 标题字符硬上限：超过就是模型没听话，直接截断，避免撑爆两行布局。 */
const TITLE_MAX_CHARS = 40

/** 内置目标长度（customPrompt 可以覆盖）。 */
const TARGET_CJK_CHARS = 20

/**
 * 首尾成对出现的包裹符号。只有"首尾都命中同一种括号"才剥，
 * 避免把标题里正常出现的 `】`（如 `需求【15474】`）削掉一半。
 */
const WRAPPING_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['【', '】']
]

/**
 * 组装系统提示词。
 * @param {object} cfg 插件配置（只用到 customPrompt）。
 * @returns {string} 系统提示词。
 */
function systemPrompt(cfg) {
  const lines = [
    '你为「用户与 AI 编码助手」的会话撰写标题。',
    '阅读给出的对话记录，写出这条会话真正在做什么、想达成什么，而不是复述第一句话。',
    '只输出一行纯文本标题：不要引号、不要解释、不要 Markdown、不要代码块、不要表情符号、不要句号结尾。',
    `使用对话中的主要语言；中文控制在 ${TARGET_CJK_CHARS} 字以内，英文约 8 个词以内。`,
    '标题会被截断显示在很窄的侧栏里，所以优先写最具体的名词和动作。'
  ]
  const extra = String((cfg && cfg.customPrompt) || '').trim()
  if (extra) {
    lines.push('')
    lines.push('用户的附加要求（在不违反上面「一行纯文本」的前提下优先满足，包括允许添加编号或前缀）：')
    lines.push(extra)
  }
  return lines.join('\n')
}

/**
 * 清洗模型输出：
 * - 只取第一行（模型偶尔会多给一行解释）；
 * - 去掉 Markdown 前缀、包裹引号、代码块围栏；
 * - 折叠空白、去掉句末句号；
 * - 超过硬上限截断。
 * @param {unknown} raw 模型原始输出。
 * @returns {string} 可写入的标题；空串表示这次输出不可用。
 */
function cleanTitle(raw) {
  let text = String(raw == null ? '' : raw)
  text = text.replace(/\r\n?/g, '\n')
  // 去 markdown 代码围栏
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, '')
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || ''
  let out = firstLine
  // 去标题级 markdown / 列表符号 / 粗体标记
  out = out.replace(/^#{1,6}\s+/, '')
  out = out.replace(/^[-*+>]\s+/, '')
  out = out.replace(/\*\*|__|`/g, '')
  // 去整体包裹的引号 / 书名号（只剥首尾成对的，允许嵌套多层）
  for (let guard = 0; guard < 4; guard += 1) {
    const pair = WRAPPING_PAIRS.find(
      ([open, close]) => out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)
    )
    if (!pair) break
    out = out.slice(pair[0].length, out.length - pair[1].length).trim()
  }
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/[。．.]+$/, '')
  out = out.trim()
  if (out.length > TITLE_MAX_CHARS) out = `${out.slice(0, TITLE_MAX_CHARS - 1)}…`
  return out
}

/**
 * 把一段文本压成兜底标题（没有模型可用时）。
 * @param {string} text 首条用户消息。
 * @param {number} [maxChars] 字符上限。
 * @returns {string} 兜底标题。
 */
function fallbackTitle(text, maxChars = 24) {
  const flat = String(text || '').replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1)}…`
}

module.exports = { TITLE_MAX_CHARS, TARGET_CJK_CHARS, systemPrompt, cleanTitle, fallbackTitle }
