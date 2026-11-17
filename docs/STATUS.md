# 状态 · M0（0.1.0 骨架）

- 日期：2026-11-17
- 结论：**M0 真机通过** —— 微信发一句、agent 真实回复一句，重启后 resume 同一条会话。
- 范围：只做文字。媒体、交互（提问/审批）、GUI 卡片、Chat 行、存储域迁移都在后续里程碑（见 DESIGN §12）。

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

## 已知边界（M0 有意不做）

- 只处理文字；图片/文件/语音的消息被丢弃（`normalizeInbound` 返回 null，日志有行）。
- 没有提问/审批（M1），因此 `ask_user_question` 在微信会话里会落到宿主的审批/提问 UI（GUI）。
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
