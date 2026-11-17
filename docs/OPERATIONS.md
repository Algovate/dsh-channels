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
| `allowlistPerAccount` | `{}` | 账号键 → 发送者列表；显式空列表仍覆盖全局白名单 |
| `allowedChats` | `[]` | 额外限制聊天 ID；空列表不限制聊天 |
| `senderPerMinute` / `senderPerDay` | `6` / `60` | 按通道、账号和发送者计；设为 `0` 关闭对应限制 |
| `maxTextChars` / `bubbleGapMs` | `600` / `400` | 默认单条文字长度及分条间隔；适配器可设自己的长度上限 |
| `maxTurnWaitMs` / `turnPollMs` | `1200000` / `120` | 等待回合结束的上限及查看会话日志的间隔，单位毫秒 |
| `questionsEnabled` / `approvalsEnabled` | `true` / `true` | 在聊天中接收提问及一次性审批 |
| `interactionTimeoutMs` | `600000` | 已送达的交互提示等待回复的时长，单位毫秒 |
| `autoSendFiles` | `true` | 回复后发送本回合输出目录中的附件 |
| `maxProducedFiles` / `maxProducedBytes` | `3` / `20971520` | 每回合自动发送的文件数上限及单文件字节上限 |
| `workingDirectory` | `<state>/workspace` | DSH 会话工作目录 |

手动编辑后需要重启。状态卡片可以实时保存全局白名单、两项配额、提问/审批和自动附件开关；账号级白名单、凭证和目录仍在文件里改。

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
| `/cancel` | 请求停止命令到达时自己的当前任务，保留排队消息；不能撤销已完成的操作 |
| `/clear` | 清除命令到达时自己尚未开始的排队消息，不影响运行中的任务或其他发送者 |
| `/new` | 后续消息改用新会话，已有任务继续使用原会话 |

`/status`、`/tasks`、`/cancel` 和 `/clear` 不消耗回合配额。账号、白名单和重复消息检查仍然有效。命令携带附件时，下载前仍需通过附件配额检查。群内仅任务发起者可以停止任务，每位成员只清除自己的排队消息。

停止会先提示“已请求停止”，宿主确认中止或成功移除未消费输入后再提示“已取消”。约 500 毫秒内没有证据时提示未确认，请到桌面核对。已经完成执行、正在发送结果的任务不能用 `/cancel` 撤回。执行超时或进程重启也不代表工具操作已经停止，未知状态下应先核对实际效果。

执行完成与结果送达分别显示。文字失败显示待重发；平台没有确认时显示投递结果未知。附件不自动重发，失败或被跳过时到桌面产物目录取回；文字积压补发完成不代表附件已送到。`/tasks` 展示已保留的最近任务。短编号可用于辨认任务，暂不支持按编号取回结果。

## 状态和重试

| 路径（相对状态根目录） | 内容 |
|---|---|
| `config.json` | 操作者的配置覆盖 |
| `counters.json` | 无宿主 `channels` 存储域时保存配额计数；兼容读取旧会话线号 |
| `inbox.json` | 尚未开始的普通消息、原会话线及私有路由上下文；未开始消息最多 500 条，另保留三天内的清除回执以阻止重投，权限 0600 |
| `lines.json` | 已确认的会话线号，保存成功后 `/new` 才生效 |
| `tasks.json` | 每聊天最近已开始任务的摘要、发起者和执行/投递状态；每个聊天最多 10 项，总计最多 500 项，权限 0600，不用于重放任务 |
| `outbox.json` | 失败的普通文本回复，最多 50 条，满时淘汰最旧条目 |
| `journal/journal-*.jsonl` | 接收与发送流水 |
| `logs/channels-*.log` | 运行、拒绝和错误日志 |
| `media/inbound/` / `asr-models/` | 收到的附件和可选语音模型 |
| `workspace/` | 默认工作目录，含每轮自动附件的 `.channel-output-*` 子目录 |
| `openclaw-weixin/` | 微信索引、凭证和按账号保存的 `.sync.json` 游标 |

从源码运行 `npm run build && npm run doctor -- --state`，或在已安装的 profile 中运行 `pnpm exec dsh-channels-doctor --state`。发现表外路径时退出码为 1。旧的空 `memory/` 会被忽略；若有文件，先确认内容再移走。状态目录包含聊天内容和凭证，备份时按敏感数据处理。

发送流水先写 `sending`，适配器返回后写 `settled`。状态含义：

| 状态 | 含义 |
|---|---|
| `accepted` | 平台接受并返回了消息 ID |
| `unconfirmed` | 平台接受但没返回 ID；不会自动重发 |
| `failed` | 发送失败；普通文本回复可入待重发队列 |
| `pending` | 只有 `sending` 记录，结果未知，不能据此判断手机是否收到 |

重试保留原投递 ID，只尝试原通道、账号和聊天。分条文本失败后停止继续发送，剩余分条随同一队列项保存；重试每完成一条便原子保存进度。同聊天的新回复等待积压，其他聊天独立重试。平台已收到但客户端未收到成功响应时，重试仍可能造成重复，无法保证恰好一次投递。附件、交互提示和命令回复不进待重发队列。可在状态卡片查看最近发送状态，或按 ID 搜索 `journal/` 中的所有尝试。

重启时两种平台都可能重放未确认的入站消息。微信只把游标保存到连续处理完的批次。核心用当天和前两天的流水过滤有平台消息 ID 的重复投递；普通消息到回合开始时重新检查权限，通过后才写接收流水并扣除配额。普通消息先落盘到 `inbox.json`，启动成功的原账号会恢复尚未开始的消息，并重新检查权限和配额。权限被撤销的消息移出待处理队列；账号不匹配或配额未释放时保留等待，约每 30 秒重试。收件箱满或落盘失败时，平台交接使用 `DSH_INBOUND_RETRY` 错误要求重投。已开始的回合不会自动恢复，以免重复执行工具。`tasks.json` 将原先执行中或正在停止的任务展示为未知；原先发送中的结果展示为投递结果未知。该文件损坏或无法写入时，不开始新的回合，消息保留在收件箱中，待修复并重启后恢复。

## 排障

| 现象 | 检查 |
|---|---|
| 机器人不回 | 看 `logs/` 的 `refused` 原因，检查账号覆盖、发送者、聊天白名单和配额。通过后用 `/whoami` 核对 ID |
| 发送失败或结果未知 | 按上一节检查流水和待重发；`accepted` 不是已读回执 |
| 回合出错 | 查 `turn failed for`。手机只显示简短提示；当前没有 `/diag` 命令 |
| 提问被桌面提前结束 | 见[已知限制](STATUS.md#已知限制) |
| 找不到桌面会话 | 展开 **Channels** 或 **Ungrouped**，检查工作区登记日志 |
| 卡片无法读写 | 检查宿主是否提供 `webServer`。写入路由要求请求 `Origin` 与宿主一致；不要把这些管理路由暴露到不可信网络 |
| 部署后仍是旧行为 | 检查 profile 归档路径、安装结果和宿主是否已重启 |

管理卡片的三个 `/channels/*` 接口要求宿主身份验证；写入另检查同源并限制请求体大小与读取时间。审批答复需携带提示中的本次验证码，群内仅发起人可答复。每回合的空产物目录自动删除；非空 `.channel-output-*` 目录保留为用户文件，可在取回后手动清理。日志、流水和入站附件仍由运维按需归档或删除。

文档正文提取采用固定预算：二进制文件最多 8 MiB、解析工作线程最多 5 秒、PDF 最多 20 页；超过预算时保留原附件路径。ASR 按完整 UTF-8 JSON 行接收响应，单条响应上限 256 KiB。回合超时会撤销其聊天交互，并取消对应宿主工作或移除尚未消费的输入。

状态卡片和手机 `/status` 显示待开始的输入数量。`inbox.json` 无法解析或读取时会阻止接收新的普通回合；先停用插件、备份文件并修复后重启。不要直接清空包含用户请求的收件箱。设置刷新会更新未编辑的字段，保留本地尚未保存的编辑；保存只提交改动的字段。
