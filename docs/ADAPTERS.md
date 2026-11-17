# 适配器

适配器是一个**库**，核心按名字从配置的 `adapters` 里 `import()` 它。它只做两件方向的翻译，
别的都在核心里。这条边界有实测证据：第二个适配器（Telegram）与微信适配器**不共享任何一行代码**，
核心也没为它改一行。

## 1. 契约

```ts
export interface AdapterModule {
  createAdapter(options: {
    ctx: unknown                      // 宿主上下文（一般不用）
    runtime: unknown                  // 只用到 runtime.logger / runtime.markExpired
    stateRoot?: string                // 插件状态根；附件放 <stateRoot>/media/inbound
    config: Record<string, unknown>   // adapterConfig[<package name>]
  }): ChannelAdapter | Promise<ChannelAdapter>
}
```

`ChannelAdapter` 的完整形状见 [DESIGN §2.2](DESIGN.md) 与 `packages/core/src/types.ts`：

| 成员 | 要求 |
|---|---|
| `id` | 稳定短名，会进 `source.kind`、会话 id、Chat 行的行键 |
| `label` | 中英双语，卡片和 Chat 行显示它 |
| `capabilities` | 含 `maxTextChars`（平台自己的上限，核心据此分条） |
| `accounts` | 至少能列出账号；凭证被平台拒绝时 `markExpired` |
| `interactions` | `format` 只能是 `'numbered'`（0.1.0 只有这一种渲染） |
| `start` / `stop` | 幂等；`stop` 要能中断长轮询并等它退出 |
| `onInbound` | 返回注销函数 |
| `send` | **不抛异常**：失败返回 `{ok:false, code}` |
| `typing` | 可选；失败只当没做过 |

## 2. 两个适配器的现状

| | 微信 | 电报 |
|---|---|---|
| 包 | `@rodin/dsh-channels-weixin` | `@rodin/dsh-channels-telegram` |
| 传输 | iLink 长轮询（vendored openclaw-weixin） | Bot API 长轮询（无依赖，`fetch`） |
| 认证 | 扫码登录写的 token，`<state>/openclaw-weixin/` | `adapterConfig.token` |
| 文字 | ✅ 600 字/条 | ✅ 4000 字/条 |
| 图片/文件/视频 | ✅ 入站下载解密；出站上传 | ✅ 入站 `getFile`；出站 multipart |
| 语音 | 入站 SILK→WAV→ASR（需要引擎）；出站**不做** | 入站保存文件；出站作为文件 |
| 文档正文 | txt/md/docx 零依赖，pdf 需可选 `pdfjs-dist` | 不抽取（可后续接核心的 `extractDocumentText`） |
| 交互 | 编号 | 编号 |
| 真机 | ✅ | ❌ 待 token |
| 代码量 | ~965 行（含 vendored 传输） | ~539 行 |

## 3. 新增一个适配器：清单

1. **建包** `packages/adapter-<name>/`：`package.json`（`main: dist/src/index.js`、
   `peerDependencies: { "@rodin/dsh-channels": "*" }` 且 `optional: true`）+ `tsconfig.json`
   （`references: [{ path: "../core" }]`）。
2. **写 `src/transport.ts`**：平台调用，`fetchImpl`/`spawn` 之类可注入，这样测试能单步一次轮询。
   每个失败都是值。长轮询要有 offset，重启不重放。
3. **写 `src/normalize.ts`**：平台消息 → `InboundMessage`。**明确拒绝**这些：机器人自己的消息
   （会成环）、编辑过的消息（编辑不是新输入）、频道广播、空消息。
4. **写 `src/index.ts`**：`createAdapter()` 返回 `ChannelAdapter`；`send` 按 `outgoing.media`
   分流；交互用编号。
5. **加进 `packages/core/client.js` 的 `CHANNELS` 表**（id、row 键、徽标、强调色）——否则 GUI 里
   没有属于它的 Chat 行。
6. **测试**：normalize 的每条拒绝规则、transport 的一步轮询与失败、`ChannelAdapter` 结构契约。
7. **部署**：profile 里加 `file:` 依赖，`adapters` 里加包名，`pnpm install`（file: 是复制）。

## 4. 已知缝隙

- **客户端 `CHANNELS` 是静态表**。浏览器看不到宿主的注册（Remote namespace 需要构建期生成的
  `/remote` 工件），所以新适配器必须手加一行。要彻底解决需要宿主提供一个"当前挂了哪些通道"的
  Remote 或类似通道。
- **平台差异只能靠上限与能力位表达**。比如 Telegram 的 inline keyboard（`buttons`）与消息编辑
  （`edit`）能力位存在，但 0.1.0 没用；微信没有按钮，所以交互统一走编号。
- **出站语音默认不做**。iLink 收而不投递；Telegram 能发，但核心把音频当文件，除非适配器自己把
  `voice` 能力打开（目前两个适配器都是 `false`）。
- **多账号**：微信适配器通过 `adapterConfig.accountId` 选账号，但一个通道目前只跑一个账号；
  多账号需要核心把账号维度放进会话键（现在 `accountId` 已经在里面了，缺的是适配器侧的并发循环）。
