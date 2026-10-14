# macOS Developer ID 签名与公证（N2）

对照 [OpenType-0.2.x-对外可用-验收板](../testing/OpenType-0.2.x-对外可用-验收板.md) 的 **N2**，以及 [SECURITY](../../SECURITY.md)。本文件是「对外可用」分发信任清单；**不含**真实证书、API Key 或专用密码。

当前公开构建（如 `electron-builder.macos.stable.cjs`）使用 **ad-hoc**（`identity: '-'`），因打包机尚无 Developer ID / 公证凭据。凭据到位前，N2 只验收「本清单落仓」；实签与公证标 **阻塞**。

## A. 前置（缺一不可）

1. Apple Developer Program 账号。
2. **Developer ID Application** 证书安装到打包机钥匙串（私钥不出机、不进仓）。
3. 公证凭据二选一，仅存 CI 密钥或本机钥匙串 / 私密环境变量：
   - App Store Connect API Key（推荐，最小权限）；或
   - Apple ID + app 专用密码。
4. 打包配置从 ad-hoc 切到真实 Developer ID；DMG / ZIP / helper / 原生组件签名策略按正式链路重核。
5. 证书、`.p12`、API Key、专用密码、公证日志中的秘密 **永不提交 Git**。

## B. 打包与公证步骤（macOS Apple Silicon 主路径）

1. 使用稳定版号（`x.y.z`）构建正式包。
2. 以 Developer ID Application 签名应用 bundle（含 helper、原生组件与必要的 entitlements）。
3. `notarytool submit` 提交 → 等待 **Accepted**。
4. 对安装包执行 **stapler staple**。
5. 机器验收：
   - `spctl --assess --type execute`（或等价 Gatekeeper 评估）通过；
   - `stapler validate` 通过；
   - 干净机器打开无「无法验证开发者」阻断（或仅出现可预期的首次打开确认）。
6. 发布产物：DMG、ZIP、更新元数据、SHA-512 / SHA-256 清单；与现有固定 GitHub HTTPS 更新源对齐。

## C. 更新链路信任

### 不变

- 固定 HTTPS 更新源。
- 元数据内完整性校验（SHA-512 等）与失败可恢复、说明原因。
- 账号 API（`api.opentype.top`）CDN / 缓存须 `no-store`、非 HIT。

### 变更（相对 ad-hoc）

- 信任锚从临时签名的「结构完整」升级为 **Developer ID 团队身份**。
- 从旧 ad-hoc 包升级到首个公证包：保留「先手动装一版含新安装器/新签名的修复包」的过渡说明（与 0.2.1 关于页逻辑一致），再启用应用内更新。

### 权限 / 钥匙串重授预期（供前端文案）

| 签名类型 | 更新后权限预期 |
| --- | --- |
| 临时签名（ad-hoc） | 每次更新后系统可能要求重新授予麦克风、辅助功能、输入监控；首次启动可能再问钥匙串。须在关于页 / 引导中可预期，不作静默失败。 |
| Developer ID + 已公证，且 **Team ID 稳定** | 同开发者更新 **不应** 无故清空上述权限；若仍出现，记为缺陷并回归。 |

建议对外文案要点：

- 未公证（临时签名）包：更新后可能需重新授权麦克风与辅助功能等。
- 正式公证版：使用同一 Apple 开发者团队签名的更新，权限应保持；若系统仍提示，按引导重授并反馈。

## D. 本轮边界

- **N4**（邮件验证码 / 找回密码）本轮不做；账户页继续明示未开放。
- Windows 正式签名不在本清单范围；本文件只覆盖 macOS Developer ID + 公证主路径。
- 实签阻塞解除条件：产品确认证书与公证凭据已装入打包机，且 B 节机器验收通过。

## E. 验收证据（给 QA）

落仓后可先勾「清单就绪」。实签解除阻塞时请附：

1. 构建机器上证书 CN / Team ID（可打码序列号，勿贴私钥）。
2. `notarytool` Accepted 记录（脱敏）+ `stapler validate` 输出。
3. 干净机器首次打开与「关于 → 检查更新」各一截图（无密钥、无个人数据）。
4. 更新失败恢复路径复测记录（合成即可）。
