# dsh-channels · 通道

**让你的 DSH Agent 出现在聊天软件里。** 微信是第一个适配器。

这是一个**全新项目**（不是 `dsh-plugin-weixin` 的 fork），设计见 [`docs/DESIGN.md`](./docs/DESIGN.md)。

```bash
npm install                      # 装依赖（工作区）
npm test                         # 单元测试 + 契约测试
npm run build                    # tsc → packages/*/dist
npm run doctor                   # 状态清单与占用
```

## 结构

```
packages/core              @rodin/dsh-channels         核心：回合驱动 / 交互 / 状态 / 门链
packages/adapter-weixin    @rodin/dsh-channels-weixin  微信适配器（iLink，vendored 传输层）
```

核心是**唯一**的 DSH bundle；适配器是普通库包，由核心按 `config.adapters` 里的包名动态加载。
装什么适配器就有什么通道：

```yaml
# cordis.patch.yml 的 config
adapters:
  - '@rodin/dsh-channels-weixin'
```

## 状态

真机验证中。M0（只文字）的实现与已知边界见 [`docs/STATUS.md`](./docs/STATUS.md)。
