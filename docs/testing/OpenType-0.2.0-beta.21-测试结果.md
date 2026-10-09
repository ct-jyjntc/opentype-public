# OpenType 0.2.0-beta.21 测试结果与真人复测

日期：2026-10-09。本轮移除内置系统拼音，保留语音输入。macOS 编译打包、独立原生输入、本地 HTTP、最终包界面及包内 SenseVoice 转写均已取得证据；下列未验范围继续保留，不代表全功能或麦克风端到端验收完成。

## 构建与本机组件清理

- 版本：`0.2.0-beta.21`。冻结源码后完成编译和类型检查，提交为 `2876eb0b4610b6ecf7e567dc6fad09cccd042c3f` 并推送 `main`，随后生成安装包。
- `npm run native`、`npm run typecheck`、`npm run build:main`、`npm run build:renderer` 均完成，无编译错误。
- 新版原生构建只产出四个 Swift helper 和 OutputAudio；打包资源保留 SenseVoice Small。新输入 helper 保留目标捕获、准备、提交、结果验证、剪贴板和观察能力，不再导出 OpenType 拼音专用交接函数。该项只是资源与接口检查。
- 主仓库旧 `native/input-method/build` 已确认为仅含旧拼音组件和 SDK 的生成目录，通过系统废纸篓 API 移至 `~/.Trash/build`，空父目录已移除。个人词库、配置和历史安装包保留；见 [生成内容清理记录](../../tmp/qa-beta21/local-build-cleanup.log)。
- 本机 `~/Library/Input Methods/OpenType Pinyin.app` 确认为非符号链接目录，深度严格签名及 `dev.opentype.inputmethod` 身份校验成功，旧组件 `--prepare-removal` 返回 0 后，通过系统废纸篓 API 移至 `~/.Trash/OpenType Pinyin.app`。个人词库与配置目录未删除；其他输入法未操作。

[DMG](../../release/testing/0.2.0-beta.21/OpenType-0.2.0-beta.21-macOS-arm64.dmg) · [ZIP](../../release/testing/0.2.0-beta.21/OpenType-0.2.0-beta.21-macOS-arm64.zip) · [SHA-256 清单](../../release/testing/0.2.0-beta.21/SHA256SUMS.txt) · [构建来源](../../release/testing/0.2.0-beta.21/BUILD_INFO.json)

DMG 为 300,102,421 字节，SHA-256 `e1c22b37cb8fe6cfa9c193cd357465bd9b73da5c3659b08beefb3d96f3753cb9`；ZIP 为 288,508,465 字节，SHA-256 `44a79194193a1714ad120d4c8e1c72a9ccc3ef967e388a98b7f98a97b66450ef`。本地 ad-hoc 签名，未公证。`codesign --verify --deep --strict`、DMG 与 ZIP 完整性检查通过；包内五个语音 helper 与模型存在，没有拼音、Rime、IMK、TSF 或 Whisper 组件路径。资源与完整性检查不能代替包内真实运行。

编译记录：[native](../../tmp/qa-beta21/native-build.log)、[类型检查](../../tmp/qa-beta21/typecheck.log)、[主进程](../../tmp/qa-beta21/build-main.log)、[渲染层](../../tmp/qa-beta21/build-renderer.log)。本机组件清理：[安全移除记录](../../tmp/qa-beta21/installed-input-source-removal.log)。

打包记录：[打包](../../tmp/qa-beta21/package.log)、[签名](../../tmp/qa-beta21/verify-codesign.log)、[DMG](../../tmp/qa-beta21/verify-dmg.log)、[ZIP](../../tmp/qa-beta21/verify-zip.log)、[包内资源](../../tmp/qa-beta21/packaged-resources.log)。目标变化后的保护结果见 [独立截图](../../tmp/qa-beta21/runtime-02-native-target-changed.png)。

## 独立验收状态

桌面和服务端修改：`pr1_behavior_review`；原生、构建和交付：`pr1_style_review`；独立 Hacker 与真实路径验收：`pr1_runtime_review`。以下按实际取得的证据更新，未完成项不能视为通过。

| 用户路径或检查对象 | 本轮状态 | 验收依据 |
| --- | --- | --- |
| 带旧拼音配置与数据库表的隔离环境启动 | 已验证启动及旧表计数保留 | [启动日志](../../tmp/qa-beta21/runtime-source-launch.log)确认主窗口和托盘就绪；关闭源/包应用后，五张旧拼音表行数前后均为 1/0/1/0/0（[计数记录](../../tmp/qa-beta21/runtime-legacy-after.json)）。只证明隔离数据计数保留，不宣称逐字节一致；新服务数据库未创建拼音表 |
| 服务端三条旧拼音同步路由 | 已验证本地 HTTP 行为 | `POST /user/pinyin/sync/status`、`pull`、`push` 均实际返回 `404 unknown_route` |
| 旧拼音 IPC | 未独立调用 | 已完成源码注册/预加载移除和真实界面入口检查；未通过产品 preload 独立调用旧通道，不从 HTTP 结果推断 IPC 行为 |
| 服务端普通词典创建、回读与同步状态 | 已验证本地 HTTP 行为 | 创建 `SenseVoiceQA21` 后列表回读的 ID、词条和空读音提示一致；同步状态返回 `dictionary_sync_version: 1, revision: 1`。未据此宣称跨设备同步已验 |
| 服务端语音路由的无效请求边界 | 已验证拒绝行为 | 非 multipart 请求返回 `400 expected_multipart`；这不证明转写成功 |
| 桌面语音词典、读音提示与旧历史加载 | 已验证包界面路径 | 最终包加载原有 7 条合成历史及词条；将现有长词的提示改为 `Beta21 pronunciation verified`，保存后列表显示新提示及成功消息（[词典截图](../../tmp/qa-beta21/runtime-05-package-dictionary.png)）。历史详情编辑/回放仍待真人复测 |
| 新原生输入目标捕获与交付 | 已验证专用 AppKit 真路径 | 正式 `deliverToInput` 把选中的 `🙂` 替换为 `【听写成功】`，返回 `status: verified, method: clipboard`；改变原目标内容后，第二次交付被 `injection_target_changed` 拒绝。见 [输入结果](../../tmp/qa-beta21/runtime-input-results.json)、[实际插入截图](../../tmp/qa-beta21/runtime-01-native-insert.png) |
| 包内 SenseVoice 实际转写 | 已验证包内引擎/模型 | 系统 Tingting 合成已知中文句子，包内 worker 与模型输出“明天下午3点开会讨论下个季度的产品路线图。”，退出码 0（[ASR 日志](../../tmp/qa-beta21/runtime-package-asr.log)）。不是实时麦克风端到端证据 |
| 快捷键录入与取消录入 | 已验证包内 F8 路径 | 点击快捷键录入后按 F8，显示 F8 与“听写快捷键已暂停”，未弹听写胶囊；取消后原快捷键未改变（[截图](../../tmp/qa-beta21/runtime-04-package-shortcut.png)）。不等同物理右 Command 或录音取消已验 |
| 最终 DMG/ZIP、签名与包内资源 | 已完成构建与结构检查 | 精确来源、字节数、散列与验证结果见随包 `BUILD_INFO.json`；包 GUI/ASR 依据上方独立路径分别记录 |
| 最终安装包启动与主要入口 | 已验证 DMG 提取 app | 只读挂载后提取 app，以独立旧 QA profile 实际启动；设置导航无拼音输入，并保留账户、设置、听写模型、个性化、Skills、关于、帮助（[截图](../../tmp/qa-beta21/runtime-03-package-no-pinyin.png)） |
| 真人右 Command、麦克风长句自然停顿、录音取消及第三方应用 | 待真人复测 | 按下方步骤记录结果；不可将快捷键录入取消当作录音取消证据 |

完整独立报告见 [运行验收记录](../../tmp/qa-beta21/runtime-acceptance.md)。专用输入 fixture、源码 GUI、交付包 GUI 和临时服务均已停止；测试包未安装到 Applications。Windows 仅做源码审查，没有编译/运行验收，不列入 macOS 真实路径结论。beta.20 的紧凑比例和滚动条继续保留，本轮不把此前视觉验收自动视为全部新语音路径已通过。

服务端真实请求与响应见 [独立 HTTP 记录](../../tmp/qa-beta21/runtime-http-results.json)。这些请求在本地隔离服务执行，没有部署远端服务。未验证云端整理与跨设备同步；完整麦克风→识别→插入的真实端到端路径仍需真人复测。

历史测试不新增、不修改，相关检查只作变更探针；不运行已知旧失败 fixture，也不因拼音 API 已删除而修写历史拼音检查。功能是否成立以独立用户路径记录为准。

## 真人复测步骤

1. 打开首页和设置：页面中不应再有系统拼音、候选窗、拼音词库或拼音同步入口。语音词典、历史、Skills、听写模型和快捷键应仍可进入。
2. 在快捷键设置点击录入按钮，按物理右 Command，再尝试另一组键。录入期间只更新快捷键，不应弹出听写胶囊；Esc 可取消。保存后回到普通文本输入框使用该快捷键。
3. 关闭可选 DeepSeek 整理，在备忘录说“明天下午三点开会，讨论下个季度的产品路线图”。结束后应得到含时间与事项的本地识别文字。记录识别结果与等待时间；首页试听只预览，不应插入外部应用。
4. 使用系统自带拼音或其他日常输入法，先确认当前候选、完成一段键盘文字，再启动语音输入。结束后文字应插入预期位置，旧文字不应意外重复或丢失。
5. 开始听写后按 Esc，分别在录音中和结束后的处理阶段尝试取消。取消后应退出当前状态，不应在稍后突然插入结果。
6. 开始听写后切换应用或改变选区再停止。应用应阻止把结果误写入变化后的目标，并保留可复制的结果；不要使用含未保存重要内容的输入框。
7. 连续说话超过两分钟，期间包含几次自然停顿，最后补一句“以上是全部内容”。录音不应按固定时长自动停止，结束后应给出完整文字；记录末句、重复、漏字、断句及停止到输出的耗时。
8. 打开新录音的历史详情，核对文字与录音，再编辑文字并保存。打开语音词典添加一个专有名称和读音提示，编辑后重启；历史与词条应保留，读音提示不应随拼音输入功能一起消失。
9. 打开 Skills、设置末页与长文本，在最小窗口、浅色和深色主题下检查滚动与按钮可达性；beta.20 的紧凑比例和滚动条应仍保留。
10. 重启应用检查 SenseVoice Small 仍就绪、旧语音历史和语音词典仍保留。旧版个人拼音文件与数据库表应保持原样，本次移除不要求清空个人数据。

每项记录“通过/失败、操作步骤、实际结果、耗时”，异常附应用版本和发生位置。真人麦克风、物理快捷键、长时间自然停顿和第三方应用兼容性需要按上述步骤复测；Windows 构建、Developer ID/公证及新机器首次启动尚未验证。

可复制记录格式：`步骤编号｜通过/失败｜实际文字或界面表现｜等待秒数｜应用名称｜备注`。本机旧组件已移至 `~/.Trash/OpenType Pinyin.app`，并保留个人词库；不要将其误认为新版自动卸载所有设备上的旧输入源。
