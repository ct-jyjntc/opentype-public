# OpenType 官方账号服务

客户端登录、注册、令牌刷新、历史与词典同步固定使用 `https://api.opentype.top`。个人 SiliconFlow 与文字整理密钥仍由客户端管理，账号服务器不需要这些密钥。

这份文档是可执行的部署配方，不代表域名已上线。部署前必须取得实际源站入口，确认域名下已有服务和数据库，并将远端与本次代码双向比较。不能用旧仓库文件覆盖线上独有修改，也不能只配置 DNS 就宣称账号可用。

## 运行条件

- Linux 单实例、Node.js 24 LTS（24.12 或更新的 24.x），`node:sqlite` 和 TypeScript 类型擦除均为 Node 内置；`server/` 无第三方运行依赖，不需安装整个 Electron 项目。
- Caddy 2.10 或更新版本负责 HTTPS 和反向代理；Node 仅监听 `127.0.0.1:9100`，不开放该端口到公网。
- 数据库位于 `/var/lib/opentype/opentype.db`，目录仅服务用户可访问；数据库 WAL/SHM 也必须保留。签名密钥跨重启保持不变。
- 密码注册、登录和同步无需邮件网关。验证码登录、找回密码需要提供受信任的 HTTPS 邮件网关和已验证发件地址；缺少它们会返回明确的“邮件服务暂未开放”，不会假装已发送。

## 首次部署

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

## HTTPS 和 Cloudflare

使用 `server/deploy/Caddyfile` 合并站点配置，保留主机上的其他站点。模板仅信任官方 Cloudflare IP 段提供的 `CF-Connecting-IP`，再由本机 Caddy 写入 `X-Real-IP`；Node 不盲信公网 `X-Forwarded-For`。使用前与 [Cloudflare IP 清单](https://www.cloudflare.com/ips/) 对照，之后随官方调整维护。若已有 Caddy 全局块，合并到其 `servers` 块，不重复添加全局块。

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

在源站 80/443 可达、Caddy 证书正常后，为 `api.opentype.top` 建立指向真实源站的 A/AAAA 或已有受控源站的 CNAME，开启 Cloudflare 代理。TLS 模式为 **Full (strict)**，不可用 Flexible。可先完成 DNS only 和证书验证再切代理，切换后再次验证 HTTPS 和账号路径。

为主机名 `api.opentype.top` 配置 **Cache Rule：Bypass cache**。所有账号与同步响应同时带 `Cache-Control: private, no-store` 和 `CDN-Cache-Control: no-store`；不要启用 Cache Everything、缓存 POST 或对 API 使用交互式浏览器挑战。Cloudflare 代理提供 TLS/连接复用、压缩和网络层保护，私人同步内容不能为了加速被 CDN 缓存。模板不改变该 zone 其他域名的缓存/TLS配置；如果 zone 全局 TLS 仍为 Flexible，应先评估其他域名再修改，或使用针对该主机的配置规则。

## 上线验收

使用独立的合成账号，通过实际客户端“设置 → 账号”注册并登录；确认本机没有服务器输入框。验证退出、重新登录、关闭重启后的会话和失效刷新。令牌不应输出到命令日志。

新账号的历史同步默认关闭；需在账号页显式开启，单独修改保留时间或清空云端也不能开启同步。既有显式设置保持不变。用两台隔离客户端的合成数据验证开启后的历史推送/拉取/删除和词典的显式同步；第二个账号必须看不到第一个账号的数据。完成检查后只清理合成账号，不能碰真实用户内容。验证 HTTPS 响应不含 CDN `HIT`，未经登录的同步请求为 401，注销、删除账号后旧令牌也为 401。生产未配置邮件时验证码请求应为 503 且没有 `dev_code`。实际邮件送达需用户明确授权的测试邮箱，不能向随机或真实用户批量发送。

客户端升级迁移会清除旧空地址/自建服务器的会话，并保留历史和词典；旧历史绑定原域或本机范围，避免登录官方账号后自动跨域上传。官方既有账号关闭同步的选择会迁移到该域的账号范围。首次升级前的未绑定历史不会自动上传到新服务。

## 更新、备份和回滚

更新前保存正在运行的提交号和 systemd/Caddy 配置，在停止服务后备份数据库及 WAL/SHM（或用 SQLite 的在线备份功能；禁止服务运行时只复制主 `.db` 文件），备份目录权限 `0700`。将新版本上传到新的 release 目录，先对当前远端做双向 diff，保护线上独有修改与密钥文件，再切 `current` 和重启。失败时切回上一版本。只有确认没有新写入、接受数据回退后才恢复数据库备份，避免用旧备份覆盖新用户数据。

本次新增的 refresh session 索引/字段采用可重复执行的数据库迁移。旧 access token 在此次安全升级后会被拒绝，需要刷新或重新登录；新令牌与会话绑定，注销、重置密码、删号以及 refresh 重放吊销会话后均失效。旧版本不理解新撤销约束，回滚代码会降低此项保护，应仅作短期故障恢复。
