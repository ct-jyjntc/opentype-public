# OpenType 完成度评估

评估日期：2026-10-07（Asia/Shanghai）。源码基线：`82875bb`。范围：当前仓库、现有本地发布目录、隔离测试及服务健康检查。本轮只做评估，未修改业务代码，也未重新发布安装包。

**结论：已具备较完整的产品框架，适合继续内测，但尚不足以作为面向普通用户、可稳定依赖的 TypeLess 替代品。** 核心差距在数据保护、语音任务正确性、故障恢复、安装依赖和发布一致性。没有进行与最新版 TypeLess 的同音频对照测试，因此不对识别率或效果等价性作结论。

## 已经具备的基础

- Electron 桌面外壳、macOS 原生热键/权限/文本注入接口，以及听写、翻译和语音指令的代码路径。
- 本地识别网关、可切换的 provider、转写后润色、历史数据库、账号认证、词典 CRUD 与 CSV 导入、历史同步接口。
- 可成功编译的 Swift/TypeScript/React 源码、已有 arm64 发布包和多组自动检查。

这些基础有实际实现和测试支持；不能由此推导所有功能在真实界面、真实网络和任意应用中均可靠。

## 本轮验证

| 验证 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 当前 tsconfig 包含的客户端源码；不包含 server/gateway 的完整类型检查 |
| `npm test` | 279 个断言通过 | core 29、privacy 27、shortcut 27、auth 25、providers 49、db 47、contract 75 |
| `npm run gateway:build` / `npm run test:gateway` | 构建通过、20 个断言通过 | 网关协议及模拟上游处理 |
| `npm run test:server` | 202 个断言通过 | 临时数据库和真实本地服务进程的接口测试 |
| `npm run build` | 通过 | 4 个 Swift helper、主进程、preload、自有 React 页面可构建 |
| `npm run test:e2e` | 16/16 通过 | 库加载、数据库结构、构建产物检查；没有驱动 GUI 完成语音输入 |
| 针对性缺陷复现 | 5 类问题确认 | 元数据丢失、取消无效、同步失败后无法重试、翻译/指令静默降级、关闭同步仍接受写入 |
| 默认本地网关健康检查 | `127.0.0.1:8090` 连接被拒绝 | 检查时本地网关没有监听；不能用历史性能结果代替当前可用性 |
| 云端健康检查 | `status=ok, asr=false, llm=true` | 云服务在线、报告有 LLM，但报告 ASR 不可用 |

针对性复现使用临时 SQLite、合成文本和本地模拟上游；测试数据已清理。没有运行默认会访问生产服务器并创建账号的 `test:integration`，没有宣称 `verify:all` 全通过。界面工具两次读取 OpenType 窗口超时，故本轮未确认真实麦克风录制、跨应用粘贴、多屏、休眠恢复和整套引导流程；工具超时本身不构成应用崩溃证据。

## 必须优先修复的问题

### 1. 关闭云同步没有阻止数据推送

**优先级：最高，涉及用户隐私。证据：代码追踪 + 隔离服务复现。**

主进程每次历史写入都调用 `sync.schedulePush()`，同步引擎只检查用户和是否已有任务，没有检查 `sync_enabled`。服务端推送接口也没有检查该设置。因此设置面板中的关闭状态不能约束这条上传路径。

隔离服务实测：设置 `sync_enabled=false` 后，推送一条合成历史仍返回 accepted；随后状态仍为 false，但云端记录数变成 1。

证据：[写入后调度](../../src/main/index.ts)、[推送入口](../../src/main/services/sync.ts)、[服务端推送](../../server/src/index.ts)。

验收要求：关闭同步后客户端不发记录，服务端拒绝写入；覆盖关闭时已有在途任务、重启、重新登录三种情况。

### 2. 账号与同步默认使用公网 HTTP

**优先级：发布前必须修复。证据：默认配置、前端产物、在线健康检查。**

主进程与实际使用的前端都内置公网 `http://` 地址，登录密码、认证令牌、同步文本缺少 TLS 传输保护。应用层 RSA 配置也是关闭状态，不能把它视为替代保护。

证据：[默认地址](../../src/main/index.ts)、[前端地址常量](../../frontend/renderer/static/js/DLh7vjiS.js)、[RSA 配置](../../src/main/services/renderer-bridge.ts)。

验收要求：统一 HTTPS 配置并覆盖前端、认证、同步和 WebSocket，校验证书；默认配置禁止明文公网传输。

### 3. 选中文本和上下文在实际语音入口丢失

**优先级：核心功能。证据：真实 SQLite 往返复现。**

`HistoryRepo.byId()` 返回 `modeMeta/audioMetadata/audioContext`，主进程直接传给 pipeline；pipeline 却读取 `mode_meta/audio_metadata/audio_context`。有内容的数据库记录最终被当作空元数据。

复现结果：存有选中文字、上下文和采样率的记录，传给 provider 时 `selected_text` 不存在、`audioContext={}`、采样率消失。模式本身仍可读取，不能把问题描述成所有模式都失效；但“选中文字后要求改写”缺少被改写原文，翻译重试也可能丢失仅存于记录中的目标语言。

证据：[记录装配](../../src/main/index.ts)、[错误字段读取](../../src/main/services/pipeline.ts)。

验收要求：统一记录类型，补从真实数据库一路到 provider 请求的测试；同时规范前端上下文结构到模型所需字段的转换。

### 4. 取消按钮没有取消前端发起的后台语音请求

**优先级：核心交互。证据：隔离 pipeline 复现。**

`voiceFlowForRenderer()` 没有为 `abortId` 注册控制器，也没有传 `signal`；`cancelByAbortId()` 调用的是另一条录音流程的取消方法。测试中取消后 provider 仍返回，结果仍是 `success=true, aborted=false`。

这证明后台计算和等待未被取消；前端有自己的过期结果判断，不能进一步声称每次取消都会误插入文字。

证据：[请求参数](../../src/main/services/pipeline.ts)、[取消实现](../../src/main/services/pipeline.ts)。

验收要求：按请求 ID 管理取消信号，覆盖转写和润色阶段，并忽略已取消任务的后续结果。

### 5. 同步失败记录无法被手动重试

**优先级：数据可靠性。证据：真实 SQLite + 模拟 HTTP 服务复现。**

一次非 OK 服务端响应会把记录标为 `sync_failed`，而待同步查询只选 `pending_upload`。测试服务恢复后再次执行 `pushNow()`，上传数为 0，没有第二次 HTTP 请求。代码中的最大重试次数常量没有形成实际重试流程。

证据：[失败标记](../../src/main/services/sync.ts)、[候选过滤](../../src/main/db/index.ts)、[失败计数](../../src/main/db/index.ts)。

验收要求：实现带退避的有限重试与显式人工重试；临时故障恢复后失败记录能够补传。

### 6. 重启后 provider 可能忽略已经保存的配置

**优先级：配置可靠性。证据：初始化顺序检查。**

provider 在模块顶层构造，而 `initStore()` 要到 `app.whenReady()` 才运行。此时 `getConfig()` 返回默认值，已经保存的 provider、模型、地址和 Key 不会用于首次构造。运行中的 `config:set` 会重建 provider，但启动后没有对应重建。认证和同步实例也提前固定了默认云地址。

证据：[配置回退](../../src/main/index.ts)、[提前构造 provider](../../src/main/index.ts)、[实际读取配置时机](../../src/main/index.ts)、[运行时重建](../../src/main/index.ts)。

验收要求：先加载配置，再构造服务；用非默认地址测试保存、退出、重启之后的真实请求目的地。

## 与成熟替代品的体验差距

### 7. 安装包不具备完整的开箱即用链路

默认使用本地网关，但安装配置只包含客户端和 4 个 dylib，没有 whisper 服务、网关服务或模型的安装与生命周期管理。用户仍需另装 whisper.cpp、下载约 1.5GB 模型并运行脚本。当前本机默认网关不可达；云端也报告 ASR 不可用。

证据：[打包资源](../../electron-builder.json)、[本地启动脚本](../../gateway/scripts/start-stack.sh)、[安装说明](../../gateway/README.md)。

建议补首次模型下载、空间检查、进度/失败重试、服务启动与退出管理、就绪探测。仅“应用窗口能打开”不足以通过首次安装验收。

### 8. 语音链路保留不必要的 WebSocket 等待

实际前端优先尝试 `/ws/rt_voice_flow`，失败后才使用 IPC fallback；正常 fallback 默认等待 `Ku=0x1770`，即 6000ms，弱网标记等条件可改变该等待。当前服务端没有 WebSocket upgrade/对应路由。这是代码路径中的额外等待，不是本轮测得的端到端延迟。

证据：[实际语音 bundle](../../frontend/renderer/static/js/UfR9-a2Z.js)，锚点 `Ku=0x1770`、`sendFallbackEvent`、`/ws/rt_voice_flow`；服务端入口没有对应实现。

建议为本地 provider 直接选择可用链路，再决定是否投入实时服务端实现。

### 9. 词典能维护，不代表能影响识别

服务端有词典 CRUD，但当前客户端 provider、网关 ASR 请求和润色 prompt 没有接入个人词典的读取与使用。没有发现把这些词作为识别提示、纠错依据或个性化参数的完整链路。

证据：[词典存储](../../server/src/services/dictionary.ts)、[语音请求参数](../../src/main/services/pipeline.ts)、[网关 prompt](../../gateway/src/server.ts)、[服务端语音处理](../../server/src/services/voice.ts)。

建议使用公司名、人名、混合英文术语做“添加前/添加后”对照，验证识别与润色确实消费了词典。自动学习用户修正也不能因存在词典页面就视为已实现。

### 10. 翻译和指令失败会被伪装成成功

默认网关在 LLM 失败时返回 ASR 原文，且不带降级标记。隔离测试让 LLM 返回 503：翻译到英文和语音指令两种请求都返回 HTTP 200，正文均为中文原文“明天下午三点开会。”。LocalProvider 又会将其标记为成功。

证据：[网关降级](../../gateway/src/server.ts)、[成功结果映射](../../src/main/services/providers/index.ts)。OpenAI provider 也有失败返回原文的策略，但携带 `refine_failed`。

听写可以明确提示“返回未润色原文”；翻译和改写未完成时应保留录音、明确失败并允许重试。网关还应返回独立 `raw_text`，目前仅返回处理后 `text`。

## 发布与维护差距

### 11. 本地发布目录落后于当前源码

直接解读 `release/mac-arm64/OpenType.app/Contents/Resources/app.asar`，发现其中仍然：

- 待同步队列为空就直接返回，没有最新的完整状态循环。
- 没有 `pushing → syncing` 状态转换。
- 没有 `syncPushTotal` 批次进度变量。

当前源码和本轮构建已包含这些修复。因此该目录中的 `.app` 仍带旧同步行为。此次未挂载 DMG、未下载线上 Release，不能把本地 `.app` 的结果扩展成对每个分发副本的确认。

证据：[当前状态映射](../../src/main/services/frontend-shape.ts)、[当前批次处理](../../src/main/services/sync.ts)、本地 `.app` 的 ASAR 对照结果。

建议版本号绑定 commit，发布前在实际安装产物上回归；修复后提高版本号，避免同为 0.1.0 时更新检查无法辨别。

### 12. 实际前端没有可复现的源码构建链

窗口加载 `frontend/renderer/` 与其 preload；Vite 构建的是另外的 `src/renderer → dist/renderer`。所以本轮 React 构建通过，不能证明实际大界面可以从源码重建。实际前端使用构建产物和字节补丁，长期增加功能、升级依赖、定位问题和验证供应来源都会困难。

证据：[真实前端根目录与 preload](../../src/main/index.ts)、[主窗口加载](../../src/main/index.ts)、[Vite 构建目标](../../vite.config.ts)。

建议逐步建立自有可构建前端和清晰 IPC 类型；同时核实既有界面、字体、素材的授权与来源。本轮没有得出授权合规性的法律结论。

### 13. 分发与运营仍有边界

- 仅有 macOS arm64 打包目标；没有完成 Windows/Linux/Intel Mac 的原生适配与验证。
- 对本地 `.app` 执行 `codesign -dv` 显示 `Signature=adhoc`、`TeamIdentifier=not set`，不是完整的 Developer ID 分发签名。
- 当前更新通道打开 GitHub Release 页供手动下载，`quit-and-install` 没有安装动作。
- 仓库 HANDOFF 记录生产邮件通道未配置；代码确认未配置时只输出验证码日志。本轮未登录服务器检查环境或实际发邮件，因此生产配置现状仍需复核。

证据：[平台配置](../../electron-builder.json)、[更新实现](../../src/main/services/renderer-bridge.ts)、[邮件降级](../../server/src/services/mail.ts)。

## 为什么测试全绿仍不能认定完善

现有测试有价值，但部分“契约测试”只构造一个示例对象，再断言这个对象的字段存在，没有执行真实 IPC handler，例如 [这些断言](../../scripts/test-contract.ts)。这类检查不能发现实际 handler 漏字段或装配错位。标为 e2e 的脚本也明确只覆盖无 GUI 部分。

建议增加少量真正穿透模块边界的测试：真实数据库 → pipeline → provider 请求；实际 preload → IPC handler；同步关闭/失败恢复；非默认配置重启；冷安装 → 录音 → 翻译/改写 → 粘贴。语音品质另设中文、英文、中英混说、专有名词、停顿改口、长段落、噪声场景的固定语料，记录识别错误、误改写、端到端耗时分位数与实际插入成功率。

## 建议推进顺序

1. **先保数据与结果正确**：同步关闭门控、HTTPS、元数据映射、取消、失败重试、配置初始化、翻译/指令的错误语义。
2. **再让新用户真正能用**：本地服务与模型管理、移除无效等待、接入词典、做好离线和上游故障提示。
3. **再完成发布与持续维护**：基于修复后的 commit 出新版并验收实际安装包，补签名、邮件、更新流程，逐步替换不可重建前端。

现阶段适合有环境配置能力的用户参与内测；普通用户下载即用、长期替代主力语音输入工具的目标尚未达到。
