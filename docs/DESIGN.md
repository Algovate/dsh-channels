# dsh-channels 详细设计

- 日期：2026-11-17
- 状态：**设计定稿，M0 未开工**
- 关系：这是**新项目**的设计文档（用户选定方案 C：不做 fork）。当前仓库的
  `dsh-plugin-weixin` 1.5.13 是它的参考实现与证据来源，不是它的代码基线。
- 落地位置：M0 开始时整篇移入新仓库 `dsh-channels/docs/DESIGN.md`；本文留在
  `dsh-plugin-weixin/docs/` 作为交接记录，其中的真机证据链接都指向本仓库的 `docs/`。

> 一句话：**`dsh-channels` 让 DSH Agent 出现在你的聊天软件里；微信是第一个适配器。**

---

## 1. 定位

### 1.1 问题

今天要把 DSH Agent 接到一个聊天平台上，得把三件事重新写一遍：

1. **回合驱动**：把一条消息变成一个 agent 回合，再把回复捞出来发回去（还要处理
   事件唤醒、重启恢复、side session、超时、迟到回复）。
2. **交互 seam**：`ask_user_question` 与 `approval/request` 要在手机上答，还要保证
   "一个会话同时只有一个待答"、答案不被入站队列堵死。
3. **状态与迁移**：状态文件清单、保留策略、`doctor`、`/diag export`、域存储迁移。

这三件事与聊天平台**无关**，但每接一个平台就重抄一次。参考实现里有 36k 行，
其中大约三分之一才是"微信"（vendor transport、媒体、ASR、贴纸），其余是上面那些。

### 1.2 产品边界

| 是 | 不是 |
|---|---|
| 本地优先：Agent 在用户自己的机器上，聊天软件只是入口 | 不做公网服务端、不做 SaaS、不做多租户 |
| 个人账号：一个 bot 绑一个微信/Telegram 账号，账号可以多个但互不干扰 | 不做企业微信/公众号/客服系统 |
| 通道可插：核心只认契约，适配器各带自己的 SDK | 不做"一个适配器通吃所有平台"的猜测式抽象 |
| 交互完整：提问、审批、计划确认都能在手机上完成 | 不做工具审批的旁路、不做静默放行 |
| 数据在本地：凭证 0600、记忆是自己的文件 | 不做聊天记录镜像、不上传第三方 |

### 1.3 用户

单机用户（开发者、能开终端的人）。验收标准永远是"在真机上、用真账号、发真消息"，
不是"单测绿了"。

---

## 2. 名字与包

### 2.1 已定

- 项目名 / 仓库名 / 显示名：**`dsh-channels`**，中文「**通道**」。
- 第一个适配器：**微信**（iLink，vendored `openclaw-weixin`）。

### 2.2 npm 名冲突（必须先决定）

`dsh-channels` 这个 npm 名**已经被占用**：`dushaobindoudou` 于 2026-08-24 发布了
`dsh-channels@0.0.1`，描述是 "Chat-channel framework for dsh bots — name reserved;
first release in development"，包含 telegram / discord / slack / feishu 适配器的计划。
**和本项目是同一类东西**。

实测（2026-11-17）：

| npm 名 | 状态 |
|---|---|
| `dsh-channels` | ✗ 已被占用（同类项目，0.0.1 预留） |
| `dsh-channel` | ✓ 可用 |
| `dsh-channel-weixin` | ✓ 可用 |
| `dsh-channels-weixin` | ✓ 可用 |
| `dsh-presence` | ✗ 已被同一作者占用 |

所以发布名二选一（ADR-001）：

- **A（推荐）**：`@<scope>/dsh-channels` + `@<scope>/dsh-channels-weixin`。品牌、代码、
  文档全部保持 `dsh-channels`；scope 用你自己的 npm 用户名或组织。
- **B**：`dsh-channel` + `dsh-channel-weixin`（单数，两个都空着）。品牌和包名不完全一致。

设计上做了一件事让这个决定**只影响一个字段**：包 id 不硬编码，构建时从
`package.json` 注入（见 3.3）。参考实现把 `PKG = "dsh-plugin-weixin"` 抄在
`src/client.js` 与 `bin/*` 里，改名要动 16 个文件，这次不重犯。

### 2.3 与占用者的区别（写进 README）

同为"通道框架"，但本项目的落点是**个人账号 + 本地 Agent**：微信（个人号，iLink）、
审批/提问在手机上完成、状态与记忆都在本机、零公网依赖。那个项目面向"社区平台桥"，
计划里的适配器是 telegram/discord/slack/feishu。差异化要一句话说清，避免搜索混淆。

---

## 3. 仓库与构建

### 3.1 结构（pnpm workspace monorepo）

```
dsh-channels/
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ core/                       # dsh-channels        核心，零厂商依赖
│  │  ├─ src/
│  │  │  ├─ index.ts              # apply(ctx, config)
│  │  │  ├─ service.ts            # ctx.channels（注册表 + 路由 + 发送）
│  │  │  ├─ turns/                # attach / resume / inject / followup / awaitReply
│  │  │  ├─ interaction/          # 提问 + 审批：队列、渲染、解析、TTL
│  │  │  ├─ outbound/             # 分条、markdown 归一、outbox、三态
│  │  │  ├─ inbound/              # 归一化后的入站管道：门 → 队列 → 回合
│  │  │  ├─ store/                # state-layout、域、doctor、diag export
│  │  │  ├─ schedule/             # ctx.schedule 适配 + 回复汇
│  │  │  ├─ commands/             # agent 作用域命令
│  │  │  └─ client/               # 卡片 + Chat 行（esbuild 打包成 dist/client.js）
│  │  ├─ cordis.patch.yml
│  │  └─ package.json
│  └─ adapter-weixin/             # dsh-channels-weixin
│     ├─ src/                     # 长轮询、收发、媒体、语音、ASR 桥
│     ├─ vendor/openclaw-weixin/  # 原样 vendored（附 THIRD-PARTY-NOTICES）
│     └─ package.json
└─ docs/ (DESIGN.md, compatibility.md, manual-checks.md, ADR/)
```

规则：

- **核心不依赖任何厂商 SDK**；`dependencies` 目标是 ≤ 5 个（`@deepseek-ai/schemastery`、
  `zod`、`qrcode-terminal` 属于适配器/核心各自需要时才装）。
- 适配器单独发版：微信 SDK 变了不影响核心版本号。
- 每个包各自是一个 DSH bundle（`dsh.bundle.patch`）；用户可以只装微信，也可以只装核心
  （核心单装时没有通道，卡片会说明"还没有装任何适配器"）。

### 3.2 语言与构建

- **TypeScript**（Node ≥ 22，ESM）。`tsc` 出 `dist/`（`declaration: true`），
  `main: dist/index.js`、`types: dist/index.d.ts`。
- **客户端入口用 esbuild 打一个 bundle**，产出包装：

```js
// dist/client.js —— 构建产物，不是手写
window.__ModuleLoader__.load({
  id: "<package name, injected at build>",
  factory: (require) => { /* … */ return module.exports; },
});
```

  构建脚本末尾做两条断言（写成 `test/packaging.test.ts`）：
  1. 产物里出现的 `require(...)` 只有 `react` 与 `react/jsx-runtime`；
  2. 产物的 `id` 等于 `package.json` 的 `name`（改名只改一处）。

- **不做**手写 bundle。参考实现证明手写能跑，但两个包 + 契约之后，类型比"省一个构建步骤"更值钱。
- 测试用 `node --test`，零测试框架依赖（参考实现 1353 条就是这么跑的）。

### 3.3 包 id 的单一来源

```ts
// build 时注入：import.meta.env 不通用，用 define
export const PKG = "__PKG_NAME__";      // esbuild define 替换
```

`bin/*`（安装器、发布脚本）从 `package.json` 读，不在源码里写死。

---

## 4. 架构总览

```
                 ┌────────────────────────────── 适配器（每平台一个）────────────────────────────┐
  微信 iLink ──▶ │ inbound: 长轮询 → 归一化 InboundMessage → core.dispatch                      │
                │ outbound: core.send(Outgoing) → 平台 API → SendResult                        │
                │ interaction: render(interaction) / parse(reply, interaction)                │
                │ capabilities: { text, media, voice, buttons, … }                            │
                └───────────────▲──────────────────────────────┬──────────────────────────────┘
                                │ register(adapter)            │ send / render
                ┌───────────────┴──────────────────────────────▼──────────────┐
                │ core: ctx.channels（服务）                                  │
                │  ├ registry：channel id → adapter                           │
                │  ├ route：account+conversation → session line               │
                │  ├ inbound queue：每会话串行 + 交互回复 bypass              │
                │  ├ turn driver：attach/resume → inject → followup → await    │
                │  ├ interaction queue：每会话单待答 + TTL                    │
                │  ├ outbound：分条 / outbox / 三态 / journal                 │
                │  └ store：state-layout / 域 / doctor / diag                 │
                └───────────────┬──────────────────────────────┬──────────────┘
                                │                              │
                     DSH 宿主服务（Cordis）               本地文件（~/.dsh/channels/）
       agents · session/event · systemPrompt · uiConversation   sessions.json · memory/ · journal/
       schedule · commands · storageDomain · sessionTitle        outbox.json · config.json · logs/
```

三条不变量（违反任何一条都是设计事故）：

1. **适配器只会"翻译"，不做业务**：它不知道回合、不知道提问队列、不知道存储。
2. **核心不含协议**：它不 import 任何平台 SDK，也不认识 `wxid` 之类的字段。
3. **失败只降级，不传染**：任何通道错误都不能让一个回合失败，只能 warn + 文件日志。

---

## 5. 核心契约

### 5.1 适配器契约

```ts
export interface ChannelAdapter {
  /** 稳定 id，同时是 session id 前缀、source.kind、Chat 行键的一部分。 */
  readonly id: ChannelId;                    // 'weixin' | 'telegram' | …
  readonly label: { zh: string; en: string } // 显示名，卡片与 Chat 行徽标用
  readonly capabilities: Capabilities;

  /** 启动与停止（长轮询/长连接）。幂等。 */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** 入站：适配器把原始事件归一化后交给核心。返回 disposer。 */
  onInbound(handler: (message: InboundMessage) => void): () => void;

  /** 出站：核心只调这一个函数。 */
  send(target: Target, outgoing: Outgoing): Promise<SendResult>;

  /** 可选：正在输入、编辑、已读等。核心只在 capabilities 声称支持时调用。 */
  typing?(target: Target): Promise<void>;

  /** 交互渲染：核心把"要问什么"交给适配器决定长什么样。 */
  readonly interactions: {
    format: 'numbered' | 'native';
    render(interaction: InteractionView): Outgoing;
    parse(reply: string, interaction: InteractionView): InteractionReply | null;
  };

  /** 账号：登录、登出、状态、过期标记。卡片与 doctor 用。 */
  readonly accounts: AccountSurface;
}

export interface Capabilities {
  text: boolean;
  media: { image: boolean; file: boolean; voice: boolean; video: boolean };
  stickers: boolean;
  typing: boolean;
  /** 平台能发"按钮/回调"时核心直接用它，否则退回编号文本。 */
  buttons: boolean;
  /** 同一条消息可否编辑（用于"正在输入…"式的原地更新）。 */
  edit: boolean;
  /** 单条文本上限，核心据此分条；0 表示不分。 */
  maxTextChars: number;
}
```

**能力降级只发生在核心**：平台不发语音 → 核心改发文件；平台 4096 字 → 核心按
`maxTextChars` 分条；平台没有按钮 → 交互退回编号（微信就是这样）。

### 5.2 数据契约

```ts
export interface Target {
  channel: ChannelId;
  accountId: string;
  conversationId: string;
}

export interface InboundMessage extends Target {
  senderId: string;
  /** 干净的人话。注入块永远不在这里（见 5.3）。 */
  text: string;
  media: InboundMedia[];
  at: number;
  /** 适配器私有原始结构，仅排障用；核心不解释它。 */
  raw?: unknown;
}

export type InboundMedia =
  | { kind: 'image' | 'file' | 'video'; path: string; mime: string; bytes: number; name?: string }
  | { kind: 'voice'; path: string; mime: string; bytes: number; transcript?: string };

export interface Outgoing {
  text?: string;
  bubbles?: { maxChars: number; gapMs: number };
  media?: OutgoingMedia[];
  /** reply 走正常回复；notice 是插话（如"已在处理"）；question 是交互渲染。 */
  kind: 'reply' | 'notice' | 'question';
}

/** 三态是必须的：平台"接受了"不等于"对方收到了"。 */
export type SendResult =
  | { ok: true; messageId: string; unconfirmed?: false }
  | { ok: true; unconfirmed: true; messageId?: string }
  | { ok: false; retryAfterMs?: number; code: string; detail?: string };
```

`SendResult` 的三态直接决定 journal 写什么、outbox 是否重试、卡片上显示
"已接收 / 接收但没回执 / 失败"。参考实现的 `sendOutcome()` 就是这么来的。

### 5.3 入站管道

```
adapter.onInbound → normalize 校验 → 身份解析（账号/会话/发送者）
   → 交互回复？──是──▶ interaction.queue.consumer(reply)      ← 不入队列，直接消费
   │ 否
   ▼
门（gate）链：已登录 → 白名单 → 每发送者每分钟 → 每发送者每日 → 会话允许 → 群聊策略
   │ 拒 → 记 journal（refused + 原因）+ 可选回一句（有冷却）
   ▼
per-conversation FIFO 队列（同一会话串行；不同会话并行）
   ▼
回合驱动（5.4）
```

门链是**纯函数 + 配置**，每条门一个测试；拒绝一律有原因码，卡片与 `/diag` 显示原因码。

群聊策略与 `mentionsBot` 这类平台相关判断留在适配器（它知道 @ 的表示法），
核心只消费 `InboundMessage.group: boolean`。

### 5.4 回合驱动（最难的一块，规则全部来自参考实现的真机教训）

```ts
// 一次投递的骨架
async runTurn(line: SessionLine, message: InboundMessage): Promise<TurnResult> {
  const record = await this.attach(line);              // 1. 先 resume，失败再 create
  this.injectPerTurnBlocks(record, line);              // 2. 每轮块 → agent.inject()
  const before = lastSeq(record.agent);
  record.agent.followup(userMessage(line, message));   // 3. 人话 → followup
  return this.awaitReply(record, before, {             // 4. 事件唤醒 + 看门狗
    onProgress: noteTyping,
    signal: this.queue.signal(line),
  });
}
```

硬规则（每条都要有测试，见 §6）：

- **session id 确定性**：`chan-${channel}-${sha1(channel|account|conversation).slice(0,16)}`。
  重启后 resume 同一条线，而不是开新会话。
- **先 resume 后 create**：`SessionAlreadyExistsError` 时复查 `agents.get(sessionId)` 再 create，
  create 撞车时重试一次 resume（GUI 会抢同一个 session）。
- **回复靠事件唤醒**：订阅 `session/event`（`{ global: true }`），`awaitReply` 由事件驱动；
  轮询只是"一直没有事件"时的看门狗（快窗 400ms → 慢窗 `eventPollMs`）。
- **人设进 system prompt**：`ctx.systemPrompt.section({ name: 'channels:persona' })`，
  不拼进用户消息。
- **每轮块用 `agent.inject()`**：记忆/生活状态/回忆/知识等作为一段带 `source` 的快照，
  `kind: 'channels-context'`、`form: 'snapshot'`、`sections: [...]`。人话永远只有人话。
- **入站消息的 `source`**：`{ kind: '<channel>', form: 'message', conversationId, group, senderId? }`。
  **不能**用 `kind: 'user'` 加字段——会话格式校验对 `user` 只允许
  `kind`/`rpcId`/`clientTimeZone`；未知 kind 走 `default:` 放行。
- **迟到回复**：回合结束后才落盘的 assistant 消息要么丢弃、要么作为 `notice` 发出，
  由 `onLateReply` 统一决定（不能默默丢）。
- **side session**：记忆摘要、日报、群总结用独立 session（id 前缀 `chan-<ch>-mem-…`），
  它的回合永不发气泡。

### 5.5 出站管道

```
core.send(target, outgoing)
  ├ markdown 归一（平台能力：纯文本/受限 markdown）
  ├ 分条（bubbles 或 capabilities.maxTextChars）→ 每条一个 SendResult
  ├ 发送 → ok? journal settled(accepted|unconfirmed)
  │        └ 失败? outbox 入队（指数退避、按会话保序、上限 N、重启仍在）
  └ 超长代码块 → 改发文件（capabilities.media.file）
```

- **journal 两段式**：发送前写 `phase: "sending"`，有结果后写 `phase: "settled"`，
  读取时按会话 + `at` 合并。日志里"有 out 但对方没收到"必须可解释。
- **outbox** 只存文本与媒体引用，不存"发送意图"的中间态；重试是幂等的（平台侧靠
  `clientId` 去重，能拿到就带）。

### 5.6 交互 seam（提问 + 审批）

```ts
interface InteractionView {
  id: string;
  kind: 'question' | 'approval';
  conversation: Target;
  title: string;
  options: { id: string; label: string }[];   // question 用
  hint?: string;
  expiresAt: number;
}

interface InteractionReply { value: string }   // question: option id；approval: 'allow' | 'deny'
```

核心职责：

- **每会话单待答**：新交互到达时，如果同会话已有待答 → 排队（或按策略拒绝，见配置）。
- **TTL**：默认 10 分钟，到点撤回并向 agent 报"未答复"（对应 `unanswered` 语义）。
- **回复 bypass 入站队列**：交互回复直接进 `interaction.queue`，**绝不**排到正在提问的
  回合后面（否则死锁到超时，参考实现踩过）。
- **审批只允许一次**：`allowed-once`；拒绝与取消必须区分（宿主区分了）。
- **降级**：`capabilities.buttons === false` 时用 `interactions.format === 'numbered'`，
  严格解析（`1` / `1.` / 全角数字），解析失败**不**消费待答，回一句"没听懂，回复序号"。

### 5.7 日程与命令

- `/subscribe` → `ctx.schedule.create({ kind: 'at'|'cron', prompt, target })`。任务由宿主
  持有，**重启不丢**。
- 调度回合：宿主以 `source.kind === 'schedule'` 的 user 消息进入会话线，核心的回复汇
  把它发回聊天（`onLateReply` 不适用，这是"本回合的回复"）。
- **prompt 里不写死时间**：循环任务第二次就会说错时间，让 agent 自己用 `time-context`。
- 命令注册在 **agent 作用域**：`agentCtx.inject(['commands'], (scope) => scope.commands.register(...))`；
  直接读 `agentCtx.commands` 会抛 `without inject`。
- 命令结果落在 detached notice，不是聊天气泡；看不到时先查 `command/done` 事件是否落盘。

### 5.8 状态与存储

**状态根**：`~/.dsh/channels/`（不复用 `~/.dsh/weixin`，见 ADR-004）。

`state-layout.ts` 从第一天就是唯一权威表，条目形状照搬参考实现（它已被证明好用）：

```ts
type Entry = {
  kind: 'file' | 'dir';
  relative: string;
  label: string;
  store: 'domain' | 'planned' | 'file';   // 迁移意向
  reason?: string;                        // store: 'file' 必填
  pattern?: true;                         // memory/life-<account>.json 这类按 key 分裂的
};
```

- **守卫测试**：扫描 `src/**/*.{ts,tsx}`，出现 `join(stateRoot, 'x')` 而 `x` 不在表里 → 测试失败。
  （参考实现靠它抓出了漏掉的 `diag/`。）
- **`doctor --state`**：按迁移意向分组、带理由、列出**表外文件**；`/diag export` 复用同一个
  `stateInventory()`。
- **域**：`channels_derived`（域名不能有连字符），第一阶段五张可重建计数表：
  `budget` / `sender_daily` / `usage_ledger` / `life_state` / `affinity`。
  节奏：文件权威 → 影子写 → 双读比对 → 切读；每条记录**进域前归一化**，镜像与比对用
  同一个对象；mismatch 限流**按表**。
- **`import`**：`dsh-channels import --from ~/.dsh/weixin --dry-run` 列出会搬什么
  （账号凭证、registry、sessions.json、memory/、人设绑定）；真跑前要求旧插件未挂载。

### 5.9 UI

**一张卡，六个页签**：通道（装了哪些适配器）/ 账号（登录、白名单、过期）/ 会话 / 交互
（提问审批开关与超时）/ 存储（清单 + 占用）/ 诊断（doctor 摘要 + 导出）。

**Chat 行**（每个通道一种）：

```ts
const definition = {
  kind: 'channel-user',           // 渲染器键，必须在 conversation.chat.node 上注册
  target: 'chat',
  match: (event) => event.type === 'user/message' && event.data.source?.kind === adapter.id
    ? { id: String(event.data.id), role: 'start', exclusive: true }   // ← 必须独占
    : null,
  start: (_c, m) => rowData(m.event.data),      // 只取纯数据，不读全局
  update: (c) => c.state,
  buildViewNode: (c) => ({ key: c.key, kind: 'channel-user', id: c.id, target: 'chat',
    anchorSeq: c.start?.event.seq ?? 0, location: c.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible', groupTree: 'exchange', data: c.state }),
};
```

- 徽标用通道名（微信绿 / Telegram 蓝），气泡抄宿主 `._bubble_1sgyj_1`：
  `--dsw-specific-bubble`、`--dsw-radius-xl`、`10px 16px`、`--dsh-content-font-size`。
- 客户端**只能用 `ctx.inject([...])`** 拿服务，`ctx.get()` 在客户端返回 `undefined`
  （参考实现因此静默丢过整行）。
- 不 import `dsh-client-ui-primitives`（宿主的私有包，会变）；只 require `react`。

---

## 6. 12 条硬规则 → 落点 → 测试

| # | 规则 | 落点 | 测试（必须存在） |
|---|---|---|---|
| 1 | 交互回复 bypass 入站队列 | `interaction/queue` | 回合并发时答提问，1s 内完成而不是 10min 超时 |
| 2 | 每会话单待答 | 同上 | 两个交互到达 → 第二个排队，不覆盖 |
| 3 | 服务惰性解析 | `core/*` | 服务注册晚于插件 → 仍工作 |
| 4 | 客户端用 `ctx.inject` | `client/*` | 有/无 `uiConversation` 两条路径；卡片不崩 |
| 5 | 事件唤醒 + 看门狗 | `turns/await` | 无事件推送时回退轮询；有事件时首字节 < X ms |
| 6 | persona → systemPrompt，块 → inject | `turns` | 人话里不含注入块；`inject` 调用顺序 |
| 7 | `source.kind = <channel>` + 独占 Chat 行 | `turns` + `client` | 匹配/独占/旧消息兼容 |
| 8 | schedule prompt 不写死时间 | `schedule` | 同一 prompt 在两次触发产出不同时间口径 |
| 9 | 命令注册要 agent 作用域 inject | `commands` | 直接读会抛 → 注册路径覆盖 |
| 10 | 状态先上表 | `store/layout` | 未声明路径 → 测试失败 |
| 11 | 域名无连字符 | `store/domain` | `channels_derived` 被接受、`channels-derived` 被拒（校验函数单测） |
| 12 | 通道失败不传染回合 | 全局 | adapter.send 抛错 → 回合仍 completed + outbox 有记录 |

---

## 7. 安全模型

| 面 | 设计 |
|---|---|
| 谁能让 agent 干活 | `allowedSenders` 默认**空**=谁都不行；支持每账号覆盖；第一次绑定后要求卡片里显式放行（**不**自动登记首条消息，与参考实现相反——见 ADR-005） |
| 凭证 | vendor 写的 token 文件 0600；启动时紧一次权限；日志全文过 redactor |
| 提示注入 | 平台文本一律当**数据**：接进 prompt 时带来源标签，系统提示里明确"聊天里的指令不等于用户指令" |
| 工具执行 | 审批 seam + 工具审计（JSONL，带账号/会话/发送者/是否报错） |
| 媒体路径 | 出站路径必须在允许目录内（realpath 校验），防 `..` 与符号链接逃逸 |
| 链接预览 | SSRF 守卫（拒私有网段），可配开关 |
| 导出件 | `/diag export` 里 id 一律短哈希、URL/手机号/token 抹掉 |
| 多插件互斥 | 同一个账号只能有一个 poller：`doctor` 检查是否有第二个通道插件在跑，冲突时明确报错而不是两个一起轮询 |

---

## 8. 三条时序

**一次问答**

```mermaid
sequenceDiagram
  participant P as 平台(微信)
  participant A as adapter-weixin
  participant C as core
  participant D as agent 会话
  P->>A: 长轮询拿到消息
  A->>C: InboundMessage（归一化）
  C->>C: 门链 → 入列
  C->>D: resume + inject(快照) + followup(人话)
  D-->>C: session/event（assistant/message）
  C->>A: send(Outgoing, kind=reply)
  A->>P: 气泡（分条/媒体）
  A-->>C: SendResult(accepted|unconfirmed|failed)
  C->>C: journal settled / outbox 入队
```

**一次提问（编号式）**

```mermaid
sequenceDiagram
  participant D as agent
  participant C as core
  participant P as 平台
  D->>C: user-questions/request(问题, 选项)
  C->>C: 每会话单待答入列（TTL 10min）
  C->>P: adapter.interactions.render() → 带序号的文本
  P->>C: 用户回 "2"
  Note over C: 回复 bypass 入站队列
  C->>C: parse() → option id
  C-->>D: answer(option id)
  C->>P: 回执"已记录"
```

**一次订阅到点**

```mermaid
sequenceDiagram
  participant S as ctx.schedule
  participant D as 会话
  participant C as core
  participant P as 平台
  S->>D: user/message(source.kind="schedule")
  D-->>C: turn 结束
  C->>P: send(回复汇, kind=reply)
```

---

## 9. 配置草案（`Config` 用 schemastery）

```ts
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  allowedSenders: Schema.array(String).default([]),        // 默认拒绝所有人
  allowlistPerAccount: Schema.dict(Schema.array(String)).default({}),
  // 交互
  questionsEnabled: Schema.boolean().default(true),
  approvalsEnabled: Schema.boolean().default(true),
  interactionTimeoutMs: Schema.number().default(10 * 60_000),
  // 节奏
  bubbles: Schema.object({ maxChars: Schema.number().default(600), gapMs: Schema.number().default(400) }).default({}),
  eventPollMs: Schema.number().default(2000),              // 看门狗，不是主节奏
  // 门链
  senderPerMinute: Schema.number().default(6),
  senderPerDay: Schema.number().default(60),
  // 安全
  sourceContext: Schema.boolean().default(false),          // 在 prompt 里带来源标签
  linkPreview: Schema.boolean().default(false),
  // 存储
  storageEngine: Schema.union(['file', 'domain']).default('file'),
});
```

每个字段都要写清楚"何时生效"（live / restart / 重新登录），卡片用徽章标注——
参考实现已有现成的 `describeConfigEffect()` 思路。

---

## 10. 测试策略

1. **假宿主 harness**（从参考实现搬思路，不搬代码）：

```ts
function harness() {
  const agents = { get: () => undefined, create: async ({ setup }) => ({ agent, dispose }) };
  const agent = { followup, inject, steer, session: { id, snapshotEvents: () => events } };
  const ctx = { get: (name) => services[name], inject: (deps, cb) => cb(subFor(deps)) };
  return { ctx, events, prompts };
}
```

2. **适配器契约套件**：同一组测试跑在 `MockAdapter` 与 `WeixinAdapter`（wire 层用假 server）上：
   归一化、三态、能力降级、交互解析、错误分类。
3. **守卫测试**：§6 的 12 条 + 状态清单守卫 + 打包守卫。
4. **真机清单**（`docs/manual-checks.md`）：每条按"手机做了什么 → 看什么证据"写，
   证据落到 `journal` / `session.v*.jsonl.zstd` / `doctor --state` / GUI DOM。
5. **CI**：`check`（类型 + 语法 + 打包规则）→ 全量测试 → `pack` 自检（跑一遍出厂脚本）→
   标签发布（provenance）。

目标：**每个已知坑一条测试**，并且测试标题就写清它防的是什么（参考实现的测试名就是文档）。

---

## 11. 发布与兼容

- 版本：`MAJOR.MINOR.PATCH`；适配器独立发版；`CHANGELOG` 用"用户能感知的变化"写，
  不列提交。
- 兼容表 `docs/compatibility.md`：插件版本 × 宿主版本 × 验证到什么程度，只写**真机验证过**
  的组合；`doctor` 打印当前宿主是否在表里。
- 升级流程：宿主升 rc → 跑 `manual-checks` → 更新兼容表 → 必要时发补丁版。
- npm：`@scope/dsh-channels`、`@scope/dsh-channels-weixin`（或 `dsh-channel*`，见 2.2）。
- 许可证：MIT；vendored 的 `openclaw-weixin` 保留原声明；`THIRD-PARTY-NOTICES` 列全
  （`zod`、`qrcode-terminal`、`silk-wasm` 等）。

---

## 12. 里程碑

| 阶段 | 交付 | 估时 | 出口条件（Exit criteria） |
|---|---|---|---|
| **M0 骨架** | workspace、core（服务/路由/回合驱动/出站/状态表）、adapter-weixin（只文字）、`doctor --state`、假宿主 harness | 2–3 天 | mini 真机：微信发一句 → 回一句；重启后 resume 同一条会话；`doctor` 0 problem；守卫测试就位 |
| **M1 交互** | 提问 + 审批 + 单待答队列 + bypass + TTL + 编号渲染/解析 | 3–4 天 | 手机回序号能答；审批"允许"真的执行并只允许一次；并发回合下不超时 |
| **M2 媒体** | 图片/文件/语音（SILK→WAV→ASR）/视频抽帧、outbox、journal 两段式、限流 | 3 天 | 双向图片文件语音；断网重试；journal 能回答"发出去没有" |
| **M3 UI** | 卡片六页签 + Chat 行（徽标/气泡）+ 命令 13 条 | 2–3 天 | GUI 里微信消息是带徽标的一行；`/status` 产生 `command/done` |
| **M4 存储** | 域影子写五张表 + `/diag export` + `import` 迁移 + 冷启动复核 | 2 天 | 域值与文件一致、零 mismatch；旧数据可搬且 dry-run 可读 |
| **M5 第二个适配器** | Telegram（最省事）证明抽象 | 2–3 天 | 同一套契约测试全绿；**核心零改动** |
| **M6 发布** | CI、provenance、market 上架、README/兼容表 | 1–2 天 | `npm i` 即用；标签发布带 provenance |

M0 的目录清单（最小可运行）：

```
packages/core/{src/index.ts, src/service.ts, src/turns/*.ts, src/outbound/*.ts,
               src/inbound/*.ts, src/store/{layout,inventory,domain}.ts, cordis.patch.yml}
packages/adapter-weixin/{src/index.ts, src/transport.ts, src/media.ts, vendor/}
test/{harness.ts, layout-guard.test.ts, turn.test.ts, outbound.test.ts}
```

---

## 13. 风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 宿主 API 每 rc 都动（座位名、客户端加载器、`createUserMessage` 签名） | 升级即坏，且只有真机能发现 | 兼容表 + 每次升级跑真机清单；把所有宿主接触面收敛到 `core/host/` 一层，便于一处适配 |
| iLink（个人微信）API 不稳定/被限 | 通道随时可能失效 | 适配器隔离 + 明确"平台边界不是插件能绕过的"；不承诺 SLA |
| npm 名被占用 | 发布不了 | 已实测并给出两个可用方案（§2.2） |
| 单人维护（bus factor） | 长期不可持续 | 契约 + 假宿主 harness 让第二个适配器/第二个维护者能上手；文档优先于技巧 |
| 过度抽象（"先写框架再适配"） | 半年做不出能用的东西 | 先用微信把 M0–M1 打通，Telegram 只用来验证抽象（M5 才允许动核心） |
| 安全边界被"图方便"突破（自动放行首个发送者、跳过审批） | Agent 被陌生人驱动 | §7 的红线写成测试：默认拒绝、审批只允许一次、审计不可关 |

---

## 14. 与旧插件的关系

- 旧插件 `dsh-plugin-weixin@1.5.13` 保持可发布状态，作为**参考实现**；
  它的 `docs/manual-checks.md` 5.1–5.9、`docs/storage-migration.md`、本仓库的
  `docs/remaining-plan.md` §4「已知坑」是本设计的事实来源。
- **代码复用**：MIT 允许复制，但只允许复用**小工具与模式**（原子写、分条、门链、测试写法），
  并保留版权声明；不复用 5.9k 行的客户端 bundle 与 4.4k 行卡片。
- **数据迁移**：`import` 命令，dry-run 先行；账号 token 搬过去后重紧 0600。
- **互斥**：两个插件不能同时挂载（同一账号只能一个 poller）；`doctor` 要检查并在文档里写明。
  `cordis.patch.yml` 的入口 id 与旧插件不同（否则 loader 会去重），但**状态根不同**，
  所以互相看不见，必须靠 doctor 检查提醒。

---

## 15. ADR

| # | 决定 | 理由 | 代价 |
|---|---|---|---|
| 001 | 核心/适配器分包；npm 名用 scope（`@scope/dsh-channels`）或 `dsh-channel` | `dsh-channels` 已被同类项目占用（0.0.1 预留） | 品牌与包名可能不完全一致 |
| 002 | TypeScript + esbuild（仅客户端入口） | 契约多、两个包；类型比"省一个构建"值钱 | 多一步构建；CI 要先 build |
| 003 | 包 id 构建时注入，源码不硬编码 | 改名只改一处（旧插件改了 16 个文件） | 构建脚本要断言 id 与 package.json 一致 |
| 004 | 状态根 `~/.dsh/channels/` | 与旧插件隔离，避免互相污染 | 迁移要显式 `import` |
| 005 | 不自动放行首个发送者 | 默认拒绝才叫安全；自动放行是"方便"换"陌生人都能驱动 agent" | 首次使用多一步：卡片里点一下 |
| 006 | 入站 `source.kind = <channel>` + Chat 行 `exclusive` | `user` source 不许加字段；不独占就被画成上下文行 | 失去宿主的"继续"按钮（失败回合），接受 |
| 007 | 客户端只用 `ctx.inject`，不用 `ctx.get` | 客户端上下文只解析 inject 过的服务，`get` 静默返回 undefined | 无 |
| 008 | 先微信后 Telegram，核心最小化 | 先有能用的东西，再用第二个适配器检验抽象 | Telegram 上线晚 |

---

## 附录 A · 命令清单（agent 作用域）

| 命令 | 成本 | 说明 |
|---|---|---|
| `/status` | 0 | 账号、会话线、配额、预算、模型 |
| `/new` `/list` `/use` | 0 | 会话线管理 |
| `/stop` `/retry` | 0 | 打断 / 重发上一条 |
| `/quiet` `/snooze` | 0 | 静默 N 分钟 |
| `/remind` `/subscribe` | 0 / 到点一次模型调用 | 本地计时器 / 宿主日程 |
| `/memory` `/forget` | 0 | 记忆查看与删除 |
| `/diag` `/diag export` | 0 | 体检 / 可外发的体检包 |
| `/persona` | 0 | 切角色（M3 后可迁到 agent preset） |
| `/help` | 0 | 命令表 |

## 附录 B · 初版状态表（M0 就上表）

| 条目 | kind | store | 备注 |
|---|---|---|---|
| `accounts`（凭证） | dir | file | vendor 写，0600 |
| `registry.json` | file | planned | 绑定账号清单 |
| `config.json` | file | planned | 设置覆盖 |
| `sessions.json` | file | planned | 会话线 |
| `workspace/` | dir | file | agent 工作目录（用户产物） |
| `memory/` + `memory/index/` | dir | planned | 记忆与回忆索引 |
| `journal/` `audit/` `logs/` | dir | file | append-only |
| `media/inbound/` | dir | file | 二进制 |
| `outbox.json` | file | planned | 待发队列（保序） |
| `budget.json` `sender-daily.json` `usage-ledger.json` | file | domain | 派生计数 |
| `memory/life-<account>.json` `memory/affinity-<a>-<c>.json` | file | domain | `pattern: true` |
| `instance.lock` `diag/` `backups/` | — | file | 锁/产物/备份 |
| `login-qr.png` `*.tmp` | — | file | 临时 |

## 附录 C · 术语

- **通道（channel）**：一个聊天平台适配器，如 `weixin`。
- **会话线（session line）**：一个 `(account, conversation)` 对应的 agent 会话，可有多条改线。
- **待答交互（interaction）**：一次提问或审批，每个会话同时最多一个。
- **门（gate）**：入站放行判断，纯函数。
- **门链（gate chain）**：已登录 → 白名单 → 限流 → 会话 → 群聊，顺序固定。
