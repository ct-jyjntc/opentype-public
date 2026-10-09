# 历史 HTTP 协议适配器

当前桌面本地识别只使用 SenseVoice Small，由 Electron utility process 直接运行。此目录中的 HTTP 适配器和测试仅用于协议回归，不再提供 Whisper 启动入口；Whisper 权重与本地程序已移除。

SenseVoice 模型文件保存在 `models/sensevoice-int8`，由桌面构建与原生识别测试使用。

协议测试：`npm run test:gateway`。桌面启动：项目根目录执行 `npm run build && npm start`。
