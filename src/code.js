'use strict'

/**
 * 时间轮盘编号（title-wheel code）
 *
 * 设计目标：
 * 1. **同一时间固定同号**：编号只由会话创建时间决定，不随机、不递增，
 *    刷新页面 / 重启 DSH / 重算多少次都是同一个编号。
 * 2. **相邻时间编号分散**：如果直接把一天切成连续弧段再顺号，相邻时间的编号
 *    会挨在一起（A0, A1, A2…），扫一眼分不清谁先谁后。这里把「格序号」做一次
 *    模 1296 的双射洗牌，让时间上相邻的格子在字符表上相隔很远。
 * 3. **全天无重号**：1296 格对 1296 个两位编号，洗牌是双射，所以一天之内
 *    任意两个不同的格子必然得到不同的编号。
 *
 * 为什么是 1296 = 36²：
 * - 字符表 36 个（A-Z 后接 0-9），两位编号有 36² = 1296 种组合；
 * - 一天 86400 秒 ÷ 1296 = 66.6667 秒/格，粒度刚好够区分"早上/下午/刚才"，
 *   又不会因为太细导致同一格撞号太频繁。
 *
 * 已知取舍：同一格（66.7 秒）内创建的两条会话编号相同。会话标题前多出两位
 * 字符本来就只是"时间锚点"，撞号不影响阅读；要彻底避免就得加长编号，不值。
 *
 * @module title-wheel/code
 */

/** 编号字符表：A=0 … Z=25，0=26 … 9=35。故意让字母在前，视觉上更像"编号"而不是"序号"。 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** 进制 = 字符表长度。 */
const RADIX = ALPHABET.length

/** 一天的格子数 = 36²。 */
const SLOTS_PER_DAY = RADIX * RADIX

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 每格毫秒数（66666.666…，不取整，避免 1296 格累计误差）。 */
const SLOT_MS = DAY_MS / SLOTS_PER_DAY

/** 洗牌乘数默认值。必须与 1296 互质，双射才成立（461 是质数且不整除 1296）。 */
const DEFAULT_MULTIPLIER = 461

/** 洗牌偏移默认值（把编号整体错开，避免"00:00 必然是同一个编号"）。 */
const DEFAULT_SALT = 977

/** 最大公约数，用于校验乘数与 1296 互质。 */
function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * 归一化洗牌乘数：非法或与 1296 不互质时退回默认值。
 * 不互质会让洗牌退化成非双射（出现重号），所以必须拦。
 * @param {unknown} value 配置值。
 * @returns {number} 1..1295 之间、与 1296 互质的乘数。
 */
function normalizeMultiplier(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MULTIPLIER
  const m = n % SLOTS_PER_DAY
  if (m === 0) return DEFAULT_MULTIPLIER
  return gcd(m, SLOTS_PER_DAY) === 1 ? m : DEFAULT_MULTIPLIER
}

/**
 * 归一化洗牌偏移：取模到 [0, 1296)。
 * @param {unknown} value 配置值。
 * @returns {number} 0..1295 的偏移。
 */
function normalizeSalt(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_SALT
  return ((n % SLOTS_PER_DAY) + SLOTS_PER_DAY) % SLOTS_PER_DAY
}

/**
 * 取时间戳所在**本地**日期的零点。
 * 用本地时区而非 UTC：编号要贴合"我今天几点开的会话"这个直觉，
 * 跨零点后重新从当天 0 点起算。
 * @param {number} ts 毫秒时间戳。
 * @returns {number} 当天 0 点的毫秒时间戳。
 */
function startOfLocalDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 时间戳落在当天的第几格（0..1295）。
 * @param {number} ts 毫秒时间戳。
 * @returns {number} 格序号。
 */
function slotIndexFor(ts) {
  const elapsed = Math.min(Math.max(ts - startOfLocalDay(ts), 0), DAY_MS - 1)
  const index = Math.floor((elapsed * SLOTS_PER_DAY) / DAY_MS)
  return Math.min(SLOTS_PER_DAY - 1, Math.max(0, index))
}

/**
 * 格序号 → 编号。先做 `(index * multiplier + salt) mod 1296` 的双射洗牌，
 * 再把洗牌结果拆成两位 36 进制字符。
 * @param {number} index 格序号 0..1295。
 * @param {object} [options] 洗牌参数。
 * @param {number} [options.multiplier] 乘数，默认 461。
 * @param {number} [options.salt] 偏移，默认 977。
 * @returns {string} 两位编号，如 `J7`。
 */
function codeForSlot(index, options = {}) {
  const safeIndex = Math.min(SLOTS_PER_DAY - 1, Math.max(0, Math.trunc(Number(index)) || 0))
  const multiplier = normalizeMultiplier(options.multiplier)
  const salt = normalizeSalt(options.salt)
  const perm = (safeIndex * multiplier + salt) % SLOTS_PER_DAY
  const high = Math.floor(perm / RADIX)
  const low = perm % RADIX
  return ALPHABET[high] + ALPHABET[low]
}

/**
 * 会话创建时间 → 编号。
 * @param {unknown} createdAt 会话创建时间（毫秒时间戳）。
 * @param {object} [options] 洗牌参数，见 {@link codeForSlot}。
 * @returns {string} 两位编号；时间戳非法时返回空串（调用方据此不渲染前缀）。
 */
function sessionCode(createdAt, options = {}) {
  const ts = Number(createdAt)
  if (!Number.isFinite(ts) || ts <= 0) return ''
  return codeForSlot(slotIndexFor(ts), options)
}

module.exports = {
  ALPHABET,
  RADIX,
  SLOTS_PER_DAY,
  DAY_MS,
  SLOT_MS,
  DEFAULT_MULTIPLIER,
  DEFAULT_SALT,
  gcd,
  normalizeMultiplier,
  normalizeSalt,
  startOfLocalDay,
  slotIndexFor,
  codeForSlot,
  sessionCode
}
