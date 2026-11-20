# 验证状态

## 2026-11-20 重构 Phase 2：状态持久化换成 SQLite

状态层从「整份 JSON 原子重写 + v1/v2 迁移 + legacy 镜像 + 双文件锁」换成 SQLite：`state.db` 的 `sections` 表按事务保存七个段，单写者锁改为原子 `mkdir` 的 `state.lock.d/owner.json`。首次打开在事务里导入旧 `state.json` 与六个旧段文件，校验后归档到 `legacy-state/*.bak`；归档中断会在下次打开补完，不重复导入。`doctor --state` 只读查询数据库，`--migrate` 执行同一导入。

真机验证（部署提交 `be383d7`，宿主进程 `77048`，发布目录 `~/dsh-plugin-pkgs/dsh-channels/be383d7/`）：

- 首次启动完成导入：`sections` 含 `inbox`、`outbox`、`tasks`；`state.json` 已归档，状态根只剩 `state.db`、`-wal`、`-shm`、`state.lock.d`、`legacy-state`。
- 权限：`state.db`、`-wal`、`-shm` 均为 0600（发现默认 umask 生成 0644 后修复并加测试）。
- 重启后三个 section 的 SHA-256 完全一致，无重复导入、无新告警；微信与飞书两个通道正常注册。
- 完整 `npm test` **512 项通过**（新增事务回滚、损坏库拒绝、锁接管、导入归档、权限等用例）。

媒体真实消息的回合验证在 Phase 1 已覆盖；本轮未再发送新消息，持久化以「重启前后哈希一致」和导入/回滚测试为准。

## 2026-11-20 重构 Phase 1：历史归档与共享适配器 kit

按 [设计评审](DESIGN-REVIEW.md) 执行第一阶段：历史计划、审查与部署日记移入 `docs/notes/`，`STATUS.md` 只保留当前记录；新增核心子路径 `@derekluo/dsh-channels/adapter-kit`（`safeFileSegment`、`extensionOfName`、`defaultExtensionFor`），三个适配器共用文件名与扩展名规则，微信通过参数保留 SILK 默认扩展名；适配器对核心包改为必需运行时依赖。

部署提交 `02f0126`（宿主进程 `76619`，发布目录 `~/dsh-plugin-pkgs/dsh-channels/02f0126/`），三个包逐文件校验一致（core 152 / 微信 123 / 飞书 33）。安装后从 profile 目录解析 `@derekluo/dsh-channels/adapter-kit` 成功，两个通道注册且飞书长连接建立，无加载错误。完整 `npm test` **513 项通过**（新增 3 项 kit 测试）。

## 2026-11-20 拆分飞书适配器职责并部署

把飞书适配器的 REST 层拆成 [api.ts](../packages/adapter-feishu/src/api.ts)（域名、`fetch` 注入、请求时限、生命周期、tenant token、网关票据）与 [transport.ts](../packages/adapter-feishu/src/transport.ts)（消息、卡片、上传下载）；附件下载与落盘从入口抽到 [attachments.ts](../packages/adapter-feishu/src/attachments.ts)。`index.ts` 只保留配置解析与装配。测试夹具合并：`test/asr-fixtures.ts`（两个适配器共用）与 `test/feishu-fixtures.ts`，并删掉 API/transport 中未使用的 `logger` 选项。

部署提交 `3c8ff96`（宿主进程 `76413`，发布目录 `~/dsh-plugin-pkgs/dsh-channels/3c8ff96/`），三个包逐文件校验一致（core 149 / 微信 123 / 飞书 33）。用安装后的代码对真实飞书做了只读冒烟：tenant token 换取成功、网关票据返回 `msg-frontier.feishu.cn`（PingInterval 90），两个通道启动无告警。完整 `npm test` **510 项通过**。

## 2026-11-20 合并到 main 并部署

`feat/feishu-channel` 以 `--no-ff` 合并进 main（合并提交 `9105c47`），并推送 `origin/main`（`d9f4504..9105c47`）。合并后在干净树重跑完整测试 **510 项通过**。

随后把 main 的 `9105c47` 部署到 mini（发布目录 `~/dsh-plugin-pkgs/dsh-channels/9105c47/`，备份 `backup-20261120T014150Z/`，宿主进程 `76289`）。部署脚本先按 SHA-256 校验归档，再逐文件比对安装结果：

| 包 | 安装校验 |
|---|---|
| core | 149 个文件一致（含共享 ASR 桥接脚本） |
| 微信 | 123 个文件一致 |
| 飞书 | 27 个文件一致 |

启动日志确认微信与飞书两个通道注册，飞书长连接建立；安装后的两个适配器解析到同一个桥接脚本（`…/@derekluo/dsh-channels/bin/asr-transcribe.py`），`same for feishu: true`。

## 2026-11-20 媒体双向真机验证

在第一轮部署后继续验证媒体，暴露并修复了两个只有真机才会出现的问题，随后部署提交 `a7a71c6`（发布目录 `~/dsh-plugin-pkgs/dsh-channels/a7a71c6/`，飞书归档 SHA-256 `11022c52263d5ce3b9d2312e1dcc1ea712a4d2f23eac6014d8e68a471fdd08d2`，宿主进程 `74523`，备份 `backup-20261120T005744Z/`）。

1. **附件类型误判**：飞书会把 JPEG 以 `.webp` 文件消息投递，`file` 消息又不带 mime，落盘后模型先报格式不符、需自己改名才能读取。新增 [media.ts](../packages/adapter-feishu/src/media.ts) 按魔术字节嗅探 jpeg/png/gif/webp/pdf/ogg/mp3/wav/mp4/mov/zip，文本类按扩展名给 `text/plain`，落盘扩展名与 mime 以内容为准。部署后重发同一张图，保存为 `-file.jpg`（`image/jpeg`），模型直接 `read_image` 读取成功。
2. **上传 `file_type` 非法**：`/im/v1/files` 只接受 `opus/mp4/pdf/doc/docx/xls/xlsx/ppt/pptx`，其他一律必须 `stream`；直接传扩展名会让 `.txt` 报 `Invalid request param.`。改为白名单映射，其余回退 `stream`。

宿主层验证结果：

- 入站图片：落盘 167016 字节，嗅探为 `image/jpeg`，回合 5762ms 正常回复。
- 入站文件（`.md`，8472 字节）：回合 79752ms 完成并投递 1330 字回复。
- 出站适配器层：真实上传并发送图片（`om_x…`）与 txt 文件（`file_key`、`om_x…`）均成功。
- 出站宿主层：让 agent 创建 `hello.txt` 并用 `present` 声明，核心自动投递附件，`delivery:"accepted"`、媒体消息 ID `om_x100b60cdfb9298accf212cb22b75376`，回合 3390ms。

新增媒体嗅探与上传类型回归测试，完整 `npm test` **501 项通过**。

## 2026-11-20 收敛 ASR 桥接并清理重复代码

把两个适配器各自一份的 whisper 桥接脚本收敛为**核心包唯一一份** `bin/asr-transcribe.py`；微信与飞书都通过 `require.resolve('@derekluo/dsh-channels/package.json')` 定位它，配置环境变量统一为 `DSH_ASR_*`（旧 `DSH_WEIXIN_ASR_*`/`DSH_FEISHU_ASR_*` 继续可读）。顺带清理：飞书 transport 的发送路径合并为单一 `#postMessage`，`sendText` 只发文本、卡片归 `sendCard`；socket 的有限重连预算改为降速重试而非无效果计数；normalize/media 删除不可达分支；测试里三份 `MockWebSocket` 抽到 `test/feishu-mocks.ts`。

部署提交 `6ac8c42`（宿主进程 `76021`，发布目录 `~/dsh-plugin-pkgs/dsh-channels/6ac8c42/`）。安装后确认两个适配器解析到同一个脚本：

```
weixin bridge: …/node_modules/@derekluo/dsh-channels/bin/asr-transcribe.py
feishu bridge: …/node_modules/@derekluo/dsh-channels/bin/asr-transcribe.py
same file: true
```

真机回归：飞书语音入站 → `transcribed voice note (9 chars)`（MPS，faster-whisper medium）→ 回合 11.8 秒完成；微信轮询正常启动。完整 `npm test` **510 项通过**。

## 2026-11-20 飞书语音转写（whisper）真机验证

给飞书适配器接入可选语音转写：桥接脚本通用化后只随**核心包**发布一份（`bin/asr-transcribe.py`），微信与飞书共用，环境变量以 `DSH_ASR_*` 为准并兼容旧前缀；新增 `AsrBridge` 保持进程常驻。转写在附件落盘后进行，文本写入 `InboundMedia.transcript`；转写失败只记原因，音频照常交付。新增配置 `asrEnabled`/`asrCommand`/`asrModel`/`asrModelDir`/`asrLanguage`/`asrTimeoutMs`/`asrScriptPath`。

真机过程中修复了一个两个适配器共有的解析缺陷：mlx-whisper 会把 `Detected language: …` 写到 stdout，旧解析器把它当成协议应答并以 `unexpected extra ASR answer` 失败。现在只把以 `{` 开头的行当作协议应答，其余作为诊断日志，微信与飞书共用该修复。

模型选型在 mini 上用真实语音对比（同一桥接脚本、三条真实语音）：

| 引擎 | 热态耗时（约 4 秒语音） | 结果 |
|---|---|---|
| mlx small | 约 0.3 秒 | 2/3 正确，「也好吧」正确 |
| mlx large-v3-turbo（1.5G，对比后已删除） | 约 0.9 秒 | 3 条中 2 条出错，短句更差 |
| faster-whisper medium（CPU int8，1.4G） | 约 5 秒 | 3/3 正确，「转写测速成功」完全正确 |

随后在 mini 上验证了 ctranslate2 的 MPS 后端（Apple Silicon GPU）：同一桥接脚本、同一模型，热态每条从约 5.2 秒降到约 1.2 秒，宿主日志里「模型加载 → 转写完成」从 5.1 秒降到 1.05 秒，转写结果不变。新增 `asrDevice`（`cpu` 默认 / `mps`）与 `asrComputeType`（默认 cpu 用 `int8`、mps 用 `float16`），部署提交 `6dd8d98`（宿主进程 `75857`）并设为 `mps`；真机语音回合正常，转写与回复均成功。

最终默认选用 **faster-whisper medium**（独立 venv `~/dsh-plugin-pkgs/asr-venv-fw`，模型 `~/dsh/channels/asr-models/Systran__faster-whisper-medium`），部署提交 `d2ab828`（宿主进程 `75572`，发布目录 `~/dsh-plugin-pkgs/dsh-channels/d2ab828/`）。宿主层真机确认：语音入站 → 转写 `transcribed voice note (15 chars)` → 模型按内容正确回答。

完整 `npm test` **509 项通过**。ctranslate2 日志提示 Apple Silicon 可用 MPS 后端（约 2 倍提速）；桥接目前固定 CPU int8，后续可作为可选项。

## 2026-11-20 语音/视频真机验证

继续验证语音与视频，暴露并修复了资源下载类型错误：`GET /im/v1/messages/:id/resources/:key` 的 `type` 只接受 `image` 或 `file`，音频和视频必须用 `file`；此前传 `audio`/`video` 会返回 HTTP 400。修复后部署提交 `4c0bb12`（发布目录 `~/dsh-plugin-pkgs/dsh-channels/4c0bb12/`，飞书归档 SHA-256 `fb62992b24c5c3d9c6c94bf70381c256ede5952bbf4aa99f02da1df1f1b474df`，宿主进程 `74717`）。

真机结果：

- 入站语音：`voice.ogg`（4847 字节，嗅探 `audio/ogg`）正常落盘并进入回合；本机无语音转写工具，模型如实说明拿不到逐字内容（适配器按设计只保存音频，不内置转写）。
- 入站视频：`video.mp4`（8718276 字节，嗅探 `video/mp4`）正常落盘；模型用 ffmpeg 抽帧描述内容，并把九宫格截图作为图片回传到原聊天（媒体消息 `om_x100b60cda4faccb4b4c6e89ed549b1a`），顺带覆盖了「视频入站 → 图片出站」的组合链路。
- 出站语音/视频（适配器层）：opus 语音与 mp4 视频均上传并发送成功（视频不需要封面，`image_key` 留空可用）。

至此文本、图片、文件、语音、视频的入站与出站均已在真实飞书应用上验证。完整 `npm test` **502 项通过**。

## 2026-11-20 飞书适配器部署到 mini 并完成宿主全链路验证

在真机协议验证之后，把提交 `d4a662a` 的 core、微信、飞书三个包部署到 mini 的 Web profile，与既有微信通道并行运行。发布目录为 mini 的 `~/dsh-plugin-pkgs/dsh-channels/d4a662a/`，含 `release.json`、`deployment.json` 和 `backup-20261120T005207Z/`（profile 文件与通道配置备份）。

| 包 | 归档 SHA-256 | 安装校验 |
|---|---|---|
| core | `838992ae6912c33a91b66d9ae83a6ba3bdf9fa262bfa9dde0fe4383c0f30dc98` | 148 个文件逐一比对一致 |
| 微信 | `d65ec9c2829467ab4d85890da05e680ca57f6874ab6d3ae837134bc9b2845280` | 124 个文件逐一比对一致 |
| 飞书 | `cd01d028233c28e59a7c6a1e9ab342cb1b0cd282f0e5849f8802b0a1f220a42e` | 21 个文件逐一比对一致，`ws` 依赖已解析 |

部署流程沿用既有约定：停 `com.dsh.web` → 备份 profile 与 `config.json` → 写入依赖并 `pnpm install`（新增 `ws`，从 registry 拉取成功）→ 合并通道配置 → 重启。通道配置只**追加**飞书条目和发送者 `open_id`，微信的 `asrCommand`、`asrModelDir` 与原有白名单原样保留，文件权限维持 0600。宿主新进程 `74060`，启动无 warn/error：

```
channel 'weixin' registered
channel 'feishu' registered
weixin adapter polling account fd22aefdda85@im.bot
feishu adapter connecting app app:cli_aa74460e03789c10
feishu persistent connection established
```

宿主层验证结果：

- `/whoami`：入站落流水，回复「【当前聊天】…通道：feishu…角色：管理员…DSH 会话：chan-feishu-…」以 `delivery:"accepted"` 结算，拿到飞书消息 ID。
- 真实回合：入站「用一句话回复：宿主全链路 OK」→ 接收回执 → 模型回合 `settled in 1348ms` → 回复「宿主全链路 OK」`accepted`。即入站、权限、路由、模型回合、出站完整闭环。
- 两个通道并行，微信轮询与飞书长连接同时在线，无告警。

本轮未发布 npm；媒体双向在宿主层未做真机验收（仅有模拟测试覆盖）。

## 2026-11-20 飞书真实应用端到端验证

用真实自建应用（`open.feishu.cn`，长连接网关 `msg-frontier.feishu.cn`，`service_id=33554678`，服务端 `PingInterval=90s`）做了真机端到端验证，凭证只经环境变量传入仓库外的临时探针，未写入任何 git 跟踪文件。

真机过程暴露并修复了三个模拟测试未覆盖的问题：

1. **WebSocket 帧类型（静默丢帧）**：Node 内置全局 `WebSocket` 的二进制帧默认以 Blob 交付，原代码 `new Uint8Array(blob)` 不报错却返回空数组，导致事件被静默丢弃、无日志。改为使用 `ws` 库（飞书官方 node-sdk 同款），其 message 事件直接给 Node Buffer；并在 `toBytes()` 对 Blob 显式报错，新增回归测试。
2. **tenant token 响应结构**：`auth/v3/tenant_access_token/internal` 是扁平响应（`tenant_access_token` 在顶层，无 `data` 包装），与其他 OpenAPI 不同。改为同时兼容扁平与 `data` 两种形态，新增扁平响应回归测试。
3. **消息编辑约束**：飞书 `PATCH /im/v1/messages` 只能编辑 `interactive` 卡片消息，编辑普通 text 消息返回 `This message is NOT a card.`。因此任务卡（接收回执）改为始终以卡片发送（新增 `sendCard()`），`editMessage()` 固定写卡片内容；普通模型回复仍走 text。

真机验证通过的链路：tenant token 换取、长连接票据与建连、入站文字（正确归一化出 open_id/chat_id/`platformMessageId`）、200 确认帧、原生按钮卡片发送、点按钮触发 `card.action.trigger` 并归一化为按钮 value 文本、卡片原地 PATCH 两次（执行中→完成）、连接断开后按服务端节奏自动重连并重收事件。媒体双向（图片/文件上传下载）已由模拟测试覆盖，本轮真机未发素材。

本地完整 `npm test` **499 项通过**（新增扁平 token、Buffer/Blob 帧两个回归测试）。未发布 npm、未部署到 mini 宿主；真机用的是独立探针进程，验证后已停止并清理含凭证的临时文件。

