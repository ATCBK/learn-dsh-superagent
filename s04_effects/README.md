# s04: 事务 + 效果队列 —— 先改状态，后做效果

> *"状态先落定，效果再动手。"*

---

## 问题

到现在，worker 报告、模型研判、回话，全都是**改状态的同时立刻发生**的。这在"玩具"里没事，在真实系统里会出大问题：

- 你在 `decide` 里改状态改到一半，进程崩了。状态可能"建了工单但没派工"，或者"派工了但工单没存上"；
- 副作用（起 worker、发消息）如果跟着状态**一起**发生，就会"状态说没做、消息却已经发出去了"——人收到两条一样的回复，agent 起了两个一样的会话。

真实项目 `src/app/effects.ts` 的答案是：**把"改状态"和"做效果"彻底拆开**。

| 动作 | 属于 | 何时 | 特点 |
|---|---|---|---|
| 改状态（存事件 / 建工单 / 记报告） | 事务内 | 同步 | 可回滚，崩了当没发生 |
| 做效果（起 worker / 发消息 / 请模型） | 效果队列 | 提交后 | 可重放，崩了接着做 |

---

## 解决方案

一个命令 = 在一个事务里改完所有状态 + **只把"要做的事"记进队列**。事务提交后，队列才真正去跑：

```
 decide（事务内）                     事务提交后
 ┌─────────────────────────┐        ┌──────────────┐
 │ 建工单 + 签授权（改状态）   │        │ dispatch()   │
 │ 记下一个 launch 效果（入队）│ ─────→ │ 真的去起 worker│
 └─────────────────────────┘        └──────────────┘
```

改状态和记效果**写在同一笔事务里**，要么都成、要么都回滚；而真正跑效果，永远在提交之后。

---

## 工作原理

**第 1 步：一个"只记不跑"的队列。** 每种效果一个 key，同 key 只留一行（去重）；`dispatch` 按入队顺序跑一遍：

```ts
// framework/effects.ts
enqueue(kind, key, payload) { this.rows.set(`${kind}:${key}`, { kind, key, payload, seq: ++this.seq }) }
dispatch() { for (const row of [...this.rows.values()].sort((a,b)=>a.seq-b.seq)) { /* 取出并跑对应 handler */ } }
```

**第 2 步：把副作用从"直接调"改成"入队"。** 看执行器的 `start`——它不再干活，只记下"要启动"（对应真实 `DshExecutor.start` → enqueue launch 效果）：

```ts
// framework/executor.ts
start(ticket, assignment) {
  this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
}
launch(ticket, assignment) { /* 建目录、干活、报告——真正的副作用 */ }
```

**第 3 步：真正干活，在提交后由队列触发。** 注册一个 `launch` 处理器，`dispatch` 时才调用 `executor.launch`：

```ts
effects.handle('launch', p => { const t = engine.ticket(p.ticketId)!; executor.launch(t, t.assignments[0]!) })
```

**第 4 步：看分离的证明。** `decide` 之后、`dispatch` 之前，`effects.pending()` 是 1（launch 已入队），但 worker **还没开工**；`dispatch()` 之后 worker 才真的起来。

完整代码：`framework/effects.ts` + `framework/executor.ts` + `framework/main.ts`。

> 真实版的 `Effects` 更强：它是 SQLite 持久化的（崩了能重放）、失败指数退避、按种类控制并发、还有 `Later` 语义（"暂时没空"不算失败）。这些 s10（SQLite）和 s15（健康）会展开，这里先抓住"分离"这件事。

---

## 试一下

```sh
node framework/main.ts
```

盯住两行输出：

1. `接单` 之后、`dispatch` 之前，`排队中的效果数: 1`，且没有 `[worker] 开工` —— **状态改了，副作用还没发生**；
2. `dispatch` 之后，`[worker] 开工` 才出现 —— **效果在提交后才跑**。

试着在 `decide` 之后不调 `dispatch` 就结束程序——工单已经建好了，但 worker 永远没被叫起来。这就是"状态和效果分离"最直观的样子。

---

## 接下来

队列解决了"什么时候做"，但还没解决"同一件事会不会做两次"。现在如果同一条消息来了两次，`receive` 靠 id 去重；但"这条消息后来去了哪、被谁接手、被谁退回"——这些**去向**现在完全没有记录。

s05 幂等 + Disposition → 给每条事件记一本"去向账"，让系统随时能回答"这件事到底处理过没有、处理到哪了"。
