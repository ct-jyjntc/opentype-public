# 用户提供的 Typeless / Chatterfly 材料：核对与采用方向

日期：2026-10-08。本次核对报告、归档清单、关键伪代码和 OpenType 当前源码，将可验证的实现线索整理为后续开发依据。本次只更新研究文档，没有改变 beta.6 应用行为或安装包。

材料目录：私有参考材料目录（不随公开仓库提供）。

## 材料实际包含什么

| 材料 | 本次确认 | 使用边界 |
|---|---|---|
| `REVERSING_REPORT.md` | 927 行，包含窗口、IPC、数据表、语音链路、原生接口与静态分析限制 | 多轮记录混合，旧章节的数量和完成度不能代替归档核对 |
| `Typeless-2.8.1.tgz` | 227,494 字节，37 个普通文件；包括反混淆主进程、14 个 SQL 迁移及索引 | 实际归档没有 README 所描述的 `dist/`、`node_modules/`、`native/` 链接内容，不能仅凭这个包直接启动完整客户端 |
| `Chatterfly-pseudo-src.tar.gz` | 4,947,047 字节，实际包含 1,087 个类级 `.pseudo.c` 文件，与 manifest 的类数一致 | 是寄存器与跳转级伪代码，存在重复函数和未还原分支，不是可编译源码 |
| `type_chatterfly-for-dev.tar.gz` | 包含报告及上述两个分发包；嵌套两个包与当前目录对应文件 SHA-256 一致 | 是交接集合，不能当成额外的完整前后端工程 |

入口文档声称的“29,004 文件 / 约 867 MB”描述的是更大的研究工作区，并非当前三个小归档自身的内容。本次未独立验证整个研究工作区，也不采用其“完美复刻”措辞作为验收结果。

## 对 OpenType 最有用的六组线索

以下行号均为归档中对应成员的原始行号；类成员路径前缀是 `restored_project/classes/`。

| 参考线索 | 实际证据 | OpenType 当前情况与采用方向 |
|---|---|---|
| 音频分块与结束排空 | `SGAudioChunkAccumulator.pseudo.c:4` 的 append、`:163` 的 drainSynchronously、`:183` 的 flushRemaining；还有 overflow/drop 诊断入口 | 当前已有麦克风 ACK、尾包封口、串行识别与失败保留。增加积压和阶段耗时可观测性比重新接另一套 ASR 更有价值；不能从这些方法名推导 Chatterfly 的分段时长 |
| 稳定文本、临时文本和尾段延迟分开 | `SGMacSpeechSessionData.pseudo.c:4` 追加稳定文本，`:170` 为 asrStableText，`:208` 为 asrTailLatency，`:253` 为 asrTempText | 当前 SenseVoice 是分段离线识别。可明确表示已完成片段、尚未完成尾段与最终全文；不将中间结果自动插入目标应用 |
| 短按、长按、双击及冲突状态 | `YBShortcutRecognizer.pseudo.c:345` / `:380` 取消双击/长按计时器，`:738` / `:1555` 按下/松开，`:2149` 检查单击与双击冲突，`:3931` 抑制单击 | 当前 `hotkey.ts` 是固定 push-to-talk 或 toggle，源码 UI 绑定解析默认 toggle。后续补“短按保持录音、长按松手结束”的统一行为，再决定是否开放双击；右 Command 组合键、Esc、失焦和设置录入隔离必须一起回归 |
| 文本后处理有独立阶段与流式事件 | `SGMacSpeechLLMProcessor.pseudo.c:438` / `:735` 分别启动 pause/post 处理；`SGSpeechPostProcessorSSE.pseudo.c:2355` Pause、`:3286` Skill、`:3629` SSE 消息、`:4668` delta、`:785` cancel | 当前 DeepSeek `stream:false`，音频结束后全文整理一次。可借鉴阶段进度与可取消的流式预览，但最终成功确认之前不插入半句。增加流式显示本身不证明总处理更快 |
| 语音插入后的修正可形成学习闭环 | `SGVoiceEditTracker.pseudo.c:42` / `:47` learned terms 与 edited final text 回调，`:354` settle，`:1258` poll，`:1603` report，`:2583` prepareForVoiceCommit | 当前只有手动词典和显式风格，历史编辑不等于自动学习。优先设计本地、可审阅、可删除的纠词候选；仅跟踪本次插入范围，避免采集无关输入。不从现有伪代码推断完整学习算法或隐私保证 |
| 选中文字与输入环境分开处理 | `SGVoiceSelectionCache.pseudo.c:167` pickSelection、`:277` precacheSelection；`SGSpeechPostProcessInputEnv.pseudo.c:4` isPassword | 当前已有开始录音时冻结上下文和隐私过滤。应补选中文本失焦/切应用/密码框/黑名单域名的实测，不能仅因取得 AX 文本就允许发送上下文 |

Typeless 的主进程和 SQL 迁移可继续作为 IPC、窗口与历史同步契约的参照。OpenType 已有对应架构，此部分主要用于边界查漏；本次材料没有解决我们尚未完成的云端按条删除传播。

## 容易误读的地方

- **Pause 不等于音频 VAD。** 这里的 `startPauseProcessWithSessionData...` 位于 LLM 后处理器，SSE 处理器构造 ASR 文本请求并接收 Pause 等消息。这只能证明存在文本后处理阶段，不能据此复制所谓 Chatterfly 本地 VAD 算法或阈值。
- **分片编码不等于流式识别模型。** Opus/音频累积器、稳定文本字段分别属于音频传输和会话管理，不能证明两款产品使用哪一种 ASR 模型。
- **没有还原服务端能力。** 材料自己的缺口清单明确标注动态 API 协议与鉴权行为未验证；也未提供服务端识别/整理模型权重、训练数据或完整提示词。静态端点列表不能让 OpenType 自动取得同等效果。
- **伪代码须交叉验证。** 抽查 `appendASRText` 存在重复函数块，`flushRemaining` 包含未展开的分支。可采用可证实的职责划分，具体算法、阈值和正确性必须在我们自己的实现与测试中确定。

## 更新后的开发顺序与验收

维持 SenseVoice Small、本地优先、无产品录音时长上限、全文整理一次的既定选择。

1. **补快捷键使用体验。** 短按、长按、组合键干扰、按键重复、键序颠倒、设置录入、Esc、休眠恢复；以无误触、无悬挂录音为通过条件。
2. **补真实延迟证据。** 分别记录停止 ACK、ASR 尾段、文本整理和最终插入完成；使用同一批真人音频比较，汇总典型值与较慢样本，避免只报告一个最快值。
3. **补中文表达偏好与场景整理。** 标点、中英文间距、聊天/邮件/列表偏好；固定改口、数字、专业名词语料，检查完整性和是否增加事实。
4. **补可控纠词学习。** 先从用户明确保存的历史修改提取候选词，确认后写入词典；再评估限于本次输入范围的跨应用修正检测。
5. **继续数据与发布缺口。** 云端删除传播、旧孤立录音的可审查清理、正式签名/公证和真人跨应用验收不因新增材料而视为完成。

上述是当前差距和采用顺序，不是已实现功能清单。整体进度仍以 [持续完善清单](typeless-parity-plan.md) 为准。

## 归档指纹

- Typeless-2.8.1.tgz：`1667c43e7070e6a7975769415fc029d3d158a8b0fe302767f2c4638b2b23e050`
- Chatterfly-pseudo-src.tar.gz：`2cc73b89baafd52c9a76ad574d5d05c1bfe06311f23ba59de0e3a9fcca756d78`
- REVERSING_REPORT.md：`ae65763378199d3550cb7da3f7ed5c932e28daabb17c75ce7db04ac6a9cfa290`

以上为本次实际读取文件的 SHA-256，并核对了开发交接总包内对应成员的一致性；不是对完整研究工作区所有产物的校验声明。
