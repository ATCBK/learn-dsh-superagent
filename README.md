# Learn dsh-superagent —— 把一个"被动对话窗口"改造成"持续在线的自主协作者"

一套纯中文自学课程：把 DeepSeek 的 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)（研究原型）拆成 16 章，讲清它是**怎么从 0 到 1 搭起来的**，以及每一层机制解决的真实问题。

> 只讲这个项目独有的工程机制、它解决的真实问题与创新点；跳过"装依赖、写循环"这类基础套路。正文中文，代码内标识符保留原样。

## 一句话方法论

> 当大模型执行单个任务越来越少需要人工干预，限制生产力进一步提升的瓶颈，从**执行力**转向**人的注意力**。于是这套 harness 的目标不是"让模型更强"，而是**在接管繁琐的会话管理与上下文同步的同时，把人从执行细节抬升到只剩「决策」和「验收」**。

它用五根柱子做到这一点：

| 柱子 | 命题 | 对应章节 |
|---|---|---|
| ① 双层架构 | 决定与执行分成两个角色 | s02、s03 |
| ② 事件驱动 | 一切靠事件流动，不靠请求-响应 | s04、s05、s06 |
| ③ 异步多信道 | 人在哪发起，回复回哪，且不打断 | s07、s08、s09 |
| ④ 存算分离 | 状态是唯一真相，会话是可丢弃的执行体 | s10、s11、s12 |
| ⑤ 授权 | 准入与研判分离，规则变更可追踪 | s13、s14 |
| ⑥ 外部 Watchdog | 系统自己盯着自己 | s15、s16 |

## 从 0 到 1 的路线（这是本课程的核心承诺）

**不写 16 个互不相干的示例**。一个 `framework/` 目录从第 1 章开始、一章接一章长出来，第 16 章结束时它就是一套完整、可运行的最小核心框架（假模型 / 假渠道 / 假 GitHub，**零外部依赖**，只用 Node 24 内置的 TypeScript 直跑能力）。

每章的"试一下"都是跑同一个入口，观察这一章新长出来的机制在真实输出里的表现：

```sh
node framework/main.ts
```

到 s16，你手里有：`Engine 状态机 → Effects 队列 → SQLite Store → Outbox 回执 → Source 插件 → Policy 准入 → 每工单一目录的执行器 → Pass 心跳 + HealthBoard → 服务脚本`，全部由你自己一行行敲出来、且能跑通。

## 环境要求

- **Node ≥ 23.6**（内置 TypeScript 直跑能力；本课程在 Node 24.13 验证）。不需要 pnpm / npm install / tsx。

## 课程地图

| 章 | 柱子 | 机制 | 真实项目落点 |
|---|---|---|---|
| s01 | 内核 | 事件 → 决定 → 工单（状态机） | `src/core/engine.ts` |
| s02 | ① | 主/执行器双 Session 角色 | `src/app/sessions.ts` |
| s03 | ① | 每工单一目录 + 执行环境 | `src/executor/dsh.ts` |
| s04 | ② | 事务 + 效果队列（Effects） | `src/app/effects.ts` |
| s05 | ② | 幂等 id + Disposition 审计 | `src/core/ids.ts` `src/core/intake.ts` |
| s06 | ② | 域事件 → notice / relay | `src/core/ports.ts` `src/app/notices.ts` |
| s07 | ③ | Source 插件协议 | `src/sources/kind.ts` |
| s08 | ③ | 读位防重放 | `src/sources/poll.ts` |
| s09 | ③ | Outbox + 回执 | `src/app/outbox.ts` |
| s10 | ④ | SQLite 持久化 + 嵌套事务 | `src/app/store.ts` |
| s11 | ④ | Mandate 不可变授权 + 恢复 | `src/core/tickets.ts` |
| s12 | ④ | 订阅扇出 | `src/core/intake.ts` |
| s13 | ⑤ | Gate + Assessment 两段评估 | `src/policy.ts` |
| s14 | ⑤ | Policy 版本化 + policyEffects | `src/policy.ts` |
| s15 | ⑥ | Pass 心跳 + HealthBoard | `src/app/passes.ts` `src/infra/health.ts` |
| s16 | ⑥ | 服务脚本（外部看门狗） | `scripts/dsh-superagent` |

每章结构：**标题+motto → 问题 → 方案（表/图）→ 工作原理（第 1 步…第 N 步，每步一行大白话 + 一小段代码）→ 试一下 → 下一步**。

## 如何阅读

按 `s01 → s02 → … → s16` 顺序读。每一章只依赖前面的概念；`framework/` 的代码逐章累加，建议**每章自己先敲一遍**，再对照 `framework/` 看差在哪。

## 16 章已全部写完，框架就绪

`framework/` 现在是一套**能跑的最小核心框架**，从 s01 到 s16 逐章长出来：

```
framework/
├── main.ts     入口：完整链路（来源轮询 → 准入 → 研判 → 开单 → 执行 → 报告 → 回话 → 持久化）
├── engine.ts   s01/s05/s11/s12 状态机 + 授权 + 扇出 + 审计
├── effects.ts  s04 效果队列
├── store.ts    s10 SQLite + 嵌套事务 + kv
├── outbox.ts   s09 回执投递
├── source.ts   s07/s08 来源插件 + 读位
├── github.ts   假 GitHub 来源
├── policy.ts   s13/s14 Gate/Assessment + 版本化
├── executor.ts s02/s03 每工单一目录的执行器
├── sessions.ts s06 notice/relay
├── passes.ts   s15 心跳
├── health.ts   s15 健康看板
└── service.ts  s16 外部看门狗
```

**跑完整链路**（零依赖，Node 24 直跑）：

```sh
node framework/main.ts
```

**三处"假"的东西，换成真的就是 dsh-superagent**：模型（`policy.ts` 的 `assess` → DeepSeek 模型）、渠道（`github.ts` / `outbox.ts` → 真实 GitHub/飞书 CLI）、worker（`executor.ts` → 真实 DSH Session）。

## 许可证

[MIT](LICENSE)
