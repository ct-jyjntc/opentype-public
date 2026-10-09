# SenseVoice 与 DeepSeek：实现和验证记录

日期：2026-10-07。分支：`codex/typeless-parity`。TypeLess 完整替代目标继续进行中。

## 模型判断

SenseVoice Small 是低延迟中文本地听写的强候选，现有证据不足以认定它是所有场景的最优模型。官方发布的 Small 覆盖普通话、粤语、英语、日语、韩语；非自回归架构降低了推理时间，但不是原生流式识别。官方跨基准结论不能直接当成本软件真实用户的准确率。

2026-10-07 阅读的官方来源：

- https://github.com/FunAudioLLM/SenseVoice ：发布范围、基准范围、推理架构、部署与许可说明。
- https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07 ：固定 INT8 模型与 tokens。
- https://api-docs.deepseek.com/api/create-chat-completion ：官方模型、请求结构与关闭思考。

## 本机对比

机器：Apple M4。八条 macOS TTS 音频（Tingting / Samantha），每条两次；内容涵盖中英文短句、数字、改口、技术名词、中英混说和长段落。两者使用相同 16kHz 单声道 WAV、自动语言模式。SenseVoice 使用 sherpa-onnx-node 1.13.8 / CPU 两线程 / INT8 / ITN 开启；Whisper large-v3-turbo 使用 whisper.cpp / Metal / 四 CPU 线程 / HTTP inference。

| 观察 | SenseVoice Small INT8 | Whisper large-v3-turbo |
| --- | --- | --- |
| 模型文件 | 239,233,841 字节 | 1,624,555,275 字节 |
| 短句处理时间，3.7–10 秒音频 | 76–181 ms | 2,952–3,566 ms |
| 长段处理时间，17–24 秒音频 | 339–448 ms | 3,359–4,110 ms |
| 加载后整个进程 RSS | 893 MiB | 1,770 MiB |
| 内存观察 | 进程高水位约 962 MiB | 请求结束采样最高约 1,791 MiB |

内存列测量方法不同；Whisper 的主机 RSS 不完整表示 Metal 分配。不能用这些数值证明最低设备要求。处理时间不含录音、润色、界面和插入，不是用户端到端延迟；Whisper 含 HTTP 开销。此前强制语言的两句烟测较快，本次为自动语言模式，不能混用两轮数字。

准确度观察：

- 两者的普通中文、普通英文和长段内容基本保留了原意。
- 中英混说句中，SenseVoice 把 TypeScript / API / GitHub / pull request 识别成 `typepescript` / `AI` / `geh` / `po request`，Whisper 更好地保留了这些词。
- 英文技术词句中 SenseVoice 也出现 Typescriptri / Postger SQL / Po request；Whisper 将 pull request 写成 pool request，但其余术语更完整。
- 两者都把“八五折”转成了“85折”，这是有语义影响的数字归一化错误，不能算标点差异。

因此保留两种可选模型，未强制覆盖原有 Whisper 选择。原始记录见 [JSON 报告](local-asr-comparison-2026-10-07.json)，可用 `scripts/compare-local-asr.mjs` 重跑。尚未用真人、口音、噪声或大规模语料验证，不报告综合准确率或全模型排名。

## 已实现

- SenseVoice 独立 Electron utility process：主线程不运行模型；只允许一个在途任务，超时和取消终止本次进程，迟到结果不插入，空闲两分钟退出。下一次请求按需加载。
- 按实际文件头识别 WAV / Ogg Opus；压缩解码也在子进程。限制编码字节和解码后长度，静音不生成文字；超过 30 秒和明确不支持的语言走 Whisper。自动模式目前仍只有五语能力。
- 设置窗口为可构建的自有源码，从托盘打开，可选择模型、下载模型、启停 DeepSeek、保存独立 API Key。下载固定版本，流式写入、校验长度和 SHA256、校验通过后改名，失败移除部分文件并允许重试。
- DeepSeek 官方非思考模式，独立密钥，不把密钥或音频发给本地网关。网关支持单次禁用润色，避免重复调用。听写失败可保留原文，翻译/编辑失败明确返回失败；取消、空结果、截断输出和意外思考内容不作为完成结果插入。
- 用户提供的密钥在系统安全存储下加密成一次性待导入配置，避免覆盖正在运行的旧版配置。新版启动导入；只有确认密钥已加密持久化才删除待导入文件。配置 IPC 与设置窗口仅返回密钥是否存在。
- 原生模块在 ASAR 外展开；打包包含模型出处及许可证。权重不写入 Git 或安装包。

## 验证证据

- typecheck、完整 `npm test`、网关 30 个断言、现有无 GUI e2e 16/16、主进程/前端构建与 `git diff --check` 通过。
- 新增八组 DeepSeek 协议及故障场景：官方 URL、独立认证、关闭思考、仅文字、目标语言、选中文本、截断/空响应/意外思考、取消、重定向拒绝、原文恢复、网关不重复润色、一次性加密配置持久化。
- 新增进程与下载测试覆盖忙碌、超时、崩溃、旧请求/旧进程结果、取消、重新加载、WAV 块边界、解码长度限制、错误下载清理和并发下载去重。
- 真实 Electron utility process 识别 WAV 和 Ogg Opus，通过静音、损坏格式、长音频保护、忙碌、取消后再识别、空闲释放后再识别、语言/长录音回退测试。
- 真实系统安全存储下导入用户密钥的隔离副本，检查落盘不含明文、重新打开可解密。用户的待导入原件仍保留，真实历史与登录未改动。
- 实际设置页保存 SenseVoice，退出并重启后仍选中该模型，并显示密钥已保存；UI 只显示空的密码输入框。
- 官方 DeepSeek 三次真实文本请求：改口整理 873 ms、翻译 507 ms、选中文本礼貌改写 724 ms，均正常停止、非空、没有思考内容。输入均为合成例句，没有用户音频或真实上下文。
- 独立目录中的 macOS arm64 打包成功。通过打包 ASAR 内的 worker 重跑真实 WAV / Ogg Opus 和生命周期测试，证明原生依赖、动态音频解码依赖可从包内加载。未重新发布或替换正在运行的旧安装包。

## 仍需完成

真人语料和录音到插入的延迟；个人词典/技术名词纠错；数字与单位保真；低配置设备测试；长录音原生分段/VAD；Whisper 的开箱安装与服务管理；完整自有前端、HTTPS、同步删除/账号隔离、跨应用输入、签名更新与其他平台。一次模型烟测与构建通过不代表达到 TypeLess 产品完整度。
