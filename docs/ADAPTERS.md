# 适配器指南

适配器作为普通包安装。核心从配置的 `adapters` 加载它，不需要额外的 DSH bundle 行。

## 内置适配器

| 能力 | 微信 | Telegram | 飞书 |
|---|---|---|---|
| 传输 | iLink 长轮询，使用内置传输代码 | Bot API 长轮询，使用 `fetch` | 长连接 WebSocket（`ws` 库，飞书官方 SDK 同款）；REST 收发用内置 `fetch` |
| 凭证 | 按账号保存的 iLink 登录文件 | Bot token | 应用 `App ID` / `App Secret`（自建应用） |
| 文字 | 每条最多 600 字符 | 每条最多 4000 字符 | 每条最多 4000 字符 |
| 图片、文件、视频 | 双向 | 双向 | 双向 |
| 入站语音 | 保存音频；可选 SILK 转码和转写 | 保存音频文件 | 保存音频；可选 whisper 转写 |
| 出站语音 | 作为文件，非语音气泡 | 作为文件，非语音气泡 | 作为音频消息发送 |
| 交互 | 编号或文字回复 | 编号或文字回复，审批和单题选项使用原生按钮 | 编号或文字回复，审批和单题选项使用卡片原生按钮（`card.action.trigger`） |
| 正在输入 | 无 | 有 | 无 |
| 消息编辑 | 无 | 有（任务卡原地更新） | 有（任务卡原地更新） |

飞书长连接上的网关帧是固定的 protobuf `Frame`，适配器内置一个只覆盖该 schema 的零依赖编解码器（见 [proto.ts](../packages/adapter-feishu/src/proto.ts)），不引入 protobuf 运行时。事件可能按 `sum`/`seq` 分片，适配器先重组再处理，且只在核心持久交接成功后回 `code:200` 的确认帧；处理失败回 `code:500` 请网关重投。

每个适配器实例使用一个账号。凭证、可用配置和迁移见[运维指南](OPERATIONS.md)，真机覆盖见[验证状态](STATUS.md)。

## 接口

从核心包导入 `AdapterModule`、`AdapterRuntime`、`ChannelAdapter` 和消息类型。完整定义见 [types.ts](../packages/core/src/types.ts)。

- **加载。** 导出 `createAdapter({ ctx, runtime, stateRoot, config })`。`config` 是以本包名索引的配置对象。
- **标识。** 提供稳定的通道 ID 和账号 ID。账号 ID 参与会话、去重、配额与重发；变更显示名称不应变更账号 ID。平台提供稳定的消息 ID 时，填入 `platformMessageId`，使同一聊天的重投可去重。
- **入站。** 可先用核心 `canBypassInbound(message)` 判断无附件文本是否为任务控制或当前交互答复，让它绕过耗时媒体队列；此方法只分类，交付前仍须调用 `canReceive` 鉴权。先剔除平台回显、编辑、广播以及不支持或为空的消息，再做预检。保持同一聊天的消息顺序；附件慢时尽量允许其他聊天前进。
- **出站。** 只接受本通道和本账号的目标。`send()` 返回已接受（带消息 ID）、未确认（平台接受但无 ID）或失败（带原因码）；平台要求等待时填入 `retryAfterMs`，核心持久重试会保留该下限。`typing()` 可选。若平台支持原生按钮，声明 `capabilities.actions: true` 并读取 `Outgoing.actions`（`label`/`value`）；按钮回传时把 `value` 当作该发送者的一条文本输入，进入同一套交互解析。若平台支持编辑，声明 `capabilities.edit: true` 并实现 `edit(target, messageId, outgoing)`；核心会把接收回执编辑成“执行中/仍在处理/已完成/失败”的任务卡。
- **交互。** 提问和审批的文本渲染、解析和等待队列由核心提供；有 `actions` 时渲染原生按钮，没有时退回编号文本。分条由核心配置 `maxTextChars` 和 `bubbleGapMs` 控制。
- **driver 入口（必需）。** 实现 `startWithSink(sink)`：完成平台补全后调用 `await sink.offer(message, { priority })`。核心按聊天串行 durable handoff，并在 `DSH_INBOUND_RETRY` 时退避重试；适配器只保留平台游标/批次确认和媒体顺序。核心只调用 `startWithSink`；缺少此方法的适配器会在注册前被拒绝，并记录迁移提示。
- **生命周期。** `startWithSink(sink)` 和 `stop()` 应可重复调用；运行中重复启动保持原 sink，停止后可用新的 sink 重启；`stop()` 要中止轮询和入站下载并等待退出。

### 附件预检

在下载或转写前调用 `canReceive`。无附件时传 `false`，这样有效的交互答复仍可通过。预检成功后只补充同一对象，调用 `cancelReceive` 释放未交付的配额；已交付时调用也安全。

```ts
if (runtime?.canReceive?.(message, attachments.length > 0) === false) return
try {
  await enrichMessage(message, attachments, signal)
  if (!signal.aborted) await sink.offer(message, { priority: attachments.length === 0 && runtime?.canBypassInbound?.(message) === true })
} finally {
  runtime?.cancelReceive?.(message)
}
```

这里的 `enrichMessage` 由适配器实现，补充附件；`sink` 是启动时收到的核心持久交接入口。单个附件失败时，保留可用的正文和附件，并将缺失说明写入 `message.attachmentErrors`；不要把 URL、凭证或完整异常放进该字段。核心会把缺失说明提供给模型；纯附件全部失败时只通知用户并释放预留，不启动模型。持久交接失败时保留同聊天普通消息的位置重试；优先控制可以绕过，但只能确认连续完成的更新前缀。

## 接入步骤

1. 按[现有适配器](../packages/adapter-telegram)建立工作区包和 TypeScript 项目引用，不复制核心实现。
2. 分开平台调用、消息归一化和适配器入口。对网络调用设置读取限制和取消机制。用可替换的网络调用测试游标推进、失败和关闭。
3. 在 [client.js](../packages/core/client.js) 的 `CHANNELS` 添加 Chat 行定义。这个表在浏览器端是静态的；宿主加载新通道不会自动注册渲染器。
4. 运行 `npm test`，检查构建产物，再按[安装指南](OPERATIONS.md#安装)安装并启用。

普通消息持久交接失败时，核心入站处理器抛出 `code: "DSH_INBOUND_RETRY"` 的错误。适配器须保留或回退轮询位置并退避重投，不能确认这条更新；其他单条处理错误仍按普通失败记录。需要私有回复上下文的平台可将它放在 `InboundMessage.raw`，并提供可选的 `restoreInbound(message)`，在核心恢复排队消息前重建路由；不要覆盖比恢复消息更新的上下文。

## 从旧适配器 API 迁移

将 `start()` 与 `onInbound(handler)` 合并为 `startWithSink(sink)`，删除处理器集合，在补全消息后 `await sink.offer(message, options)`；只有持久交接完成后才能推进平台确认。仍须保留 `DSH_INBOUND_RETRY` 的退避与重投语义。核心及两个内置适配器需一起升级。

已移除 `ChannelAdapter.interactions`、`InteractionView`、`InteractionReply`、`Outgoing.bubbles` 和 `Capabilities.text/stickers/typing/buttons`。文本发送是必需能力；原生交互使用 `actions`，输入状态使用可选的 `typing()` 方法，编辑能力继续使用 `edit`。
