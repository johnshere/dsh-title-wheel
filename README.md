# 标题轮盘 / dsh-title-wheel

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话侧栏加三样东西：

1. **标题两行显示** —— 左侧会话列表的标题原本一行就省略号，现在放得下两行，超过两行才截断；
2. **时间轮盘编号** —— 每条会话标题前面挂一个两位编号（如 `J7 · 需求 15474 优化`），按会话创建时间算出来，同一时刻恒定同号、全天不重号、相邻时间互相错开；
3. **可自定义的模型标题** —— 用模型把整段对话总结成一行标题，提示词末尾可以追加你自己的要求（例如"提取需求编号放在标题最前面"）。

编号是**纯代码**算出来的，走 CSS `::before` 渲染，不写进标题数据 —— 所以模型每轮重写标题都不会把它冲掉。

> 名字里的"轮盘"指的是编号的取法：一天被切成 1296 格，格序号经过一次双射洗牌再拆成两位字符，看上去像轮盘转出来的，但结果是确定的。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 标题多行 | 1-3 行可配，默认 2 行；只有超过行数才显示省略号 |
| 时间编号 | 两位字符（`A-Z 0-9`），默认显示，可关 |
| 模型标题 | 注册唯一 `sessionTitle` provider，每次发消息后重算（带节流） |
| 自定义提示词 | 追加在内置提示词之后，而不是替换它 |
| 模型路由 | 可指定标题用哪个 provider / model，留空跟随会话当前路由 |
| 手动重算 | 一键把**当前已打开**会话的标题重刷一遍；历史会话在下次发消息时自动重算 |
| 失败降级 | 模型超时/报错时保留现有标题，没有标题则用首条用户消息，不会在侧栏弹错 |
| 设置页 | 宿主设置里新增「标题轮盘」一节，配置实时写入 `~/.dsh/title-wheel/config.json` |

## 安装

插件按 **link** 方式安装（源码在 `C:\Workspace\00-packages\dsh-title-wheel`，profile 里只放一个目录链接）：

```powershell
# 1. 把包链接进 profile 的 node_modules
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-title-wheel" `
  -Target "C:\Workspace\00-packages\dsh-title-wheel"

# 2. 在 profile 的 package.json 里登记（dependencies 与 dsh.profile.bundles 各一处）
#    "dependencies":     { "dsh-title-wheel": "link:C:/Workspace/00-packages/dsh-title-wheel" }
#    "dsh.profile.bundles": [ ..., "dsh-title-wheel" ]

# 3. 完全退出 DSH 桌面端（含托盘），重新打开
```

### 必须独占 `session-title` 槽位

宿主的会话标题服务**全局只允许一个 provider**，第二个 `register()` 会直接抛错，导致整棵 plugin tree 加载失败。所以安装本插件时要停掉其它标题 provider：

- 本包自带的 `cordis.patch.yml` 会自动禁用基座自带的 `session-title-llm`；
- 如果 profile 里另外装过标题插件（例如 `@weibaohui/dsh-smart-title`、`@deepseek-ai/dsh-session-title-all-prompts-llm`），请从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里移除，并删掉 `cordis.patch.yml` 里对应的 `insert`。

## 配置

设置 → 标题轮盘。也可以直接改 `~/.dsh/title-wheel/config.json`（改完重启生效）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `titleLines` | `2` | 标题最多显示几行（1-3） |
| `sessionCode` | `true` | 是否在标题前显示时间编号 |
| `modelTitle` | `true` | 是否用模型生成标题 |
| `customPrompt` | `""` | 追加在系统提示词末尾的自定义要求 |
| `codeMultiplier` / `codeSalt` | `461` / `977` | 编号洗牌参数（乘数必须与 1296 互质） |
| `maxInputBytes` | `12000` | 喂给模型的转写字节上限，超了按"首条用户消息 + 最近上下文"裁剪 |
| `maxOutputTokens` | `256` | 输出 token 上限，防止思考型模型把预算烧在 reasoning 上 |
| `timeoutMs` | `60000` | 单次生成硬超时 |
| `minIntervalMs` | `120000` | 同一会话两次重算的最小间隔，`0` = 每次都算 |
| `provider` / `model` | `""` | 标题模型路由，两者都填才生效，否则跟随会话 |

### 自定义提示词示例：把需求编号提到最前面

`customPrompt` 默认留空。填下面这段，标题就会把需求编号写在开头：

```text
若对话中出现需求编号（Confluence 标题里【】内的数字，或分支名 feature-<数字> 里的数字），
请把编号写成【15474】的形式放在标题最前面，后面接一句不超过 20 字的简述。
标题里没有编号时照常写标题，不要编造编号。
```

内置提示词固定了「一行、纯文本、不用 Markdown、优先具体名词」这些底线，自定义内容只能在其之上补充 —— 所以你写坏了也不会把标题变成一段解释文字。

## 编号是怎么算的

```
一天 = 1296 格（36²），每格 66.67 秒
index = floor(当天已过毫秒 × 1296 / 86400000)          → 0..1295
perm  = (index × 461 + 977) mod 1296                   → 双射洗牌（461 与 1296 互质）
编号  = alphabet[perm ÷ 36] + alphabet[perm % 36]       → alphabet = "A..Z" + "0..9"
```

- **同一时间恒定同号**：只依赖创建时间，刷新、重启、重算都不变；
- **全天不重号**：1296 格对 1296 个两位编号，洗牌是双射；
- **相邻时间错开**：不洗牌时相邻格子的编号会挨在一起（`A0, A1, A2…`），洗牌后相邻格子在字符表上相隔 461 或 835 位，扫一眼就能区分先后。

样例（本地时间）：`17:16:11 → J7`、`17:17:11 → W0`。

编号覆盖**全量会话**（含磁盘上没打开的）：会话列表要显示的是历史会话，而 `ctx.sessions.list()` 只给本进程里活着的会话，重启后其它行就没有编号了。所以宿主侧走 `sessionQuery.listSessions()` 拿「live + persisted 的完整语料」，缺这个服务时才退回活会话。

已知取舍：同一格（66.67 秒）内创建的两条会话编号相同。编号本来只是"时间锚点"，撞号不影响阅读；要彻底避免就得加长编号，不值。

## 实现要点

- **双行标题**：覆盖宿主 `ui-workspace` 的 `.sessionRow { height:32px }` 与 `.title { white-space:nowrap; text-overflow:ellipsis }`，改用 `-webkit-line-clamp`。选择器写成 `[class*="_sessionRow"]`，因为宿主 CSS Modules 的类名带构建期哈希前缀（`hIlkoa_` 之类），随版本变化。
- **编号前缀**：客户端把 `[data-row-key="session:<id>"] [class*="_title"]::before { content: "J7 · " }` 注入 document。宿主会话列表没有 shadow DOM，document 级样式表直接生效；`::before` 不参与 React diff，也不占标题文本。
- **不 import 任何 `@deepseek-ai/*` 包**：本插件装在 profile 之外（`link:`），从插件目录往上解析不到宿主的 node_modules（宿主是 Electron，模块压在 `app.asar` 里）。消息对象、流式 chunk 归并都在本地实现，只依赖 `ctx.*` 服务。
- **手动重算只覆盖活会话**：`ctx.sessionTitle.refresh(session)` 内部校验会话是否还在这个进程的 store 里（非活会话直接抛 `session "<id>" is not live in this store`），所以历史会话没法在这里补标题；它们靠 `automatic: 'all-prompts'` 在下次收到用户消息时自动重算。
- **配置不用 schemastery**：改用 JSON 文件 + 插件自己的 HTTP 端点（`/title-wheel/api/*`），避免 schema 与宿主版本耦合。代价是不进宿主原生设置文档，所以我们自带设置页。

## 开发

```powershell
npm run build   # client/index.js → client/bundle.js（包进 window.__ModuleLoader__.load）
npm run check   # 语法检查
npm test        # 42 个单测：编号算法、转写裁剪、提示词清洗、provider 协议、HTTP 端点、客户端 CSS
```

`client/bundle.js` 是构建产物，不要手改。

```
src/index.js      宿主插件：注册 sessionTitle provider、HTTP 端点、回填
src/code.js       时间轮盘编号
src/config.js     JSON 配置读写（原子写、clamp、未知键丢弃）
src/transcript.js 会话日志 → 提示词输入（首条锚点 + 尾部回填裁剪）
src/prompt.js     系统提示词组装、标题清洗
client/index.js   客户端：双行 CSS、编号 ::before、设置页
```

## 许可

MIT
