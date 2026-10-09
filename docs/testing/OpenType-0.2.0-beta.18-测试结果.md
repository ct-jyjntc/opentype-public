# OpenType 0.2.0-beta.18 测试结果与真人复测

日期：2026-10-09。此版本已完成 macOS arm64 编译打包及部分真实用户路径验收；**不是全功能验收通过**。

## 安装包

[DMG](../../release/testing/0.2.0-beta.18/OpenType-0.2.0-beta.18-macOS-arm64.dmg) · [ZIP](../../release/testing/0.2.0-beta.18/OpenType-0.2.0-beta.18-macOS-arm64.zip) · [SHA-256 清单](../../release/testing/0.2.0-beta.18/SHA256SUMS.txt) · [版本说明](../releases/0.2.0-beta.18.md)

仅提供 Apple Silicon macOS 测试包；ad-hoc 签名，未公证。Windows 缺 SDK/MSVC/运行环境，未编译、未生成可安装包。beta.17 保留，不覆盖历史产物。

## 已有证据

Hacker `/root/packaged_acceptance` 未参与功能编写，从只读 DMG 提取的 app 直接启动，配置全程隔离于系统临时目录；未修改 app、注入脚本、读取真实 profile、注册输入源或授予新权限。详情：[独立产物验收报告](../../tmp/qa-beta18/packaged-acceptance.md)。

| 真实输入/路径 | 观察到的结果 | 证据 |
| --- | --- | --- |
| 新配置首次引导 → 首页 | 页面可见，入口可操作 | [首页截图](../../tmp/qa-beta18/02-home.png) |
| 模型页首次加载及重启 | SenseVoice 校验通过，重启仍就绪 | [首次就绪](../../tmp/qa-beta18/04-model-ready.png)、[重启就绪](../../tmp/qa-beta18/11-restart-model-ready.png) |
| 设置 → 快捷键录入 | F8 与 Command+Shift+K 被识别，保存 F8，Esc 取消另一组合 | [录入截图](../../tmp/qa-beta18/06-shortcut-F8.png) |
| 已设 F8 → 再开录入器 → 按 F8 | 只录入，不启动听写；首页重启后仍 F8 | [隔离截图](../../tmp/qa-beta18/07-active-shortcut-isolated.png)、[重启截图](../../tmp/qa-beta18/10-restart-home-F8.png) |
| Skills 新建 → 保存 → 搜索 → 重启 | 自定义“隔离验收草稿”保留 | [保存](../../tmp/qa-beta18/09-skill-saved.png)、[重启](../../tmp/qa-beta18/12-restart-skill-retained.png) |
| 包内模型/worker + Tingting 中文 WAV/Opus | 输出“明天下午3点开会讨论下个季度的产品路线图。”；超过 75 秒音频返回 15 句 | [实际模型日志](../../tmp/qa-beta18/packaged-asr.log) |
| 词典旧 UUID/hash 迁移、连续改名、删除重建、跨账号操作 | 独立 localhost HTTP + SQLite 复核未发现新反例；旧身份不能删除同名新词条 | [独立复核](../../tmp/qa-beta18/independent-review.md)、[HTTP 输出](../../tmp/qa-beta18/independent-dictionary-http.log) |
| SSE 跨 UTF-8/CRLF 分块、截断、取消 | 实际 loopback 服务收到 stream:true；完整输出、截断回原文、取消无最终待插入文字 | [实际 SSE 输出](../../tmp/qa-beta18/refinement-live-sse.log) |

模型音频来自已知中文文本生成的语音，未通过现场真人麦克风。模型 harness 使用包内 worker/模型，但其宿主不是交付 app 的全部录音流程；不能据此声称自然停顿调度、跨应用插入或实际延迟已验证。SSE 使用合成凭据和本地服务，不代表 DeepSeek 云端服务实测。

独立服务端 Hacker 为 `/root/mac_native_build`；独立 SSE Hacker 为 `typescript_validation`，均未编写对应被验收功能。验收没有新增测试文件。

## 编译与历史检查记录

应用及服务端类型检查、main、renderer、macOS 原生构建成功；DMG 提取副本的 `codesign --verify --deep --strict` 成功。日志：[类型与服务端汇总](../../tmp/qa-beta18/typescript-summary.md)、[原生构建](../../tmp/qa-beta18/native-build.log)、[DMG 提取与签名](../../tmp/qa-beta18/dmg-extraction.log)、[打包](../../tmp/qa-beta18/package.log)。

27 组既有应用脚本均执行，25 组退出 0，2 组旧 fixture 失败：refinement mock 要求非流式，与现行流式预览冲突；recording-controls fixture 在异步准备完成前推送音频/松键，与提前取消保护冲突。没有修改 fixture 或回退功能，不能声称 `npm test` 全通过。服务端历史脚本 215/215。上述数字仅作为变更探针，真实能力结论见前表和对应输出。

## 真人对照步骤

建议每项记录“通过/失败、应用名称、步骤、实际结果、录屏时间”；麦克风和输入权限由您在系统提示中决定。可先保留当前版本，再用本测试包进行复测。

### 1. 原始快捷键问题（右 Command 必测）

1. 打开设置，点击“修改语音输入快捷键”，确认出现“正在监听按键，听写快捷键已暂停”。
2. 物理按下并松开右 Command。预期显示“右 Command”，不出现听写胶囊，不开始录音。
3. 改按 F8 和 Command+Shift+K，预期显示对应键；Esc 取消，旧绑定保持。
4. 保存右 Command，退出并重开，确认绑定保留。再次打开录入器按右 Command，仍只能录入；关闭录入器后才按绑定开始听写，Esc 取消。
5. 分别检查左/右 Command，不应混淆；在准备录音时快速松键，不应出现迟到的录音或文字。

本次工具能验证 F8/组合键，但公开 CUA 不允许单独发送右修饰键，故 **物理右 Command/Fn 仍未验**。

### 2. 长说话与自然停顿

1. 模型页确认 SenseVoice 已就绪；先关闭云端整理以单独观察本地识别。
2. 在空白文本框开始说话，依次说“第一段，明天下午三点开会。”，停顿约 1 秒，再说“第二段，讨论下个季度的产品路线图。”，最后加一句“请保留结尾这一句。”。
3. 连续说话 2～3 分钟，间隔自然停顿；预期不会因 30/60 秒门槛自动结束。中间预览应在停顿后逐步出现。
4. 主动停止，预期只等待剩余处理，按顺序输出全部内容；检查段落边界无漏词、重词，最后一句不丢。
5. 再开始后按 Esc，预期不插入取消的文字；切换目标窗口后检查没有插入错误窗口。记录停止到结果的实测等待秒数。

本轮离线长音频已返回真实结果，以上麦克风/停顿/焦点/延迟路径仍需真人验收。

### 3. Skills

1. 新建“会议纪要”，填“分为讨论、结论、待办三部分；不增加未提到的信息”，保存并重启，确认保留。
2. 在首页手动选择该 Skill；按界面说明自行配置 DeepSeek 后，用不含敏感信息的虚构会议内容尝试听写和文字工作台。
3. 预期输出符合三部分结构；取消运行不应出现迟到结果；切换 Skill 后下一次生效。
4. 开启应用/网站自动规则，检查匹配场景使用指定 Skill，非匹配场景不误用；手动选择优先。

本轮仅确认入口、编辑保存、搜索和持久化，真实云端 Skill 输出未验。

### 4. 拼音安装及与语音交接

本轮未注册系统拼音，以下由您在愿意修改系统输入源的测试环境进行。

1. 设置 → 拼音输入，按界面安装后到系统输入源选择 OpenType。检查真实输入源是否出现，并在文本编辑器输入 `nihao`，候选窗应显示可选中文。
2. 检查数字/空格选词、上下翻页、鼠标候选、回车输出拼音、Esc 取消，以及中英文切换。
3. 保持一段未提交拼音，启动语音并说一句中文；结束后检查原组字和语音完整衔接，无重复提交、丢失或插到其他窗口。
4. 分别试验交接时 Esc、切换应用/输入框、关闭目标窗口；不应有迟到的文本插入。
5. 更新或卸载输入源时保留自定义词库；不强制关闭正在写作的目标应用。

Windows 还需独立验收 TSF 安装、32/64 位应用、更新中连续输入、剪贴板保护与音量恢复；没有 Windows 可执行产物时不能标记通过。

## 复测环境保留

隔离配置：`/var/folders/08/m67pjbwd2dv7gpb38hl1k_d40000gn/T/opentype-beta18-acceptance-s5_1lzo1/profile`。同级 `installed/OpenType.app` 来自 DMG，实例已退出。截图和日志位于 [tmp/qa-beta18](../../tmp/qa-beta18/)，未触碰真实用户 profile、词库和 Applications 安装。
