# dsh-channels · 通道

在个人微信或 Telegram 里使用 DeepSeek Harness（DSH）agent。发来的消息会进入 DSH 会话，回复、提问、审批和附件会回到原聊天。微信可选配语音转写。

![模拟演示：从微信发消息，DSH 处理回合并回复到原聊天](docs/demo.gif)

**默认拒绝所有发送者。** 只把信任的人加入白名单。获准的发送者可以用聊天驱动 agent，并按宿主规则审批工具调用。

| 包 | 用途 |
|---|---|
| [`@derekluo/dsh-channels`](packages/core) | DSH bundle：会话、权限、交互、重试、桌面状态卡片 |
| [`@derekluo/dsh-channels-weixin`](packages/adapter-weixin) | 个人微信，通过 iLink 长轮询 |
| [`@derekluo/dsh-channels-telegram`](packages/adapter-telegram) | Telegram Bot API，通过长轮询，不用配置 webhook |

## 开始使用

1. 准备 Node.js 22.13 或更高版本。此前的宿主集成验证使用 DSH `0.2.2-rc.3`；其他版本见[验证状态](docs/STATUS.md)。
2. 按[安装指南](docs/OPERATIONS.md#安装)构建并安装核心及所需适配器。只把核心加进 DSH profile 的 bundle 列表。
3. 按[微信](docs/OPERATIONS.md#微信)或 [Telegram](docs/OPERATIONS.md#telegram)一节配置凭证和适配器，再启动宿主。
4. 给机器人发一条测试消息。从状态目录的 `logs/` 找到 `refused … not-allowed`，核对自己的发送者 ID，再把它加入状态卡片白名单或 `config.json`。通过白名单后，用 `/whoami` 核对发送者、账号和会话 ID。

默认状态目录是 `~/.dsh/channels`；`DSH_CHANNELS_STATE_DIR` 可覆盖。手动编辑 `config.json` 后重启宿主。[配置参考](docs/OPERATIONS.md#配置)列出了默认值和可实时修改的设置。

## 手机和桌面

| 手机命令 | 作用 |
|---|---|
| `/help` | 列出命令 |
| `/whoami` | 查看发送者、通道账号、会话和当前 DSH 会话线 |
| `/status` | 查看通道与状态目录，以及当前聊天的待重发、待答和最近发出 |
| `/new` | 从下一条普通消息开始使用新会话，保留原会话 |

命令也需要通过权限和配额检查。遇到提问时按提示回复序号或文字；审批回复 `1` 允许一次，`2` 拒绝。

桌面聊天中的通道消息带有微信或 Telegram 徽标。宿主支持工作区登记时，会话归入 **Channels**；通道状态和设置在 **Plugins → @derekluo/dsh-channels**。

## 开发与参考

```bash
npm ci
npm test
```

- [运维指南](docs/OPERATIONS.md)：安装、配置、账号迁移、语音转写和排障。
- [设计](docs/DESIGN.md)与[决策记录](docs/DECISIONS.md)：消息如何进入回合，以及主要设计取舍。
- [适配器指南](docs/ADAPTERS.md)：平台能力、接口和接入步骤。
- [验证状态](docs/STATUS.md)与[变更记录](CHANGELOG.md)：测试范围、已知限制和升级注意事项。

包清单声明 MIT 许可。微信内置传输层的来源与许可见[第三方声明](packages/adapter-weixin/THIRD-PARTY-NOTICES.md)。
