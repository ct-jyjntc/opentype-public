# 边录边识别交付记录

版本：0.2.0-beta.5。默认模型继续使用 SenseVoice Small int8，不增加其他模型。

## 处理流程

`AudioWorklet → 带会话 ID 的 PCM → CaptureSession → PauseSegmenter → 串行本地推理 → 全文合并 → 可选整理 → 一次交付`

- 以 20ms 音频帧判断音量；累计至少 2 秒且检测到约 700ms 连续低音量时提前提交片段。短录音在停止时仍会完整识别。
- 持续讲话无明显停顿时，最长约 25 秒选择最后 5 秒内的低能量边界。每个采样点只进入一个片段，尾部会留给下一段。
- 模型使用独立进程的 2 个 CPU 线程。后台队列串行执行，停止前已成功完成的片段不会重复推理。
- 停止时先等待 AudioWorklet 尾音确认，然后提交尾段，识别可与录音保存同时进行。慢机器若存在积压，仍需等待未完成任务。
- 完整原始 WAV 保留供播放与重试。DeepSeek、翻译和指令仅在全文合并后运行，录音中不插入中间文本。
- 失败片段在停止时重试一次；持续失败会报错，不把残缺文本当成成功。取消或异常退出终止原生任务并释放队列；迟到音频以会话 ID 和停止确认状态拦截。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm run verify:all` | 通过，退出码 0；含新增 9 项后台识别回归 |
| 采样完整性 | 不同 IPC 块大小、短尾音、低音量及 541 秒连续信号，拼接后逐采样相等 |
| 会话与错误恢复 | 串行队列、积压处理、只重试失败段、旧任务迟到、停止确认、取消重录、一次全文整理及一次插入通过 |
| `npm run test:live-transcription:host` | 真实 SenseVoice + 按实际时长送入的 36 秒中文合成语音通过 |
| `npm run test:local-asr:host` | WAV/Opus、75 秒以上音频、取消重启、空闲释放、模型校验通过 |
| 实际前端 | 隔离配置下约 50 秒循环测试音频，经首页“试试听写”启动/停止，历史记录正常显示结果 |
| 构建与分发 | beta.5 ARM64 DMG 构建通过；`codesign --verify --deep --strict` 和 `hdiutil verify` 通过 |

实际前端使用 Chromium 文件模拟麦克风，测试进程为读取音频文件单独关闭 AudioServiceSandbox；产品构建没有关闭这一沙箱。未替换用户应用，也未读写真实历史和录音。真实键盘、麦克风、系统粘贴和长时间真人口述仍应按复测清单验证。

## 本机时延样本

Apple M4 / 16 GiB；36.037625 秒，三个中文句子各重复两次，句间加一秒停顿。关闭文字整理。

| 方式 | 停止前完成 | 停止到返回文字 |
|---|---:|---:|
| 全部录完再识别，模型已加载 | 0 段 | 668.68ms |
| 录音中提前识别，含首次模型冷启动 | 5 段 | 141.67ms |

该样本停止后等待减少约 78.8%；第 6 段在停止后完成，所有测试句子均保留。后台首段包含模型加载约 977ms，其余段约 129–145ms。这里统计的是测试会话停止至文字结果返回，不包含实体麦克风、真实系统插字和云端文字整理；不是准确率排名或所有设备的性能保证。

## 证据位置

- `tmp/live-transcription/verify-all.log`
- `tmp/live-transcription/benchmark.json`
- `tmp/live-transcription/asr-host.log`
- `tmp/live-transcription/ui.log`
- `tmp/live-transcription/ui-result.png`
- `tmp/live-transcription/package.log`
- `tmp/live-transcription/dmg-verify.log`
- `release/testing/0.2.0-beta.5/`：安装包、真人复测清单、性能记录及校验和。
