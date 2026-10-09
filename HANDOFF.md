# OpenType 维护说明

公开仓库：<https://github.com/ct-jyjntc/opentype-public>。

此仓库从审核后的 beta.22 源码快照开始，不包含旧仓库 Git 历史、私有部署配置、凭据、开发者账号信息、本机运行数据或安装包。旧版本的维护记录保留在私有仓库中。

当前产品专注语音输入：SenseVoice Small、自然停顿提前识别、不限总录音时长、Skills、历史、语音词典及安全文字写入。拼音输入组件和本地 Whisper 已移除。应用标识及用户数据迁移规则保持不变。

- 开发与构建见 [README](README.md)。
- 密钥配置、泄露处理与提交前检查见 [SECURITY](SECURITY.md)。
- 最近版本行为与已知验收范围见 [beta.22 版本说明](docs/releases/0.2.0-beta.22.md) 和 [真人复测清单](docs/testing/OpenType-0.2.0-beta.22-测试结果.md)。
- `docs/releases`、`docs/reviews`、`docs/testing` 中较早内容为历史记录，不代表当前功能；其中引用的旧提交、内部运行报告和安装包不随公开快照提供。

不要将真实 API Key、JWT 签名密钥、邮件服务凭据、用户 profile、录音或云端部署数据写入文档、测试 fixture 或源码。

## 历史前端兼容性探针

旧 `frontend/` 分发 bundle 包含上游遥测配置，且不是当前应用的生产构建输入，因此不随公开快照提供。当前可编辑前端位于 `src/renderer`，由 `npm run build` 构建。

`build:frontend-compat`、`test:ipc-voice` 和 `test:frontend-runtime` 仍作为历史资产保留，依赖旧私有参考文件。缺少文件时会明确报错，不能将其视为公开构建失败或已通过。`npm test`、`verify`、`verify:all` 等历史聚合命令也包含这些探针，不能作为此公开快照的可用性结论。不要为执行这些探针而重新提交私有 bundle。
