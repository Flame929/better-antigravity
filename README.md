# Better Antigravity

给 Google Antigravity 2 桌面应用（macOS）加的输入框状态仪表和智能压缩。
不修改应用文件：通过应用自带的 Chrome 远程调试端口，把 `hud.js` 注入到主界面网页。

在 Antigravity 2.27 / 2.28 上实测可用。应用更新后，界面结构或内部接口可能变化，需要重新验证。

## 功能
- **上下文仪表**：圆弧表示上下文已用比例（绿 <60%、黄 <85%、红 ≥85%）；中心闪电按 tok/s 从下往上填充，面板按速度评级（≥150 优秀、≥80 正常、≥40 偏慢、更低很慢）并画出最近 5 次的柱状图；5 个点表示本对话已压缩次数。
- **额度仪表**：Gemini 有 5 小时和每周两个限额（来自 `RetrieveUserQuotaSummary`，`GetUserStatus` 只给更紧的那个，作为退路）。圆弧表示 5 小时限额剩余（绿 ≥66%、黄 <66%、红 <33%）；悬停面板两行列出 5 小时和每周；星星只按 5 小时窗口的消耗速度变色，每周窗口的速度只在面板里显示（周窗口看最近 6 小时，不足 2 小时按 2 小时算）；中心 Gemini 星按“当前速度到重置前会用掉剩余额度的多少”分四档，面板里每个窗口都有一条速度刻度，越过竖线就撑不到重置：灰 <50% 完全够用、绿 <90% 大概率够用、黄 <120% 需要节省、红 ≥120% 肯定不够（最近 1 小时内至少观察 5 分钟才出结果，观察不足 30 分钟按 30 分钟算，防止一次大请求就变红）；5 个点表示距离重置的小时数。
- **悬浮面板**：每个仪表各自的详情，用 bento 卡片排版；额度面板分别显示 5 小时和每周的剩余、重置时间和消耗速度；上下文面板里有“智能压缩”按钮和自动智能压缩开关（默认关闭；打开后上下文 ≥75% 且 AI 空闲 20 秒时触发，窗口在后台也会触发；同一对话压缩后 10 分钟内不再自动触发）。
- **压缩防重复与日志**：压缩进度存在 localStorage，HUD 被重新注入后接着跑，30 分钟内不重复发 1/2；AI 最近写过交接文档时只发 2/2 一条。`window.__agHud.log()` 查看最近 50 条事件（含 HUD 被销毁的原因）。
- **快捷键 Ctrl+G**：侧边栏分组在 Status 和原来的分组（Project / None）之间切换。原理：通过 React 上下文找到应用的 `storageService`，改 `projectsGroupBy`。
- **智能压缩**：通过 `SendUserCascadeMessage` 接口在后台发消息，不碰输入框（失败才退回打字方式）。先让 AI 写交接文档 `.agents/handoff/<对话ID前8位>.md`，再执行带 8 节结构指令的 `/compact`，压缩后 AI 按全局规则读回交接文档。

## 文件
| 文件 | 作用 |
|---|---|
| `hud.js` | 注入到页面的 HUD（仪表、面板、智能压缩）；可重复注入，新版替换旧版 |
| `inject.mjs` | 注入器：`node inject.mjs` 常驻；`--once` 注入一次；`--remove` 移除 |
| `install.sh` / `uninstall.sh` | 安装 / 卸载登录后自动运行的 LaunchAgent |
| `GEMINI.md` | 全局规则（交接文档约定），复制到 `~/.gemini/config/GEMINI.md` |
| `tools/safe-inject.mjs` | 体检：`node tools/safe-inject.mjs 30` 注入后 30 秒监测响应、CPU、布局，异常自动卸载 |
| `tools/cdplib.mjs` | CDP 连接小工具，供体检和调试脚本使用 |

## 在新电脑上复现
1. 安装 Antigravity 2 和 Node.js 22 以上。
2. 复制全局规则：`mkdir -p ~/.gemini/config && cp GEMINI.md ~/.gemini/config/GEMINI.md`
   - 注意位置是 `~/.gemini/config/`，**不是** `~/.gemini/GEMINI.md`（后者是旧版 Gemini CLI 的，Antigravity 2 不读）。
3. 先体检一次：打开 Antigravity，运行 `node tools/safe-inject.mjs 30`，看到“✅ 通过”再继续。
4. 没问题再安装自动注入：`bash install.sh`（日志在 `~/.antigravity-hud/inject.log`）。

## 原理要点（排查用）
- **调试端口**：Antigravity 每次启动都开 Chrome 远程调试（`remote-debugging-port=0`，随机端口），端口写在
  `~/Library/Application Support/Antigravity/DevToolsActivePort` 第一行。应用重启或更新后端口会变，注入器每 3 秒重读。
- **主界面**：本地语言服务器提供的网页 `https://127.0.0.1:<端口>/`。
- **语言服务器接口**：页面内 `POST /exa.language_server_pb.LanguageServerService/<方法>`，请求头
  `content-type: application/json`、`connect-protocol-version: 1`、`x-codeium-csrf-token: window.__APP_CONFIG__.csrfToken`。
  - `GetUserStatus`：额度在 `userStatus.cascadeModelConfigData.clientModelConfigs[].quotaInfo`（`remainingFraction`、`resetTime`）。
  - `GetCascadeTrajectoryGeneratorMetadata`：每次模型调用的 `usage`、`streamingDuration`、`chatStartMetadata.contextWindowMetadata`；支持 `generatorMetadataOffset` 增量拉取。
  - `GetCascadeTrajectorySteps`：步骤与状态；支持 `stepOffset`。压缩完成会新增 `CORTEX_STEP_TYPE_CHECKPOINT` 步骤。
  - `GetAllRules`（带 `workspaceUris`、`enablePersonal: true`）：查看应用实际识别的规则，全局规则显示为 `user_global`。
- **插入点**：输入框 `[data-testid="agent-input-box"]`，模型按钮 `[data-testid="model-selector-trigger"]`（外面单独包了一层容器）。
- **斜杠命令**：输入 `/compact` 后回车，会变成 `data-uri="slashCommand:compact"` 的标签，指令要接在标签后面再发送。

## 踩过的坑（改代码前必看）
- **不能让 DOM 变化驱动渲染**：曾用 MutationObserver 一变就重绘，重绘又改 DOM，死循环把应用卡死（渲染进程 CPU 137%，只能强退）。
  现在监听只在 HUD 被挤掉时补挂一次，并有熔断：1 秒渲染超过 30 次自动卸载。
- **判断“AI 这一轮说完了”**：不能看“忙碌”状态（回复太快会看不到），不能看步骤数（用户输入一发出就有），
  也不能看“所有步骤已结束”（调用工具前有几秒空档）。要看：最后一步是不带工具调用的文字回复，并持续 3 秒不变。
- **窗口在后台时**，往输入框插文字会失败（页面没有焦点）；正常使用是点按钮，窗口必在前台。测试时用 CDP `Emulation.setFocusEmulationEnabled`。
- **改完任何代码**，先跑体检：注入后 30 秒每秒测页面响应、CPU 和注入前后布局，仪表必须真的挂在页面上。

## 许可证

MIT，见 [LICENSE](LICENSE)。
