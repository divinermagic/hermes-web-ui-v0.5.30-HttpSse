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

## License

保持上游项目许可证约束。详见 [`LICENSE`](./LICENSE)。
