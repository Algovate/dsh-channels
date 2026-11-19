# 运维指南

## 安装

需要一台装有 DSH 的机器（桌面版或 CLI）和 Node.js 22.13 或更高版本。已验证的 DSH 版本见[验证状态](STATUS.md)。

### 从 npm 安装

先确认 npm 上有要装的版本，例如 `npm view @derekluo/dsh-channels versions`；只有占位版本时，改用下一节的源码构建。

在终端安装核心和微信适配器。将 `default` 换成实际的 DSH profile 名：

```bash
dsh plugin --profile default add @derekluo/dsh-channels@0.1.0 @derekluo/dsh-channels-weixin@0.1.0
```

使用 Telegram 时，把微信适配器换成 `@derekluo/dsh-channels-telegram@0.1.0`。安装后按下文配置凭证和白名单，再重启宿主。

`dsh plugin` 只是把参数转给 profile 目录里的 pnpm，所以装完要确认 profile 的 `dsh.profile.bundles` 有 `@derekluo/dsh-channels`，没有就补上。`desktop` profile 只能由桌面版自带的 `dsh` 管理，用 npm 装的 CLI 执行 `dsh plugin` 会被拒绝。升级时用新版本号重跑同一条命令，确认 bundle 行仍在，再重启宿主。

如果安装过发布前的本地构建，请把 profile 的依赖和 bundle 列表，以及配置中的 `adapters` 与 `adapterConfig`，都改成本文中的包名。

### 从源码构建安装包

在仓库根目录构建并生成本地安装包：

```bash
npm ci
npm test
package_dir="$(mktemp -d)"
npm pack --workspaces --pack-destination "$package_dir"
printf '%s\n' "$package_dir"
```

把需要的归档复制到目标机上的固定目录。在目标 DSH profile 的 `package.json` 中合并相应的依赖和 bundle 条目。下例同时启用两个包的安装；只使用一个通道时可省去另一个适配器。保留 profile 中已有的依赖和 bundle。

```json
{
  "dependencies": {
    "@derekluo/dsh-channels": "file:/opt/dsh-packages/derekluo-dsh-channels-0.1.0.tgz",
    "@derekluo/dsh-channels-weixin": "file:/opt/dsh-packages/derekluo-dsh-channels-weixin-0.1.0.tgz",
    "@derekluo/dsh-channels-telegram": "file:/opt/dsh-packages/derekluo-dsh-channels-telegram-0.1.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@derekluo/dsh-channels"]
    }
  }
}
```

在 profile 目录运行 `pnpm install`。适配器是核心加载的库，只将核心登记为 bundle。升级本地构建时，给新归档不同的文件名、更新 `file:` 路径并重新安装，然后重启宿主。

## 卸载与停用

临时停用：在 `config.json` 写 `"enabled": false` 并重启宿主，插件不再启动适配器。状态目录原样保留，白名单、会话线号、待重发和流水都还在；改回 `true` 即恢复。

彻底移除：

1. 从 profile 的 `dependencies` 和 `dsh.profile.bundles` 中删掉 `@derekluo/dsh-channels`。可以先运行 `dsh plugin --profile <名字> remove @derekluo/dsh-channels`，但它只转给 pnpm，bundle 行是否清掉以 `package.json` 为准。
2. 不再使用某个通道时，一并删掉对应的适配器包，以及 `adapters`、`adapterConfig` 里的条目。
3. 在 profile 目录运行 `pnpm install`，重启宿主。
4. `~/.dsh/channels` 不会被自动删除。确认不再需要后再移走；里面有凭证和聊天内容，按敏感数据处理。

## 配置

状态根目录默认是 `~/.dsh/channels`，可在宿主进程环境中设置 `DSH_CHANNELS_STATE_DIR`。同目录下的 `config.json` 按**顶层键**覆盖加载器配置：如果写了 `adapterConfig`，它会替换整个原值。未覆盖的键继续用加载器值或核心默认值。

创建含凭证的配置前先运行 `umask 077`；已有文件用 `chmod 600 "$state/config.json"` 收紧权限，其中 `state` 是实际状态目录。不要把包含 token 的配置加入版本库。下文的 JSON 是可合并的示例；替换占位值并保留已有设置。

| 配置 | 核心默认值 | 作用 |
|---|---|---|
| `enabled` | `true` | 为 `false` 时跳过插件启动 |
| `adapters` / `adapterConfig` | `[]` / `{}` | 要加载的包名；适配器参数按包名索引。随包提供的 patch 默认列出微信 |
| `allowedSenders` | `[]` | 全局发送者白名单；空列表拒绝所有人 |
| `owners` | `[]` | 可切换项目/会话和管理计划的发送者；空列表表示所有获准发送者都是管理员 |
| `groupTrigger` / `groupPrefix` | `prefix` / `/ask` | 群聊：`prefix` 只响应带前缀的消息，`mention` 还接受 `groupMention`，`all` 响应全部获准消息；前缀和句柄会在解析命令和回合前去掉 |
| `groupMention` | 空 | `groupTrigger: mention` 时接受的机器人句柄，如 `@my_bot`；留空则只接受前缀 |
| `allowlistPerAccount` | `{}` | 账号键 → 发送者列表；显式空列表仍覆盖全局白名单 |
| `allowedChats` | `[]` | 额外限制聊天 ID；空列表不限制聊天 |
| `senderPerMinute` / `senderPerDay` | `6` / `60` | 按通道、账号和发送者计；设为 `0` 关闭对应限制 |
| `maxTextChars` / `bubbleGapMs` | `600` / `400` | 默认单条文字长度及分条间隔；适配器可设自己的长度上限 |
| `maxTurnWaitMs` / `turnPollMs` | `1200000` / `120` | 等待回合的上限（超时只停止等待，任务继续在后台处理并在完成时回传），以及没有 `session/event` feed 时的回落轮询间隔，单位毫秒 |
| `questionsEnabled` / `approvalsEnabled` | `true` / `true` | 在聊天中接收提问及一次性审批 |
| `interactionTimeoutMs` | `600000` | 已送达的交互提示等待回复的时长，单位毫秒 |
| `autoSendFiles` | `true` | 自动投递本回合 `present` 声明或独立本地 Markdown 图片嵌入的附件 |
| `maxProducedFiles` / `maxProducedBytes` | `3` / `20971520` | 每回合自动发送/索引的文件数上限及单文件字节上限 |
| `projects` | `{}` | 项目别名 → 已存在的绝对目录；`default` 为保留别名 |
| `workingDirectory` | `<state>/workspace` | DSH 会话工作目录 |

配置文件不存在时继承 profile 配置；现有文件不可读、格式错误或权限字段（`enabled`、发送者/聊天列表、账号覆盖）类型错误时会拒绝启用通道，避免退回更宽的权限。卡片保存设置也不会覆盖这样的坏文件，请恢复备份或修正原文件后重启。

手动编辑后需要重启。状态卡片可以实时保存全局白名单、两项配额、提问/审批和自动附件开关，并批准/拒绝未知发送者的待批准请求；管理员名单、账号级白名单、凭证和目录仍在文件里改。批准会优先写入该账号已有的显式白名单覆盖，否则写入全局白名单。`owners` 只限制 `/project`、`/sessions`、`/session`、`/new` 和计划管理；成员仍可执行任务、查看 `/status`、`/tasks`、取回产物和停止自己的任务。群聊默认 `groupTrigger: prefix`，前缀对命令同样生效；设为 `mention` 并配置 `groupMention` 后也接受直接 @ 机器人，设为 `all` 则每位获准成员的每条消息都会触发回合。交互答复在等待期间可不带前缀。

## 项目和会话切换

在 `config.json` 顶层加入项目配置并重启宿主，例如：

```json
{
  "projects": {
    "app": "/Users/example/Workspace/app",
    "docs": "/Users/example/Workspace/docs"
  }
}
```

别名为 1–40 个英文字母、数字、下划线或连字符，首字符须为字母或数字；`default` 固定指向 `workingDirectory`。无效别名或非绝对路径会被忽略。命令只接收别名，不接受临时路径；目录必须存在且可访问。所有获准使用通道的成员都可以选择这些项目，配置目录代表允许 agent 在该目录执行任务，不构成文件系统沙箱。

发 `/projects` 查看别名，`/project app` 选择项目。`/sessions` 显示此聊天在当前项目的最近 20 个会话编号及当前编号；第 0 条是初始会话，尚未发普通消息的编号也可能出现在列表中。`/new` 分配从未使用过的新编号，`/session 0` 可返回初始会话。命令不枚举任意桌面会话，也不接受宿主 session ID；不同聊天和项目的选择相互独立。群聊选择沿用共享会话规则：获准成员都可切换，后续成员消息使用共享选择。

切换持久保存在 `state.json` 的 `lines` 段（旧 `lines.json` 在首次升级时迁移归档）。切换只影响后续接收的输入；运行中或已排队的消息保留入队时的会话及目录。项目别名指向新目录时会使用新的项目会话；默认目录更改后，用 `/new` 开新会话，避免恢复原目录的历史会话。宿主提供会话目录信息时，目录不一致会拒绝执行。

删除项目或更改其目录后，旧目录下尚未开始的任务会保留在收件箱并暂停，恢复配置后可继续；也可用 `/clear` 清除自己的排队消息。已开始任务不会因此停止。旧任务产物只在其目录仍被某个项目或默认目录配置时允许取回，与当前选择无关。`lines.json` 损坏或不可读时拒绝新输入及切换，请恢复备份后重启；不要直接删除该文件，否则可能回到旧会话编号。旧数字线号和 counters 线号继续兼容读取，新版结构写入后不支持旧版切换功能。

## 计划任务回传

宿主须启用兼容的 `schedule` 和 `sessionPersistence` 服务，并支持 `schedule/resolve-agent` 事件。计时、执行及原生任务存储由 DSH 负责；本插件不自建计时器或调用模型重跑任务。仅安装 npm 包不代表服务已挂载，应使用当前 DSH 版本支持的 profile/组合启用原生计划服务。2026-11-18 已确认 mini 的 DSH `0.2.2-rc.3` 应用内置这些服务，并通过 Web profile 挂载；无需在 profile 单独安装计划包。部署后的真实一分钟计划及最终文字回传已通过隔离目标验证。

- `/schedule after 10 检查项目部署状态`：10 分钟后执行一次。
- `/schedule every 60 汇总项目状态`：每 60 分钟执行。分钟数为 1–525600 的整数，任务内容不超过 4000 个 UTF-16 单元。
- `/schedules`：列出你在原通道、原账号、原聊天创建的计划。
- `/schedule pause <ID>`、`/schedule resume <ID>`、`/schedule delete <ID>`：暂停、恢复、删除。ID 至少 8 个字符，重名需使用完整 ID。

创建时固定当前配置项目及工作目录，每个计划有独立执行会话。任务描述应自包含，不能依赖普通聊天的上下文；命令不接受附件，请引用项目内已存在的文件。每人在一个聊天最多保留 20 个绑定，全局最多 100 个；已结束计划也需手动删除。权限检查仍然有效，但这些命令和原生计划执行不扣普通通道回合配额；创建重复计划代表对后续原生执行的持续授权。

原生“已投递”仅表示指令进入会话收件箱。插件用投递消息 ID 匹配实际回合，结束后把最终文字或失败通知发回原聊天，不会把该会话中其他消息的结果当成计划结果。结果只回传文字，最长约 16000 个 UTF-16 单元；附件及定时回合中的提问、审批仍在 DSH 桌面处理。`/tasks`、`/status`、`/cancel` 继续管理普通通道任务；暂停或删除计划不撤销已开始的原生回合，停止执行需在 DSH 操作。

`schedules.json` 以 0600 保存归属、创建意图、部分进度和待回传结果。创建结果不明确时不会自动重试创建，通过独立目标会话查找原生记录后关联；可取消未确认绑定，迟到的孤立任务在插件挂载期间不能激活。若原生创建仍可能完成，请在 DSH 核对并清理。原生目标被修改后，插件停止回传；删除本地绑定不会改动已经指向其他会话的原生任务。

运行期间，插件在原生激活和结果发送前检查原发送者、账号、原项目与目标，异步查询结束后再次检查，已删除的绑定和已停用的插件不会继续激活。排队中的管理命令在实际执行前重新检查当前权限；原项目失效时，仍获授权的创建者可以暂停或删除计划。已进入 outbox 的结果重试也检查，失去授权的待发送结果会取消，不挡住后续回复。原生服务暂不可用或归属文件损坏时保留重试记录，修复后恢复。**禁用或卸载插件不会停止 DSH 原生计划；停用前请先暂停或删除计划。** 插件不在运行时，其激活检查和回传均不生效。

重启后读取既有执行记录恢复回传，不重跑工具。每次只读取每个计划最近 200 条仍被 DSH 保留的投递记录，已被原生保留策略删除的记录不能恢复；每个绑定最多保留 10 条待回传结果。`turn/end` 事件触发读取，周期恢复通常在 30 秒内再次尝试；结果发送耗时还受账号排队和限流影响。不明确的发送可能重复通知，不能保证恰好一次。异常归属文件拒绝修改，并在插件运行期间阻止其命名空间内的原生任务激活；请恢复备份后重启，勿直接删除文件以免丢失管理归属。

只有通过本插件命令创建的计划参与回传。桌面或模型原生 `schedule_*` 工具创建的计划不会自动绑定；原生工具仍按宿主权限运行，不受本插件命令的归属过滤。需要限制通道 Agent 的宿主任务管理能力时，不要在其预设中挂载原生计划管理工具。

## 微信

本仓库没有独立的扫码命令。先用现有 iLink 登录工具取得账号凭证。将该工具写出的 `openclaw-weixin/accounts.json`（索引）和对应的 `openclaw-weixin/accounts/<accountId>.json`（凭证）复制到状态根目录下的同名位置。保留凭证文件的 `0600` 权限。如果手头只有旧版全局 `credentials.json`，请重新配对取得按账号保存的文件。

```json
{
  "adapters": ["@derekluo/dsh-channels-weixin"],
  "adapterConfig": {
    "@derekluo/dsh-channels-weixin": {
      "accountId": "REPLACE_WITH_INDEXED_ACCOUNT_ID"
    }
  }
}
```

省略 `accountId` 会选择索引的第一项。启动日志里的 `weixin adapter polling account` 会显示实际账号。每个运行实例只选一个微信账号，同一账号只交给一个轮询进程。

可选参数：`stateDir`（覆盖微信凭证、游标和入站媒体的根目录）、`longPollTimeoutMs`（默认 35000，可由服务端调整）、`cdnBaseUrl`、`mediaEnabled`（默认开启），以及下文的语音转写参数。

## Telegram

```json
{
  "adapters": ["@derekluo/dsh-channels-telegram"],
  "adapterConfig": {
    "@derekluo/dsh-channels-telegram": {
      "token": "REPLACE_WITH_BOT_TOKEN",
      "botId": "my_bot"
    }
  }
}
```

`botId` 是可选的显示名称。官方 API 要求形如 `数字ID:密钥` 的 token；账号键是 `bot:<数字ID>`，为同一 bot 更新 token 时键保持不变。配置 `apiBaseUrl` 后，自建服务使用与端点绑定的 `custom:…` 键，以启动日志里的 `telegram adapter polling bot` 为准。可选参数还有 `pollTimeoutSeconds`（默认 25）、`mediaEnabled`（默认开启）和 `maxInboundBytes`（默认每个附件 20 MiB）。

### 迁移旧账号键

如果 `allowlistPerAccount` 使用旧 `botId` 或 `default`，把对应列表（包括显式空列表）迁移到新键，再重启。迁移之前，核心发现当前账号的旧覆盖项而缺少新键时会拒绝消息，避免退回更宽的全局白名单。旧会话和待重发仍保留原键，不会自动转移。

## 语音转写

微信可用可选的 `silk-wasm` 将 SILK 转成 WAV。转写另需 Python 和模型；转写不可用时保留已保存的音频，模型会收到无法读取音频的说明。

在独立虚拟环境安装所用引擎。下例给出 Apple silicon 的 MLX 方案；CPU 方案将 `mlx-whisper` 换成 `faster-whisper`。检查时使用一个已存在的 WAV 文件：

```bash
state="${DSH_CHANNELS_STATE_DIR:-$HOME/.dsh/channels}"
python3 -m venv "$HOME/.venvs/dsh-asr"
"$HOME/.venvs/dsh-asr/bin/python" -m pip install mlx-whisper
printf '{"wav":"/absolute/path/to/sample.wav"}\n' |
  DSH_WEIXIN_ASR_MODEL_DIR="$state/asr-models" \
  "$HOME/.venvs/dsh-asr/bin/python" packages/adapter-weixin/bin/asr-bridge.py
```

成功时输出 `{"ok":true,"text":"…"}`。首次转写可能需要下载模型。若要离线运行，先把 MLX 的 small 模型放到模型根目录的 `mlx-community__whisper-small-mlx/`，或把 faster-whisper 的 small 模型放到 `Systran__faster-whisper-small/`。两种引擎需要不同权重；也可用环境变量 `DSH_WEIXIN_ASR_MODEL_PATH` 指定模型路径。

在微信的 `adapterConfig` 里把 `asrCommand` 设为上述 Python 的绝对路径。可选 `asrModelDir`（默认微信状态根目录下的 `asr-models/`）、`asrLanguage`（默认由引擎识别）及 `asrEnabled`（默认开启）。

## 手机任务控制

普通消息落盘后回复“已接收”，有前序任务时显示前面任务数量。接收确认本身发送失败不会撤销已接收的任务；先用 `/status` 核对，避免重复提交。

任务开始处理满 60 秒时，如果仍在处理且聊天没有待答提示，会收到一次提醒。排队时间不计入这 60 秒。

提问和审批的聊天回复时限受回合剩余时间约束。过期的审批验证码会收到失效提示。验证码加操作的回复格式专用于审批。

| 命令 | 行为 |
|---|---|
| `/status` | 查看当前或最近任务摘要、耗时、执行状态、结果投递状态及排队数量 |
| `/tasks` | 查看最近 5 项已开始的任务，显示短编号、摘要、执行状态和发送状态。群聊中仅列出自己的任务 |
| `/files [任务ID]` | 查看任务产物列表；省略 ID 时查看当前聊天中最近完成的任务 |
| `/resend <任务ID> [序号]` | 重发一个已记录的产物，省略序号时发送第 1 个 |
| `/cancel` | 请求停止命令到达时自己的当前任务，保留排队消息；不能撤销已完成的操作 |
| `/clear` | 清除命令到达时自己尚未开始的排队消息，不影响运行中的任务或其他发送者 |
| `/projects` | 查看管理员配置的项目别名及当前选择 |
| `/project <别名>` | 切换项目；`default` 返回默认工作目录 |
| `/sessions` | 查看当前聊天、当前项目最近 20 个会话编号及当前编号 |
| `/session <编号>` | 切回当前项目的历史会话 |
| `/new` | 后续消息改用新会话，已有任务继续使用原会话 |

`/status`、`/tasks`、`/cancel`、`/clear`、`/files`、`/resend` 及四条项目/会话切换命令不消耗回合配额。账号、白名单和重复消息检查仍然有效。命令携带附件时，下载前仍需通过附件配额检查。群内仅任务发起者可以停止任务，每位成员只清除自己的排队消息。

停止会先提示“已请求停止”，宿主确认中止或成功移除未消费输入后再提示“已取消”。约 500 毫秒内没有证据时提示未确认，请到桌面核对。已经完成执行、正在发送结果的任务不能用 `/cancel` 撤回。执行超时或进程重启也不代表工具操作已经停止，未知状态下应先核对实际效果。

执行完成与结果送达分别显示。文字失败显示待重发；平台没有确认时显示投递结果未知。自动附件与文字一起持久排队，失败时按原顺序重试剩余部分；已发送的文字不重发。文件缺失、变更或被跳过时保持未全部交付，可用 `/resend` 或在桌面取回。`/tasks` 展示已保留的最近任务。短编号可用于取回已记录的产物：`/files a1b2c3d4` 列出稳定的文件序号，`/resend a1b2c3d4 2` 重发第 2 个文件。任务ID至少 8 个字符，允许带 `#`；前缀冲突时会列出完整任务ID。

## 状态和重试

| 路径（相对状态根目录） | 内容 |
|---|---|
| `config.json` | 操作者的配置覆盖 |
| `state.lock` | 单写者锁：持有者进程存活时拒绝其它实例读写；进程退出后可接管，不随 `doctor` 清理 |
| `state.claim` | 领取 state.lock 时独占创建的短期互斥文件，正常完成即删除；中断遗留会阻止启动 |
| `state.json` | **v2 权威状态**：`inbox`、`tasks`、`outbox`、`lines`、`schedules`、`counters`、`pairings` 七段，原子替换，权限 0600 |
| `legacy-state/` | 升级成功后保存旧状态的原始备份；不再生成或读取旧镜像 |
| `journal/journal-*.jsonl` | 接收与发送流水 |
| `logs/channels-*.log` | 运行、拒绝和错误日志 |
| `media/inbound/` / `asr-models/` | 收到的附件和可选语音模型 |
| `workspace/` | 默认工作目录，含任务产物目录 `.channel-output-*` |
| `openclaw-weixin/` | 微信索引、凭证和按账号保存的 `.sync.json` 游标 |

从源码运行 `npm run build && npm run doctor -- --state`，或在已安装的 profile 中运行 `pnpm exec dsh-channels-doctor --state`。发现表外路径时退出码为 1。旧的空 `memory/` 会被忽略；若有文件，先确认内容再移走。状态目录包含聊天内容和凭证，备份时按敏感数据处理。

发送流水先写 `sending`，适配器返回后写 `settled`。状态含义：

| 状态 | 含义 |
|---|---|
| `accepted` | 平台接受并返回了消息 ID |
| `unconfirmed` | 平台接受但没返回 ID；不会自动重发 |
| `failed` | 发送失败；普通文本回复可入待重发队列 |
| `pending` | 只有 `sending` 记录，结果未知，不能据此判断手机是否收到 |

普通文字回复在首次发送前完整落盘；无法保存则拒绝发送。重试保留原投递 ID，只尝试原通道、账号和聊天。分条文本失败后停止继续发送，剩余分条随同一队列项保存；重试每完成一条便原子保存进度。同聊天的新回复等待积压，其他聊天独立重试。平台已收到但客户端未收到成功响应时，重试仍可能造成重复，无法保证恰好一次投递。自动附件使用索引、大小和 SHA-256 指纹进入同一队列；每次重试重新校验权限、原项目和文件字节，只有匹配的私有快照可上传。人工 `/resend`、交互提示和命令通知仍直接发送。新任务的文字交接、剩余分条和最终任务投递回执分别与相关状态一起原子保存。可在状态卡片查看最近发送状态，或按 ID 搜索 `journal/` 中的所有尝试。

重启时两种平台都可能重放未确认的入站消息。微信只把游标保存到连续处理完的批次。Telegram 也只确认连续交接完成的更新，最多跟踪 100 条，普通交接并发上限为 2；同聊天持久交接失败会阻止后续普通消息越过，无附件控制命令仍可优先处理。等待时最多每秒重读未确认批次。若 Bot API 返回的 50 条整批都被旧前缀挡住，更后面的控制消息须等前缀前进才能读取。核心用当天和前两天的流水过滤有平台消息 ID 的重复投递；普通消息到回合开始时重新检查权限，通过后才写接收流水并扣除配额。普通消息先落盘到 `state.json` 的 `inbox` 段，启动成功的原账号会恢复尚未开始的消息，并重新检查权限和配额。权限被撤销的消息移出待处理队列；账号不匹配或配额未释放时保留等待，约每 30 秒重试。收件箱满或落盘失败时，平台交接使用 `DSH_INBOUND_RETRY` 错误要求重投。已开始的回合不会重新执行工具。新任务在宿主提交前保存精确的输入绑定；重启后可只读扫描原会话日志恢复已确认结果，未结束时保存游标继续等待，宿主日志缺失或旧任务无绑定时保持未知。恢复前后检查原账号、发送者、项目和会话目录。`state.json.tasks` 将原先执行中或正在停止的任务展示为未知；原先发送中的结果展示为投递结果未知。该段或权威文件损坏/无法写入时，不开始新的回合，消息保留在收件箱中，待修复并重启后恢复。

Outbox 不可读、版本/结构错误或条目不合法时，停止修改与重试，原文件保持不变，日志提示修复。请先停止宿主并备份 `state.json`，恢复有效备份或修正完整的 `outbox` 段后重启。旧 `.json` 文件不再热导入。设置卡片的待重发数量无法代表损坏文件中的真实数量，以日志为准。

附件缺失时，模型会收到哪些附件未接收的说明；纯附件全部失败只回送通知，不启动任务或扣回合额度。Telegram 的本地落盘错误也按附件接收失败报告。

## 排障

| 现象 | 检查 |
|---|---|
| 机器人不回 | 看状态卡片的“待批准的发送者”；批准后重发。也可看 `logs/` 的 `refused` 原因，检查账号覆盖、发送者、聊天白名单和配额。通过后用 `/whoami` 核对 ID |
| 发送失败或结果未知 | 按上一节检查流水和待重发；`accepted` 不是已读回执 |
| 回合出错 | 查 `turn failed for`。手机只显示简短提示；当前没有 `/diag` 命令 |
| 提问被桌面提前结束 | 见[已知限制](STATUS.md#已知限制) |
| 找不到桌面会话 | 展开 **Channels** 或 **Ungrouped**，检查工作区登记日志 |
| 卡片无法读写 | 检查宿主是否提供 `webServer`。写入路由要求请求 `Origin` 与宿主一致；不要把这些管理路由暴露到不可信网络 |
| 部署后仍是旧行为 | 检查 profile 归档路径、安装结果和宿主是否已重启 |

管理卡片的四个 `/channels/*` 接口要求宿主身份验证（含 `/channels/pairing`）；写入另检查同源并限制请求体大小与读取时间。审批答复需携带提示中的本次验证码，群内仅发起人可答复。自动附件及手动重发都先复制安全校验后的文件，上传临时副本，结束或失败后清理副本。每回合的空产物目录自动删除；非空 `.channel-output-*` 目录保留为用户产物，可在取回后手动清理。日志、流水和入站附件仍由运维按需归档或删除。

文档正文提取采用固定预算：二进制文件最多 8 MiB、解析工作线程最多 5 秒、PDF 最多 20 页；超过预算时保留原附件路径。ASR 按完整 UTF-8 JSON 行接收响应，单条响应上限 256 KiB。回合超时会撤销其聊天交互，并取消对应宿主工作或移除尚未消费的输入。

状态卡片和手机 `/status` 显示待开始的输入数量。`state.json` 的 `inbox` 段无法解析或读取时会阻止接收新的普通回合；先停用插件、备份文件并修复后重启。不要直接清空包含用户请求的收件箱。设置刷新会更新未编辑的字段，保留本地尚未保存的编辑；保存只提交改动的字段。

### 发送与排队的失败提示

任务记录无法保存时，消息仍保留在收件箱，聊天会收到一次“任务记录无法保存”的通知，`/status` 可再次查看。修复磁盘写入权限后会周期重试；启动时已损坏的状态文件仍须修复并重启。`/clear` 释放的配额不会因队列收尾再次释放。

出站文本只有在成功落盘后才显示待重发。保存失败时会提示到 DSH 取回结果；待重发队列达到 50 项时拒绝新增项，保留原有条目。平台要求的重试等待时间与本地退避取较大值，重启后仍按保存的 `nextAt` 执行。

`present` 声明的文件按数量、大小上限复制并索引；超出上限、为空、为符号链接或无法安全读取时，聊天会提示附件未全部发送，任务不显示全部已发送。只捕获通过 `present` 或最终回复中独立本地 Markdown 图片声明的文件，不扫描工作目录推测产物。

微信控制命令和交互答复可绕过同聊天的媒体处理队列，鉴权规则不变。普通消息保持顺序；进程同时最多两路附件下载，单条消息最多保存 100 MiB，读取时使用剩余字节预算。配置默认值在核心集中定义；数值超出合法范围时使用默认值，负数配额不会意外关闭限流。

### 历史产物取回

新任务正常完成时会保存任务产物目录与最多 100 个合格文件的相对路径索引，在发送结果前尝试保存索引；保存失败会明确提示历史取回不可用，本轮结果仍继续发送。索引在重启后仍可用，序号不随目录里后来新增的文件变化。已结束且无待投递的历史按每聊天最多 10 项保留；执行中、待恢复及待投递的记录不因历史保留策略淘汰，全局最多 500 项，全部占用时暂停新执行；索引被历史淘汰后，文件仍在任务产物目录中。旧版本任务没有索引时不会自动猜测或扫描其他目录。

如果聊天里收不到自动附件，先确认该会话 preset 挂载了 `present`；图片也可通过最终回复中独立成段的本地 Markdown 图片嵌入交付。旧的 `legacyOutputScan` 配置已移除，遗留字段会被忽略；不再创建供模型写入的每回合扫描目录。既有任务的产物索引和 `/resend` 仍可使用。

`/files` 和 `/resend` 限定原通道、原账号及原聊天；群聊还限定任务发起者。只对已完成执行且不在交付处理中的任务开放。文件被删除、移动、变为空文件、超出当前 `maxProducedBytes`，或路径中出现符号链接时，会提示到 DSH 查看。工作目录更改后，只有旧目录仍在 `projects` 或默认目录配置中时才可读取旧任务文件。

重发使用本次校验后的私有临时副本，读取字节受大小上限约束，发送后清理。图片使用图片附件类型，其余文件使用相应附件类型。重发失败不会进入文本 outbox；平台接受但未返回确认时明确提示未确认。一次重发不改变整项任务原先的投递状态，也不会重新调用模型或创建任务。

### 升级到统一状态 v2

首次启动自动迁移。所有来源都有效且新状态原子保存成功后，旧六个状态文件才会归档到 `legacy-state/`；已有 canonical 段不会被较新的旧镜像覆盖。迁移或归档失败时拒绝新任务，保留原始字节供修复，修复后重启即可继续。正常运行只更新 `state.json`，不要再编辑 inbox.json、tasks.json、outbox.json 等旧文件。

预先检查与显式迁移：

```bash
npm run doctor -- --state
# 停止对应 DSH 宿主后，使用同一个 DSH_CHANNELS_STATE_DIR：
npm run doctor -- --migrate
```

迁移前备份整个状态根与 profile 的 package.json/pnpm-lock.yaml。回退旧插件时，应停止宿主并恢复整套升级前状态及 profile，不能混用 v2 与单个旧镜像。`legacy-state` 备份含聊天和平台上下文，应与凭证一样保护。

### 状态锁领取中断

`state.claim` 使两个同时启动的进程不能都取得状态根的所有权。若日志提示领取被中断，先停止使用同一状态目录的 DSH 实例，核对 `state.claim` 和 `state.lock` 中记录的进程均已退出，再移走遗留的 `state.claim` 并重启；不要在对应进程仍存活时删除锁。正常退出进程留下的有效 `state.lock` 会在下次启动自动接管；格式损坏的锁需要先核对所有权再修复。
