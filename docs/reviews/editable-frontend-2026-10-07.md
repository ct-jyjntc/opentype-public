# 可编辑前端重建

本批将应用实际加载的前端切换为 React + TypeScript + CSS 源码。主窗口、首次引导、历史、词典、设置、录音浮窗、回答卡片和独立听写设置均由 Vite 构建。旧 `frontend/` 保留作参考，安装包不再复制或加载它。

## 修改入口

| 内容 | 源码 |
| --- | --- |
| 首页、导航、首次引导 | `src/renderer/hub.tsx` |
| 页面、对话框、深浅色样式 | `src/renderer/app.css` |
| 历史、搜索、详情、播放、重试 | `src/renderer/pages/history.tsx` |
| 词典、编辑、CSV 导入 | `src/renderer/pages/dictionary.tsx` |
| 账号、快捷键、语言、设备、外观、个性化 | `src/renderer/pages/settings.tsx` |
| SenseVoice / Whisper / DeepSeek 设置 | `src/renderer/speech-settings.tsx` |
| 录音浮窗与采集生命周期 | `src/renderer/floating-bar.tsx`、`src/renderer/capture.ts` |
| 回答卡片 | `src/renderer/interactive-card.tsx` |
| 共享控件、图标、对话框焦点管理 | `src/renderer/components/ui.tsx` |
| 数据契约、明确列举的 preload 接口 | `src/shared/desktop.ts`、`src/preload/desktop.ts` |
| 本地前端服务、录音会话 | `src/main/services/desktop.ts`、`src/main/services/capture-session.ts` |

### 构建与修改

```sh
npm install
npm run build
npm start
```

开发时先执行一次 `npm run build`。一个终端运行 `npm run dev`，另一个运行：

```sh
OPENTYPE_RENDERER_URL=http://127.0.0.1:7777 npm start
```

修改页面和 CSS 后由 Vite 更新。修改主进程或 preload 后重启 Electron。不要编辑 `dist/`，它是生成目录。

隔离测试可使用：

```sh
OPENTYPE_TEST_USER_DATA_DIR="$PWD/tmp/my-ui-test" npm start
```

这个路径覆盖仅开发态有效，正式包忽略。真实用户目录继续使用 `~/Library/Application Support/dev.opentype.desktop/`。

## 保留与修复

- 复现旧界面的侧栏、历史和词典结构、设置弹窗导航、字体层级与留白。首页与账号区域适配本地免登录使用；未声称所有页面达到逐像素相同。
- 页面通过 preload 明确列举的接口调用真实 SQLite、配置、模型和系统服务；没有使用静态演示数据替代业务。
- 主界面关闭后，常驻浮窗仍是唯一麦克风拥有者。
- 停录等待 AudioWorklet 尾包确认；保存 WAV 后再识别，原生本地识别不依赖外部 ffmpeg。
- 重复停止、取消后迟到结果、旧会话与新会话隔离、录音失败保存和重试均增加回归覆盖。
- 修复 Fn 提前抢占 Fn+Space / Fn+Shift、Esc 取消入口、托盘开始/停止行为。
- 本地词典真实保存、搜索、编辑、删除和 CSV 导入。词条与明确填写的个性化偏好送入 DeepSeek 文本整理；没有自动学习的虚假状态。
- 新安装默认选择 SenseVoice。已有模型配置保留。超过 30 秒或其他语言依然需要本地 Whisper 网关。
- 公共配置只返回明确允许的字段与密钥存在标记，不返回 store 命名空间或明文密钥。
- 所有产品窗口继续启用 sandbox / contextIsolation，禁用 Node 集成；没有旧通用 IPC 对象暴露给新页面。

## 验证记录

- 已通过源码构建、TypeScript、完整 `npm run verify:all`、录音会话 9 个场景、桌面真实 SQLite/API 测试；隔离客户端联调 50/50、服务端 213/213。
- 实际以 Vite 地址加载 Electron，修改首页标题后即时显示新文字，恢复源码后界面恢复，验证源码修改确实作用于实际窗口。
- 真实 Electron UI：导航、词典新增与持久化、设置弹窗、快捷键修改及重启读取，明亮/黑暗/跟随系统切换。
- 固定中文 TTS 通过 Chromium 测试音频设备 → AudioWorklet → WAV → 原生 SenseVoice → SQLite → 历史详情；文本含“明天下午3点开会，讨论下个季度的产品路线图”。测试文件循环播放，因此本次录音中该句重复，不是去重质量评测。
- 详情录音成功解码，播放进度实际前进；同一录音的“重新识别”成功。
- Chromium 音频服务沙箱首次阻止读取测试文件；仅测试启动追加 `--disable-features=AudioServiceSandbox` 后成功读取固定音频。生产窗口和安装包没有该开关。未用此结果冒充真人麦克风测试。
- CUA 的功能键合成没有触发全局事件，因此真机物理 Fn/F8 的验收仍须真人操作；相关完整按键序列的状态机回归通过。

## 仍需确认

真人噪声/蓝牙麦克风、多屏/休眠、各类应用的插入、长录音和语言质量仍需测试。官方 TypeLess 的跨平台能力、自动学习、在线操作、商业签名与公证没有因此全部实现。整体替代目标保持进行中。
