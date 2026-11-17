# 适配器指南

适配器作为普通包安装。核心从配置的 `adapters` 加载它，不需要额外的 DSH bundle 行。

## 内置适配器

| 能力 | 微信 | Telegram |
|---|---|---|
| 传输 | iLink 长轮询，使用内置传输代码 | Bot API 长轮询，使用 `fetch` |
| 凭证 | 按账号保存的 iLink 登录文件 | Bot token |
| 文字 | 每条最多 600 字符 | 每条最多 4000 字符 |
| 图片、文件、视频 | 双向 | 双向 |
| 入站语音 | 保存音频；可选 SILK 转码和转写 | 保存音频文件 |
| 出站语音 | 作为文件，非语音气泡 | 作为文件，非语音气泡 |
| 交互 | 编号或文字回复 | 编号或文字回复 |
| 正在输入 | 无 | 有 |

每个适配器实例使用一个账号。凭证、可用配置和迁移见[运维指南](OPERATIONS.md)，真机覆盖见[验证状态](STATUS.md)。

## 接口

从核心包导入 `AdapterModule`、`AdapterRuntime`、`ChannelAdapter` 和消息类型。完整定义见 [types.ts](../packages/core/src/types.ts)。

- **加载。** 导出 `createAdapter({ ctx, runtime, stateRoot, config })`。`config` 是以本包名索引的配置对象。
- **标识。** 提供稳定的通道 ID 和账号 ID。账号 ID 参与会话、去重、配额与重发；变更显示名称不应变更账号 ID。平台提供稳定的消息 ID 时，填入 `platformMessageId`，使同一聊天的重投可去重。
- **入站。** 先剔除平台回显、编辑、广播以及不支持或为空的消息，再做预检。保持同一聊天的消息顺序；附件慢时尽量允许其他聊天前进。
- **出站。** 只接受本通道和本账号的目标。`send()` 返回已接受（带消息 ID）、未确认（平台接受但无 ID）或失败（带原因码）。`typing()` 可选。
- **交互。** 提问和审批的文本渲染、解析和等待队列由核心提供。旧 `interactions` 字段保留为可选兼容接口，核心不调用它；新适配器无需实现。`Outgoing.bubbles` 及未实现的按钮、编辑等能力标志也已弃用；文本分条使用核心配置，正在输入提示通过可选 `typing()` 方法提供。
- **生命周期。** `start()` 和 `stop()` 应可重复调用；`stop()` 要中止轮询和入站下载并等待退出。`onInbound()` 返回注销函数。

### 附件预检

在下载或转写前调用 `canReceive`。无附件时传 `false`，这样有效的交互答复仍可通过。预检成功后只补充同一对象，调用 `cancelReceive` 释放未交付的配额；已交付时调用也安全。

```ts
if (runtime?.canReceive?.(message, attachments.length > 0) === false) return
try {
  await enrichMessage(message, attachments, signal)
  if (!signal.aborted) deliver(message)
} finally {
  runtime?.cancelReceive?.(message)
}
```

这里的 `enrichMessage` 和 `deliver` 由适配器实现：前者补充附件，后者通知 `onInbound` 注册的处理函数。单个附件失败时，尽量保留可用的正文和附件。

## 接入步骤

1. 按[现有适配器](../packages/adapter-telegram)建立工作区包和 TypeScript 项目引用，不复制核心实现。
2. 分开平台调用、消息归一化和适配器入口。对网络调用设置读取限制和取消机制。用可替换的网络调用测试游标推进、失败和关闭。
3. 在 [client.js](../packages/core/client.js) 的 `CHANNELS` 添加 Chat 行定义。这个表在浏览器端是静态的；宿主加载新通道不会自动注册渲染器。
4. 运行 `npm test`，检查构建产物，再按[安装指南](OPERATIONS.md#安装)安装并启用。

普通消息持久交接失败时，核心入站处理器抛出 `code: "DSH_INBOUND_RETRY"` 的错误。适配器须保留或回退轮询位置并退避重投，不能确认这条更新；其他单条处理错误仍按普通失败记录。需要私有回复上下文的平台可将它放在 `InboundMessage.raw`，并提供可选的 `restoreInbound(message)`，在核心恢复排队消息前重建路由；不要覆盖比恢复消息更新的上下文。
