# Hermes Web UI v0.5.30 HttpSse

这是 `hermes-web-ui` v0.5.30 的 **HTTP/SSE 改造版**，用于在不稳定或限制 WebSocket/Socket.IO 的网络环境中运行 Hermes WebUI。

目标很明确：**普通聊天 ChatRun 与 Group Chat / 群聊这两条实际使用的核心聊天链路不再依赖 Socket.IO 长连接，而是改为 HTTP 请求 + SSE（Server-Sent Events）事件流。**

> 当前改造口径：Terminal / 终端功能允许继续使用 WebSocket；Kanban / 看板当前不用，允许保留现状，不作为本版 HTTP/SSE 改造成败判断项。

---

## 为什么这是 HTTP/SSE 模式

原版 v0.5.x 的部分功能使用 Socket.IO / WebSocket 做实时通信，例如 ChatRun、群聊消息、看板事件等。在一些公司网络、代理、防火墙、网关或反代环境中，WebSocket Upgrade 经常会被拦截、超时或直接禁止，表现为 WebUI 连接不上、一直 disconnected、消息无法流式返回。

本分支改为 HTTP/SSE 模式，原因如下：

1. **兼容公司网络环境**：SSE 基于普通 HTTP 响应流，不需要 WebSocket Upgrade，通常能穿过公司代理、CDN、Nginx/Caddy 反代和防火墙。
2. **保留流式体验**：聊天输出、群聊事件、看板更新仍然可以通过 `text/event-stream` 实时推送，不需要退化成完全轮询。
3. **部署更简单**：HTTP/SSE 对反向代理要求更低，只要支持普通 HTTP 长连接即可，不需要额外配置 `/socket.io`、`Upgrade`、`Connection: upgrade` 等规则。
4. **更适合 Hermes 当前稳定部署方式**：用户当前稳定使用的是 HTTP/SSE 模型，避免引入 v0.5+ 的 Socket.IO 连接问题。
5. **便于灰度测试**：HTTP API 和 SSE 端点可以用 `curl` 直接验证，排查比 WebSocket 更直观。

---

## 改造范围

### 已改为 HTTP/SSE 的核心链路

- **ChatRun**
  - 运行/中止等控制动作使用 HTTP REST 接口。
  - 流式输出使用 SSE 事件流。

- **Group Chat / 群聊**
  - 加入房间、发送消息、中断 Agent 等动作使用 HTTP REST 接口。
  - 房间消息、Agent 状态、心跳等实时事件使用 SSE。

- **Kanban / 看板事件**
  - 当前不作为本版必须改造范围，保留现有状态即可。

### Socket.IO 状态

- 原 Socket.IO `/socket.io/` 通道不作为 ChatRun / Group Chat 的核心实时通道使用。
- 本地 amend 版已通过构建验证，ChatRun / Group Chat 客户端入口使用 `EventSource` 和 HTTP `fetch`。
- Terminal 终端功能可以继续使用 WebSocket，不在本次 HTTP/SSE 改造范围内。

### 已知说明

- 本仓库仍可能保留部分历史依赖、测试文件、Kanban 或终端相关代码中的 `socket.io` / `ws` 字符串，这是上游 v0.5.30 历史代码和兼容残留，不代表 ChatRun / 群聊链路仍依赖 Socket.IO。
- 如果在强禁止 WebSocket 的环境中部署，请优先验证 ChatRun、群聊这两条 HTTP/SSE 主链路；Web Terminal 等特殊功能如仍使用 PTY/WebSocket，应单独评估或关闭。

---

## 关键端点设计

典型模式：

```text
控制类动作：HTTP POST / REST
实时事件流：HTTP GET + text/event-stream / SSE
```

示例：

```text
GET  /api/hermes/chat-run/events            # ChatRun SSE 事件流
POST /api/hermes/chat-run/run               # 启动 ChatRun
POST /api/hermes/chat-run/abort             # 中止 ChatRun

GET  /api/hermes/group-chat/events          # 群聊 SSE 事件流
POST /api/hermes/group-chat/join-room       # 加入房间
POST /api/hermes/group-chat/send            # 发送消息
POST /api/hermes/group-chat/interrupt-agent # 中断 Agent

GET  /api/hermes/kanban/events              # 看板事件流（非本次必须改造范围）
```

---

## 验证结果

本地已有历史冒烟测试报告：[`sse-conversion-smoke-test-report.md`](./sse-conversion-smoke-test-report.md)

`/root/outputs/hermes-web-ui-v0.5.30-amend` 本地修正版的最新验证摘要：

| 项目 | 结果 |
|---|---|
| `npm run build` | 通过，已生成 `dist/client` 与 `dist/server` |
| ChatRun 相关测试 | 通过，4 个测试文件 / 22 个用例通过 |
| 全量测试 | 91/94 测试文件通过，574/579 用例通过；剩余失败为 Kanban 测试预期未同步和本机端口占用导致的 gateway 端口期望差异 |
| 当前生产 0.4.9 | 未重启、未覆盖、未影响 |

历史报告摘要：

| 项目 | 结果 |
|---|---|
| 冒烟用例 | 12/12 通过 |
| SSE Content-Type | `text/event-stream` 正常 |
| 群聊 join/send/interrupt | 正常 |
| SSE heartbeat | 正常 |
| SSE 重连 | 正常 |
| SSE 并发 3 连接 | 正常 |
| `/socket.io/` | 返回 404 |
| 本机生产环境 | 未触碰、未影响 |

---

## 快速启动

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

默认访问：

```text
http://127.0.0.1:8648
```

### 构建

```bash
npm run build
```

---

## 反向代理注意事项

HTTP/SSE 模式不需要 WebSocket Upgrade，但需要允许 HTTP 长连接和关闭代理缓冲。

Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8648;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Caddy 通常可以直接反代：

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:8648
}
```

如遇到 SSE 中断，重点检查代理/CDN 是否缓冲 `text/event-stream`。

---

## 与原版 v0.5.30 的区别

| 项目 | 原版 v0.5.30 | 本仓库 HttpSse 版 |
|---|---|---|
| ChatRun 实时通信 | Socket.IO / WebSocket | HTTP + SSE |
| 群聊实时通信 | Socket.IO | HTTP + SSE |
| 看板事件 | Socket.IO/实时通道 | 非本次必须改造范围 |
| 公司网络兼容性 | 可能被 WebSocket Upgrade 卡住 | 更容易通过 HTTP 代理 |
| 反代配置 | 需要处理 Upgrade / Socket.IO | 普通 HTTP 长连接即可 |
| 排障方式 | WebSocket/Socket.IO 较难排查 | curl 可直接验证 SSE |

---

## 适用场景

- 公司网络禁止或限制 WebSocket。
- 反向代理/CDN 对 Socket.IO 支持不稳定。
- Hermes WebUI 需要在 HTTP/SSE 模式下灰度测试。
- 希望保留 v0.5.30 新功能，但避免 v0.5+ Socket 连接问题。

---

## 重要提醒

这是用于灰度测试和迁移验证的 HTTP/SSE 改造版本。部署到正式环境前，建议至少验证：

1. Hermes Gateway API Server 健康状态正常。
2. ChatRun 可以完整流式输出。
3. 群聊加入、发送、Agent 回复、SSE 推送正常。
4. 反代没有缓冲或中断 `text/event-stream`。
5. 如所在网络完全禁止 WebSocket，请确认不启用仍依赖 WebSocket 的特殊功能。

---

## 生产升级要求（2026-05-21）

本仓库已用于将生产 WebUI 从 `0.4.9` 升级到 `0.5.30 HttpSse`。升级目标不是“全站完全移除 WebSocket”，而是保证公司网络中最常用的两条聊天链路可用：

- 普通单聊 / ChatRun：HTTP REST + SSE。
- Group Chat / 群聊：HTTP REST + SSE。

### 强制约束

1. **禁止覆盖 `/root/.hermes`**。
   - `/root/.hermes` 是 Hermes Agent 的核心数据目录，包含 `config.yaml`、`.env`、`auth.json`、`state.db`、`cron/jobs.json`、`skills`、`scripts`、`profiles`、`sessions`、`outputs` 等。
   - 升级 WebUI 只能替换 WebUI 程序包或 systemd 指向，不能删除、重建或覆盖 `/root/.hermes`。
2. **升级前必须备份当前状态**。
   - 至少备份 `/root/.hermes`、当前 WebUI 程序目录、当前 systemd unit/drop-in。
   - 备份文件中可能包含密钥、Cookie、Token、OAuth 登录态，必须私有保存。
3. **升级过程只切换 WebUI，不重置 Hermes Gateway 数据**。
   - `hermes-gateway.service` 使用现有 `/root/.hermes`。
   - 如需重启服务，只允许重启 WebUI/Gateway 服务本身，不允许初始化新的 Hermes home。
4. **Terminal / Kanban 不作为本次验收失败项**。
   - Terminal 仍可能使用 WebSocket。
   - Kanban 相关测试或历史断言不影响 ChatRun / Group Chat 的 HTTP/SSE 验收。

### 推荐生产部署方式

1. 在隔离目录构建本仓库：

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run build
```

2. 在非生产端口先做 smoke test，确认：

```text
GET /api/hermes/chat-run/events
GET /api/hermes/group-chat/events
POST /api/hermes/group-chat/send
```

3. 将构建好的 WebUI 程序放到独立目录，例如：

```text
/root/hermes-web-ui-v0.5.30-HttpSse-live-YYYYMMDD-HHMMSS
```

4. 用 systemd drop-in 切换 `hermes-webui.service` 的 `ExecStart` / `ExecStop` / `ExecReload` / `WorkingDirectory`，不要直接覆盖 `/root/.hermes`：

```text
/etc/systemd/system/hermes-webui.service.d/override-v0530-httpsse.conf
```

5. reload 并重启 WebUI：

```bash
systemctl daemon-reload
systemctl restart hermes-webui.service
```

### 生产验证清单

升级后至少确认：

```bash
systemctl is-active hermes-webui.service
systemctl is-active hermes-gateway.service
curl -sS -m 5 http://127.0.0.1:8648/health
curl -sS -m 5 http://127.0.0.1:8642/health
```

并验证：

- `/api/hermes/chat-run/events` 返回 `event: connected` / `event: resumed`。
- `/api/hermes/group-chat/events?token=<WEBUI_TOKEN>` 返回 `event: connected` / `event: joined`。
- `/root/.hermes/cron/jobs.json` 仍存在，定时任务数量符合预期。
- `/root/.hermes/skills`、`/root/.hermes/scripts`、`/root/.hermes/profiles`、`/root/.hermes/sessions`、`/root/.hermes/outputs` 仍存在。

### 本次生产升级实测结果

2026-05-21 的生产升级采用以上方式完成，关键信息如下：

```text
WebUI version: 0.5.30
WebUI live dir: /root/hermes-web-ui-v0.5.30-HttpSse-live-20260521-session-usage-hotfix
systemd override: /etc/systemd/system/hermes-webui.service.d/override-v0530-httpsse.conf
pre-upgrade backup: /root/output/pre-upgrade-webui-HttpSse-20260521-095535
webui 0.5.30 backup: /root/outputs/bak-webui0530.zip
full Hermes home backup: /root/outputs/bak-hermes-home-20260521.zip
legacy 0.4.9 rollback backup: /root/output/bak-webui049.zip
```

实测结论：

- `hermes-webui.service` active。
- `hermes-gateway.service` active。
- `/health` 返回 `webui_version: 0.5.30`。
- ChatRun SSE smoke test 通过。
- Group Chat SSE + REST smoke test 通过。
- `/root/.hermes` 未被覆盖。
- 原有 cron jobs、skills、scripts、profiles、sessions、outputs 均仍存在。

### 灰度分支修改记录

#### 2026-05-21 — 修复单聊回复后页面闪一下的问题

- **现象**：普通单聊发送问题后，大模型回复过程中界面偶发闪动；浏览器 Console 出现 `Socket.IO run stream error: table session_usage has no column named created_at`。
- **根因**：生产库 `/root/.hermes-web-ui/hermes-web-ui.db` 中的旧 `session_usage` 表来自早期版本，只有 `updated_at`，缺少当前 `usage-store` 所需的 `id` 和 `created_at`；通用 schema 同步为保护数据，跳过了 `PRIMARY KEY` 和无默认值 `NOT NULL` 字段，导致单聊写入/读取用量统计时报错。
- **修复**：在 `packages/server/src/db/hermes/schemas.ts` 增加针对旧 `session_usage` 的安全迁移：服务启动时检测缺少 `id` 或 `created_at` 即重建该表，保留原有 token/model/profile 数据，并用旧 `updated_at` 回填 `created_at`。
- **验证**：新增 `tests/server/schema-sync.test.ts` 回归用例；`npm test -- --run tests/server/schema-sync.test.ts tests/server/usage-store.test.ts` 通过；`npm run build` 通过；生产重启后 `session_usage` 已包含 `id` 与 `created_at`，ChatRun SSE smoke test 通过。
- **数据安全**：未覆盖 `/root/.hermes`；重启前备份了 `/root/.hermes-web-ui/hermes-web-ui.db` 和 systemd drop-in 到 `/root/output/pre-session-usage-hotfix-20260521-192601`。

### 回退要求

如升级后异常，优先回退 WebUI 程序和 systemd 指向，不要覆盖 `/root/.hermes`。可使用生产备份中的回退脚本：

```bash
bash /root/outputs/bak-webui0530/restore-webui0530.sh
```

如需完整回退到旧版 `0.4.9`，再使用旧版回退包：

```bash
bash /root/output/bak-webui049/restore-webui049.sh
```

---

## Changelog

### 2026-05-20 — 8 Bug 修复（生产就绪）

此版本在 HTTP/SSE 改造的基础上修复了 8 个关键 Bug，经本机验证 ChatRun 与群聊均正常。

#### Bug 1 — SSE chat-run 路由被 proxy 拦截
- **现象**：`/api/hermes/chat-run/*` 返回 `GatewayManager not initialized`
- **根因**：`SseChatRun.setupRoutes()` 在 `registerRoutes()` 之后执行，被 proxy 中间件吞掉
- **修复**：`packages/server/src/index.ts` — 将 SseChatRun 初始化移到 registerRoutes 之前

#### Bug 2 — 群聊 REST API 返回 503
- **现象**：创建/列表/删除房间返回 `{"error":"Group chat not initialized"}`
- **根因**：`setSseGroupChatServer()` 只设了 `sseServer`，REST 路由检查 `chatServer` 为空
- **修复**：`packages/server/src/routes/hermes/group-chat.ts` — 同时赋值 `chatServer = server as any`

#### Bug 3 — 群聊发送消息显示 `[object Object]`
- **现象**：@智能体发送消息后 UI 显示 `[object Object]`
- **根因**：客户端调 `/group-chat/message`，服务端路由是 `/group-chat/send`；proxy 返回嵌套 error 对象被塞进 `Error()` → `err.message = "[object Object]"`
- **修复**：客户端 store 和 API 模块改 `message` → `send`，加固错误提取逻辑

#### Bug 4 — 普通 1v1 聊天不工作
- **现象**：普通聊天没有响应，消息发不出
- **根因**：全局 EventSource 创建时未带 `session_id` 参数，服务端返回 400
- **修复**：`packages/client/src/api/hermes/chat.ts` — `setupGlobalEventSource` 接受 sessionId，resume 和 startRun 传入

#### Bug 5 — 群聊 SSE 每 3 秒断开重连
- **现象**：浏览器 Console 不断出现 `[GroupChat] SSE error`，EventSource 每 ~3 秒重连
- **根因**：`handleEventsStream` 用 `res.writeHead()` 直接写响应，但未设 `ctx.respond = false`，Koa 自动关闭了 SSE 流
- **修复**：`packages/server/src/services/hermes/group-chat/sse-server.ts` — 加 `ctx.respond = false`

#### Bug 6 — 群聊消息不实时显示
- **现象**：发消息后看不到自己的消息和 Agent 回复，刷新后才出现
- **根因**：`join-room` 未传 `connectionId`，SSE 连接未切换到目标房间；`send` 未传 `userId`
- **修复**：
  - store 捕获 `connected` 事件中的 `connectionId`
  - `join-room` 和 `send` 传递 `connectionId`/`userId`
  - 纯文本消息乐观本地推送（立即显示）

#### Bug 7 — SSE 重连后 send 返回 400
- **现象**：SSE 断连重连后发消息返回 `400 Not in room`
- **根因**：重连产生新 `connectionId`，但未重新 `join-room`，新连接不在房间里
- **修复**：`connected` 事件中检测 connectionId 变化时自动调用 `join-room`

#### Bug 8 — SSE 连接 5 秒后断开（connectionsSize=0）
- **现象**：日志显示 `connectionsSize=0`，`room members: []`，send 持续 400
- **根因**：Node.js 默认 `keepAliveTimeout=5s`，心跳 30s 一次，初始事件后 5 秒无数据即断开
- **修复**：
  - `res.writeHead` 后加 `req.socket.setTimeout(0)` 禁用 socket 超时
  - 心跳从 30s 缩短到 15s

---

**修改文件汇总**（5 个文件）：

| 文件 | 涉及 Bug |
|------|---------|
| `packages/server/src/index.ts` | Bug 1 |
| `packages/server/src/routes/hermes/group-chat.ts` | Bug 2 |
| `packages/server/src/services/hermes/group-chat/sse-server.ts` | Bug 2, 5, 8 |
| `packages/client/src/api/hermes/chat.ts` | Bug 4 |
| `packages/client/src/stores/hermes/group-chat.ts` | Bug 3, 6, 7 |
| `packages/client/src/api/hermes/group-chat.ts` | Bug 3 |

---

## License

保持上游项目许可证约束。详见 [`LICENSE`](./LICENSE)。
