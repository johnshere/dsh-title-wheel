'use strict'

/**
 * 配置存取
 *
 * 为什么不用 ctx.settings + schemastery：
 * 本插件以 `link:` 方式装在 profile 之外（源码仓 + link 安装），从插件目录向上
 * 找 `@deepseek-ai/schemastery` 会落到 `C:\node_modules` 之类的空目录，只能靠
 * 宿主安装路径的绝对兜底，而宿主是 Electron（模块在 app.asar 里），路径还随
 * 打包方式变化。为了「装到任何 profile 都能跑」，这里直接用一个 JSON 文件做
 * 唯一配置源：无原生依赖、无 schema 版本耦合，设置页走插件自己的 HTTP 端点。
 *
 * 代价是不出现在宿主的原生设置文档里 —— 但我们本来就有自己的设置页。
 *
 * @module title-wheel/config
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * 默认配置。字段分四组：
 * - 主配置：sessionCode / modelTitle / customPrompt
 * - 显示：titleLines（标题最多几行）
 * - 编号：codeMultiplier / codeSalt（洗牌参数，见 code.js）
 * - 生成：maxInputBytes / maxOutputTokens / timeoutMs / minIntervalMs / provider / model
 */
const DEFAULT_CONFIG = Object.freeze({
  // ── 主配置 ─────────────────────────────────────────────────────────────
  /** 标题最前面显示时间轮盘编号（纯代码生成，不写进标题数据）。 */
  sessionCode: true,
  /** 用模型生成标题；关掉则保留现有标题，没有标题时用首条用户消息兜底。 */
  modelTitle: true,
  /** 自定义提示词，追加在系统提示词末尾；空串 = 只用内置提示词。 */
  customPrompt: '',
  // ── 显示 ───────────────────────────────────────────────────────────────
  /** 标题最多显示几行（1-3），超过才截断。 */
  titleLines: 2,
  // ── 编号 ───────────────────────────────────────────────────────────────
  /** 洗牌乘数，必须与 1296 互质，非法值自动退回 461。 */
  codeMultiplier: 461,
  /** 洗牌偏移，取模到 [0,1296)。 */
  codeSalt: 977,
  // ── 生成 ───────────────────────────────────────────────────────────────
  /** 转写是否包含助手回复。恒为 true 时"再改一下"这类消息才判得出主题。 */
  includeAssistant: true,
  /** 封帧后输入的 UTF-8 字节上限，超了按"首条锚点 + 尾部回填"裁剪。 */
  maxInputBytes: 12000,
  /** 输出 token 上限，防止思考型适配器把预算烧在 reasoning 上。 */
  maxOutputTokens: 256,
  /** 单次生成端到端硬截止（ms）。没有它，流挂起时标题永远不更新。 */
  timeoutMs: 60000,
  /** 同一会话两次生成的最小间隔（ms），0 = 不节流。 */
  minIntervalMs: 120000,
  /** 标题模型路由覆盖；两者都非空才生效，否则跟随会话已记录路由。 */
  provider: '',
  model: ''
})

/** 数值字段的合法区间（越界一律 clamp，不抛错，避免一个坏配置让插件罢工）。 */
const LIMITS = Object.freeze({
  titleLines: [1, 3],
  maxInputBytes: [512, 200000],
  maxOutputTokens: [16, 8192],
  timeoutMs: [1000, 600000],
  minIntervalMs: [0, 3600000],
  codeMultiplier: [1, 1295],
  codeSalt: [-1296, 1296]
})

/** DSH 主目录（测试可注入）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 配置文件绝对路径。 */
function configFile() {
  return path.join(dshHome(), 'title-wheel', 'config.json')
}

/** 模块级缓存：生成发生在热路径上，不能每轮读盘。 */
let cache = null

/**
 * 把任意输入洗成合法配置：布尔取真值、数字 clamp 取整、字符串 trim。
 * 未知键直接丢弃（防止旧版本残留在文件里的字段被继续带出去）。
 * @param {unknown} input 原始配置片段。
 * @returns {object} 完整配置对象。
 */
function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...DEFAULT_CONFIG }
  const pick = (key) => (Object.prototype.hasOwnProperty.call(src, key) ? src[key] : DEFAULT_CONFIG[key])

  out.sessionCode = Boolean(pick('sessionCode'))
  out.modelTitle = Boolean(pick('modelTitle'))
  out.includeAssistant = Boolean(pick('includeAssistant'))
  out.customPrompt = String(pick('customPrompt') || '')
  out.provider = String(pick('provider') || '').trim()
  out.model = String(pick('model') || '').trim()

  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const raw = Number(pick(key))
    const fallback = DEFAULT_CONFIG[key]
    if (!Number.isFinite(raw)) {
      out[key] = fallback
      continue
    }
    out[key] = Math.min(max, Math.max(min, Math.round(raw)))
  }
  return out
}

/** 从磁盘读原始 JSON；文件缺失 / 损坏一律当空配置，不让插件起不来。 */
function readFile() {
  try {
    const text = fs.readFileSync(configFile(), 'utf8')
    if (!text.trim()) return {}
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 原子写：先写临时文件再 rename，避免设置页连点保存时读到半截 JSON。
 * @param {object} value 完整配置。
 */
function persist(value) {
  try {
    const file = configFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // 写盘失败不影响本次运行：内存里的 cache 已经是新值
  }
}

/**
 * 读当前配置（带缓存）。
 * @returns {object} 完整配置对象（副本，调用方可随意改）。
 */
function readConfig() {
  if (!cache) cache = sanitize(readFile())
  return { ...cache }
}

/**
 * 写入配置片段并落盘。
 * @param {object} patch 只包含要改的字段。
 * @returns {object} 合并后的完整配置。
 */
function writeConfig(patch) {
  const merged = sanitize({ ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) })
  cache = merged
  persist(merged)
  return { ...merged }
}

/** 清空缓存（测试用）。 */
function __resetCache() {
  cache = null
}

module.exports = {
  DEFAULT_CONFIG,
  LIMITS,
  dshHome,
  configFile,
  sanitize,
  readConfig,
  writeConfig,
  __resetCache
}
