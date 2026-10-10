# OpenType 官方账号服务

客户端登录、注册、令牌刷新、历史与词典同步固定使用 `https://api.opentype.top`。个人 SiliconFlow 与文字整理密钥仍由客户端管理，账号服务器不需要这些密钥。

截至 2026-10-10，生产运行 0.2.0 的服务端（release 目录 `/opt/opentype/releases/fixes-20261010T1630Z-on-ff9ffcb`，23 个服务文件与 0.2.0 提交中的 `server/` 逐一匹配）。上一版本 `ff9ffcb4364edd4f661e987688d74ff53575ef9b`（beta.25）目录保留用于回滚。下文先记录当前部署，再提供新安装时可选的 Caddy 配方；二者不要混用或同时占用端口。后续更新仍须将线上与新代码双向比较，保护已有配置和数据。

## 当前生产部署

生产使用经 Node 官方 SHA-256 清单校验的独立 **Node 24.21.0 LTS**。应用放在带提交号的 release 目录，通过既有 systemd 服务的 drop-in 切换工作目录和运行时；旧 Node 22、旧代码和原 unit 均保留用于回滚。

既有 JWT、数据库与环境文件保持连续，账号进程只监听 `127.0.0.1:9100`，设置 `NODE_ENV=production`、`TRUST_PROXY=loopback`、`ALLOW_DEV_EMAIL_CODES=false` 和 `UMask=0077`。数据目录权限为 `0700`，数据库、WAL、SHM 和环境文件为 `0600`；部署备份和线上数据库均通过 SQLite 完整性检查。版本切换前保留源码、服务与环境配置及一致性数据库备份，未将生产秘密复制到仓库。beta.25 通过独立的 `/etc/opentype/turnstile.env` 环境文件提供 Turnstile 站点键和秘密键，权限为 `0600`；生产缺少任一配置会拒绝启动。

**专用 nginx 服务**承接 80/443，只服务 `api.opentype.top`；全局 nginx 未启用，主机上原有 cloudflared 保持运行。nginx 只信任 Cloudflare 官方清单的 22 个来源网段提供的客户端 IP，再由本机反代传递给账号服务。

证书使用 Let's Encrypt，当前证书有效期至 **2027-01-07**。Certbot 定时器已启用，专用续期 hook 仅校验并 reload OpenType 的 nginx；Cloudflare 代理切换前后各完成一次带 deploy hook 的续期演练，代理开启后的实际 ACME 路径也已跑通。未来续期仍需监控。

Cloudflare DNS 已开启代理，TLS 严格模式及不缓存规则精确限制于 `api.opentype.top`。独立人员两次请求公网 `/health` 均得到 HTTPS 200、Cloudflare 响应标识及不同请求 ID；缓存状态为 `DYNAMIC`，响应带 `Cache-Control` 与 `CDN-Cache-Control: no-store`。beta.25 未携带安全验证结果的认证请求返回 403，beta.24 及更早应用的新登录返回 426 升级提示，同样不缓存；没有测量各地区延迟或吞吐提升。

此前 beta.24 的历史验收：最终安装包使用全新隔离配置，已由非后端/前端作者的审查者实际完成官方账号注册、确认同步关闭及零历史、退出和再次密码登录。

独立公网验收使用两个合成账号完成历史与词典推送、拉取：账号 A 收到预先指定的原文与词条，账号 B 返回空列表；未开启同步时上传为 403，显式开启后成功。退出后原 access token 请求为 401，密码重新登录成功。上述响应均来自 Cloudflare，缓存为 `DYNAMIC/no-store`；合成账号已清理。刷新轮换、重放撤销等对抗行为在隔离本地真实 HTTP 服务验证，beta.25 部署另用合成账号实际确认部署前的 refresh 在部署后仍可换取新令牌，删除该账号后原 refresh 返回 401。真人多设备、麦克风与跨应用输入仍需复测。

beta.25 最终安装包已由非桌面账户/模型界面作者完成独立真路径验收：内嵌 live Turnstile 注册、退出、再次 live 验证和密码登录成功，账户界面显示同步关闭、零云端历史。首轮合成密码输入不一致已通过服务端只读核验定位，使用准确粘贴的第二账号重验成功；两个合成账号及其 refresh 会话均已精准清理。模型准备失败保持原识别方式、重试后启用本地并校验模型；独立无内置模型的真实 ModelStore 从官网取消下载后清理临时文件，再次完整下载并校验成功。图标资源/模板及应用界面已审，系统菜单栏实机截图未取得。

维护探测应使用与应用一致的 `User-Agent: OpenType/0.2.0-beta.25`，并检查真实 API 响应体；通用爬虫客户端的默认标识可能受到边缘安全策略影响，不能用其结果代替软件路径。

邮件服务尚未配置，因此不能宣称验证码投递与找回密码可用。密码注册、登录及同步不需要邮件网关。

## 运行条件

- Linux 单实例、Node.js 24 LTS（24.12 或更新的 24.x），`node:sqlite` 和 TypeScript 类型擦除均为 Node 内置；`server/` 无第三方运行依赖，不需安装整个 Electron 项目。
- HTTPS 可用当前生产的专用 nginx + Certbot，或下文新安装模板的 Caddy 2.10 及更新版本；Node 仅监听 `127.0.0.1:9100`，不开放该端口到公网。
- 数据库位于 `/var/lib/opentype/opentype.db`，目录仅服务用户可访问；数据库 WAL/SHM 也必须保留。签名密钥跨重启保持不变。
- 密码注册、登录和同步无需邮件网关。验证码登录、找回密码需要提供受信任的 HTTPS 邮件网关和已验证发件地址；缺少它们会返回明确的“邮件服务暂未开放”，不会假装已发送。

## 新安装可选配方：Caddy

先确认 `/usr/bin/node --version` 为受支持版本。在已有主机上，先比较当前 systemd/Caddy/服务文件和配置，仅合并必要修改；以下路径用于新的独立服务，不可盲目覆盖已有部署。

```sh
sudo useradd --system --home /var/lib/opentype --shell /usr/sbin/nologin opentype
sudo install -d -m 0755 /opt/opentype-api/releases
sudo install -d -m 0700 /etc/opentype
sudo install -d -m 0700 -o opentype -g opentype /var/lib/opentype
```

将审查过的 `server/` 内容上传到带提交号的 `/opt/opentype-api/releases/<commit>/`，由 root 持有代码，`opentype` 用户只读。建立 `/opt/opentype-api/current` 指向该目录。不要复制 `.env`、测试数据库、日志或旧私有 Git 历史。

复制 `server/.env.example` 到 `/etc/opentype/server.env`，文件权限设为 `0600`。在主机安全会话里用 `openssl rand -hex 32` 生成一次 `JWT_SECRET`，直接填写到该文件；不要通过聊天、版本库或部署日志传递。生产必须配置 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`，widget 绑定 `www.opentype.top`，秘密键仅存服务端。`TURNSTILE_REQUIRED=false` 仅适用于开发，不能关闭生产验证。其余变量按模板填写。`NODE_ENV=production` 必须保留，`ALLOW_DEV_EMAIL_CODES` 必须为 `false`。邮箱配置可留空，此时密码路径仍可使用。开发回显验证码需要显式 `NODE_ENV=development`、`ALLOW_DEV_EMAIL_CODES=true` 且仅监听回环地址，生产组合会拒绝启动。

将 `server/deploy/opentype-api.service` 安装到 `/etc/systemd/system/`，核对 `ExecStart` 的 Node 路径，再启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now opentype-api
curl --fail http://127.0.0.1:9100/health
curl --fail http://127.0.0.1:9100/oauth/challenge/config
```

服务的健康响应仅说明账号进程已启动；还需完成下文真实账号和同步验收。

## Caddy HTTPS 和 Cloudflare 配置

使用 `server/deploy/Caddyfile` 合并站点配置，保留主机上的其他站点。模板仅信任官方 Cloudflare IP 段提供的 `CF-Connecting-IP`，再由本机 Caddy 写入 `X-Real-IP`；Node 不盲信公网 `X-Forwarded-For`。使用前与 [Cloudflare IP 清单](https://www.cloudflare.com/ips/) 对照，之后随官方调整维护。若已有 Caddy 全局块，合并到其 `servers` 块，不重复添加全局块。

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

在源站 80/443 可达、Caddy 证书正常后，为 `api.opentype.top` 建立指向真实源站的 A/AAAA 或已有受控源站的 CNAME，开启 Cloudflare 代理。TLS 模式为 **Full (strict)**，不可用 Flexible。可先完成 DNS only 和证书验证再切代理，切换后再次验证 HTTPS 和账号路径。

为主机名 `api.opentype.top` 配置 **Cache Rule：Bypass cache**。所有账号与同步响应同时带 `Cache-Control: no-store` 和 `CDN-Cache-Control: no-store`；不要启用 Cache Everything、缓存 POST 或对 API 使用交互式浏览器挑战。Cloudflare 代理提供 TLS/连接复用、压缩和网络层保护，私人同步内容不能为了加速被 CDN 缓存。模板不改变该 zone 其他域名的缓存/TLS配置；如果 zone 全局 TLS 仍为 Flexible，应先评估其他域名再修改，或使用针对该主机的配置规则。

## 后续上线与真人复验

官网页面由 `www.opentype.top` 提供，`api.opentype.top` 只提供 API；旧网页登录和帮助路径不再输出 HTML。客户端在固定官网 iframe 中完成 Turnstile，主窗口核对来源、窗口、请求标识及操作，服务端核对官方验证结果、hostname、action、时效及重复使用。八个认证入口均先验证 challenge；refresh、退出和同步不需要重复挑战。

使用独立的合成账号，通过实际客户端“设置 → 账号”完成内嵌安全验证后注册并登录；确认本机没有服务器输入框。验证退出、重新登录、关闭重启后的会话和失效刷新。令牌不应输出到命令日志。

新账号的历史同步默认关闭；需在账号页显式开启，单独修改保留时间或清空云端也不能开启同步。既有显式设置保持不变。用两台隔离客户端的合成数据验证开启后的历史推送/拉取/删除和词典的显式同步；第二个账号必须看不到第一个账号的数据。完成检查后只清理合成账号，不能碰真实用户内容。验证 HTTPS 响应不含 CDN `HIT`，未经登录的同步请求为 401，注销、删除账号后旧令牌也为 401。生产未配置邮件时，完成安全验证后的邮件验证码请求应为 503 且没有 `dev_code`；缺少安全验证时先返回 403。实际邮件送达需用户明确授权的测试邮箱，不能向随机或真实用户批量发送。

客户端升级迁移会清除旧空地址/自建服务器的会话，并保留历史和词典；旧历史绑定原域或本机范围，避免登录官方账号后自动跨域上传。官方既有账号关闭同步的选择会迁移到该域的账号范围。首次升级前的未绑定历史不会自动上传到新服务。

## 更新、备份和回滚

更新前保存正在运行的提交号和 systemd/实际反代配置，在停止服务后备份数据库及 WAL/SHM（或用 SQLite 的在线备份功能；禁止服务运行时只复制主 `.db` 文件），备份目录权限 `0700`。将新版本上传到新的 release 目录，先对当前远端做双向 diff，保护线上独有修改与密钥文件，再切工作目录和重启。当前生产回滚须恢复切版前备份的 `official-release.conf`，保留现有环境、JWT 和数据库，再执行 `systemctl daemon-reload` 并重启服务；不删除历史 drop-in，以免退回更旧的原 unit 和运行时。新安装模板则切回上一 `current`。默认不恢复旧数据库；只有确认没有新写入、接受数据回退后才恢复备份，避免覆盖新用户数据。

beta.24 新增的 refresh session 索引/字段采用可重复执行的数据库迁移。该版迁移前的 access token 会被拒绝，需要刷新或重新登录；新令牌与会话绑定，注销、重置密码、删号以及 refresh 重放吊销会话后均失效。旧版本不理解新撤销约束，回滚代码会降低此项保护，应仅作短期故障恢复。

beta.25 没有新增数据库结构迁移，保留现有 JWT、数据库与会话；旧版新登录需要升级，已有会话仍可正常续期。回滚时还须匹配应用内验证与服务器策略，避免把旧入口当作跳过验证的备用方式。

## 0.2.0 服务端更新

此次更新新增 `users.email_verified_at` 列，迁移时将全部既有账号标为已验证，因此既有密码不受影响；此后通过密码注册、未验证邮箱的账号在首次验证码登录或找回密码时清除原密码并吊销其他会话，防止抢注。同时修复：验证码表每邮箱只保留最新一条、`/user/feedback` 缺少导入、限流表满时全局拒绝（改为仅淘汰按 IP 的桶，IPv6 按 /64 计数，按邮箱/用户的桶不被淘汰）、单条格式错误的历史导致整批推送失败。

部署时先校验线上 release 与 `ff9ffcb` 逐文件一致，再用 `node:sqlite` 在线备份数据库（完整性 ok，19 个用户、90 条历史），连同 drop-in、`/etc/opentype.env` 和 Turnstile 环境文件保存在 `/var/backups/opentype/before-fixes-20261010T162319Z/`；在数据库副本上以服务用户预演通过后，仅修改 drop-in 的 `WorkingDirectory` 并重启。切换后本机与公网 `/health` 为 200，Cloudflare 响应 `DYNAMIC/no-store`，用户、历史与会话数量不变。回滚：恢复备份的 `official-release.conf` 后 `daemon-reload` 并重启；新增列对旧代码无影响，无需恢复数据库。

## 官网下载

自 0.2.0 起，官网 Worker（`website/_worker.js`）从 GitHub `releases/latest` 读取最新**正式版**（排除草稿与预发布），生成 `/downloads/manifest.json` 并转发 `/downloads/macos-arm64` 对应版本的 DMG；结果在边缘缓存 5 分钟，GitHub 不可用时退回站内静态 `downloads/manifest.json`（缓存 60 秒）。发布新正式版后无需修改官网，最多 5 分钟后生效；静态 manifest 仅作兜底。官网通过 `npx wrangler@4.146.0 pages deploy website --project-name opentype-website --branch main` 部署。

## beta.26 发布衔接

beta.26 安装包对应公开源码 `d87e95178efff27bc277635b3f7569e0fdd20724`。相对已验收的 beta.25，产品源码仅修改 `src/main/services/updater.ts` 的 CommonJS 默认导出读取；账号、模型、图标及服务端源码保持一致。线上 API 继续运行 `ff9ffcb4364edd4f661e987688d74ff53575ef9b`，不因桌面更新组件修复而重新切换服务。

非修复作者在最终 beta.26 包的隔离进程中，通过其真实主框架 preload → IPC → 更新组件 → 公开 GitHub 发布源完成检查，返回 `current` 和测试版通道，应用版本 beta.26、当时公开源版本 beta.25 与独立公网查询一致，无降级或错误。这是实际安装包的更新调用与网络路径验收，不是鼠标按钮实测；未执行自动更新下载安装。系统菜单栏像素截图未取得，图标验收范围仍限资源/模板与应用界面。

[beta.26](https://github.com/ct-jyjntc/opentype-public/releases/tag/v0.2.0-beta.26) 已公开为测试版，包含 DMG、ZIP、两份 blockmap、两个更新通道文件、校验清单、构建记录及真人复测文档。已公开的 beta.25 二进制保持不变，其版本说明指向 beta.26。

官网最终部署 `59a9a3d5` 已启用 beta.26 manifest。非官网作者通过真实 Edge 打开 `www.opentype.top`，对主下载按钮使用键盘 Enter，浏览器进入下载状态并取得完整 DMG：300373208 字节，SHA-256 为 `8e3663320f5a9e3398f893ad97c16873bd5be22997e602bd61fe57c6feda8d2e`，与公开 Release 一致；地址栏始终保留官网域名。顶部导航下载按钮可获得焦点且不再禁用。此结果是实际浏览器下载，不只依据 HTTP 状态；未据此声称安装或跨应用输入已验证。
