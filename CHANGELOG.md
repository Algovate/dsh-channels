# 变更记录

## 0.1.0 — 未发布

第一个版本。微信（iLink）与 Telegram 两个适配器，核心提供回合驱动、交互、媒体、门链、
持久状态与一个 Web 状态卡片。

### 核心

- 契约：`ChannelAdapter` / `InboundMessage` / `Outgoing` / 三态 `SendResult` / 编号交互。
- 会话：由会话键派生 `chan-<channel>-<sha1>`，重启接回同一条；`/new` 追加会话线。
- 回合：live → resume → create →（撞车）resume；挂宿主预设；人设进 system prompt；
  人的话作 `source.kind = <channel>`。
- 门链：过期账号 → 白名单（默认拒绝）→ 会话白名单 → 每分钟 → 每天，每级带原因码。
- 队列：每会话 FIFO，跨会话并行；交互答复与命令 bypass。
- 交互：提问与审批共用一个每会话待答队列，编号渲染，桌面与聊天先答者胜，超时/撤销不编造答案，
  审批没人决定时失败关闭。
- 媒体：入站附件（类型嗅探）、进模型的结构化描述、出站附件按 MIME 路由、回合产物回发。
- 语音：SILK→WAV（可选 `silk-wasm`）、常驻 ASR 桥（python 子进程，失败降级）。
- 文档：txt/md/csv/json 直读、docx 零依赖解压、pdf 可选解析。
- 状态：`config.json` 覆盖、两段式 journal、outbox、`doctor`、状态表守卫测试。
- 限流：每分钟/每天，计数进宿主 `channels` 存储域（无域时回落文件）；发送最小间隔与冷却。
- 手机命令：`/help` `/whoami` `/status` `/new`。

### Web 客户端

- Chat 行：通道消息带徽标的气泡，`exclusive` 声明，主题 token 与宿主一致。
- 状态卡片：通道与能力、允许的发送者（可增删）、限流与行为开关（可保存）、待重发、
  最近 8 条发出的状态。
- 工作区：启动时登记「Channels」工作区，会话首次附着时挂进去。

### 适配器

- `@rodin/dsh-channels-weixin`：iLink 长轮询（vendored MIT 传输）、文字/图片/文件/视频、
  语音转写、文档正文、发送限流与冷却。
- `@rodin/dsh-channels-telegram`：Bot API 长轮询（无依赖）、文字/图片/文件/视频、编号交互，
  与微信适配器不共享代码。

### 测试

162 条：契约与 id、门链、队列、分条、状态表守卫、回合驱动各路径、交互队列与两条 seam、
媒体描述、journal、限流计数、产生的文件、文档抽取、ASR 客户端、客户端 Chat 行与卡片、
两个适配器。
