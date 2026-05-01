# WeChat Claude Bot

通过微信消息远程操控 Claude Code —— 基于腾讯 iLink 协议的微信 AI 机器人。

在微信上发消息，Claude Code 自动接收并回复。支持文字、语音、图片（通过浏览器上传）分析和长期记忆。

```
微信 ──► iLink Bot ──► wechat-agent ──► wechat-autoreply ──► Claude Code CLI ──► 文件系统/工具
   ◄──────────────────────────────────────────────────────────────────────────┘
```

## 系统架构

三个独立进程协同工作：

| 进程 | 文件 | 功能 |
|------|------|------|
| **Agent** | `wechat-agent.js` | HTTP 服务 (:3456)，轮询 iLink 接收微信消息，提供 /inbox、/send、/upload 接口 |
| **AutoReply** | `wechat-autoreply.js` | 后台守护进程，每 3 秒检查 Agent 收件箱，自动调用 Claude Code 回复 |
| **Login** | `src/login.ts` + `src/ilink/auth.ts` | QR 扫码登录 WeChat Bot |

### 消息流程

```
1. 用户在微信上发消息
2. wechat-agent 通过 iLink getupdates API 接收
3. wechat-autoreply 从 /inbox 获取消息
4. 启动 node cli.js -p 调用 Claude Code 处理
5. 回复通过 /send 接口发回微信
6. 长期记忆自动保存到本地文件
```

### 图片处理流程

微信 iLink 协议图片为加密传输，无法直接下载，采用浏览器上传方案：

```
1. 用户在微信发图片
2. AutoReply 回复上传链接 http://<LAN_IP>:3456/upload
3. 用户手机浏览器打开链接（需同一 WiFi）
4. 选择图片上传 → Tesseract OCR 识别文字
5. Claude Code 基于 OCR 结果分析回复
```

## 前置条件

| 依赖 | 说明 |
|------|------|
| **Node.js 18+** | 运行环境 |
| **Claude Code** | 已安装并登录 (`npm install -g @anthropic-ai/claude-cli` 或项目内 `node cli.js`) |
| **微信手机端** | 扫码登录用 |
| **Tesseract OCR** | 图片文字识别（可选，login.bat 会自动检查） |

## 快速开始

### 1. 克隆项目

```bash
git clone <repo-url>
cd weixin-claude-bot
```

### 2. 登录微信 Bot

```bash
login.bat
```

或手动执行：

```bash
npm install
npm run login
```

终端显示二维码，用微信扫码并确认。登录凭证保存在 `~/.weixin-claude-bot/credentials.json`。

### 3. 配置环境变量

设置 Claude Code 调用的 API（如使用 DeepSeek 的 Anthropic 兼容接口）：

```bash
set ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
set ANTHROPIC_API_KEY=sk-your-key-here
```

### 4. 启动 Bot

```bash
start-all.bat
```

会启动两个窗口：
- **WeChat Agent** — HTTP 服务 (localhost:3456)
- **Auto-Reply** — 自动回复守护进程

### 5. 发消息测试

在微信上给 Bot 发消息，即可收到 Claude Code 的回复。

## 命令参考

| 命令 | 说明 |
|------|------|
| `login.bat` | 登录/重新登录（检测是否已登录） |
| `start-all.bat` | 一键启动 Agent + AutoReply |
| `npm run login` | 手动执行 QR 登录 |
| `npm run config` | 查看/修改配置 |

## 配置文件

所有数据存储在 `~/.weixin-claude-bot/`：

| 文件 | 内容 |
|------|------|
| `credentials.json` | 微信登录凭证 |
| `config.json` | Bot 配置（模型、权限、工作目录） |
| `sync-buf.txt` | 消息游标（断点续传） |
| `memories/*.md` | 用户长期记忆 |

## API 端点 (Agent)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /inbox | 获取并清空消息队列 |
| GET | /inbox/peek | 查看队列（不清空） |
| POST | /send | 发送微信消息 |
| GET | /upload | 图片上传页面（浏览器） |
| POST | /upload-image | 上传图片文件 |
| GET | /status | 健康检查 |

## 注意事项

- **iLink 协议是实验性的** — 腾讯未正式公开文档，API 可能随时变更
- **Claude Code 的 skills/extensions** 是本地的，与 Bot 无关。你可以在 Claude Code 的工作目录中自行配置。
- **Token 会过期** — 出现 session 过期提示时重新运行 `login.bat`
- **图片分析** — 需要手机和电脑在同一 WiFi 网络
- **DeepSeek 兼容 API** 不支持多模态视觉，图片通过 OCR 提取文字

## 项目结构

```
weixin-claude-bot/
├── wechat-agent.js        # HTTP Agent (iLink 轮询 + API)
├── wechat-autoreply.js    # 自动回复守护进程
├── login.bat              # 一键登录脚本
├── start-all.bat          # 一键启动脚本
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # (旧版) 主入口
│   ├── login.ts           # QR 登录
│   ├── config.ts          # 配置管理
│   ├── store.ts           # 状态持久化
│   ├── ilink/
│   │   ├── types.ts       # iLink 协议类型
│   │   ├── api.ts         # HTTP API 封装
│   │   └── auth.ts        # QR 登录流程
│   └── claude/
│       └── handler.ts     # (旧版) Claude 子进程调用
├── tessdata/              # Tesseract OCR 中文语言包
└── docs/                  # 技术文档
```

## License

MIT