# 状态 · M0 + M1 + M2 + M2b（0.1.0）

- 日期：2026-11-17
- 结论：**M0/M1/M2 真机通过，M2b 的文档抽取真机通过、语音的转写链路真机验证（微信语音端到端待补）**。
- 范围：文字、交互（提问+审批）、媒体（图片/文件/视频双向）、产生的文件回发、两段式 journal、
  发送限流、文档正文抽取、语音转写。GUI 卡片、Chat 行、存储域迁移仍在后续（见 DESIGN §12）。

## 已实现

| 模块 | 内容 |
|---|---|
| `packages/core` | 契约（types）、会话 id 派生、入站门链（默认拒绝）、每会话 FIFO 队列 + `runNow` bypass、回合驱动（live → resume → create → 撞车再 resume；注入 context；`source.kind = <channel>`）、宿主默认模型路由与预设挂载、分条/纯文本归一、媒体描述、outbox、两段式 journal、状态表+库存+doctor、配置（schemastery）+ 状态目录 `config.json` 覆盖、产生的文件扫描、文档正文抽取 |
| `packages/adapter-weixin` | iLink 长轮询（可单步 `pollOnce`）、文字/媒体发送、发送限流与冷却、入站归一化、入站媒体下载（含类型嗅探）、SILK→WAV（silk-wasm）、ASR 桥（常驻 python 子进程）、账号面、编号式交互渲染/解析 |
| 测试 | **128 条**：契约/id、门链、队列、分条、状态表守卫、回合驱动各路径、归一化、传输层（可注入 poll/send）、interaction 队列与两条 seam、媒体描述、journal、产生的文件、文档抽取、ASR 客户端、包内路径 |

## 真机证据（mini，宿主 `0.2.2-rc.3`）

M0（文字 + 重启 resume）：

```
{"level":"info","line":"turn for weixin|… settled in 3695ms (197 chars)"}
user/message   source {"kind":"weixin","form":"message","conversationId":"o9cq…","group":false}
assistant/message  [{"type":"text","text":"我收到了“4…”"}]
turn/end       {"reason":{"kind":"completed"}}
```

M1 提问（同一条会话线内，回合阻塞等答复）：

```
02:29:28 answered the pending interaction in weixin|…
02:29:32 turn … settled in 29861ms (323 chars)
tool/result  {"answers":[{"id":"drink","selected":["1"]}]}
```

M1 审批（工具真执行）：

```
02:36:58 approval/request: tool=bash target=weixin|…
02:37:08 answered the pending interaction in weixin|…
02:37:10 turn … settled in 14300ms
~/Desktop/channels-approval-test.txt 出现（52 bytes，已清理）
```

M2 入站图片（嗅探扩展名后一次读成）：

```
saved inbound image to …/mwk3c7u6-mwk3c84x-image.jpg (193960 bytes)
ASSISTANT "这是一张济南未来 7 天天气趋势图…"
```

M2 出站附件（回合产物）：

```
journal out … "media":["…/inbound-image-20261117.jpg"], "delivery":"accepted",
              "messageId":"7528286688427258120"
```

M2b 文档正文（正文进了 prompt；该回合随后因 API 余额不足失败，与抽取无关）：

```
[用户发送的文件已保存到本地：…/mwk3oq7x-…md（…md, 3.5k）]
<document path="…md">
在临床带教场景中，该系统的交互流程围绕…
```

## 撞出来的坑（都已修，且都有测试或文档）

1. **保存的设置必须盖过 loader 配置**：patch 里的 `allowedSenders: []` 把状态目录的 `config.json`
   盖掉了，第一条消息被 `not-allowed` 拒。现在合并顺序是 `{...loader, ...saved}`。
2. **新建会话必须有模型路由**：否则第一步就 `agent has no provider/model`。读宿主的
   `agentDefaultModel.currentSelection()` 作为 `agentOptions`。
3. **新建会话必须挂宿主预设**：不挂 `agentPresets.mount()` 时 agent 只有 `working_directory`
   一个工具，`ask_user_question` 根本不存在（模型自己在 reasoning 里说的）。
4. **重启后要先 resume 再 create**：会话在磁盘上、没有活 agent 时，`create` 报
   `session already exists`；顺序是 live → resume → create →（撞车再 resume）。
5. **内部报错不发给人**：模型/宿主错误只进日志，给用户一句「这边出了点问题」。
6. **iLink 图片不带 content-type**：先前存成 `.bin`，`read_image` 拒读，agent 自己复制成 `.jpg`
   才看到图。现在按文件头嗅探（JPEG/PNG/GIF/WEBP/MP4/WAV/PDF）给扩展名。
7. **下载不能阻塞轮询**：附件先异步取完再交给核心，否则一个 20MB 视频会卡住所有会话。

部署经验：pnpm 的 `file:` 目录依赖是**复制**进 profile 的，换了源码目录必须重新 `pnpm install`，
否则跑的还是旧代码（这次因此白验了一轮）。

## M1 已知行为：桌面可能先"答空"

真机观察到一次：agent 调 `ask_user_question`，微信收到了编号问题，但 41ms 后桌面 answerer 返回了一个
**空的答案集**（`{answers: []}`，等价"跳过"），回合于是继续用文字回答，微信里那条提问成了幽灵。
竞速本身是对的（先真答者胜），但"桌面答空"与"用户跳过"在 seam 词汇里无法区分。
后续可选：把空答案集当成"还没决定"，继续等微信（像 approval 对 `unavailable` 那样）。

## M3：Chat 行（GUI 已验）

频道消息在 GUI 里现在是一条带「微信」徽标的气泡：徽标 + 群聊/发信人/附件数，人话在气泡里，
右对齐、配色和圆角用宿主自己的 token。

真机证据（浏览器里数 DOM）：

```
打开 chan-weixin-1421e1b70d9e4eef →
[data-channels-chat-row] 19 个
badges: "WeChat 用 ask_user_question 让我选一个：咖啡还是茶？…"
console: 无 @rodin/dsh-channels 相关告警
```

### 工作区分组（M3b 已完成）

插件启动时用 `ctx.inject(['workspaceRegistry'], …)` 登记一个叫「Channels」的工作区
（`workspaceRegistry.create(dir, title)` 对已有目录幂等），并在会话**首次附着**时调
`workspace.attachSession(sessionId)` 把已存在的会话挂进去——注册表只在建表时做历史归组，
已存在的会话不会自动补挂。真机结果：

```
workspace.json → Channels sessions: ['chan-weixin-1421e1b70d9e4eef']
GUI 侧栏 → Channels 分组展开后出现 "o9cq807BqQ0x: proceed"，点开渲染 19 条微信气泡
```

顺带修掉一个真 bug：`startChannels` 之前**忽略了 `config.workingDirectory`**（写死状态目录下的
`workspace`），所以上一轮"改到默认工作区"的实验其实没生效。

### 设置卡片（M3b 已完成：状态可读）

插件页（Plugins → `@rodin/dsh-channels`）里有一张「通道」卡片：通道、媒体能力、允许的发送者数量、
待重发数、是否在等答复、最近 8 条发出的状态（accepted / unconfirmed / failed / pending），带刷新。

卡片还能**改白名单**：输入发送者 id → 添加，或点某个条目上的 ✕ 移除。写入走宿主自己的
`POST /channels/allowlist`（同源 + `Origin` 校验），一次同时改**运行中的门链**与状态目录里的
`config.json`，所以下一条消息就生效、重启后还在。真机：

```
POST {add:"test-sender-1"} → {"ok":true,"allowlist":[…,"test-sender-1"]}   （config.json 同步）
POST {remove:"test-sender-1"} → {"ok":true,"allowlist":[…]}
POST origin=http://evil.example → 403 {"code":"origin"}
卡片（Plugins → @rodin/dsh-channels）：微信 / 1 个允许 / image·file·video / Outbox 0 / 最近发出 accepted…
```

数据来源按优先级两级：

1. **`channels.status()` Remote**（`TypertRemoteService`，namespace `channels`）。宿主侧注册成功
   （日志有 `status remote registered`），但客户端**拿不到** `ctx.remote.channels`：`api-remotes` 的
   客户端半边只挂载**构建期生成**的 `/remote` 工件，插件在运行期新增 namespace 不会出现在浏览器里。
2. 所以卡片回退到宿主自己注册的 **HTTP 路由 `GET /channels/status`**（`ctx.webServer.register`），
   同源、`no-store`、只返回卡片要显示的东西。真机验证（页面里直接 fetch）：

```
{"status":200,"channels":["weixin"],"allowlist":1,"journal":8,"outbox":0}
```

### 这一层踩到的几个坑

1. **`apply` 必须返回 disposer 函数**：我先把 `ctx.inject(...)` 的返回值直接返回，boot 直接
   拒绝整个客户端（`TypeError: Invalid effect`，只有一行 console 日志，页面看起来一切正常）。
   现在返回一个函数，里面同时拆行注册与注入。
2. **频道的会话在 GUI 里属于「Ungrouped」**：会话按工作区分组，而 `~/.dsh/channels/workspace`
   不是已登记的工作区。展开「Ungrouped」就能看到；会话标题是首条消息命名出来的
   （`o9cq807BqQ0x: 图显示不了？`）。要给频道会话一个正经分组，得向宿主的 workspace 服务登记
   工作区——留给 M3b。
3. **会话要先有标题**：`sessionTitle.rename(session 对象, title)`（第一个参数是活会话对象，
   不是 id，传 id 会得到 `session "undefined" is not live`）。

## M4：持久化的限流计数（存储域）

限流闸门原来是**内存计数**：重启清零，"每人每天 60 条"等于没有。现在计数持久化，
存活在宿主的 `channels` 存储域里（`ctx.storageDomain.open` + `defineDomain`/`domainTable`），
读是同步的（闸门不能 await），写是写穿（落盘失败只 warn，绝不因此拒绝人的消息）。

没有 storageDomain 的宿主（测试、headless）回落到插件自己的 `counters.json`，接口一致。

真机：`rate counters: channels storage domain`（03:51:11）——域打开成功；写入在首条入站消息时发生。

### 这一层踩到的坑（值得记住）

1. **把宿主包当普通依赖装，会把宿主的行搞坏**：`@deepseek-ai/dsh-storage-domain@0.2.0-rc.2` 作为
   dependency 被 pnpm 按到 profile 里，宿主启动时判定 "incompatible with dsh 0.2.2-rc.3" 并
   **禁用了自己的 storage-domain 行**。改成 **optional peerDependencies** + 运行期动态 `import()`
   之后宿主恢复正常。教训：宿主提供的包只能声明成 peer，且代码里必须能"没有它也跑"。
2. **`ctx.get('storageDomain')` 拿不到**（和 workspaceRegistry 一样），必须 `ctx.inject(['storageDomain'], …)`。
3. 静态 `import` 一个可选 peer 会让 `tsc -b` 在没装的构建里失败；把 specifier 写进变量再
   `await import(name)`，类型上就只需要自己的接口。

## M5：第二个适配器（Telegram）

`packages/adapter-telegram`（`@rodin/dsh-channels-telegram`）—— 与微信适配器**不共享任何一行代码**，
核心也没为它改一行。这就是"适配器只是翻译层"这个说法的证据。

| 部分 | 内容 |
|---|---|
| 传输 | Bot API 长轮询（`getUpdates` + offset，webhook 需要公网 HTTPS，家用网络没有）；`sendMessage`、`sendPhoto/sendVideo/sendDocument`（multipart）、`getFile` 下载、`sendChatAction` typing；`fetchImpl` 可注入，所以一次轮询能在测试里单步 |
| 归一化 | 私聊/群聊、photo 只取最大尺寸、document/voice/audio/video 带 mime、**拒绝**编辑消息、频道广播、bot 自己的消息和空消息 |
| 交互 | 编号式（与微信一致）：`render` 生成 `1. …`，`parse` 接受全角数字 |
| 失败策略 | 每次发送都返回结果不抛异常；429 带 `retryAfterMs`；轮询失败退避 3s |

真机**未验**：需要一个 bot token（`adapterConfig["@rodin/dsh-channels-telegram"].token`）。
代码层面的证据是 11 条适配器测试 + 契约测试（同一份 `ChannelAdapter` 契约被核心接受，
`render/parse` 的编号行为一致，缺 token 时是清晰报错而不是半启动）。

客户端也认识它了：`CHANNELS` 表里加了 `telegram`（行 `telegram-user`，徽标「Telegram／电报」）。
这张表是唯一需要为新适配器改动的地方——因为浏览器看不到宿主的注册（见 M3 那条限制）。

## 手机端命令（/help、/whoami、/status、/new）

手机上做不了的三件事——看状态、查自己的 id、开新会话——现在都是命令。命令在**门链之后、
回合队列之前**被消费：允许的人拿到回答，陌生人拿到拒绝，两者都**不会启动模型回合**。

| 命令 | 作用 |
|---|---|
| `/help` | 列出四个命令 |
| `/whoami` | 发送者 id、会话 id、通道/账号、当前会话线（配合白名单用） |
| `/status` | 通道、状态目录、允许人数、待重发、是否在等答复、最近 3 条发出的状态 |
| `/new` | 这条聊天换到新的会话线；旧会话留在 GUI 里 |

`/new` 的会话线是**派生的**（`sessionIdFor` 按 `会话#线号` 再算一次），线号存在持久计数里，
所以重启不会走回旧会话。

真机（2026-11-17 12:02）：`/help`、`/whoami`、`/status`、`/new` 全部到达；`/new` 的日志是
`starts session line 1` + 一条确认消息，且**没有**产生回合。

## 已知边界

- 语音**微信端到端**未验：ASR 引擎与桥在 mini 上已单独验证（见下），但用户发出的一条语音没有到达 iLink。
- 审批只给「允许一次 / 拒绝」，没有"允许并记住"（宿主也没有稳定的一次性授权）。
- 多题只支持「一题一行/分号分隔」，没有逐题确认；微信没有按钮，全走编号。
- **视频不抽帧**：只保存视频文件，模型读不了画面。
- **PDF 抽取需要可选依赖 `pdfjs-dist`**；没装时只给路径并说明未抽取。
- 没有 GUI 卡片、没有 Chat 行：微信消息在 GUI 里暂时显示为 context 行（M3）。
- 回合回复靠轮询 `snapshotEvents()`（默认 120ms）；事件唤醒还没做。
- 没有工具审计、`/diag export`、命令、记忆注入——这些是 M3/M4 的范围。
- 单账号；多账号选择靠 `adapterConfig.accountId`。
- 与旧插件不能同时挂载（同一微信账号只能一个长轮询）：mini 的旧插件已从 profile 移除，
  备份是同目录的 `package.json.before-channels` / `pnpm-lock.yaml.before-channels`。

## 本机怎么跑

```bash
npm install
npm test            # build + test（128 条）
npm run doctor      # 状态清单：DSH_CHANNELS_STATE_DIR 或 ~/.dsh/channels
```

## 部署到一台机器（手工流程）

```bash
# 1) 打包两个包（dist 必须已构建；适配器还要带 bin/ 与 vendor/）
tar czf /tmp/channels-core.tgz -C packages/core package.json cordis.patch.yml bin dist
tar czf /tmp/channels-weixin.tgz -C packages/adapter-weixin package.json vendor bin dist

# 2) 目标机：解到某目录，profile 里加 file: 依赖 + bundles 行，移除旧插件
#    改完源码目录要重新 pnpm install（file: 是复制）
# 3) 导入账号（旧插件的 credentials 可以直接拷）
mkdir -p ~/.dsh/channels && cp -R ~/.dsh/weixin/openclaw-weixin ~/.dsh/channels/
# 4) 白名单（默认拒绝所有人）+ 适配器配置
cat > ~/.dsh/channels/config.json <<'JSON'
{
  "allowedSenders": ["<你的 sender id>"],
  "adapters": ["@rodin/dsh-channels-weixin"],
  "adapterConfig": {
    "@rodin/dsh-channels-weixin": {
      "asrCommand": "/path/to/venv/bin/python",
      "asrModelDir": "/Users/<you>/.dsh/channels/asr-models"
    }
  }
}
JSON
```

语音转写（可选，本机实测的一套）：

```bash
python3 -m venv ~/dsh-plugin-pkgs/asr-venv
~/dsh-plugin-pkgs/asr-venv/bin/python -m pip install mlx-whisper        # Apple silicon
HF_HUB_DISABLE_XET=1 ~/dsh-plugin-pkgs/asr-venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("mlx-community/whisper-small-mlx", token=False,
                  local_dir="/Users/<you>/.dsh/channels/asr-models/mlx-community__whisper-small-mlx")
PY
# 单独验证：say 生成一句 → afconvert 成 16k wav → 喂给 bin/asr-bridge.py
```

host 的 API key 在 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（0600），换 key 后重启 host。
2026-11-17 换过一次，备份是同目录 `.credentials.yaml.bak-<stamp>`。
