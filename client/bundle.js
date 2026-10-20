/*! dsh-title-wheel v0.1.0 | MIT | 构建产物，请勿手改，源码见 client/index.js */
window.__ModuleLoader__.load({
  id: "dsh-title-wheel",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    /**
     * 标题轮盘（title-wheel）—— 客户端
     *
     * 两件事：
     * 1. **显示层**：往 document 注入两段 `<style>`：
     *    - 会话标题最多显示 N 行（默认 2 行），超过才截断；
     *    - 每个会话标题前用 `::before` 挂上它的时间轮盘编号。
     *    会话列表 DOM 上没有 shadow root（已核对 ui-workspace 等 bundle 无
     *    attachShadow / adoptedStyleSheets），所以 document 级样式表直接生效。
     *
     *    为什么编号走 CSS 而不是写进标题字符串：编号属于"显示装饰"，写进数据后
     *    模型每轮重写标题都会把它冲掉，而且会污染标题长度预算与搜索。`::before`
     *    不参与 React 的 diff，也不占标题文本，永远在最前面。
     *
     * 2. **设置页**：配置读写全走插件自己的 HTTP 端点（见 src/index.js）。
     *
     * 样式选择器用 `[class*="_sessionRow"]` 而不是具体类名：宿主的 CSS Modules
     * 类名带构建期哈希前缀（当前是 `hIlkoa_`，随版本变化），只有后缀稳定。
     *
     * @module title-wheel/client
     */

    const React = require('react')

    const h = React.createElement

    const PLUGIN_ID = 'title-wheel'
    const API = '/title-wheel/api'
    const DISPLAY_STYLE_ID = 'title-wheel-display'
    const CODES_STYLE_ID = 'title-wheel-codes'
    const UI_STYLE_ID = 'title-wheel-ui-style'

    /** 编号/行数变化后重新拉取的间隔（本地请求，开销可忽略）。 */
    const REFRESH_INTERVAL_MS = 30000

    /** 数值字段区间，与服务端 config.js 保持一致（前端先夹一次，避免手滑提交离谱值）。 */
    const LIMITS = {
      titleLines: [1, 3],
      codeMultiplier: [1, 1295],
      codeSalt: [-1296, 1296],
      maxInputBytes: [512, 200000],
      maxOutputTokens: [16, 8192],
      timeoutMs: [1000, 600000],
      minIntervalMs: [0, 3600000]
    }

    /**
     * 把一个数字夹进合法区间。
     * @param {unknown} value 输入值。
     * @param {string} key LIMITS 的键。
     * @param {number} fallback 非法时的回退值。
     * @returns {number} 合法整数。
     */
    function clampNumber(value, key, fallback) {
      const range = LIMITS[key]
      const n = Math.round(Number(value))
      if (!Number.isFinite(n)) return fallback
      if (!range) return n
      return Math.min(range[1], Math.max(range[0], n))
    }

    /** 转义 CSS 属性选择器里的字符串。 */
    function cssEscape(value) {
      return String(value).replace(/["\\]/g, '\\$&')
    }

    /**
     * 标题多行显示的样式表。
     *
     * 宿主原始规则（ui-workspace 的 Rows.module.css）：
     *   `.sessionRow { height: 32px }`
     *   `.title { text-overflow:ellipsis; white-space:nowrap; overflow:hidden }`
     * 固定行高 + nowrap 是一行显示的两个成因，必须一起改：只放开 nowrap 会让
     * 文字被 32px 高度裁掉，只改高度则仍然不换行。
     *
     * @param {number} lines 最多显示几行。
     * @returns {string} CSS 文本。
     */
    function displayCss(lines) {
      const n = clampNumber(lines, 'titleLines', 2)
      return [
        // 行高由内容撑开：单行仍是 32px 的观感，双行则自然长到 40px 左右。
        'html body [class*="_sessionRow"]{height:auto;min-height:32px;padding-top:3px;padding-bottom:3px}',
        // 两行 clamp：-webkit-line-clamp 才是"超过两行才隐藏"的实现，clamp 自带省略号，
        // 所以把 text-overflow 改回 clip，否则会出现两个省略号。
        `html body [class*="_sessionRow"] [class*="_title"]{white-space:normal;text-overflow:clip;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${n};line-clamp:${n};overflow-wrap:anywhere;mask-image:none;-webkit-mask-image:none}`
      ].join('\n')
    }

    /**
     * 每个会话的编号前缀样式表。
     * @param {Array<{id:string,code:string}>} sessions 会话编号表。
     * @returns {string} CSS 文本。
     */
    function codesCss(sessions) {
      if (!Array.isArray(sessions) || sessions.length === 0) return ''
      return sessions
        .filter((item) => item && item.id && item.code)
        .map(
          (item) =>
            `[data-row-key="session:${cssEscape(item.id)}"] [class*="_title"]::before{content:"${cssEscape(item.code)} · "}`
        )
        .join('\n')
    }

    /** 取（必要时创建）一段注入用的 style 节点。 */
    function ensureStyle(id) {
      let node = document.getElementById(id)
      if (!node) {
        node = document.createElement('style')
        node.id = id
        document.head.appendChild(node)
      }
      return node
    }

    /** 读写端点。 */
    async function getJson(path) {
      const response = await fetch(`${API}${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return response.json()
    }

    async function putJson(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return response.json()
    }

    async function postJson(path) {
      const response = await fetch(`${API}${path}`, { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return response.json()
    }

    /** 去抖。 */
    function debounce(fn, wait) {
      let timer = null
      return (...args) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          fn(...args)
        }, wait)
      }
    }

    /** 同步状态：上一轮写入的文本，用来避免无意义的重排。 */
    const applied = { display: '', codes: '' }

    /**
     * 拉一次状态并把两段样式刷新到位。
     * @returns {Promise<void>}
     */
    async function refreshStyles() {
      try {
        const status = await getJson('/status')
        const settings = status.settings || {}
        const display = displayCss(settings.titleLines)
        if (display !== applied.display) {
          ensureStyle(DISPLAY_STYLE_ID).textContent = display
          applied.display = display
        }

        if (settings.sessionCode) {
          const data = await getJson('/sessions')
          const codes = codesCss(data.sessions)
          if (codes !== applied.codes) {
            ensureStyle(CODES_STYLE_ID).textContent = codes
            applied.codes = codes
          }
        } else if (applied.codes !== '') {
          ensureStyle(CODES_STYLE_ID).textContent = ''
          applied.codes = ''
        }
      } catch {
        // 宿主未就绪 / 插件重载中：下一轮再试，不打扰用户
      }
    }

    /** 设置页用到的样式（只用宿主暴露的 --dsw-* token，跟随主题）。 */
    const UI_CSS = `
    .tw-section{display:flex;flex-direction:column;gap:14px;padding:4px 0}
    .tw-head{display:flex;flex-direction:column;gap:4px}
    .tw-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
    .tw-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
    .tw-row{display:flex;align-items:flex-start;gap:8px;cursor:pointer;user-select:none}
    .tw-row-text{display:flex;flex-direction:column;gap:2px}
    .tw-row-label{font-size:13px;color:var(--dsw-alias-label-primary)}
    .tw-row-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
    .tw-field{display:flex;flex-direction:column;gap:4px}
    .tw-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
    .tw-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-button-elevated-fill);color:inherit;padding:5px 8px;font-size:13px;outline:none}
    .tw-input:focus{border-color:var(--dsw-alias-border-brand, var(--dsw-alias-border-l4))}
    .tw-textarea{min-height:76px;resize:vertical;font-family:inherit;line-height:19px}
    .tw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
    .tw-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .tw-btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-button-elevated-fill);color:inherit;padding:5px 12px;font-size:13px;cursor:pointer}
    .tw-btn:disabled{opacity:.5;cursor:default}
    .tw-btn-primary{background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-button-elevated-fill));color:var(--dsw-alias-label-on-primary, inherit);border-color:transparent}
    .tw-note{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}
    .tw-note-err{color:var(--dsw-alias-label-danger, var(--dsw-alias-label-secondary))}
    .tw-advanced summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary);user-select:none}
    .tw-advanced[open] summary{margin-bottom:10px}
    .tw-advanced-body{display:flex;flex-direction:column;gap:10px;padding-left:2px}
    .tw-divider{height:1px;background:var(--dsw-alias-border-l3, var(--dsw-alias-border-l4))}
    `

    /** 一行开关。 */
    function Toggle(props) {
      return h(
        'label',
        { className: 'tw-row' },
        h('input', { type: 'checkbox', checked: Boolean(props.checked), onChange: (event) => props.onChange(event.target.checked) }),
        h(
          'span',
          { className: 'tw-row-text' },
          h('span', { className: 'tw-row-label' }, props.label),
          props.hint ? h('span', { className: 'tw-row-hint' }, props.hint) : null
        )
      )
    }

    /** 一个数字输入。 */
    function NumberField(props) {
      return h(
        'label',
        { className: 'tw-field' },
        h('span', { className: 'tw-field-label' }, props.label),
        h('input', {
          className: 'tw-input',
          type: 'number',
          value: props.value,
          min: props.min,
          max: props.max,
          onChange: (event) => props.onChange(Number(event.target.value))
        }),
        props.hint ? h('span', { className: 'tw-row-hint' }, props.hint) : null
      )
    }

    /**
     * 设置页主体。
     * @returns {object} React 元素。
     */
    function SettingsSection() {
      const [settings, setSettings] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [backfill, setBackfill] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        getJson('/status')
          .then((status) => {
            if (!alive) return
            setSettings(status.settings)
            setBackfill(status.backfill || null)
          })
          .catch((err) => setError(`读取配置失败：${err.message}`))
        return () => {
          alive = false
        }
      }, [])

      const patch = (key, value) => setSettings((prev) => ({ ...(prev || {}), [key]: value }))

      const save = async () => {
        if (!settings) return
        setBusy(true)
        setError('')
        try {
          const result = await putJson('/settings', { settings })
          setSettings(result.settings)
          setNote('已保存')
          await refreshStyles()
        } catch (err) {
          setError(`保存失败：${err.message}`)
        } finally {
          setBusy(false)
        }
      }

      const startBackfill = async () => {
        setBusy(true)
        setError('')
        setNote('')
        try {
          await postJson('/backfill')
          setNote('已开始重算，正在刷新已打开会话的标题…')
          // 轮询进度：重算是后台任务，HTTP 只确认"已开始"
          for (let i = 0; i < 80; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500))
            const status = await getJson('/status')
            setBackfill(status.backfill || null)
            if (!status.backfill || !status.backfill.running) {
              setNote(`重算结束：成功 ${status.backfill ? status.backfill.done : 0} 条，失败 ${status.backfill ? status.backfill.failed : 0} 条`)
              break
            }
          }
        } catch (err) {
          setError(`重算失败：${err.message}`)
        } finally {
          setBusy(false)
        }
      }

      if (!settings) {
        return h('div', { className: 'tw-section' }, h('div', { className: 'tw-note' }, error || '加载中…'))
      }

      const backfillBusy = Boolean(backfill && backfill.running)
      const backfillText = backfill
        ? backfill.running
          ? `重算中 ${backfill.done}/${backfill.total}`
          : backfill.total > 0
            ? `上次重算：成功 ${backfill.done} 条，失败 ${backfill.failed} 条`
            : ''
        : ''

      return h(
        'div',
        { className: 'tw-section' },
        h(
          'div',
          { className: 'tw-head' },
          h('div', { className: 'tw-title' }, '标题轮盘'),
          h(
            'div',
            { className: 'tw-desc' },
            '左侧会话列表的标题最多显示两行，超出才截断；编号按会话创建时间从当天 1296 格里取，同一时刻恒定同号。'
          )
        ),

        h(NumberField, {
          label: '标题最多显示行数（1-3）',
          value: settings.titleLines,
          min: LIMITS.titleLines[0],
          max: LIMITS.titleLines[1],
          onChange: (value) => patch('titleLines', clampNumber(value, 'titleLines', 2))
        }),

        h('div', { className: 'tw-divider' }),

        h(Toggle, {
          label: '在标题前显示时间编号',
          checked: settings.sessionCode,
          hint: '纯代码生成，不进标题数据，模型改写标题也不会冲掉；同一 66 秒内创建的会话会同号。',
          onChange: (value) => patch('sessionCode', value)
        }),

        h(Toggle, {
          label: '用模型生成标题',
          checked: settings.modelTitle,
          hint: '每次发消息后按节流间隔重新总结标题；关掉则保留现有标题，没有标题时用第一条用户消息。',
          onChange: (value) => patch('modelTitle', value)
        }),

        h(
          'label',
          { className: 'tw-field' },
          h('span', { className: 'tw-field-label' }, '自定义提示词（追加在内置提示词之后，留空则只用内置提示词）'),
          h('textarea', {
            className: 'tw-input tw-textarea',
            value: settings.customPrompt,
            spellCheck: false,
            placeholder: '例：若对话中出现需求编号（Confluence 标题【】里的数字，或分支名 feature-<数字>），把编号写成【15474】放在标题最前面，后面接一句不超过 20 字的简述。',
            onChange: (event) => patch('customPrompt', event.target.value)
          }),
          h(
            'span',
            { className: 'tw-row-hint' },
            '内置提示词固定了「一行、纯文本、无 Markdown」这些底线，自定义内容只能在此基础上补充。'
          )
        ),

        h(
          'details',
          { className: 'tw-advanced' },
          h('summary', {}, '高级'),
          h(
            'div',
            { className: 'tw-advanced-body' },
            h(
              'div',
              { className: 'tw-grid' },
              h(NumberField, {
                label: '编号乘数（与 1296 互质）',
                value: settings.codeMultiplier,
                min: LIMITS.codeMultiplier[0],
                max: LIMITS.codeMultiplier[1],
                onChange: (value) => patch('codeMultiplier', clampNumber(value, 'codeMultiplier', 461))
              }),
              h(NumberField, {
                label: '编号偏移',
                value: settings.codeSalt,
                min: LIMITS.codeSalt[0],
                max: LIMITS.codeSalt[1],
                onChange: (value) => patch('codeSalt', clampNumber(value, 'codeSalt', 977))
              })
            ),
            h(
              'div',
              { className: 'tw-grid' },
              h(NumberField, {
                label: '输入字节上限',
                value: settings.maxInputBytes,
                min: LIMITS.maxInputBytes[0],
                max: LIMITS.maxInputBytes[1],
                hint: '超了会保留首条用户消息 + 最近的上下文',
                onChange: (value) => patch('maxInputBytes', clampNumber(value, 'maxInputBytes', 12000))
              }),
              h(NumberField, {
                label: '输出 token 上限',
                value: settings.maxOutputTokens,
                min: LIMITS.maxOutputTokens[0],
                max: LIMITS.maxOutputTokens[1],
                onChange: (value) => patch('maxOutputTokens', clampNumber(value, 'maxOutputTokens', 256))
              }),
              h(NumberField, {
                label: '单次超时（毫秒）',
                value: settings.timeoutMs,
                min: LIMITS.timeoutMs[0],
                max: LIMITS.timeoutMs[1],
                onChange: (value) => patch('timeoutMs', clampNumber(value, 'timeoutMs', 60000))
              }),
              h(NumberField, {
                label: '重算最小间隔（毫秒）',
                value: settings.minIntervalMs,
                min: LIMITS.minIntervalMs[0],
                max: LIMITS.minIntervalMs[1],
                hint: '0 = 每次发消息都重算',
                onChange: (value) => patch('minIntervalMs', clampNumber(value, 'minIntervalMs', 120000))
              })
            ),
            h(
              'div',
              { className: 'tw-grid' },
              h(
                'label',
                { className: 'tw-field' },
                h('span', { className: 'tw-field-label' }, '标题模型 provider（留空 = 跟随会话）'),
                h('input', {
                  className: 'tw-input',
                  value: settings.provider,
                  spellCheck: false,
                  placeholder: '例如 deepseek',
                  onChange: (event) => patch('provider', event.target.value)
                })
              ),
              h(
                'label',
                { className: 'tw-field' },
                h('span', { className: 'tw-field-label' }, '标题模型 model（留空 = 跟随会话）'),
                h('input', {
                  className: 'tw-input',
                  value: settings.model,
                  spellCheck: false,
                  placeholder: '例如 deepseek-v3',
                  onChange: (event) => patch('model', event.target.value)
                })
              )
            ),
            h('div', { className: 'tw-row-hint' }, 'provider 与 model 必须同时填写才生效。')
          )
        ),

        h(
          'div',
          { className: 'tw-actions' },
          h('button', { className: 'tw-btn tw-btn-primary', disabled: busy, onClick: save }, busy ? '处理中…' : '保存'),
          h(
            'button',
            { className: 'tw-btn', disabled: busy || backfillBusy, onClick: startBackfill },
            backfillBusy ? '重算中…' : '重算已打开会话的标题'
          ),
          h('span', { className: 'tw-note' }, backfillText)
        ),
        h(
          'div',
          { className: 'tw-row-hint' },
          '历史会话（磁盘上、当前没打开的）无法在这里重算——宿主的标题刷新只接受本进程里的活会话；它们会在下次发消息时自动重算。'
        ),

        h('span', { className: `tw-note ${error ? 'tw-note-err' : ''}` }, error || note)
      )
    }

    /**
     * 注册设置页 slot。
     * @param {object} ctx 客户端上下文。
     */
    function registerSettings(ctx) {
      const spec = {
        name: 'settings.section',
        id: PLUGIN_ID,
        order: 96,
        label: () => '标题轮盘',
        inject: () => ({})
      }
      const mount = () => ctx.slots.register(spec, SettingsSection)
      if (typeof ctx.effect === 'function') ctx.effect(mount, `${PLUGIN_ID}: settings section`)
      else mount()
    }

    /**
     * 客户端入口。
     * @param {object} ctx 客户端上下文（提供 slots）。
     */
    function apply(ctx) {
      if (typeof document !== 'undefined') {
        ensureStyle(UI_STYLE_ID).textContent = UI_CSS
        refreshStyles()
        setInterval(refreshStyles, REFRESH_INTERVAL_MS)
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) refreshStyles()
        })
        // 新建会话后尽快补上编号；列表本身由 React 渲染，只能靠观察 DOM 变化。
        const observer = new MutationObserver(
          debounce(() => {
            refreshStyles()
          }, 3000)
        )
        observer.observe(document.body, { childList: true, subtree: true })
      }

      registerSettings(ctx)
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply,
      __internals: { displayCss, codesCss, clampNumber, cssEscape }
    }

    return module.exports
  }
})
