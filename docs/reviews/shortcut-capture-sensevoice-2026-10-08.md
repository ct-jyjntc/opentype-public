# 按键录入、SenseVoice 长音频与 Whisper 清理

## 根因

旧“修改快捷键”只是普通文本输入框，没有键盘录入器；主进程仍把右 Command 等全局事件送给听写状态机。结果是用户按键既不能填写字段，还会启动录音。

## 实现

- 主进程 `ShortcutCapture` 管理带所有者与会话 ID 的录入状态，优先消费事件，录入期间不进入热键状态机。
- 全局原生事件识别 Fn 与左右修饰键；聚焦窗口的 `before-input-event` 同时覆盖普通按键，避免依赖全局权限才能编辑。两条来源去重，防止丢失 keyUp 时普通键候选无限累积。
- 窗口失焦、导航、销毁和渲染崩溃都清理录入监听；旧会话的结束请求不会关闭新录入；退出后吸收仍按住的按键释放与延迟事件。
- SenseVoice 无 Whisper 回退。删除最短/最长会话检查与 30 秒解码拒绝，使用内部连续分段，优先在低能量位置切分，每个样本只属于一段。顺序合并文本，并在每段后发送进度，刷新停滞看门狗。

## 删除内容

- `gateway/models/ggml-large-v3-turbo.bin`：1,624,555,275 字节。
- Homebrew `whisper.cpp 1.9.4`：已卸载；没有已安装的反向依赖，没有自动清理共享依赖。
- Whisper 专属 Homebrew 安装缓存、manifest、formula 缓存与两份空临时 WAV 已删除。
- 移除 Whisper 栈启动脚本、比较与单独评测脚本，并清理启动命令。
- SenseVoice 模型文件校验通过。HTTP 协议回归适配器保留，不参与桌面本地识别。

## 证据

- `npm run verify:all`：退出码 0。
- `npm run test:local-asr:host`：真实 Electron utility process + SenseVoice 模型，WAV 与 Ogg Opus、75 秒以上音频的 15 次目标句、取消/重启/空闲释放通过；Whisper 程序与模型已删除后执行。
- `test:capture-session`：11 场景通过，含 0.1 秒短音频和 541 秒不自动停止。
- `test:local-asr`：541 秒 WAV 无截断，分段样本总数与原音频相等，进度超过总超时时间仍能完成。
- `test:shortcut-capture`：右 Command、普通键、组合键、重复/缺失释放、取消与恢复通过。
- `test:keyboard:host`：原生 RightCommand → Koffi → 录入器，录入候选正确且没有 start 事件；监听恢复与 8300 次启停回归通过。
- 实际源码界面：F8 → A → Control+1 候选逐次替换，保存成功；Esc 取消成功；模型页只显示 SenseVoice，文件校验通过。

UI 自动化工具不支持单独发送纯修饰键，因此实体右 Command/Fn 的操作与长时间麦克风录音仍列入真人复测，不把进程内原生事件测试等同于物理键盘验收。
