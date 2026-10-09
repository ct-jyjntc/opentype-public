# OpenType 0.2.0-beta.20 测试结果与真人复测

日期：2026-10-09。本轮针对滚动条和 UI 比例调整。源码界面验收、编译打包及最终包界面检查已完成；不代表全功能验收通过。

## 构建与交付

[DMG](../../release/testing/0.2.0-beta.20/OpenType-0.2.0-beta.20-macOS-arm64.dmg) · [ZIP](../../release/testing/0.2.0-beta.20/OpenType-0.2.0-beta.20-macOS-arm64.zip) · [SHA-256 清单](../../release/testing/0.2.0-beta.20/SHA256SUMS.txt) · [版本说明](../releases/0.2.0-beta.20.md)

- 源码提交：`74e95f818a212aabfc6e372bee868197e6b20b7f`，已按要求先推送远端 `main`，再从此精确提交重建与打包。
- 类型检查、主进程与渲染层编译：成功。快捷键键帽字体的独立 CSS 修正后，渲染层已单独重建；推送精确源码提交后，主进程与渲染层已重新构建，打包成功。
- 打包、签名结构、DMG 和 ZIP 完整性校验：均成功。包为本地 ad-hoc 签名，未公证；DMG 303,287,071 字节，ZIP 291,548,344 字节。散列与来源见随包 `SHA256SUMS.txt` 和 `BUILD_INFO.json`。
- 原生组件源码本轮不变，复用 beta.19 在私有工作区构建并检查过的四个 Swift helper、OutputAudio 与 IMK/Rime 输入源。

构建证据：[提交后 main/renderer 重建](../../tmp/qa-beta20/build-package.log)、[打包](../../tmp/qa-beta20/package.log)、[签名与完整性](../../tmp/qa-beta20/verify-artifacts.log)、[包内资源](../../tmp/qa-beta20/packaged-resources.log)、[原生复用](../../tmp/qa-beta20/native-reuse.log)。

## 独立真实路径验收

样式作者：`pr1_behavior_review`；独立 Hacker：`pr1_runtime_review`；构建与交付：`pr1_style_review`。只使用隔离配置，禁止从真实用户 profile 取数据；未安装到 Applications 或注册系统输入源。源应用已通过以下独立真实路径；[源界面完整报告](../../tmp/qa-beta20/runtime-source-review.md)记录原始观察与限制。最终 DMG 的界面检查见 [独立交付包报告](../../tmp/qa-beta20/runtime-package-review.md)。键盘引起的滚动位移未明确证实，不列为已验。

| 路径 | 预期观察 | 结果 |
| --- | --- | --- |
| 默认 1080×720 深色首页 | 标题、卡片与留白收紧，右侧统计同屏 | [默认窗口](../../tmp/qa-beta20/runtime-01-home-dark-default.png)；此首张图在最终键帽字体修复前，后续最小/宽窗使用最终构建 |
| 780×580 深/浅色、1280×800 浅色 | 页面可滚动，关键按钮可到达，内容不被截断 | [最小窗](../../tmp/qa-beta20/runtime-02-home-dark-min.png)、[主条拖动到底](../../tmp/qa-beta20/runtime-03-home-scroll-drag.png)、[宽窗](../../tmp/qa-beta20/runtime-08-home-light-wide.png) |
| 设置、Skills 与长代码区域 | 设置末页可到达，Skills 操作可达，代码可横向拖动 | [滚轮到设置末页](../../tmp/qa-beta20/runtime-04-settings-bottom-min.png)、[Skills 按钮可达](../../tmp/qa-beta20/runtime-05-skills-light-min.png)、[长代码横拖至 `END_OF_LONG_CODE`](../../tmp/qa-beta20/runtime-06-code-horizontal-scroll.png) |
| 浅色与深色主题 | 滚动条可辨识，滚动内容正常 | 源应用实际查看；不把未明确观察到的键盘滚动计入验收 |
| 最终 DMG 提取 app，1080×720 明亮主题 | 新样式实际启动，滚动/导航可用，模型校验就绪 | [最终包首页](../../tmp/qa-beta20/runtime-09-package-home.png)、[滚动](../../tmp/qa-beta20/runtime-10-package-scroll.png)、[模型就绪](../../tmp/qa-beta20/runtime-11-package-model-ready.png) |

直接运行既有 `scripts/test-frontend-runtime.mjs` 的 3 项检查均未失败；未运行会重写旧前端文件的构建包装器。类型检查无诊断。本轮不新增或修改测试，不重跑 beta.18 已记录的 refinement/recording-controls 两组旧 fixture 失败；历史检查仅作变更探针，不能代替真实界面验收。

## 真人复测步骤

1. 打开首页、历史、词典与设置，对照旧版本检查标题、按钮、导航和卡片的大小是否适合日常使用。
2. 将窗口缩到最小，再放大。检查横向是否出现意外溢出、底部内容能否滚动到达、弹窗关闭和保存按钮是否始终可到达。
3. 分别用触控板、鼠标滚轮和拖动滚动条检查页面、设置、Skills、历史详情和长文本区域；内外滚动不要互相抢操作。
4. 在浅色与深色主题查看滚动条的常态、悬停和拖动状态；正文、输入框与按钮应可清晰辨认。
5. 保留原有快捷键及听写习惯，复测物理右 Command、自然停顿长录音、结束后的全文输出与跨应用输入。本轮视觉修改不代表这些语音链路已重新验收。

本轮未明确确认键盘滚动位移，不能声称该路径通过；已确认的是滚轮和纵/横向滑块拖动。共享样式覆盖浮窗预览、回答正文和录音存储，但未逐一实际触发这些特殊面板。没有重跑 ASR、长词典编辑、快捷键、麦克风、跨应用输入、云端 Skill 或系统拼音安装业务；Windows、Developer ID/公证及新机器 Gatekeeper 亦未验。模型就绪只确认文件校验状态，本轮未重新做实际识别。源 GUI（PID 43523）与最终包 GUI（PID 48916）均已通过 Command+Q 退出；[隔离路径](../../tmp/qa-beta20/runtime-paths.json)仅供复查，未修改真实用户配置。
