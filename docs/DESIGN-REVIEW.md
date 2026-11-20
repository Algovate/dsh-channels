# 设计评审与重构路线

2026-11-20 对 `main`（510 项测试）做了一次结构评审，结论与执行顺序如下。它记录的是**判断**，不是承诺：每一阶段都必须 `npm test` 全绿、构建通过、部署到 mini 并验证双通道后才进入下一阶段。

## 判断

通道抽象是对的，问题在它周围自建的基础设施过多。

保留：

- `ChannelAdapter` / `IngressSink` 接缝：三个平台零共享平台代码，新通道只需一个包。
- 「接受后才确认」的持久交接（飞书 200/500、Telegram offset）。
- 默认拒绝 + 待批准、下载体积上限、日志脱敏、`doctor`。

重构：

| 问题 | 现状 | 目标 |
|---|---|---|
| 自研 JSON 状态层 | `store/` 15 文件、1831 行，含 v1/v2 迁移、legacy 镜像、单写者锁 | SQLite（WAL）+ 6 张表，约 500 行；去重用唯一索引，排队用事务 |
| 三套配置来源 | loader patch + `config.json` overlay + live settings，25 个字段手写校验 | 一个文件、一个 schema、启动校验；仅安全字段热更新 |
| outbox 与 journal 双写 | 投递状态机写两遍 | outbox 是唯一状态，诊断走普通日志 |
| 上帝模块 | `runtime.ts` 940 行、`turns.ts` 667 行 | `ingest` / `turn-runner` / `outbox-worker` 三块 |
| 手写 UI 运行时 | `client.js` 660 行自建加载器 | 服务端页面或构建产物 |
| 适配器重复 | `safeName`/扩展名/落盘三份 | 核心 `adapter-kit` 纯函数（本阶段已完成） |
| 飞书手写协议栈 | `socket.ts`+`proto.ts` 约 570 行 | 评估官方 SDK，与零依赖取舍 |

## 阶段与验收

### Phase 1（本次）

- 历史文档归档到 `docs/notes/`，`STATUS.md` 只留当前记录。
- 新增 `@derekluo/dsh-channels/adapter-kit`：`safeFileSegment`、`extensionOfName`、`defaultExtensionFor`，三个适配器共用；适配器对 core 的 peer 依赖改为必需。
- 验收：全量测试通过（含新增 kit 测试）；三个包逐文件校验一致；部署后双通道启动无告警。

### Phase 2

- `store/` 换 SQLite：`inbox`、`tasks`、`outbox`、`lines`、`schedules`、`counters`、`pairings` 表；一次性导入旧 `state.json`，删除迁移与镜像代码。
- 验收：现有状态文件可导入；510 项测试全绿；mini 上重启后待处理队列、去重、配额行为一致。

### Phase 3

- 拆分 `runtime.ts` / `turns.ts`；状态卡改为构建产物；飞书 SDK 以独立 PR 评估。
- 验收：契约测试不变；真机消息、语音、卡片回调回归通过。

## 不做的事

持久交接重试、回合恢复游标、下载上限、待批准流程是**故障换来的**，不在此次精简范围。
