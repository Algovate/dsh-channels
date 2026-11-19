# 真机测试手册

> 本文是需要在真实微信 / Telegram 账号上执行的验收清单。CI 和 `npm test` 只覆盖模拟宿主；以下项目无法由单元测试代替。
>
> 执行前记录待测 commit，构建、打包并确认安装的是同一份产物；已部署版本及验证范围见 [STATUS.md](STATUS.md)。

## 0. 范围与通过标准

**P0（必须通过）**

- 未知发送者不会启动回合，只产生待批准请求；批准前重发仍被拒绝。
- 批准/拒绝落盘后立即生效；拒绝不会放宽白名单。
- Telegram 审批按钮可完成一次审批；文本验证码仍可用。
- `present` 文件能到达聊天，`/files`、`/resend` 可用；工作目录外文件不会外发。
- 等待超时不会取消已提交回合，晚到结果仍回到原聊天。
- 群聊 `prefix` 模式下，未带前缀的消息不触发回合。
- 成员不能切换项目/会话或管理计划；管理员可以。
- 两条消息不会被重复执行；重启后已开始回合不会重跑。

**P1（建议通过）**

- 任务卡原地更新；Telegram 按钮和任务卡同时工作。
- 计划创建、暂停/恢复/删除和结果回传。
- 重启后收件箱恢复；带精确输入绑定的任务恢复原回合结果，不重新执行；缺少绑定或无法确认结果时保持未知，`state.json` 完整。
- 撤销白名单后旧排队消息不再执行。

## 1. 测试环境

| 项 | 建议 |
|---|---|
| DSH | `0.2.2-rc.3` 或当前验证版本；Web/Desktop profile 均可 |
| 状态目录 | 独立测试目录，例如 `export DSH_CHANNELS_STATE_DIR=$HOME/.dsh/channels-smoke` |
| 微信 | 专用测试账号；不要用主账号 |
| Telegram | 专用测试 bot；群聊中关闭 privacy mode 或把 bot 设为管理员 |
| 发送者 | 至少 3 个：owner、member、stranger（不同平台账号） |
| 群聊 | 一个测试群，至少 owner 和 member 两人 |
| 终端 | 能看宿主日志和状态目录 |

> 微信 iLink 是非官方接口，测试期间可能遇到登录失效或限流。每次失败先看 `logs/`，不要反复重试登录。

## 2. 准备

### 2.1 构建与安装

在仓库根目录：

```bash
npm ci
npm test
package_dir="$(mktemp -d)"
npm pack --workspaces --pack-destination "$package_dir"
printf '%s\n' "$package_dir"
```

按 [运维指南](OPERATIONS.md#安装) 把核心和需要的适配器装进测试 profile。只把核心登记为 bundle，适配器通过 `adapters` 配置加载。

### 2.2 备份与权限

```bash
state="${DSH_CHANNELS_STATE_DIR:-$HOME/.dsh/channels}"
cp -a "$state" "$state.backup.$(date +%Y%m%d-%H%M%S)"
chmod 700 "$state"
chmod 600 "$state/config.json" 2>/dev/null || true
```

不要把含 token、聊天正文或用户发送者 ID 的 `config.json`、`state.json`、日志提交到版本库。

### 2.3 配置

测试 pairing 时先保持空白名单；不要提前把 stranger 加进去。

```json
{
  "enabled": true,
  "allowedSenders": [],
  "owners": [],
  "groupTrigger": "prefix",
  "groupPrefix": "/ask",
  "senderPerMinute": 0,
  "senderPerDay": 0,
  "autoSendFiles": true,
  "maxTurnWaitMs": 1200000,
  "adapters": [
    "@derekluo/dsh-channels-weixin",
    "@derekluo/dsh-channels-telegram"
  ],
  "adapterConfig": {
    "@derekluo/dsh-channels-weixin": {
      "accountId": "REPLACE_WEIXIN_ACCOUNT_ID"
    },
    "@derekluo/dsh-channels-telegram": {
      "token": "REPLACE_BOT_TOKEN",
      "botId": "smoke-bot"
    }
  }
}
```

> `adapterConfig` 是整体替换：只写一个适配器的配置会丢掉另一个。测试时保留两者，或分开两个阶段。

`owners` 要等 owner 通过 `/whoami` 确认自己的发送者 ID 后再填，并重启宿主。空 `owners` 表示“所有获准发送者都是管理员”，适合先跑通普通任务。

### 2.4 观察点

```bash
state="${DSH_CHANNELS_STATE_DIR:-$HOME/.dsh/channels}"
tail -f "$state/logs/channels-$(date +%F).log"
```

另开一个终端：

```bash
state="${DSH_CHANNELS_STATE_DIR:-$HOME/.dsh/channels}"
python3 - <<'PY'
import json, os
path = os.path.join(os.environ.get('DSH_CHANNELS_STATE_DIR', os.path.expanduser('~/.dsh/channels')), 'state.json')
data = json.load(open(path))
sections = data.get('sections', {})
print('inbox', len(sections.get('inbox', [])))
print('tasks', len(sections.get('tasks', [])))
print('outbox', len(sections.get('outbox', {}).get('items', [])))
print('pairings', len(sections.get('pairings', [])))
print('lines', sections.get('lines', {}))
PY
```

`npm run doctor` 也可检查状态清单；默认读 `~/.dsh/channels`，测试目录要带环境变量：

```bash
DSH_CHANNELS_STATE_DIR="$state" npm run doctor
```

## 3. 测试用例

结果记录在[第 4 节](#4-结果记录)。

### A. 首次配对（P0）

**A1 未知发送者只得到一次等待提示**

1. 保持 `allowedSenders: []`，重启宿主。
2. 用 stranger 给 bot 发一条普通文字，例如“你好”。
3. 再发一条“在吗？”（10 分钟内）。

预期：

- stranger 收到一次“消息已收到，但发送者尚未获准……”；第二条不再重复提示。
- 桌面状态卡片出现“待批准的发送者”，显示通道、账号、发送者 ID 和消息预览。
- `state.json` 的 `pairings` 有 1 条；`inbox` 没有该消息。
- 日志出现 `pairing requested from …`，没有模型回合。

**A2 批准后生效**

1. 在状态卡片点“允许”。
2. 检查 `config.json` 的 `allowedSenders`（或对应账号的 `allowlistPerAccount`）已包含 stranger。
3. stranger 重发“你好”。

预期：

- 批准后 stranger 收到“发送者已获准……”；请求从卡片消失。
- 重发产生接收确认和最终回复。
- `/whoami` 显示发送者、账号、聊天、会话；角色为“成员”或“管理员”。

**A3 拒绝**

1. 另用一个未批准账号发消息，点“拒绝”。
2. 再发一条。

预期：请求消失；不产生回合；`allowedSenders` 不变。

### B. 普通回合与任务卡（P0 / P1）

**B1 WeChat 文本与回执**

1. owner 发“用一句话介绍这个项目”。

预期：

- 收到“已接收，准备处理。”，随后收到最终回复。
- `/status` 显示完成/已发送；`/whoami` 正常。
- WeChat 不支持编辑，因此回执和结果是两条独立消息。

**B2 Telegram 任务卡**

1. Telegram owner 发一条普通任务。

预期：

- 接收回执被原地编辑为“执行中…”，完成后同一消息变为“任务已完成。”。
- 最终回复作为新消息发送。
- 手机端不应出现两条“执行中/已完成”的重复提示。

**B3 长任务提醒**

1. 让任务运行超过 60 秒（例如“每 10 秒报告一次进度，持续 2 分钟”）。
2. 在 60 秒左右查看聊天和 `/status`。

预期：Telegram 任务卡变为“任务仍在处理…”，WeChat 收到一条独立提醒；完成后继续回传。

### C. 角色边界（P0）

先让 owner 和 member 都通过 `/whoami` 取得 ID，再把 owner 写入 `owners` 并重启。

**C1 成员受限**

1. member 发普通任务：应正常执行。
2. member 发 `/project default`、`/new`、`/schedule after 5 test`。

预期：

- 普通任务正常。
- 三个管理命令分别回复“只有管理员可以切换项目或会话。”或“只有管理员可以管理计划。”，不产生回合。
- `/status`、`/tasks`、`/cancel` 仍可用。

**C2 管理员**

1. owner 发 `/projects`、`/new`、`/schedules`。

预期：命令正常返回；`/new` 后 `/whoami` 的会话编号变化。

### D. 群聊前缀（P0）

**D1 未带前缀忽略**

1. 群配置 `groupTrigger: prefix`、`groupPrefix: /ask`，重启。
2. member 在群里发“今天吃什么”（不带前缀）。

预期：没有接收确认、没有回合、没有 pairing 请求；日志不出现该消息的 turn。

**D2 带前缀执行**

1. member 发 `/ask 总结一下这个项目`。
2. owner 发 `/ask /status`。

预期：

- 第一条产生接收确认和最终回复，模型看到的用户文字是“总结一下这个项目”，不含 `/ask`。
- 第二条执行 `/status` 命令并回复状态。
- 不带前缀的 `/status` 被忽略。

**D3 交互答复**

1. 让 agent 在群里发起一个提问（例如“请选择 A 或 B”）。
2. member 直接回复 `1`（不带 `/ask`）。

预期：答复被消费；不启动新回合。

### E. Telegram 原生按钮（P0）

**E1 审批按钮**

1. 让 agent 执行一个需要审批的工具（例如请求运行 `bash`，或使用宿主的审批测试工具）。
2. 手机出现审批提示和“允许一次 / 拒绝 / 取消审批”按钮。

预期：

- 点“允许一次”：工具继续；按钮回调后加载状态消失；不需要输入验证码。
- 另一次点“拒绝”：工具不执行，agent 收到拒绝结果。
- 文本回复 `a1b2c3 1` 仍可用；裸数字 `1` 不应批准。

**E2 单题选项按钮**

1. 让 agent 使用 `ask_user_question` 提一个带选项的单题。
2. 点一个选项按钮。

预期：agent 收到对应选项；文字序号仍可用。多选题和一次多题仍走文本。

### F. `present` 文件交付（P0）

**F1 图片交付**

1. 发“生成一张简单的 PNG 图片，保存到工作目录，并用 present 交付”。
2. 等回复。
3. 发 `/tasks`，再发 `/files <短ID>`，最后 `/resend <短ID> 1`。

预期：

- 聊天收到图片/文件；微信接口返回消息 ID。
- `/files` 列出产物；`/resend` 能重发。
- `state.json` 的 `tasks` 有产物索引和实际工作目录。
- 聊天里没有“把文件复制到输出目录”的隐藏指令。

**F2 工作目录外拒绝**

1. 让 agent 尝试 `present` 一个工作目录外的文件（例如 `/etc/hosts`，或临时目录中的测试文件）。
2. 观察聊天和日志。

预期：

- 文件不外发；聊天收到“N 个附件未发送……”；任务标记附件未全部发送。
- 日志出现 `copyDeliverable` 拒绝或 `deliverable notice` 相关记录。

**F3 无 `present` 的 preset**

使用没有 `present` 的 preset，在项目内生成图片，并在最终回复中独立成段嵌入本地 Markdown 图片，确认图片上传。再仅返回普通文件路径，确认不自动上传；普通文件交付需为 preset 挂载 `present`。旧 `legacyOutputScan` 开关已移除，不能用它启用目录扫描。

### G. 超时晚回传（P0）

1. 临时设 `maxTurnWaitMs: 30000`，重启。
2. 发一个明确会运行超过 30 秒的任务，例如“每 10 秒运行一次 sleep 10，持续 90 秒，最后汇报”。
3. 30 秒后观察聊天，再等待最终结果。
4. 在等待期间发 `/status`；另一次测试中发 `/cancel`。

预期：

- 30 秒左右收到“任务仍在后台处理……”，任务**没有**被取消。
- 最终结果仍回到原聊天；`/status` 在等待期间显示执行中，之后显示完成。
- `/cancel` 只在宿主确认后显示“已取消”，排队消息保留；未确认时显示“停止尚未得到宿主确认”。

### H. 计划任务（P1）

1. 发 `/schedule after 2 smoke-plan-ok`。
2. 等 2 分钟，确认最终文字回到原聊天。
3. 发 `/schedules`，执行 `pause`、`resume`、`delete`。

预期：

- 原生计划执行一次并回传最终文字；`/schedules` 只列本聊天、本发送者的绑定。
- 暂停后不执行；恢复后执行；删除后不再回传。
- 删除绑定不修改已指向其他会话的原生任务。

### I. 重启与状态（P1）

1. 发一条普通消息，在回合开始前让宿主退出；重启后等待恢复。
2. 提交一个长任务，确认已开始执行且任务记录包含 `recovery` 输入绑定后重启宿主；另用没有恢复绑定的旧任务验证未知状态。
3. 检查状态目录权限和 `doctor`。

预期：

- 未开始消息从 `sections.inbox` 恢复；已开始回合不重跑。带恢复绑定的任务只读匹配原会话日志，回传确认的结果；未结束时保存增量游标继续等待，缺少绑定或日志不可用时保持未知。
- `state.json` 存在、版本为 2 且各段有效。迁移旧部署时，旧文件原始字节保存在 `legacy-state/`；全新安装无需这些备份。运行时不再生成或更新 `inbox.json`/`tasks.json` 等旧镜像。
- `state.json` 权限 0600；目录 0700。
- `doctor` 退出码 0（测试目录无未登记文件）。

### J. 安全与清理（P0）

1. 未知发送者发图片：确认下载前被拒绝，`media/inbound` 不新增该文件；只出现待批准提示。
2. 在状态卡片移除一个已批准发送者：其下一条消息被拒绝并重新产生待批准请求，旧排队消息不再执行。
3. 删除测试计划、清空测试排队消息、恢复测试前的 `config.json` 备份。

## 4. 结果记录

| ID | 场景 | 结果（通过/失败/阻塞） | 证据 | 备注 |
|---|---|---|---|---|
| A1 | 未知发送者只提示一次 |  | 截图 / `pairings` 计数 |  |
| A2 | 批准后生效 |  | `config.json` diff / 截图 |  |
| A3 | 拒绝不放宽 |  | 截图 / `allowedSenders` |  |
| B1 | WeChat 文本与回执 |  | 截图 / `/status` |  |
| B2 | Telegram 任务卡 |  | 截图 |  |
| B3 | 长任务提醒 |  | 截图 / 日志时间 |  |
| C1 | 成员受限 |  | 截图 |  |
| C2 | 管理员可用 |  | 截图 |  |
| D1 | 群聊未带前缀忽略 |  | 日志 / 无回执 |  |
| D2 | 前缀执行/命令 |  | 截图 |  |
| D3 | 交互免前缀 |  | 截图 |  |
| E1 | 审批按钮 |  | 截图 / 工具结果 |  |
| E2 | 选项按钮 |  | 截图 |  |
| F1 | 图片交付与重发 |  | 截图 / `/files` |  |
| F2 | 工作目录外拒绝 |  | 截图 / 日志 |  |
| G1 | 超时晚回传 |  | 时间线截图 |  |
| G2 | 超时后取消 |  | 截图 / `/status` |  |
| H1 | 计划执行与回传 |  | 原生记录 / 截图 |  |
| I1 | 重启恢复 |  | `state.json` 快照 |  |
| J1 | 未知附件不下载 |  | `media/inbound` 对比 |  |

**证据要求**

- 手机截图保留时间、发送者、消息 ID（脱敏后）。
- 日志只截取相关行，不贴 token、完整聊天正文或无关用户 ID。
- 状态快照只保留 `state.json` 的计数/键，不提交正文。
- 失败时记录：时间、命令/消息、预期、实际、日志行、是否可重复。

## 5. 清理

```bash
state="${DSH_CHANNELS_STATE_DIR:-$HOME/.dsh/channels}"
# 先暂停或删除测试计划，再停用插件
# 恢复测试前的 config.json
# 如使用独立测试目录，确认无用后移走
mv "$state" "$state.smoke.$(date +%Y%m%d-%H%M%S)"
```

- 撤销测试发送者的白名单。
- 删除测试群里的 bot 或移除管理员权限。
- 不要把测试状态目录、日志或录制内容提交到仓库。

## 6. 常见失败定位

| 现象 | 先看 |
|---|---|
| 未知发送者没有提示 | `logs/` 是否有 `refused`；`canReceive` 是否被适配器调用；`state.json` 的 `sections.pairings` 段 |
| 状态卡片不显示待批准 | `/channels/status` 是否有 `pairings`；浏览器是否刷新；同源/鉴权 |
| 批准后仍被拒 | `config.json` 的全局/账号覆盖是否写到了正确层级；是否重启/热更新 |
| Telegram 按钮无反应 | bot 是否收到 `callback_query`；日志是否有 `answerCallbackQuery`；按钮 value 是否超过 64 字节 |
| 任务卡不更新 | 适配器是否声明 `capabilities.edit`；回执是否有 `messageId`；`edit` 是否返回失败 |
| 群聊没反应 | `groupTrigger` 是否为 `prefix`；消息是否以 `groupPrefix` 开头；bot 是否能看到群消息 |
| `present` 文件没到 | 文件是否在工作目录内；`present` 是否成功；`logs/` 是否有附件未发送 |
| 超时没有晚回传 | `session/event` 是否到达；任务是否仍在运行；`/status` 的执行状态 |
| 重复执行 | `state.json` 的 `sections.inbox` 段与日志接收流水；平台重投；`DSH_INBOUND_RETRY` |

---

**最后更新**：2026-11-19。执行前先 `npm test` 并记录待测 commit；有本地改动时同时保留 `git diff`。本文是验收步骤，不代表所有真机项目均已通过；实际证据见 [STATUS.md](STATUS.md)。
