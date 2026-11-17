# dsh-channels · 通道

Chat apps as DeepSeek Harness surfaces. A message from WeChat (or Telegram) becomes a real DSH
session turn, and the answer goes back to the phone — with questions, approvals, attachments,
voice and documents working in both directions.

**Deny by default.** An empty allowlist answers nobody, so mounting the plugin cannot leak an
agent to a stranger.

```
微信 / 电报  ──▶  适配器（只做翻译）  ──▶  核心（门链 · 队列 · 回合 · 交互 · 状态）  ──▶  DSH agent
     ▲                                                                                  │
     └──────────────────────────── 分条 · 媒体 · journal · outbox ◀─────────────────────┘
```

## 包里有什么

| 包 | 作用 |
|---|---|
| [`packages/core`](packages/core) — `@rodin/dsh-channels` | 契约、门链、每会话队列、回合驱动、提问/审批、媒体、journal、限流、持久状态、Web 客户端（Chat 行 + 状态卡片）、`doctor` |
| [`packages/adapter-weixin`](packages/adapter-weixin) — `@rodin/dsh-channels-weixin` | 个人微信（iLink Bot API）：文字、图片、文件、视频、语音转写、文档正文 |
| [`packages/adapter-telegram`](packages/adapter-telegram) — `@rodin/dsh-channels-telegram` | Telegram Bot API：文字、图片、文件、视频（长轮询，无需公网） |

适配器是**库**，不是加载器行：核心按名字从 `adapters` 里加载它们。装第二个通道不会多一条
loader 行，卸载也不会留下悬空行。

## 快速开始

前置：DSH ≥ `0.2.2-rc.3`，Node ≥ 22.13。

```bash
# 1) 构建（工作区根目录）
npm install
npm test            # 162 条：核心 + 两个适配器 + 客户端

# 2) 装进一个 profile：加 file: 依赖 + bundle 行
#    目标机 profile 的 package.json 里
#      dependencies: { "@rodin/dsh-channels": "file:/path/to/packages/core",
#                       "@rodin/dsh-channels-weixin": "file:/path/to/packages/adapter-weixin" }
#      dsh.profile.bundles: [ …, "@rodin/dsh-channels" ]
cd <profile> && pnpm install     # file: 是复制，改完源码要重装

# 3) 白名单（默认拒绝所有人）
mkdir -p ~/.dsh/channels
cat > ~/.dsh/channels/config.json <<'JSON'
{ "allowedSenders": ["<你的发送者 id>"], "adapters": ["@rodin/dsh-channels-weixin"] }
JSON
```

发送者 id 从哪来：先让插件跑起来，给 bot 发一句话，它会被拒；`~/.dsh/channels/logs/` 里会写
`refused … not-allowed (0 allowed sender(s))`，其中的 id 就是。或者在 GUI 的状态卡片里添加。

完整的部署、ASR、状态目录与排障见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 配置

加载器行（`cordis.patch.yml`）与状态目录的 `config.json` 都接受这些字段；**`config.json` 覆盖
加载器**——它是操作者保存的决定，patch 里的值是默认值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 加载适配器 |
| `allowedSenders` | `[]` | 允许驱动 agent 的发送者；空 = 谁都不行 |
| `allowlistPerAccount` | `{}` | 按账号覆盖白名单（语义相同：空 = 拒绝） |
| `allowedChats` | `[]` | 可选的会话白名单；空 = 允许该发送者的任何会话 |
| `adapters` | `[]` | 适配器包名，按顺序加载 |
| `adapterConfig` | `{}` | 每个适配器的配置（按包名） |
| `maxTextChars` | `600` | 单条气泡长度（适配器自带上限时以适配器为准） |
| `bubbleGapMs` | `400` | 同一回复拆分后的气泡间隔 |
| `maxTurnWaitMs` | `1200000` | 一个回合最多等多久 |
| `turnPollMs` | `120` | 回复轮询间隔 |
| `senderPerMinute` | `6` | 每发送者每分钟；`0` = 不限 |
| `senderPerDay` | `60` | 每发送者每天；`0` = 不限 |
| `questionsEnabled` | `true` | 允许在聊天里提问并取回答案 |
| `approvalsEnabled` | `true` | 允许在聊天里审批工具调用（只允许一次） |
| `interactionTimeoutMs` | `600000` | 提问/审批等多久后回落到桌面 |
| `autoSendFiles` | `true` | 把回合里产生的文件当附件发出 |
| `maxProducedFiles` / `maxProducedBytes` | `3` / `20MB` | 产生的文件上限 |
| `workingDirectory` | 状态目录下的 `workspace` | 频道会话的工作目录，也会登记成 GUI 工作区 |

适配器配置（`adapterConfig`）：

```json
{
  "@rodin/dsh-channels-weixin": {
    "accountId": "fd22…@im.bot",
    "asrCommand": "/Users/you/dsh-plugin-pkgs/asr-venv/bin/python",
    "asrModelDir": "/Users/you/.dsh/channels/asr-models",
    "asrLanguage": "zh",
    "mediaEnabled": true
  },
  "@rodin/dsh-channels-telegram": { "token": "123456:ABC…", "botId": "my_bot" }
}
```

## 在手机上

直接发消息就是对话。命令在门链之后、回合之前消费，不会启动模型回合：

| 命令 | 作用 |
|---|---|
| `/help` | 列出命令 |
| `/whoami` | 发送者 id、会话 id、通道/账号、当前会话线 |
| `/status` | 通道、状态目录、允许人数、待重发、是否在等答复、最近发出 |
| `/new` | 这条聊天换到新会话（旧会话仍在 GUI 里） |

提问与审批走编号：问题会带 `1.` `2.` 选项，回复序号即可；审批回 `1` 允许一次、`2` 拒绝。

## 在 GUI 里

- **Chat 行**：通道消息在会话里显示成带徽标的气泡（微信 / 电报），不是普通的用户气泡。
- **工作区分组**：频道会话归到自动登记的「Channels」工作区，不再是 "Ungrouped"。
- **状态卡片**（Plugins → `@rodin/dsh-channels`）：通道与媒体能力、允许的发送者（可增删）、
  限流与行为开关（可保存，下一条消息生效）、待重发、最近发出的状态。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 架构、契约、不变量、一次入站的数据流、存储与状态 |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | 适配器契约、两个适配器的现状、新增一个适配器的清单、已知缝隙 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 部署、状态目录、journal、`doctor`、ASR、排障 |
| [docs/STATUS.md](docs/STATUS.md) | 里程碑、真机证据、明确未做的事 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 架构决策记录（为什么这样） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变化 |

## 许可证

MIT。`packages/adapter-weixin/vendor/openclaw-weixin` 是 vendored 的第三方代码，
来源与许可见 [THIRD-PARTY-NOTICES.md](packages/adapter-weixin/THIRD-PARTY-NOTICES.md)。
