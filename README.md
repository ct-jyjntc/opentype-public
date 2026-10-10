# OpenType

支持云端与本地识别的语音输入法。使用快捷键开始说话，再次按键结束；也可配置为按住说话。识别结果可直接写入当前输入框。

公开仓库：<https://github.com/ct-jyjntc/opentype-public>。当前源码版本为 `0.2.0`。本仓库从经过整理的源码快照开始，不迁移旧 Git 历史、私有部署资料、用户数据或旧安装包。

## 功能

- **SiliconFlow 云端识别**：新安装默认使用 `FunAudioLLM/SenseVoiceSmall`，在听写模型设置中填写自己的 SiliconFlow API Key。录音按片段上传至 SiliconFlow，需要网络；不会自动回退到其他服务。
- **可选 SenseVoice Small INT8 本地识别**：支持中文、粤语、英语、日语和韩语；模型在独立进程中运行，支持 WAV 与 Ogg Opus。
- **自然停顿提前识别**：录音期间处理已完成的片段，停止后补齐尾段并合并全文。总录音时长没有产品限制，仍受设备资源约束。
- **语音输入与安全写入**：快捷键录入、听写、翻译、随便问；插入前校验目标，发生目标变化时保留可恢复内容。
- **写作辅助**：Skills、历史、语音词典、选择文字处理、备份和可选账号同步。
- **可选 DeepSeek 整理**：只上传识别文字与允许的文字上下文；在设置中自行配置 API Key，使用系统安全存储加密。语音识别密钥与文字整理密钥分别保存；本地识别时音频留在设备，启用整理后文字仍会发送云端。翻译和随便问需要文字模型。

当前版本不包含拼音键盘、候选窗、Rime/IMK/TSF 或本地 Whisper。语音词典的发音提示仍保留。应用标识及数据迁移规则保持不变，升级不会主动删除旧版个人词库。

登录、注册和同步使用固定的官方后端 `https://api.opentype.top`，在软件内完成账户操作，无需填写服务器地址。登录和注册的安全验证直接嵌在应用内；`www.opentype.top` 提供官网及验证页，API 域名只提供接口。听写本身无需登录；历史与词典同步分别开启，录音不参与账户同步。个人 SiliconFlow 和文字整理密钥仍在听写模型设置中管理。后端实际可用性需以部署后的端到端结果为准。

## 开发与构建

当前主要支持 macOS Apple Silicon，最低 macOS 13。需要 Node.js/npm、Xcode Command Line Tools；原生模块需针对 Electron ABI 构建。

```bash
npm ci
npm run rebuild:native
npm run build
npm start
```

`npm run build` 编译原生组件、主进程、preload 和 `src/renderer` 可编辑前端。开发时可运行 `npm run dev`；`npm start` 会清除可能导致 Electron 以 Node 模式启动的 `ELECTRON_RUN_AS_NODE`。

麦克风用于录音，辅助功能和输入监控用于全局快捷键及文字写入。按系统提示授予需要的权限；相关权限变更后可能需要重启应用。

选择本地识别时，在设置页点“下载并启用”；准备成功后直接启用，取消或失败保留原识别方式，其他设置草稿仍需保存。优先复用安装包中的有效模型，缺少时从官网固定版本地址下载并校验 SHA-256；云端识别无需下载本地模型。开发态路径为 `gateway/models/sensevoice-int8/`，安装版路径为应用数据目录中的 `models/sensevoice-int8/`。模型权重不放入 Git。出处与许可见 [SenseVoice NOTICE](build/third-party/SenseVoice-NOTICE.md)。

```bash
npm run typecheck
npm run build:main
npm run build:renderer
```

这些命令检查类型与构建，不能代替实际语音、快捷键和写入行为验收。既有测试保留为历史资产；其中依赖私有旧前端参考文件的兼容性探针不适用于独立公开快照，详见 [维护说明](HANDOFF.md)。

## 打包

准备好模型文件后，在 macOS 上生成包含模型的本地测试包：

```bash
npm run pack:beta
```

产物位于 `release/testing/<版本>/`，使用本地 ad-hoc 签名，未公证。发布到用户设备前应自行完成 Developer ID 签名、公证和真人验收；安装包、证书及签名配置不提交 Git。

macOS 临时签名版本使用事务式 ZIP 更新：应用通过固定 GitHub HTTPS 更新源下载并校验 SHA-512，再检查 ZIP 路径、应用 bundle id、应用版本、CPU 架构和 ad-hoc 签名完整性。安装器先在应用同目录准备新版本，等待旧进程退出后切换。包含启动确认协议的新版本会在界面加载并确认进程后清理旧包；未包含协议的旧候选包会在确认进程持续运行后保留旧包备份。bundle id 用于确认应用结构，不代表发布者认证；临时签名更新仍依赖 HTTPS 元数据与其中的 SHA-512。

从尚未包含此安装器的旧版本升级时，需要先手动安装包含新安装器的修复版；公开的旧版不会获得此修复。启动确认记录与失败诊断保存在当前用户数据目录的 `update-install/` 中。

Windows x64 原生源码和 `electron-builder.windows.cjs` 配置保留，需要 Windows SDK、MSVC、CMake 及 x64 Node/Electron。当前仓库的历史验收记录没有 Windows 编译和运行结果，不能视为可用 Windows 发布版。

检查更新、发布页与构建发布配置均使用 `ct-jyjntc/opentype-public`。[0.2.0 正式版](https://github.com/ct-jyjntc/opentype-public/releases/tag/v0.2.0) 提供 DMG、ZIP、更新元数据与校验文件，为临时签名，未经 Apple 公证。

## 目录

- `src/main`：录音编排、快捷键、模型进程、数据库、账号及安全文字交付。
- `src/renderer`：可编辑 React 前端，Vite 输出到 `dist/renderer`。
- `src/preload`：受控桌面 API 桥接。
- `native`：macOS Swift helper、Windows 语音原生组件。
- `server`：官方账号、历史与语音词典同步服务源码；发布版客户端不提供自定义服务器入口。
- `gateway`：历史 HTTP 协议适配器；桌面内置 SenseVoice 不依赖它。
- `docs`：设计、版本说明及历史人工验收记录。

## 安全与验收

真实凭据、部署配置、用户 profile、词库、录音、数据库、备份和日志禁止提交。使用忽略的本地环境文件，提交示例只保留空值或明确占位符；详见 [SECURITY](SECURITY.md)。

当前变更见 [0.2.0 版本说明](docs/releases/0.2.0.md)；上一轮真人复测范围见 [beta.26 复测清单](docs/testing/OpenType-0.2.0-beta.26-真人复测.md)。较早文档为历史记录，可能描述已移除功能。请使用合成内容复测，并在报告中删除密钥、个人数据与部署信息。

## 许可证

本项目以 [GNU AGPL-3.0](LICENSE) 发布。macOS 文字投递（`native/input-helper/TextInjector.swift`）复制自 [VocaMac](https://github.com/VocaHQ/vocamac) 的 `TextInjector.swift`（AGPL-3.0），文件头注明了来源版本和改动。
