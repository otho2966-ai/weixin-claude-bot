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
git clone https://github.com/otho2966-ai/weixin-claude-bot.git
cd weixin-claude-bot
```

### 2. 配置 config.json（关键步骤）

⚠️ **项目目录下没有 `config.json`！** 所有配置（模型、路径、API 地址等）都存储在系统用户目录下：

```
~/.weixin-claude-bot/config.json
```

复制示例文件并编辑：

```bash
# 创建配置目录
mkdir -p ~/.weixin-claude-bot

# 复制示例配置
cp config.example.json ~/.weixin-claude-bot/config.json

# 编辑配置（根据你的环境修改路径和模型）
notepad ~/.weixin-claude-bot/config.json
```

**必须修改的字段：**

| 字段 | 你的值示例 | 说明 |
|------|-----------|------|
| `cli` | `D:\claude-code\cli.js` | Claude Code 的 cli.js 路径 |
| `cwd` | `D:\claude-code` | Claude Code 工作目录 |
| `model` | `deepseek-v4-flash` | 使用的模型 |
| `gitBashPath` | `C:\Program Files\Git\bin\bash.exe` | Git Bash 路径（Windows 必填） |

详细字段说明见下方的[配置文件](#配置文件)章节。

### 3. 登录微信 Bot

```bash
login.bat
```

或手动执行：

```bash
npm install
npm run login
```

终端显示二维码，用微信扫码并确认。登录凭证保存在 `~/.weixin-claude-bot/credentials.json`。

### 4. 配置环境变量（可选）

设置 API 密钥，或复制 `.env.example` 为 `.env` 并填入配置：

```bash
set ANTHROPIC_API_KEY=sk-your-key-here
```

环境变量可覆盖 `config.json` 中的设置：

| 变量 | 说明 | 优先级 |
|------|------|--------|
| `CLAUDE_CODE_CLI` | Claude Code CLI.js 路径 | 环境变量 > config.json > 默认 |
| `CLAUDE_CODE_CWD` | Claude Code 工作目录 | 环境变量 > config.json > 当前目录 |
| `CLAUDE_CODE_GIT_BASH_PATH` | Git Bash 路径 | 环境变量 > config.json > 自动检测 |
| `TESSERACT_PATH` | Tesseract OCR 可执行文件 | 环境变量 > config.json > 默认路径 |
| `TESSDATA_PREFIX` | Tesseract 语言包目录 | 环境变量 > config.json > bot 内置目录 |
| `ANTHROPIC_BASE_URL` | API 地址 | 环境变量 > config.json > 内置默认 |

### 5. 启动 Bot

```bash
start-all.bat
```

会启动两个窗口：
- **WeChat Agent** — HTTP 服务 (localhost:3456)
- **Auto-Reply** — 自动回复守护进程

### 6. 发消息测试

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
| `config.json` | **Bot 配置（所有路径、模型等）** |
| `.env` | 环境变量（API密钥、路径覆盖） |
| `sync-buf.txt` | 消息游标（断点续传） |
| `memories/*.md` | 用户长期记忆 |

### 配置方法

1. 参考 `config.example.json` 创建你的配置
2. 复制到 `~/.weixin-claude-bot/config.json`

`config.json` 全部字段：

```json
{
  "model": "claude-sonnet-4-6",
  "maxTurns": 50,
  "cwd": "D:\\path\\to\\claude-code",
  "cli": "D:\\path\\to\\claude-code\\cli.js",
  "permissionMode": "bypassPermissions",
  "multiTurn": true,
  "gitBashPath": "C:\\Program Files\\Git\\bin\\bash.exe",
  "tesseractPath": "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
  "tessdataPrefix": "",
  "anthropicBaseUrl": "https://api.deepseek.com/anthropic"
}
```

| 字段 | 说明 |
|------|------|
| `model` | Claude Code 使用的模型 |
| `maxTurns` | 每次消息的最大 Agent 轮次 |
| `cwd` | Claude Code 的工作目录 |
| `cli` | Claude Code 的 `cli.js` 路径 |
| `permissionMode` | 权限模式 |
| `multiTurn` | 是否启用多轮对话 |
| `gitBashPath` | Git Bash 路径（Windows 必填） |
| `tesseractPath` | Tesseract OCR 可执行文件路径 |
| `tessdataPrefix` | Tesseract 语言包目录 |
| `anthropicBaseUrl` | Anthropic 兼容 API 地址 |

> 路径配置优先级：**环境变量 > config.json > 脚本内置默认值**

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