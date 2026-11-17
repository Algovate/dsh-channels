# 运维

## 1. 安装到一台机器

前置：DSH ≥ `0.2.2-rc.3`（宿主版本必须与插件使用的宿主包同代）；Node ≥ 22.13。

```bash
# 1) 构建 + 测试
npm install && npm test

# 2) 打包（dist 必须已构建；微信适配器还要带 vendor/ 与 bin/）
tar czf /tmp/channels-core.tgz     -C packages/core            package.json cordis.patch.yml client.js bin dist
tar czf /tmp/channels-weixin.tgz   -C packages/adapter-weixin  package.json vendor bin dist
tar czf /tmp/channels-telegram.tgz -C packages/adapter-telegram package.json dist

# 3) 目标机：解开、加 file: 依赖、加 bundle 行
#    profile 的 package.json：
#      dependencies: { "@rodin/dsh-channels": "file:…/core", "@rodin/dsh-channels-weixin": "file:…/adapter-weixin" }
#      dsh.profile.bundles: [ …, "@rodin/dsh-channels" ]
cd <profile> && pnpm install        # file: 是复制：换源码目录必须重装
```

**不要**把同一个微信账号同时挂两个通道插件：两边都会长轮询同一个账号，并争抢同一个游标。

## 2. 状态目录

默认 `~/.dsh/channels`，可用 `DSH_CHANNELS_STATE_DIR` 覆盖。表见
[DESIGN §7](DESIGN.md#7-存储)，权威来源是 `packages/core/src/store/layout.ts`：

```
~/.dsh/channels/
├── config.json              设置覆盖（0600），覆盖加载器配置
├── counters.json            限流计数的回落文件（有存储域时不写）
├── outbox.json              待重发（上限 50 条）
├── journal/journal-*.jsonl  消息流水，两段式
├── logs/channels-*.log      运行日志
├── media/inbound/<账号>/    收到的附件
├── workspace/               agent 工作目录（默认登记成 GUI 工作区「Channels」）
└── openclaw-weixin/         微信凭证（0600，vendored 登录流程写）
```

`npm run build && npm run doctor -- --state` 打印每一行的用量与它为什么在那里；状态目录里有
表外文件时会以非零退出码结束。

## 3. 配置与优先级

`config.json` **覆盖**加载器行里的同名键：patch 里的值是默认，操作者保存的才是决定。卡片上的
白名单与限流编辑都写这个文件（原子的临时文件 + rename）。

```json
{
  "allowedSenders": ["o9cq…@im.wechat"],
  "adapters": ["@rodin/dsh-channels-weixin"],
  "maxTurnWaitMs": 300000,
  "adapterConfig": {
    "@rodin/dsh-channels-weixin": {
      "asrCommand": "/Users/you/dsh-plugin-pkgs/asr-venv/bin/python",
      "asrModelDir": "/Users/you/.dsh/channels/asr-models"
    }
  }
}
```

改完需要重启宿主（`apply` 期间读一次配置）；卡片能改的那几项是例外——它们同时改运行中的值。

## 4. journal：回答"发出去没有"

```bash
tail -n 3 ~/.dsh/channels/journal/journal-2026-11-17.jsonl | jq -c '{id,phase,delivery,messageId,code}'
```

每条发出的消息写两次：`sending`（调用适配器之前）和 `settled`（之后，带
`delivery: accepted|unconfirmed|failed` 与 `messageId`/`code`）。只有 `sending` 没有 `settled`
的，就是"发到一半进程没了"——那才是 pending。

网页侧同一份数据在卡片上（最近 8 条）。

## 5. 微信登录与账号

微信适配器复用 vendored 登录流程写的凭证：`<state>/openclaw-weixin/accounts*.json`。
从旧插件迁移时可以直接拷这个目录（本插件不读旧插件的其它状态）。

选了哪个账号：`adapterConfig["@rodin/dsh-channels-weixin"].accountId`；不填就用索引里的第一个。
日志里 `weixin adapter polling account <id>` 会说明实际在跑哪个。

## 6. 语音转写（可选）

没有引擎时语音只会被转成 WAV 落盘，提示里写"无法转写"——不是错误，是降级。

```bash
# Apple silicon：mlx-whisper；其它平台换 faster-whisper
python3 -m venv ~/dsh-plugin-pkgs/asr-venv
~/dsh-plugin-pkgs/asr-venv/bin/python -m pip install mlx-whisper

# 模型下载到插件约定的目录名（桥按这个拼路径）
HF_HUB_DISABLE_XET=1 ~/dsh-plugin-pkgs/asr-venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("mlx-community/whisper-small-mlx", token=False,
                  local_dir="/Users/<you>/.dsh/channels/asr-models/mlx-community__whisper-small-mlx")
PY

# 单独验证（不经过微信）
say -v Tingting -o /tmp/a.aiff "明天下午三点提醒我开会"
afconvert -f WAVE -d LEI16@16000 /tmp/a.aiff /tmp/a.wav
printf '{"wav": "/tmp/a.wav"}\n' | DSH_WEIXIN_ASR_MODEL_DIR=~/.dsh/channels/asr-models \
  ~/dsh-plugin-pkgs/asr-venv/bin/python packages/adapter-weixin/bin/asr-bridge.py
```

然后在 `adapterConfig` 里指向这个 venv 的 python 与模型目录。桥是**常驻子进程**：一行一个 JSON
请求/响应，同一时刻只有一个请求，失败返回原因而不是抛异常，默认 60s 超时。

## 7. GUI

- **Chat 行**：通道消息显示成带徽标的气泡。
- **工作区分组**：插件启动时把工作目录登记成「Channels」工作区，会话首次附着时
  `attachSession()` 挂进去。没有这一步，会话会落在 "Ungrouped" 里（要展开才看得到）。
- **状态卡片**（Plugins → `@rodin/dsh-channels`）：三个同源路由
  `GET /channels/status`、`POST /channels/allowlist`、`POST /channels/settings`。
  POST 必须带页面自己的 `Origin`，否则 403。

## 8. 排障

| 现象 | 先看 | 常见原因 |
|---|---|---|
| 机器人不回 | `logs/` 里有没有 `refused … not-allowed` | 白名单空 / id 不对（用 `/whoami` 取） |
| 回了但没收到 | journal 里该条是否有 `settled`、`delivery` 是什么 | `failed` → `outbox.json` 会重发；`pending` → 进程中途没了 |
| 回合失败 | `logs/` 的 `turn failed for …` | 模型余额/网络；错误不会发给用户 |
| 提问没出现 | `logs/` 的 `user-questions/request: target=…` | `target=none` 表示不是本通道的会话 |
| 提问出现又消失 | 同一行附近 40ms 内的桌面应答 | 桌面 answerer 先答了空答案集（见 STATUS 已知行为） |
| GUI 里找不到会话 | 侧栏是否展开「Channels」 | 工作区登记失败（日志有 `workspace registration failed`） |
| 卡片显示"没有 channels 服务" | 宿主是否提供 `webServer` | 路由没注册成功（日志有 `status route not registered`） |
| 语音没转写 | `transcribed voice note` / `voice note not transcribed` | 没有引擎、模型目录不对、超时 |
| 装完没生效 | `pnpm install` 是否重跑过 | `file:` 依赖是复制，不重装跑的是旧代码 |

## 9. 版本与兼容

- 宿主包（`dsh-storage-domain`、`dsh-typert-protocol`）只能作为 **optional peer** 声明，代码里
  必须能"没有它也跑"，并且用运行期动态 `import()`。把它们装成普通依赖会把宿主的行挤坏
  （实测：宿主禁用了自己的 `storage-domain` 行）。
- 读服务用 `ctx.inject([...], cb)`，不要用 `ctx.get(...)`：核心服务（`storageDomain`、
  `workspaceRegistry`、`agentPresets`）用 `get` 拿到的是空。
- 升级宿主后重跑 `npm test`；`docs/STATUS.md` 记录每个里程碑验证在哪个宿主版本上做的。
