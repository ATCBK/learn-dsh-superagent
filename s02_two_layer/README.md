# s02: 双层架构 —— 一个负责判断，一个负责干活

> *"想的人不动手，动手的人不拍板。"*

---

## 问题

上一章你写的那台机器，判断、开单、干活，全是你自己在 `main.ts` 里手动调的三步。但真实场景里，"判断该不该干"和"真的去干"是两件完全不同的事：

- **判断**需要看全局——这人有没有资格、这活跟别的活冲不冲突、话该回在哪；
- **干活**需要专注——在某个目录里改代码、跑命令、看结果。

如果让同一个模型角色既判断又干活，它一会儿要盯着全局，一会儿要埋头改文件，两边都做不好，还容易"干过头"。所以把它拆成**两个角色**：

| 角色 | 只做这些 | 绝不做 |
|---|---|---|
| **orchestrator**（主 Session） | 判断、开单、收报告、回话 | 不碰具体代码 |
| **worker**（执行器 Session） | 干活、报告 | 不判断、不直接回人 |

真实项目里，这就是 `src/app/sessions.ts` 里的两个 Session：主 Session 在代码里叫 `orchestrator`，执行器 Session 叫 `worker`，各用各的模型、各有一套工具。

---

## 解决方案

把上一章里"你自己手动调的三步"变成两个角色之间的一次**交接**：

```
 orchestrator                          worker
 ┌──────────────────┐   派工(start)   ┌──────────────────┐
 │ receive/decide   │ ─────────────→ │ 在工单目录里干活    │
 │ 判断·开单·回话     │                │ 干完 → 报告 report │
 │                  │ ←───────────── │                  │
 │ 收报告·更新工单    │   报告回来了      └──────────────────┘
 └──────────────────┘
```

关键：**worker 只通过"报告"跟 orchestrator 说话**，它不自己回人、不自己开新单。

---

## 工作原理

**第 1 步：把 `executor` 从"假端口"换成真正的执行器。** 上一章它是空的 `{ start(){} }`，现在它是 `Executor` 类，有自己的工作要做：

```ts
const executor = new Executor({
  report: (ticketId, _a, report) => engine.report(ticketId, report), // 报告交回 orchestrator
})
```

**第 2 步：执行器只做一件事——把工单交给 worker 去干。** 真实版这里会起一个 DSH 会话；我们先同步假装干完：

```ts
// framework/executor.ts
start(ticket: Ticket, assignment: Assignment): void {
  assignment.state = 'running'                 // 派工进入"执行中"
  this.host.report(ticket.id, assignment.id, { state: 'ready', summary: `已完成「${ticket.title}」` })
}
```

**第 3 步：worker 的报告写回工单。** orchestrator 收报告，更新工单状态（对应真实 `Engine.report`，`src/core/engine.ts:239`）：

```ts
// framework/engine.ts
report(ticketId, report) {
  const assignment = ticket.assignments.at(-1)!
  assignment.state = 'ended'
  assignment.report = { ...report, at: now() }   // 工单记住了"最近说了什么"
}
```

**第 4 步：打破"engine 需要 executor、executor 需要 engine"的环。** 用 `let engine` 先声明、后赋值；真实项目 `src/app/runtime.ts` 用 getter 干同一件事：

```ts
let engine: Engine
const executor = new Executor({ report: (t, a, r) => engine.report(t, r) })
engine = new Engine({ ..., executor: { start: (t, a) => executor.start(t, a) }, ... })
```

完整代码：`framework/executor.ts` + `framework/engine.ts` 的 `report`。

---

## 试一下

```sh
node framework/main.ts
```

你会看到输出被分成两段：

1. `[orchestrator]` —— 收事件、请模型研判、开单；
2. `[worker]` —— 开工、报告 `ready`。

最后工单里 `assignment.state` 变成 `ended`，`assignment.report.state` 是 `ready`——**判断和干活已经分开了，靠"报告"对接**。

---

## 接下来

现在 worker 是在"当前目录"里假装干活，没有任何隔离——两个工单会互相踩，干活的目录、要用的环境变量，都还悬空。

s03 每工单一目录 → 给每个工单一个独立目录 + 一条 `prepare` 准备命令 + 环境变量，真正把"执行"装进盒子里。
