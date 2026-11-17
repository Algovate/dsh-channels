# 状态 · M0 + M1（0.1.0）

- 日期：2026-11-17
- 结论：**M0 真机通过**（文字往返、重启 resume）；**M1 提问与审批都真机通过**：
  - 提问：agent 调 `ask_user_question` → 微信收到编号问题 → 回 `1` → 同一个回合继续，宿主记录的 tool result 是
    `{"answers":[{"id":"drink","selected":["1"]}]}`；
  - 审批：`bash` 申请写桌面文件 → 微信收到「需要批准」→ 回 `1` → 工具真的执行，
    `~/Desktop/channels-approval-test.txt` 出现，回合在 14.3s 时正常结束。
- 范围：文字 + 交互。媒体、GUI 卡片、Chat 行、存储域迁移仍在后续里程碑（见 DESIGN §12）。

## 已实现

| 模块 | 内容 |
|---|---|
| `packages/core` | 契约（types）、会话 id 派生、入站门链（默认拒绝）、每会话 FIFO 队列 + `runNow` bypass、回合驱动（resume → create → 撞车重试；注入 context；`source.kind = <channel>`）、分条与纯文本归一、outbox（退避重试）、状态表 + 库存 + `doctor`、配置（schemastery）+ 状态目录 `config.json` 覆盖 |
| `packages/adapter-weixin` | iLink 长轮询（可单步 `pollOnce`）、文字发送、入站归一化（丢弃自己的回声/未完成/纯媒体）、账号面、编号式交互渲染/解析 |
| 测试 | 58 条：契约/id、门链、队列、分条、状态表守卫（未声明路径即失败）、回合驱动的五条路径、归一化、传输层（可注入 poll/send） |

## 真机证据（mini，`0.2.2-rc.3`）

```
# ~/.dsh/channels/logs/channels-2026-11-17.log
{"level":"info","line":"channel 'weixin' registered"}
{"level":"info","line":"weixin adapter polling account fd22aefdda85@im.bot"}
{"level":"info","line":"turn for weixin|… settled in 3695ms (197 chars)"}

# 会话 chan-weixin-1421e1b70d9e4eef（cwd = ~/.dsh/channels/workspace）
user/message   source {"kind":"weixin","form":"message","conversationId":"o9cq…","group":false}  text "4"
assistant/message  [{"type":"text","text":"我收到了“4…”}]
turn/end       {"reason":{"kind":"completed"}}
```

没有 outbox 条目 = 回复真的发出去了（发送失败会留在 `outbox.json`）。

## M0 撞出来的四个坑（都已修，且都有测试或文档）

1. **保存的设置必须盖过 loader 配置**：patch 里 `allowedSenders: []` 把状态目录的
   `config.json` 盖掉了，第一条消息被 `not-allowed` 拒。现在合并顺序是 `{...loader, ...saved}`。
2. **新建会话必须有模型路由**：否则第一步就 `agent has no provider/model`。现在读宿主的
   `agentDefaultModel.currentSelection()` 作为 `agentOptions`，不要求操作者填任何东西。
3. **重启后要先 resume 再 create**：会话在磁盘上、没有活 agent 时，`create` 报
   `session already exists`。现在的顺序是 live → resume → create →（撞车再 resume）。
4. **内部报错不发给人**：模型/宿主错误只进日志，给用户一句「这边出了点问题」。

另外一条部署经验：pnpm 的 `file:` 目录依赖是**复制**进 profile 的，换了源码目录必须
重新 `pnpm install`，否则跑的还是旧代码（这次被它坑了一次真机验证）。

## M1：交互 seam（提问 + 审批）

| 部分 | 内容 |
|---|---|
| `interaction/queue` | 每会话一个待答；队列头才发提示；`claim` 解析回复、`retire` 处理桌面先答、超时/撤销都 reject（`ETIMEDOUT`）而不编造答案；队列本身负责编号（编号就是回复语法） |
| `interaction/questions` | 多题渲染（题号/【标题】/详情截断/选项描述/多选说明）、解析（`1`/`1.`/全角数字/`1,2`/跳过词/无选项即自由文本）、`answerUserQuestion` 同时问桌面与微信、先真答者胜、桌面赢则 `retire` 微信提示 |
| `interaction/approval` | 工具名 + 理由渲染；`1/允许/yes` → `allowed-once`、`2/拒绝` → `rejected`、`取消` → `cancelled`；桌面的 `unavailable` **不算决定**（微信还挂着就继续等）；没人决定时**失败关闭**返回 `unavailable`，不伪造拒绝 |
| 运行时 | `agent → 会话` 反查映射（seam 只拿到 agent）；入站回复在门链之后、回合队列之前被消费（bypass），乱回复只回提示、不消耗待答 |
| 接线 | `ctx.on('user-questions/request' | 'approval/request', …, { prepend: true, global: true })`：prepend 让微信与桌面同时出现，global 因为它们在被问 agent 的作用域里派发 |

已知边界（M1 之后）：

- 多题只支持「一题一行/分号分隔」，没有逐题确认；
- 审批只给「允许一次 / 拒绝」，没有"允许并记住"（宿主也没有稳定的一次性授权）；
- 微信没有按钮，全部走编号（适配器的 `interactions.format = 'numbered'`）。

## 已知边界（M0 有意不做）

- 只处理文字；图片/文件/语音的消息被丢弃（`normalizeInbound` 返回 null，日志有行）。
- 提问/审批已在 M1 接入（见上），未做的是「逐题确认」与「允许并记住」。
- 没有 GUI 卡片，也没有 Chat 行：微信消息在 GUI 里暂时显示为 context 行（M3 补）。
- 回合回复靠轮询 `snapshotEvents()`（默认 120ms）；事件唤醒是 M1。
- 没有 journal / 审计 / `/diag export` / 限流持久化（M2）。
- 单账号；多账号的选择留给配置（`adapterConfig.accountId` 已支持）。
- 旧插件与它不能同时挂载（同一微信账号只能一个长轮询）；mini 的旧插件已从 profile 移除，
  备份是同目录的 `package.json.before-channels` 与 `pnpm-lock.yaml.before-channels`。

## 本机怎么跑

```bash
npm install
npm test            # build + test（58 条）
npm run doctor      # 状态清单：DSH_CHANNELS_STATE_DIR 或 ~/.dsh/channels
```

## 部署到一台机器（M0 手工流程）

```bash
# 1) 打包两个包（dist 必须已构建）
tar czf /tmp/channels-core.tgz -C packages/core package.json cordis.patch.yml bin dist
tar czf /tmp/channels-weixin.tgz -C packages/adapter-weixin package.json vendor dist

# 2) 目标机：解到某目录，profile 里加 file: 依赖 + bundles 行，再把旧插件移除
#    注意：改完源码目录要重新 pnpm install（file: 是复制）
# 3) 导入账号（旧插件的 credentials 可直接拷）
mkdir -p ~/.dsh/channels && cp -R ~/.dsh/weixin/openclaw-weixin ~/.dsh/channels/
# 4) 白名单（默认拒绝所有人）
cat > ~/.dsh/channels/config.json <<'JSON'
{ "allowedSenders": ["<your sender id>"], "adapters": ["@rodin/dsh-channels-weixin"] }
JSON
```
