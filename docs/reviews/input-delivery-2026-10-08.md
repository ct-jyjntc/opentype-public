# beta.12 输入目标恢复与交付核对

本批沿用 [Typeless / Chatterfly 参考材料的核对结果](reversing-deliverables-assessment-2026-10-08.md)，重点补足选区缓存、密码框过滤及真实输入交付。采用自己的 Swift/TypeScript 实现；没有执行参考目录中的脚本，也没有把伪代码当作可运行完整源码。

## 修复前的问题与现在的行为

活动录音流程原先只凭 bundle ID 恢复应用，无法区分同应用的多个窗口或字段。原生插入的返回值没有被使用，发送粘贴事件也被当成已经成功输入。

现在开始录音时保留原应用实例、AX 输入元素、窗口、UTF-16 选区与当时完整值。Swift 内部句柄只存在于进程内存中，TypeScript 主进程仅持有不透明 token；不写入历史或网络请求。最多保留 16 个活动目标，停止、失败、取消会释放，重复释放无副作用。

在读取内容前拒绝安全框、禁用框和不可编辑的控件；网页只读框不一定提供 AXEditable，因此另外检查 AXValue 是否可编辑。无法读取原文或获取有效选区的控件降级到手动复制。上下文与选中文字来自同一输入元素，网页地址仅沿其祖先查找，再经过原有隐私过滤。AXURL 同时支持字符串与 CFURL/NSURL 表示，避免地址类型不同导致域名过滤遗漏。

结束时只恢复已有应用实例，不重新启动已关闭的应用。恢复窗口、字段和原选区后，等待焦点/选区稳定；再次核对原文未改变、前台进程及精确输入元素一致、选区一致，才向目标 PID 发送一次 Cmd+V。粘贴保留现有剪贴板还原机制。

按 UTF-16 计算预期替换结果，并拒绝越界或拆开代理对的选区。随后只读取目标字段进行核对，不自动重复粘贴：

| 结果 | 用户可见行为 |
|---|---|
| 内容与预期一致 | 完成，历史记录交付已核对 |
| 已提交、无法核对或提交桥接结果不明 | 提示“请核对输入结果”，历史标为待核对，不提供声称“未发送”的重复粘贴引导 |
| 确认未发送：目标变化/关闭/不可恢复等 | 识别保持成功且原文保留，显示“文字已生成，尚未插入”复制卡，历史标为待复制 |

发送后取消不能撤回已发送文字；保存交付元数据失败也不能冒充未发送。提交或核对桥接抛错、返回不完整结果时按不确定处理，避免重复。旧 `services/pipeline.ts` 和兼容 IPC 的即时插入路线没有在本批全面重构，不把活动 CaptureSession 的修复描述为全部旧接口均已改造。

## 真实界面发现的额外问题

1. 同一 Electron 进程恢复窗口时，同步 Koffi 调用触发重入，出现 `Maximum call stack size exceeded` 并退出。准备和提交改为 Koffi 异步调用，AppKit UI 操作派发到主队列；重跑不再崩溃。
2. Chromium 声称 AXSelectedText 可写，调用却没有改变文字。改为一次常规粘贴，随后以实际字段内容核对成功。
3. Chromium 的 AX 选区恢复异步完成，第一轮立即检查会误判失败。准备阶段允许短暂等待焦点与选区稳定，提交前仍严格核对。
4. 网页 readonly 框缺少 AXEditable 标记，原先被当作可编辑。补充 AXValue 能力检查后，readonly 和 password 测试都不返回 token、选区或上下文。

## 验证证据

最终 `npm run verify:all` 通过，日志 `tmp/input-delivery/verify-all-final.log`。新增 `scripts/test-input-delivery.ts` 共 11 组，覆盖异步准备与选区稳定、超时、确认未发送的错误、发送前/后取消、只提交一次、延迟核对、未知桥接错误及重复提交保护。

`test-capture-session` 共 19 组，其中本批新增 4 组：交付失败保留识别和原文、已核对/待核对持久化、发送后取消不影响新录音、发送后保存元数据失败不提供重复粘贴。含 token 不进入历史的断言。原生 Swift 测试覆盖 UTF-16、表情替换、空值/多行/组合字符和非法范围，以及 AXURL 的字符串/NSURL/无效值处理。

使用 `scripts/test-input-delivery-ui.ts` 与 `scripts/native-input-delivery-fixture.swift` 创建独立临时目录和合成文本，由 CUA 操作真实界面，经生产 Koffi/Swift/coordinator 完成：

- Electron A 选中 `Before🙂After` 的表情，切到 B 后交付；A 变为 `Before【听写成功】After`，B 不变。
- 原文先改成 `Before用户新编辑After` 后交付，返回 `injection_target_changed`，保留新编辑。
- 仅移动光标时恢复最初选区并正确替换；原窗口关闭后拒绝交付，剩余窗口不变。
- 独立 AppKit 输入框选中 `Native🙂After` 的表情，明确将 Electron 变为前台后交付；返回原生应用得到 `Native【听写成功】After`，核对成功。反向从原生应用返回 Electron 也成功。
- 原生应用退出后交付返回 `injection_target_closed`，没有重启应用或修改 Electron 字段。
- Chromium readonly / password 框不建立目标、不提供上下文。

主要结果在 `tmp/input-delivery/ui-cross-process-final.json`，其他范围检查在 `ui-window-scenarios.json`、`ui-selection-scenarios.json` 和 `ui-readonly-secure.json`。这些历史调试文件也包含修复前失败；不把其中所有事件都当作通过。最终桥接重跑另存 `ui-final-results.json`。

正式 renderer 使用新临时数据库中的三条合成记录核对显示：待复制、已尝试发送待核对、已确认的状态区别正确；详情可查看完整结果、原始识别文字与未覆盖新编辑的说明。这是显示验证，交付生命周期由上述真实原生链路和服务测试覆盖，不冒充真人麦克风端到端测试。

测试夹具可用 `npm run test:input-delivery:ui` 启动；只允许捕获本次生成的 Electron 或原生编辑器 PID，不读取其他应用。操作只针对合成字段，未修改 `~/Library/Application Support/dev.opentype.desktop/`。

构建、严格 codesign、DMG 结构与只读挂载校验通过；包内 18 个 JS/HTML/CSS 与 dist 完全一致，两个模型文件一致，挂载包的 ASAR、原生输入库与模型文件和构建产物一致。交付目录含检查清单、截图、manifest 和 SHA-256。未安装覆盖 `/Applications`。

## 剩余边界

这不是全应用兼容证明：终端、复杂富文本、第三方代码编辑器、浏览器跨标签页、失效的 AX 实现及多屏仍需真人逐项测试。控件不能可靠暴露原文与选区时会保守回退复制。粘贴事件与用户继续输入之间仍存在系统级时序窗口；检测到不确定结果会提示核对，不能保证与任意第三方编辑器形成原子事务。

AppKit/Chromium 合成字段测试没有真人麦克风、物理键盘或真实模型质量评估。跨应用修正跟踪、真实语料准确率和延迟分布、生产 HTTPS/邮件、云端整体清理与旧孤立录音、Developer ID 签名/公证/更新、多设备和其他平台仍未完成。整体替代目标保持进行中。
