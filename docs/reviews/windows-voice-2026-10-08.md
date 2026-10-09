# Windows 语音平台实现：源码批次

本批仅修改源码和构建定义。没有运行 CMake、编译器、类型检查、测试、Windows 应用、界面验收或打包；没有修改真实用户配置。当前 beta.17 DMG 不包含这些改动，也没有新增 Windows 安装包。

## 已写入的链路

- 原生层增加 `native/windows/OpenTypeNative.dll` 的 C++ 实现与 CMake 构建定义。输入、键盘、上下文和设备接口由同一 Windows DLL 导出，主进程按平台选择；macOS 继续加载原来的 Swift 库。
- `WH_KEYBOARD_LL` 在独立原生线程监听按下/松开，区分左右 Ctrl/Alt/Shift/Win、数字、字母、功能键和常用编辑键。只监听，不屏蔽目标应用的按键。
- 键盘钩子只写入有界队列，JavaScript 定时读取，避免系统钩子等待 Electron。队列丢失会取消当前手势；安全桌面切换停止监听，返回后重新连接。本人应用注入的按键用私有标记排除。AltGr 的同时间戳合成 Ctrl 事件单独处理。
- Windows 物理修饰键映射改用虚拟键码。默认右 Ctrl 听写、Ctrl+F8 随便问、Ctrl+F9 翻译，避免默认裸 Alt 打开应用菜单。修复 Alt/Option 别名导致系统保留组合漏检，并排除单独 Win 等常见系统组合。
- 设置、录入器和首页按平台显示 Win/Alt 等键名，新手引导读取实际保存的快捷键，不再固定展示 Fn。
- UI Automation 捕获原窗口、进程、具体元素、文档内容和单一选区。密码框、无法辨认的元素和更高权限进程不获得自动交付令牌；只读选区可以用于卡片处理。
- 原输入框、全文、选区和网页地址在恢复/提交前重新核对。最多恢复一次前台窗口和选区，发送一次粘贴，不通过管理员提升或强制线程输入绑定绕过系统限制。发送前后的不确定状态沿用现有“保留文字、请核对”链路。
- 浏览器及已识别的嵌入式浏览器框架缺少完整网页地址时，外部上下文标为受保护；域名过滤沿用共享上下文规则。已捕获网址变化会使交付和纠词观察失效。
- Unicode 文本和可选 CF_HTML 通过独立 `ClipboardGuard.exe` 交付；先保存可完整回放的剪贴板格式，再核对序列号和目标，最后发送带标记的 Ctrl+V。恢复在剪贴板锁内核对序列号和所有者，主应用退出后由子进程继续恢复，见 [剪贴板独立恢复说明](windows-clipboard-2026-10-08.md)。
- 结果核对比较实际内容，允许 Windows/应用之间的 CRLF、CR、LF 等价表示。插入后纠词观察复用原生目标与原文前后边界，仅将本次插入范围内的修正交给既有审核流程，最长观察一分钟。
- Windows 设备接口接入 MMDevice 枚举、默认输入设备静音查询/控制、系统桌面状态和设备标识散列。实际录音仍由 Chromium `getUserMedia` 完成，设备选择使用浏览器枚举 ID，不把 MMDevice endpoint ID 当作浏览器设备 ID。

## 桌面与安装入口

- 主窗口在 Windows 保留系统标题栏；Dock 和 macOS 工作区操作限定平台。输入目标的原生像素坐标通过 Electron 转为 DIP 后选择浮窗屏幕。
- 麦克风授权/可用性通过用户点击后的 `getUserMedia` 检查并立即关闭测试用流；系统设置入口使用 Windows 麦克风隐私页。Windows 不显示 macOS 的“输入监控授权”按钮。
- 默认日志路径使用本平台应用数据目录；冷启动命令行和启动中收到的 `opentype://auth/callback` 会等待账号与桌面服务就绪后处理，不丢弃首次唤起参数。
- `npm run native` 由 Node 分派到 macOS 脚本或 Windows CMake；`npm start` 不依赖 Unix `env` 命令，`rebuild:native` 使用当前 Electron 的依赖安装流程。
- `npm run pack` 在 Windows 选择独立 NSIS 配置，包含 Windows DLL、SenseVoice Small 模型资源、协议注册和按用户安装；卸载保留用户数据。此处是可执行构建定义，未实际运行。
- 当前 Windows 构建目标为 x64。现有 `sherpa-onnx-node` 1.13.8 的依赖清单提供 Windows x64/ia32，没有 Windows arm64 包；没有将 ARM64 标成原生支持，也没有引入 Whisper 替代。

## 保留的边界与缺口

- Windows 拼音已接入独立引擎、TSF 组字/候选、x64/x86 客户端、安装注册、桌面设置/短语同步与可取消组字交接，见 [拼音说明](windows-pinyin-2026-10-09.md)。macOS IMK 组件不在 Windows 安装定义中；用户可选安装 Windows 拼音组件，也可继续使用既有输入法。
- Windows 外放降音/静音已接入独立进程、持久恢复记录、设备变化和设置页重试，详见 [外放实现说明](windows-output-audio-2026-10-08.md)。Windows 合盖没有同步传感器读取，依赖系统休眠/锁屏事件取消录音。
- 自动输入要求目标提供可用的 UI Automation TextPattern、单一选区与可写属性。不支持的自绘编辑器、复杂多选区、过大的文档或更高权限窗口回到手动复制，不宣称已覆盖全部第三方应用。
- 剪贴板归档目前支持可复制的 HGLOBAL、位图和图元文件格式。IStream/IStorage、设备相关格式、超过归档容量或任一格式读取失败时，拒绝自动粘贴，保留原剪贴板与听写文字。剪贴板被临时占用时由独立进程保留副本并重试。快照仅在内存中，主进程崩溃可触发恢复；同时结束父子进程或整机断电不具备磁盘恢复能力。
- UI Automation 在有消息循环的原生线程串行调用，设置了 UIA 的连接与事务超时；剪贴板备份在独立进程的 OLE STA 上运行，父进程等待时分派 COM 消息。尚无运行证据证明第三方提供者都遵守超时，也不据源码推断延迟或兼容率。
- 键盘钩子只监听，用户自定义组合仍可能同时触发目标应用自己的快捷键。Fn 是否存在独立事件由 Windows 键盘硬件决定，当前不承诺 Fn 支持。
- 用户最新范围仅含 Windows 和 macOS；Linux 与移动端已移出本轮目标。Windows 原生 ARM64 当前不支持，交付目标为 x64。以上包括拼音和组字交接的能力均仅完成源码，不据此宣称运行兼容性或已发布 Windows 安装包。

主要文件：`native/windows/{Common,Keyboard,Input,System}.cpp`、`src/main/native/ffi.ts`、`src/main/native/keyboard.ts`、`src/main/services/hotkey.ts`、`src/main/index.ts`、`electron-builder.windows.cjs`、`scripts/build-native.mjs`。
