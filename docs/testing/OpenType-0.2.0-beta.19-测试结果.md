# OpenType 0.2.0-beta.19 测试结果与真人复测

日期：2026-10-09。本轮针对 PR #1 前端更新及三项审查修复。已完成编译打包和部分独立真实路径验收，不能视为全功能验收通过。

## 产物与构建

[DMG](../../release/testing/0.2.0-beta.19/OpenType-0.2.0-beta.19-macOS-arm64.dmg) · [ZIP](../../release/testing/0.2.0-beta.19/OpenType-0.2.0-beta.19-macOS-arm64.zip) · [SHA-256 清单](../../release/testing/0.2.0-beta.19/SHA256SUMS.txt) · [版本说明](../releases/0.2.0-beta.19.md)

- 构建源码提交：`e0528858dfc3a785394db40ebe0040d504346b2c`；后续仅补充文档，不修改包内代码。
- 应用类型检查、主进程、渲染层、macOS 原生构建：均成功。四个 Swift helper、OutputAudio 和独立 IMK/Rime 输入源均在私有工作区重新编译。
- 打包、签名结构、DMG 和 ZIP 完整性校验：均成功。包为 ad-hoc 本地测试签名，未公证。DMG 303,302,245 字节；ZIP 291,535,128 字节，散列见随包清单。
- 独立交付包启动与实际用户路径：只读提取 DMG 后使用隔离配置启动，默认 1080×720 深色界面可用，具体结果如下。

构建依赖、原生输出和模型先从主仓库 APFS 克隆到独立工作区，再在私有副本内执行编译；不修改主仓库的共享构建资源。安装包保留 SenseVoice Small，不含 Whisper，beta.18 及更早产物保留。

构建与完整性证据：[build.log](../../tmp/qa-beta19/build.log)、[package.log](../../tmp/qa-beta19/package.log)、[native-artifacts.log](../../tmp/qa-beta19/native-artifacts.log)、[verify-artifacts.log](../../tmp/qa-beta19/verify-artifacts.log)、[packaged-resources.log](../../tmp/qa-beta19/packaged-resources.log)。

## 独立行为验收

功能修复作者为 `pr1_behavior_review`，交付包 Hacker 为 `pr1_runtime_review`；构建负责人为 `pr1_style_review`。原始反例与验证输入来自独立审查。下表使用 Hacker 的实际界面观察，不以历史脚本通过数代替界面或真实输出。报告见 [独立交付包验收](../../tmp/qa-beta19/runtime-acceptance.md)。验收直接启动 DMG 提取的原始 app，并使用独立配置；没有页面注入、mock IPC、真实账号或网络服务。

| 用户路径 | 应观察的行为 | 本轮结果 |
| --- | --- | --- |
| 词典长英文词汇及提示 → 编辑读音追加 `Updated` → 保存 | 两列各自换行，文字不相交，保存后的内容保留 | [换行截图](../../tmp/qa-beta19/runtime-04-dictionary-wrap.png)、[编辑保存](../../tmp/qa-beta19/runtime-05-dictionary-edited.png)；未点击删除 |
| 默认窗口、深色主题 | 首页、历史、词典与 Skills 入口可见且可操作 | 已实际打开；[Skills 截图](../../tmp/qa-beta19/runtime-06-skills-dark.png)；最小窗口和其他主题未复测 |
| 7 条混合历史 → 在历史表单把一条输出从 60 字编辑为 1000 字 | 速度/省时不被人工改长输出影响 | 总输出 5265 → 6205；速度仍为 240 字/分，省时仍为 1 min；[表单保存](../../tmp/qa-beta19/runtime-02-edit-saved.png)、[首页结果](../../tmp/qa-beta19/runtime-03-stats-after.png) |
| 无有效听写统计 | 显示“—”及估算说明 | 本轮未做界面验收 |
| 首页隐私说明 | 同时说明 DeepSeek 文字发送和可选云端同步 | [包内界面](../../tmp/qa-beta19/runtime-03-stats-after.png)已确认；未启用真实云同步 |
| DMG 中的 SenseVoice worker 与模型识别一次中文 TTS WAV | 返回已知原句 | 实际输出“明天下午3点开会讨论下个季度的产品路线图。”；[模型输出](../../tmp/qa-beta19/runtime-packaged-asr.log) |

统计 oracle 使用一条成功普通听写的 60 个有效原文字符及 15 秒音频：速度应为 `60 ÷ (15/60) = 240` 字/分，省时为 `60/40 − 15/60 = 1.25` 分钟，界面取整显示 1 min。其余 6 条为问答、翻译、0 秒文字任务、失败记录、缺少原文及纯标点原文。[合成输入与期望](../../tmp/qa-beta19/stats-oracle.json)独立于实现；[保存后的数据库核对](../../tmp/qa-beta19/runtime-db-after.json)确认编辑文字为 1000 字，而原文仍为 60 字、时长仍为 15 秒。

包内模型通过公开 worker 协议处理本机 TTS 音频，没有真人麦克风输入，也未重复 75 秒长音频。这只能确认本包模型与 worker 可实际识别，不能验证录音、自然停顿调度或跨应用输入。

相关既有检查 `test:core`、`test:privacy`、`test:shortcut`、`test:output-preferences`、`test:db`、`test:frontend-runtime` 均未失败，具体计数见 [历史检查记录](../../tmp/qa-beta19/runtime-checks.md)。本轮未新增或修改测试。beta.18 已记录的 `test:refinement`、`test:recording-controls` 两组旧 fixture 本次未重跑；没有执行完整 `npm test`，不能宣称全套通过。

## 真人复测步骤

1. 安装后打开首页、历史、词典和设置，分别使用浅色/深色主题及最小窗口。检查文字、按钮、滚动和键盘焦点。
2. 词典新增 `ThisIsAnExtremelyLongProductNameWithoutAnySpaces123456789`，读音提示填 `ThisIsAnExtremelyLongPronunciationHintWithoutAnySpaces123456789`。保存后两列不应重叠；确认可以编辑和删除该条目。
3. 检查首页“录音时长”“输出字数”“历史记录”标签，以及速度、省时的口径说明。翻译、问答或纯文字处理输出增加后，不应被计入口述速度；无有效听写记录时应显示“—”。
4. 检查隐私卡片同时提到 DeepSeek 整理和云端同步；按需要分别管理两个设置。
5. 继续复测原始快捷键问题：点击快捷键录入器后物理按右 Command，应只录入、不出现听写胶囊。保存并重启后检查绑定。
6. 使用真人麦克风连续口述 2～3 分钟，间隔自然停顿；检查预览逐段出现、不会因 30/60 秒自动停止、结束后全文无漏段或重复，并记录结束到输出的等待时间。

本轮未复测最小窗口、浅色主题、无统计样本界面、真实云端同步、物理右 Command/Fn、真人麦克风长录音与自然停顿、跨应用输入、系统拼音安装及语音交接。本次也未对删除词条、录音 start/stop/cancel、新机器 Gatekeeper 或 Developer ID/公证做验收。Windows 没有可交付安装包。验收 app 已通过 Command+Q 退出，PID 40139 和模型 worker 均结束；隔离路径记录在 [paths.json](../../tmp/qa-beta19/paths.json)，未修改真实用户 profile、Applications 安装或系统输入源。
