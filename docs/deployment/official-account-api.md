# OpenType 官方账号服务

客户端登录、注册、令牌刷新、历史与词典同步固定使用 `https://api.opentype.top`。个人 SiliconFlow 与文字整理密钥仍由客户端管理，账号服务器不需要这些密钥。

截至 2026-10-10，生产已部署公开主分支 `0886698b73447045541e6a227176ac3bf5417d18`，15 个服务源码文件与该提交逐一匹配。下文先记录当前部署，再提供新安装时可选的 Caddy 配方；二者不要混用或同时占用端口。后续更新仍须将线上与新代码双向比较，保护已有配置和数据。

## 当前生产部署

生产使用经 Node 官方 SHA-256 清单校验的独立 **Node 24.21.0 LTS**。应用放在带提交号的 release 目录，通过既有 systemd 服务的 drop-in 切换工作目录和运行时；旧 Node 22、旧代码和原 unit 均保留用于回滚。

既有 JWT、数据库与环境文件保持连续，账号进程只监听 `127.0.0.1:9100`，设置 `NODE_ENV=production`、`TRUST_PROXY=loopback`、`ALLOW_DEV_EMAIL_CODES=false` 和 `UMask=0077`。数据目录权限为 `0700`，数据库、WAL、SHM 和环境文件为 `0600`；部署备份和线上数据库均通过 SQLite 完整性检查。版本切换前保留源码、服务与环境配置及一致性数据库备份，未将生产秘密复制到仓库。

**专用 nginx 服务**承接 80/443，只服务 `api.opentype.top`；全局 nginx 未启用，主机上原有 cloudflared 保持运行。nginx 只信任 Cloudflare 官方清单的 22 个来源网段提供的客户端 IP，再由本机反代传递给账号服务。

证书使用 Let's Encrypt，当前证书有效期至 **2027-01-07**。Certbot 定时器已启用，专用续期 hook 仅校验并 reload OpenType 的 nginx；Cloudflare 代理切换前后各完成一次带 deploy hook 的续期演练，代理开启后的实际 ACME 路径也已跑通。未来续期仍需监控。

Cloudflare DNS 已开启代理，TLS 严格模式及不缓存规则精确限制于 `api.opentype.top`。独立人员两次请求公网 `/health` 均得到 HTTPS 200、Cloudflare 响应标识及不同请求 ID；缓存状态为 `DYNAMIC`，响应带 `Cache-Control` 与 `CDN-Cache-Control: no-store`。无效登录返回 401，同样不缓存；没有测量各地区延迟或吞吐提升。

最终 beta.24 安装包使用全新隔离配置，已由非后端/前端作者的审查者实际完成官方账号注册、确认同步关闭及零历史、退出和再次密码登录。

独立公网验收使用两个合成账号完成历史与词典推送、拉取：账号 A 收到预先指定的原文与词条，账号 B 返回空列表；未开启同步时上传为 403，显式开启后成功。退出后原 access token 请求为 401，密码重新登录成功。上述响应均来自 Cloudflare，缓存为 `DYNAMIC/no-store`；合成账号已清理。刷新轮换、重放撤销等对抗行为在隔离本地真实 HTTP 服务验证，生产未另行重复。真人多设备、麦克风与跨应用输入仍需复测。

维护探测应使用与应用一致的 `User-Agent: OpenType/0.2.0-beta.24`，并检查真实 API 响应体；通用爬虫客户端的默认标识可能受到边缘安全策略影响，不能用其结果代替软件路径。

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

复制 `server/.env.example` 到 `/etc/opentype/server.env`，文件权限设为 `0600`。在主机安全会话里用 `openssl rand -hex 32` 生成一次 `JWT_SECRET`，直接填写到该文件；不要通过聊天、版本库或部署日志传递。其余变量按模板填写。`NODE_ENV=production` 必须保留，`ALLOW_DEV_EMAIL_CODES` 必须为 `false`。邮箱配置可留空，此时密码路径仍可使用。开发回显验证码需要显式 `NODE_ENV=development`、`ALLOW_DEV_EMAIL_CODES=true` 且仅监听回环地址，生产组合会拒绝启动。

将 `server/deploy/opentype-api.service` 安装到 `/etc/systemd/system/`，核对 `ExecStart` 的 Node 路径，再启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now opentype-api
curl --fail http://127.0.0.1:9100/health
```

服务的健康响应仅说明账号进程已启动；还需完成下文真实账号和同步验收。

## Caddy HTTPS 和 Cloudflare 配置

使用 `server/deploy/Caddyfile` 合并站点配置，保留主机上的其他站点。模板仅信任官方 Cloudflare IP 段提供的 `CF-Connecting-IP`，再由本机 Caddy 写入 `X-Real-IP`；Node 不盲信公网 `X-Forwarded-For`。使用前与 [Cloudflare IP 清单](https://www.cloudflare.com/ips/) 对照，之后随官方调整维护。若已有 Caddy 全局块，合并到其 `servers` 块，不重复添加全局块。

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

在源站 80/443 可达、Caddy 证书正常后，为 `api.opentype.top` 建立指向真实源站的 A/AAAA 或已有受控源站的 CNAME，开启 Cloudflare 代理。TLS 模式为 **Full (strict)**，不可用 Flexible。可先完成 DNS only 和证书验证再切代理，切换后再次验证 HTTPS 和账号路径。

为主机名 `api.opentype.top` 配置 **Cache Rule：Bypass cache**。所有账号与同步响应同时带 `Cache-Control: private, no-store` 和 `CDN-Cache-Control: no-store`；不要启用 Cache Everything、缓存 POST 或对 API 使用交互式浏览器挑战。Cloudflare 代理提供 TLS/连接复用、压缩和网络层保护，私人同步内容不能为了加速被 CDN 缓存。模板不改变该 zone 其他域名的缓存/TLS配置；如果 zone 全局 TLS 仍为 Flexible，应先评估其他域名再修改，或使用针对该主机的配置规则。

## 后续上线与真人复验

使用独立的合成账号，通过实际客户端“设置 → 账号”注册并登录；确认本机没有服务器输入框。验证退出、重新登录、关闭重启后的会话和失效刷新。令牌不应输出到命令日志。

新账号的历史同步默认关闭；需在账号页显式开启，单独修改保留时间或清空云端也不能开启同步。既有显式设置保持不变。用两台隔离客户端的合成数据验证开启后的历史推送/拉取/删除和词典的显式同步；第二个账号必须看不到第一个账号的数据。完成检查后只清理合成账号，不能碰真实用户内容。验证 HTTPS 响应不含 CDN `HIT`，未经登录的同步请求为 401，注销、删除账号后旧令牌也为 401。生产未配置邮件时验证码请求应为 503 且没有 `dev_code`。实际邮件送达需用户明确授权的测试邮箱，不能向随机或真实用户批量发送。

客户端升级迁移会清除旧空地址/自建服务器的会话，并保留历史和词典；旧历史绑定原域或本机范围，避免登录官方账号后自动跨域上传。官方既有账号关闭同步的选择会迁移到该域的账号范围。首次升级前的未绑定历史不会自动上传到新服务。

## 更新、备份和回滚

更新前保存正在运行的提交号和 systemd/实际反代配置，在停止服务后备份数据库及 WAL/SHM（或用 SQLite 的在线备份功能；禁止服务运行时只复制主 `.db` 文件），备份目录权限 `0700`。将新版本上传到新的 release 目录，先对当前远端做双向 diff，保护线上独有修改与密钥文件，再切工作目录和重启。当前生产通过撤销本次 drop-in、恢复原环境配置并重载 systemd 回退；新安装模板则切回上一 `current`。默认不恢复旧数据库；只有确认没有新写入、接受数据回退后才恢复备份，避免覆盖新用户数据。

本次新增的 refresh session 索引/字段采用可重复执行的数据库迁移。旧 access token 在此次安全升级后会被拒绝，需要刷新或重新登录；新令牌与会话绑定，注销、重置密码、删号以及 refresh 重放吊销会话后均失效。旧版本不理解新撤销约束，回滚代码会降低此项保护，应仅作短期故障恢复。
