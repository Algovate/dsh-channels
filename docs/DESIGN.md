# 设计

一句话：**适配器只做翻译，其余全在核心里**。这份文档说明核心有哪些部件、它们之间靠什么契约
相连、以及为什么必须这样——每一条"必须"都对应一个在真机上踩过的坑。

## 1. 分层

```
        ┌──────────────────────────────────────────────────────────────┐
   平台 │ 微信 iLink 长轮询 / Telegram Bot API 长轮询                  │
        └───────────────────────────┬──────────────────────────────────┘
                                    │ 适配器包（库，不是 loader 行）
        ┌───────────────────────────▼──────────────────────────────────┐
        │ ChannelAdapter 契约                                          │
        │  capabilities · accounts · interactions · send · onInbound   │
        └───────────────────────────┬──────────────────────────────────┘
                                    │ 一条 InboundMessage
        ┌───────────────────────────▼──────────────────────────────────┐
        │ 核心                                                         │
        │  门链 → 交互答复 → 命令 → 每会话 FIFO → 回合驱动 → 发送       │
        │  状态：outbox · journal · counters · config overlay          │
        └───────────────────────────┬──────────────────────────────────┘
                                    │ agents / session / systemPrompt
        ┌───────────────────────────▼──────────────────────────────────┐
        │ DSH 宿主（会话、模型、工具、审批、提问、存储域、工作区）       │
        └──────────────────────────────────────────────────────────────┘
```

核心不认识任何平台概念：没有"微信账号"，只有 `accountId`；没有"群"，只有 `group: boolean`；
没有"语音"，只有 `media: [{kind:'voice', …}]`。适配器不认识 DSH 概念：它不知道回合、不知道
会话、不知道审批，只把平台消息翻译成 `InboundMessage`，把 `Outgoing` 翻译回平台调用。

## 2. 契约

### 2.1 `InboundMessage`

```ts
{
  channel: string          // 'weixin' | 'telegram' | …
  accountId: string        // 平台账号（bot 自己）
  conversationId: string   // 会话（私聊/群），适配器格式化好
  senderId: string         // 人；白名单比的是这个
  text: string
  media: InboundMedia[]
  group: boolean
  at: number               // ms
  contextToken?: string    // 回复要带的口令（iLink 有，Telegram 没有）
}
```

### 2.2 `ChannelAdapter`

```ts
{
  id, label: { zh, en },
  capabilities: { text, media{image,file,voice,video}, stickers, typing, buttons, edit, maxTextChars },
  accounts: { list(), markExpired?(id, expired) },
  interactions: { format: 'numbered'|'native', render(view), parse(reply, view) },
  start(), stop(),
  onInbound(handler): () => void,
  send(target, outgoing): Promise<SendResult>,
  typing?(target): Promise<void>
}
```

`SendResult` 是三态的：`{ok:true, messageId}` / `{ok:true, unconfirmed:true}` / `{ok:false, code, retryAfterMs?}`。
`unconfirmed` 是"平台说收到了但没给 id"——真机上它真的发生过，把它当成功或当失败都不诚实。

### 2.3 会话 id

`sessionIdFor(target)` = `chan-<channel>-<sha1(channel|account|conversation)[0:16]>`。
**由会话键派生，不是随机**：重启、重装、换机器都能接回同一条会话线。

`/new` 用**线号**扩展这个规则：`sessionIdFor({...target, conversationId: 'X#1'})`。线号存在持久
计数里，所以重启不会走回旧线；旧线保持不动，永远留在 GUI 里。

## 3. 一次入站的数据流

```
适配器 onInbound
   │
   ├─ 门链（gateMessage）                       ← 纯函数，每级带原因码
   │    过期账号 → 白名单（默认拒绝）→ 会话白名单 → 每分钟 → 每天
   │    拒绝：写日志、返回原因，人得不到回复（也不该得到）
   │
   ├─ journal 记一行 `received`
   │
   ├─ 有待答交互？ 是 → 解析回复
   │        ├ 答上了：settle，**不进回合队列**（否则排在正在提问的回合后面，死锁）
   │        └ 答不上：回一句提示，待答保持
   │
   ├─ 是命令？ 是 → 执行并回复，**不进回合队列**
   │
   └─ 每会话 FIFO 队列（同会话串行，跨会话并行）
        └─ 回合驱动
             1. 附着会话：live → resume → create →（撞车）resume
             2. 挂宿主预设（否则没有工具）
             3. 人设进 system prompt，其余上下文 agent.inject
             4. 人的话作 source.kind = <channel> 投进去
             5. 轮询会话日志直到 assistant/message 或 turn/end
             6. 纯文本 + 分条 → 发送（每段一条）
             7. 回合里产生的文件 → 附件
```

## 4. 五个必须

每条都对应一次真机故障。

**① 门链在一切之前，且默认拒绝。** 空白名单 = 谁都不行。参考实现的"第一个说话的人自动入册"
是把部署安全性交给运气。

**② 交互答复必须 bypass 回合队列。** 排在提问回合后面 = 死锁到超时。门链仍然先跑：陌生人不能
替你回答。

**③ 附着顺序是 live → resume → create。** 会话在磁盘上而没有活 agent 时，`create` 报
`session already exists`。

**④ 新会话必须挂宿主预设。** 不挂 `agentPresets.mount()` 时 agent 只有 `working_directory`
一个工具——`ask_user_question` 根本不存在（模型自己在 reasoning 里说的）。

**⑤ 内部错误不发给人。** 模型/宿主错误只进日志，用户看到「这边出了点问题」。错误文本里是
宿主内部细节，手机上既看不懂也没法处理。

## 5. 交互（提问与审批）

两个 seam 共享**一个每会话队列**：聊天没有线程，两个提示同时说"1. … 2. …"，回复就没法说明
回答的是哪一个。

- **提示的编号由队列生成**——编号就是回复语法，两处生成迟早会不一致。
- **桌面与聊天同时问，先真答者胜。** 只监听的实现会让桌面在等待期间瞎掉。
- **超时/撤销 reject，绝不编造答案。** 超时给人一句提示；"在电脑上答过了"给另一句。
- 审批的 `unavailable` **不算决定**（"没人答"），聊天还挂着就继续等；都没人决定时**失败关闭**，
  返回 `unavailable` 而不是伪造拒绝。

## 6. 媒体

**入站**：平台附件下载到 `media/inbound/<account>/`，进模型的文本是
`[用户发送的图片已保存到本地：…] + 用 read_image 看` 这样的明确指令，**人话在最后**。
语音有转写就把转写当用户原话；没有转写就明说"无法读取音频"，不给模型臆测的机会。
文档（txt/md/csv/json/docx，可选 pdf）抽正文进 `<document>` 块。

**出站**：`Outgoing.media` 按 MIME 路由；同一回复第一个附件带 caption。回合里新写的文件
（上限 3 个 / 20MB，跳过 `.` 目录与 `node_modules`）在回复之后作为附件发出。

**语音出站不做**：服务端收 bot 的语音项但不投递（参考实现实测两次）。

## 7. 存储

| 数据 | 位置 | 为什么 |
|---|---|---|
| 设置覆盖 | `<state>/config.json` | 卡片通过宿主 HTTP 路由写它；覆盖加载器配置 |
| 限流计数 | 宿主 `channels` 存储域 | 读同步（闸门不能 await）、写穿、多进程安全；没有域时回落 `counters.json` |
| 待重发 | `<state>/outbox.json` | 需要保序的小队列，原子替换 |
| 消息流水 | `<state>/journal/journal-YYYY-MM-DD.jsonl` | append-only，grep 可查；域是 KV，语义不合 |
| 日志 | `<state>/logs/` | 诊断，按天 |
| 媒体 | `<state>/media/inbound/<account>/` | 二进制大对象，用户要能直接打开 |
| 工作目录 | `<state>/workspace/` | agent 产物；默认登记成 GUI 工作区 |
| 通道凭证 | `<state>/openclaw-weixin/` | vendored 登录流程写，0600 |

`store/layout.ts` 是唯一权威表，`doctor` 读它，还有一个守卫测试：代码里写了一个表外的顶层路径
就构建失败。

**journal 两段式**：每条出站写 `sending` 和 `settled`（带 `accepted`/`unconfirmed`/`failed` 与
`messageId`/`code`），按 id 合并；只有 `sending` 的记为 `pending`。"日志说发了、手机没收到"这个问题
只有这样能回答。

## 8. 失败策略

- 一次坏轮询就是一次坏轮询：计数、退避、继续轮询。`errcode` 与 `ret` 同样重要（iLink 的过期会话
  用 `errcode:-14`，`ret` 缺失）。
- 发送失败进 outbox；媒体失败只记日志（outbox 只存文本）。
- 附件下载失败不阻塞消息：人说的话仍然进回合。
- 限流计数落盘失败只 warn：**不能因为计数没存上就拒绝人的消息**。
- 一个会话的会话 id 恢复失败 → resume，再失败 → create，撞车再 resume。

## 9. 界面

浏览器看不到宿主的注册，所以：

- **Chat 行**：客户端按 `CHANNELS` 表注册 `conversation.chat.node` 渲染器 + Claim 定义
  （`source.kind === <channel>`，`exclusive`）。
- **状态卡片**：宿主注册 `GET /channels/status`、`POST /channels/allowlist`、
  `POST /channels/settings` 三个同源路由，卡片读它们；`Origin` 必须匹配，跨站表单不能放宽白名单。

`apply` 必须返回**函数**而不是 injection 句柄——否则 loader 拒绝整个客户端
（`TypeError: Invalid effect`），页面上只有一行 console 日志。

## 10. 明确不做

- 不做"允许并记住"的审批（宿主也没有稳定的一次性授权）。
- 不在服务端渲染 HTML/iframe：主题、深色模式、locale 全都会丢。
- 不写 `cordis.patch.yml`：那是用户的文件，插件只写自己的 `config.json`。
- 不把宿主包当普通依赖装（会把宿主的行搞坏），只声明 optional peer + 动态 `import()`。
