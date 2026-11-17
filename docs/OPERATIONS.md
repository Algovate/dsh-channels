# 运维指南

## 安装

需要 Node.js 22.13 或更高版本。已验证的 DSH 版本见[验证状态](STATUS.md)。

### 从 npm 安装

在终端安装核心和微信适配器。将 `default` 换成实际的 DSH profile 名：

```bash
dsh plugin --profile default add @derekluo/dsh-channels@0.1.0 @derekluo/dsh-channels-weixin@0.1.0
```

使用 Telegram 时，把微信适配器换成 `@derekluo/dsh-channels-telegram@0.1.0`。安装后按下文配置凭证和白名单，再重启宿主。

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

## 状态和重试

| 路径（相对状态根目录） | 内容 |
|---|---|
| `config.json` | 操作者的配置覆盖 |
| `counters.json` | 无宿主 `channels` 存储域时，保存配额计数和会话线号 |
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

重试保留原投递 ID，只尝试原通道、账号和聊天。附件、交互提示和命令回复不进待重发队列。可在状态卡片查看最近发送状态，或按 ID 搜索 `journal/` 中的所有尝试。

重启时两种平台都可能重放未确认的入站消息。微信只把游标保存到连续处理完的批次。核心用当天和前两天的流水过滤有平台消息 ID 的重复投递；普通消息到回合开始才写接收流水并扣除配额。已被平台确认的入站消息及中断的回合不会由插件自动恢复。

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
