# OpenType 完善实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清零 HANDOFF.md §七的已知未完成项，使登录→引导→hub→语音→词典→同步全链路端到端可用，工程侧完成 git 化与可打包。

**Architecture:** 四个独立工作流并行：服务端补端点（词典/用户信息形状/密码重置/邮件通道/首页依赖桩）、主进程补 IPC 桩与事件对齐、渲染层产物两处字节级修补（隐藏不可用的 OAuth/移动端入口）、打包修复（frontend 入包/entitlements/图标）。渲染层产物不可重建，一切适配在主进程与服务端两侧完成。

**Tech Stack:** Electron 33 + koffi FFI + better-sqlite3（客户端）；零依赖 Node 22 + node:sqlite（服务端）；whisper.cpp 本地 ASR。

**Spec:** `HANDOFF.md` §七（已知未完成项）+ 本文件同目录的调查基线（见各任务"依据"）。

## Global Constraints

- 渲染层产物（`frontend/renderer/`）只能用**字节级精确替换**修补；改完必须 `node --input-type=module --check < 文件`（或复制为 .mjs 后 `node --check`）验证。改前已有 git 基线 `f310214`。
- IPC 通道名 `page:open-typeless-bar` 禁止改名（渲染层硬编码）。
- 桥接层返回形状以 `scripts/test-contract.ts`（47 断言）为准：裸布尔/裸字符串/`{success,data}` 等契约不可破坏。
- 服务端零依赖：只用 Node 22 内置模块；测试用真进程模式（`server/test/api.test.mjs`，spawn + 临时库）。
- 服务端部署：tar 解到 `/opt/opentype/server`（不是 `/opt/opentype`），解后必须 `chown -R opentype:opentype`，再 `systemctl restart opentype`。
- 客户端数据目录 `~/Library/Application Support/dev.opentype.desktop/` 禁止删除/改名；appId 必须与之一致（`dev.opentype.desktop`）。
- 服务器是 1 核 1.9GB 小机器，禁止压力测试；whisper 只在本地跑。
- 每完成一个任务就跑对应测试并 git commit。

## Review Focus

1. `get_user_info` 补字段时 envelope 形状错（渲染层读 `data.data.roles.filter`）→ 任务 1 补契约断言。
2. 词典路由响应形状与渲染层 `ku` hook 期望不符（读 `data.data.words`）→ 任务 2 实施前必须从 `UfR9-a2Z.js` 反查精确形状。
3. 渲染层产物补丁锚点不唯一或误伤相邻代码 → 任务 9/10 要求替换前验证锚点唯一性、替换后语法检查 + 登录页冒烟。
4. onboarding 接通后登录回调把引导掐断（reload 到 hub）→ 任务 5 的 CDP 走查必须覆盖「onboarding 内完成登录」。
5. 密码重置码复用 `verifyEmailCode` 会误建账号 → 任务 3 必须写只校验不建号的 `verifyResetCode`。

---

### 工作流 A：服务端（server/，串行，一个执行者）

依据：agent-1 调查（auth.ts/db 结构）、agent-2 调查（渲染层直连 HTTP 端点清单）。

- [ ] **A1. `get_user_info` 形状补齐**：响应 data 内增加 `roles: []`、`is_new_user: false`，并按渲染层实际读取情况补 `locale`/`translation_settings`/`org_settings`（先 grep `UfR9-a2Z.js` 确认读取点）。测试：api.test.mjs 断言新字段存在且类型正确。
- [ ] **A2. 词典 7 路由**：`GET /user/dictionary/list`、`POST /user/dictionary/add|update|delete|batch-delete|bulk-import|bulk-import/preview`。新表 `dictionary_words`。请求/响应形状以渲染层 `ku` hook（`frontend/renderer/static/js/UfR9-a2Z.js`）为准逐字段反查。测试：全 CRUD + 分页 + 幂等 + 鉴权。
- [ ] **A3. 密码重置**：新表 `password_reset_codes`（仿 email_codes：10min TTL/5 次尝试/一次性）；`POST /oauth/request_password_reset`（无论邮箱是否存在都返回 OK + IP 限流 5/h）、`POST /oauth/reset_password`（校验码→`hashPassword` 更新→`revokeAllUserTokens`）；两路由入 `AUTH_SKIP`。邮件通道：`MAIL_API_URL`/`MAIL_API_KEY`/`MAIL_FROM` env，内置 fetch POST；未配置时 console.log + 非生产回 `dev_code`。**同时把现有邮箱验证码登录（`createEmailCode` 处）接入同一邮件通道**（当前生产环境验证码只落 journald，等于不可用）。测试：全流程 + 错码限次 + 重置后旧 token 全失效。
- [ ] **A4. 首页/设置缺失端点桩**：hub 首页加载必打的 `POST /user/usage_stats`、`POST /user/personal_stats`、`POST /user/insights`、`GET /app/get_free_quota_notice_banner_config` 返回渲染层可解析的空态形状（先反查渲染层读取点）；`POST /user/update_settings`、`GET/POST /user/get_dictation_settings|set_dictation_settings`、`POST /user/feedback`、`POST /user/delete_account`（真删除：删用户行+吊销 token）按同样方式补。形状不可考的（organization/gift_card/invitation）保持 404。测试：每个新端点至少 1 断言。
- [ ] **A5. 部署 + 冒烟**：tar+scp+chown+restart（见全局约束），`/health` 200，词典 CRUD curl 冒烟，密码重置请求冒烟（邮件未配置时确认日志落码）。

### 工作流 B：主进程（src/main/ + scripts/，串行，一个执行者）

依据：agent-0/agent-2 调查。

- [ ] **B1. onboarding 走通**：`!hasOnboarded` 时主窗口加载 onboarding 页（`src/main/index.ts:1120` 附近）；`page:complete-onboarding`（`renderer-bridge.ts:489`）实现为 `store.set({hasOnboarded:true})` + 走既有登录后重载路径；登录成功回调在 `!hasOnboarded` 时改发 `user-state-change {action:'login'}` 而不是直接 reload 到 hub；补桩 `onboarding:get-user-profile-surveys` → `{success:true,records:[]}`、`onboarding:submit-user-profile-survey` → `{success:true}`（并转发服务端 `POST /user/update_onboarding`）。
- [ ] **B2. 事件名对齐**：主进程发 `sync:state-changed` 处（index.ts:458-459）同时发 `transcription-history-sync:ui-status-changed`（payload 形状按渲染层订阅点反查，契约测试已含 pushProgress 形状）；热键服务补发 `global-keyboard` 事件（设置页录入热键依赖，先查渲染层监听的 payload 形状）。
- [ ] **B3. 热键设置打通**：`activeBindings()` 读 `app-settings.featureShortcutBindings`（store:use 的 app-settings store），`keyboard-input:reload-keyboard-shortcuts` 重读后生效；与顶层 `config.shortcuts` 的优先级：渲染层设置优先。
- [ ] **B4. 文件对话框通道**：实现 `file:pick-and-parse-dictionary-csv`（showOpenDialog+解析，返回形状反查渲染层 ku hook）、`file:save-audio-with-dialog`、`file:save-png-with-dialog`、`file:save-text-with-dialog`（renderer-bridge.ts:526-529）、`context:get-app-icon`（index.ts:787，返回 data URL 或 null 的安全形状——先查渲染层用法）。
- [ ] **B5. 回归**：`npm run test` + `test:contract` + typecheck 全绿；契约断言被改动的要同步更新。

### 工作流 C：渲染层产物修补（frontend/renderer/，一个执行者）

依据：agent-0 调查。

- [ ] **C1. 隐藏 Google/Apple/SSO 登录按钮**：`frontend/renderer/static/js/CYkfoOpI.js` 登录面板组件 `q` 中定位三个按钮元素（OAuth 指向上游服务，本项目不可用），字节级删除/置不渲染；login.html 与 onboarding.html 的 SIGN_UP 步共用此面板，两处同时生效。锚点必须验证唯一。
- [ ] **C2. 隐藏「获取移动应用」按钮**：`frontend/renderer/static/js/DNMdpbnK.mjs` 中 `c51` 末尾 `return!0x0;},h51=` → `return!0x1;},h51=`；先验证锚点唯一。
- [ ] **C3. 验证**：两个文件 ESM 语法检查通过；`git diff --stat` 确认只动了这两个文件、各一处。

### 工作流 D：打包与工程化（根目录，一个执行者）

依据：agent-3 调查。

- [ ] **D1. electron-builder.json 修复**：extraResources 增加 `{ "from": "frontend", "to": "frontend" }`（52MB 入包，否则白屏）；`mac.extendInfo` 承载 `NSMicrophoneUsageDescription`/`NSAppleEventsUsageDescription`（中文文案），同时从 `build/entitlements.mac.plist` 删除这两个错位键；appId `com.example.opentype` → `dev.opentype.desktop`；加 `category: public.app-category.productivity`。
- [ ] **D2. 图标**：生成 1024×1024 `build/icon.png`（现为 64×64 占位符）。可用 Swift/AppKit 脚本绘制字标或麦克风图形导出 PNG。
- [ ] **D3. npm scripts 接线**：根 package.json 加 `"pack": "npm run build && electron-builder"`、`"test:server": "node server/test/api.test.mjs"`，并把 test:server 并入 `verify:all`。
- [ ] **D4. 未签名本地打包验证**：`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder` 出 dmg/app，启动 .app 冒烟（窗口渲染、FFI 加载、网关连接）。签名/notarize 因无 Apple 证书保持阻塞，写入 HANDOFF。
- [ ] **D5. 文档**：更新 `HANDOFF.md` §七各项状态、§四 env 清单补 MAIL_* 说明、`README.md` 打包段落。

### 收尾（主会话执行，依赖 A-D 完成）

- [ ] **E1. 服务端部署验证**（A 完成后）：健康检查 + 词典 CRUD + 重置流程 curl 冒烟。
- [ ] **E2. 客户端端到端走查**（B、C 完成后）：重启 Electron，CDP 走查：登录→onboarding 完成→hub 首页有内容→词典页增删词→历史同步；语音链路 curl 自测（say→wav→gateway）。
- [ ] **E3. `npm run verify:all` 全绿 + git 提交收尾。**

## Self-Review 记录

- 覆盖：HANDOFF §七 8 项 → #1→B1、#2→C1、#3→C2、#4→A3、#5→A1+A4、#6→A2+B4、#7→无法本机解决（写入 HANDOFF 记录）、#8→D1-D4；§八 git init→已完成（f310214）。
- 类型一致性：各工作流接口以渲染层产物实际调用点为准（计划多次强调"先反查"），避免凭猜形状。
- 比例：计划为决策与锚点清单，实施细节由调查结论承载。
