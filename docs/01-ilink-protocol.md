# 01 — iLink 协议：微信悄悄打开的大门

## 背景故事

2026年3月，腾讯悄悄在 npm 上发布了一个包 `@tencent-weixin/openclaw-weixin`：
- 3756 行 TypeScript 源码（不是编译后的 JS，完全可读）
- MIT License
- 没有官方公告、没有文档、没有公开的 GitHub 仓库接受 PR

这个包做了一件此前不可想象的事：**让第三方开发者能够通过标准 HTTP 协议与微信进行消息交互**。

微信一直是封闭生态的代名词。之前第三方接入微信只能靠灰色手段（网页版协议注入、Hook 注入等），随时面临封禁风险。而 iLink 的设计明显是面向开发者的——这是腾讯对 AI Agent 时代的一次试探性开放。

## 为什么叫 iLink？

iLink 是这套 Bot 通信协议的名称。所有 API 端点都以 `ilink/bot/` 为前缀，请求头中有 `AuthorizationType: ilink_bot_token`。

## 协议设计哲学：极简主义

iLink 的设计哲学出奇地简洁：**纯 HTTP POST，无 WebSocket，无长连接**。

整个协议只有 **5 个端点**，却覆盖了即时通讯的全部核心功能：

| 端点 | 用途 |
|------|------|
| `ilink/bot/getupdates` | Long-poll 拉取新消息 |
| `ilink/bot/sendmessage` | 发送消息 |
| `ilink/bot/getuploadurl` | 获取 CDN 预签名上传 URL |
| `ilink/bot/getconfig` | 获取 bot 配置（如 typing_ticket） |
| `ilink/bot/sendtyping` | 发送"正在输入"状态 |

**Base URL**: `https://ilinkai.weixin.qq.com`

## 为什么选择 Long-Poll 而非 WebSocket？

这个设计选择非常刻意：

1. **防火墙友好**：纯 HTTP 流量，不会被企业网络拦截
2. **实现简单**：任何能发 HTTP 请求的语言都能接入
3. **调试方便**：curl 就能测试全部功能
4. **无状态**：服务端不需要维护连接状态

Long-poll 的工作方式：客户端发一个 POST 请求，服务端 hold 住（最长 35 秒），有消息就立刻返回，超时就返回空响应。客户端收到响应后立即发起下一次请求。

## 请求头结构

每个请求需要携带以下头：

```
Content-Type: application/json
Authorization: Bearer {botToken}
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: base64(random_uint32的十进制字符串)
```

`AuthorizationType: ilink_bot_token` 这个自定义头表明腾讯为 Bot 场景专门设计了一套鉴权体系，与微信原有的用户认证完全隔离。

## 消息类型

iLink 支持 5 种消息类型：

| type | 名称 | 数据字段 |
|------|------|---------|
| 1 | TEXT | text_item.text |
| 2 | IMAGE | image_item.media(CDN) + aeskey |
| 3 | VOICE | voice_item.media(CDN) + encode_type + text(语音转文字) |
| 4 | FILE | file_item.media(CDN) + file_name + len |
| 5 | VIDEO | video_item.media(CDN) + video_size + play_length |

一个重要细节：**语音消息自带 ASR 转写结果**（text 字段）。Bot 可以直接处理文本，无需自己调语音识别服务。

## context_token：整个协议最关键的设计

```json
{
  "seq": 1,
  "message_id": 12345,
  "from_user_id": "xxx@im.wechat",
  "to_user_id": "xxx@im.bot",
  "message_type": 1,
  "message_state": 0,
  "context_token": "...",
  "item_list": [...]
}
```

**context_token 是整个协议最关键的设计**。每条入站消息携带这个 token，Bot 回复时必须原样携带回去。缺失则服务端拒绝发送。

它解决了一个关键问题：**Bot 如何知道回复哪条消息？** 传统做法是通过 `reply_to_message_id`，但这在异步场景下容易出错。context_token 将会话上下文封装为不透明令牌，Bot 无需理解其内部结构，只需原样回传。

## 断点续传：get_updates_buf

每次 `getupdates` 响应都会返回一个 `get_updates_buf`（游标），下次请求时带上这个游标，服务端就只返回新消息。即使 Bot 重启，也能从上次位置继续拉取，不会丢消息。

## 半开源：腾讯的微妙态度

这个项目的开源状态很有趣：

**表面上**：MIT License，npm 上可直接安装，发布的是 TypeScript 源码（完全可读）

**实际上**：
- 没有公开的 GitHub 仓库接受 PR
- 没有官方文档、没有 Changelog、没有 Issue Tracker
- `hao-ji-xing/openclaw-weixin` 这个 repo 存在，但内容只是 CLI 安装器

这是一种"可读但不可参与"的开放模式。可能的原因：
1. **测试水温**：观察开发者反应，评估正式开放的可行性
2. **合规考量**：避免正式承诺 SLA，保留随时调整的权利
3. **内部博弈**：不同部门对开放的态度可能存在分歧

## 风险提醒

在 iLink 上构建产品需要清醒认识风险：

| 风险 | 影响 | 缓解策略 |
|------|------|---------|
| API 可能随时变更 | 功能中断 | 抽象层隔离，快速适配 |
| npm 包可能下架 | 无法安装 | 本地缓存源码 |
| 账号可能被风控 | 服务不可用 | 多账号备份，行为合规 |
| Token 有效期不明 | 认证失败 | 实现自动刷新机制 |
| 无 SLA 保证 | 业务连续性风险 | 不用于核心业务流程 |

**建议**：将 iLink 视为实验性能力，用于内部工具、原型验证、非关键场景。不要在付费产品的核心路径上依赖它。
