# OpenType 维护说明

公开仓库：<https://github.com/ct-jyjntc/opentype-public>。

此仓库从审核后的 beta.22 源码快照开始，不包含旧仓库 Git 历史、私有部署配置、凭据、开发者账号信息、本机运行数据或安装包。旧版本的维护记录保留在私有仓库中。

当前产品专注语音输入：SiliconFlow 云端及可选本地 SenseVoice Small、自然停顿提前识别、不限总录音时长、Skills、历史、语音词典及安全文字写入。拼音输入组件和本地 Whisper 已移除。新安装默认云端；升级保留已有本地选择。本地模型支持“下载并启用”，优先复用包内模型，缺失时从官网固定版本地址下载，取消不改变原选择。云端语音与可选文字整理使用独立密钥，在“设置 → 听写模型”由用户配置。应用标识及用户数据迁移规则保持不变。

账户后端统一为 `https://api.opentype.top`，客户端登录、注册、令牌刷新、历史与词典同步均使用此地址；不再允许通过账户页面或配置 IPC 更改它。旧空地址或自定义服务的会话不会迁移到官方域名，原有本机历史和词典保留。官网与安全验证页由 `www.opentype.top` 提供，账号域名仅提供 API。beta.25 登录和注册在应用内完成 Turnstile；生产必须配置服务端验证密钥，旧版新登录需要升级，已有会话保留。此固定地址不影响用户的 SiliconFlow 与文字整理密钥。官方源站已使用 Node 24 LTS、专用 nginx 与公信证书部署，并启用仅作用于该主机的 Cloudflare 代理、严格 TLS 和不缓存规则；具体操作与验收边界见 [部署说明](docs/deployment/official-account-api.md)。

- 开发与构建见 [README](README.md)。
- 密钥配置、泄露处理与提交前检查见 [SECURITY](SECURITY.md)。
- 最近版本行为与已知验收范围见 [beta.26 版本说明](docs/releases/0.2.0-beta.26.md) 和 [真人复测清单](docs/testing/OpenType-0.2.0-beta.26-真人复测.md)。
- `docs/releases`、`docs/reviews`、`docs/testing` 中较早内容为历史记录，不代表当前功能；其中引用的旧提交、内部运行报告和安装包不随公开快照提供。

不要将真实 API Key、JWT 签名密钥、邮件服务凭据、用户 profile、录音或云端部署数据写入文档、测试 fixture 或源码。

## 历史前端兼容性探针

旧 `frontend/` 分发 bundle 包含上游遥测配置，且不是当前应用的生产构建输入，因此不随公开快照提供。当前可编辑前端位于 `src/renderer`，由 `npm run build` 构建。

`build:frontend-compat`、`test:ipc-voice` 和 `test:frontend-runtime` 仍作为历史资产保留，依赖旧私有参考文件。缺少文件时会明确报错，不能将其视为公开构建失败或已通过。`npm test`、`verify`、`verify:all` 等历史聚合命令也包含这些探针，不能作为此公开快照的可用性结论。不要为执行这些探针而重新提交私有 bundle。
