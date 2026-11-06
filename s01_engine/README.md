# s01: 一条消息 → 一张工单

> *"先记下来，再判断，最后开单。"*

---

## 问题

你想让一个 agent 帮你盯着 GitHub 仓库。有一天 Alice 在一个 issue 里 @ 了它："帮我修个 bug"。你希望它怎么做？

不是回一句"好的"就完事，而是三步：

1. **记下来** —— 这条消息先存档，同一条消息绝不能处理两次；
2. **判断** —— Alice 有没有资格让我干活？这是明确要求，还是随口一提？
3. **开单** —— 开一张"工单"，把"谁允许我干、干多深"写清楚，再交给干活的人。

为什么不能直接让模型看消息、然后干活？因为**模型不会自己记状态**——它今天看了，明天重启就忘了；**也不会自己守规矩**——你喂给它任何消息，它都可能去干活，哪怕是没资格的人。所以你需要一个"模型之外的东西"来记、来判断、来开单。这一章写的就是这个东西。

---

## 解决方案

先看"消息进来"这一步，只有三种结果：

| 信号 | 含义 | 动作 |
|---|---|---|
| 这条消息的 id 已经存过 | 同一条消息又送来了 | 返回 `duplicate`，什么都不做 |
| 这个来源不听这条消息 | 不是发给 agent 的 | 返回 `filtered`，不排队 |
| 新的、来源听的 | 值得看一眼 | 存下来，排进"等着判断"的队 |

再看"判断"这一步，结果决定"强度"：

| 信号 | 含义 | 强度 |
|---|---|---|
| 人 @ 了 agent | 明确要求干活 | `explicit`（明确） |
| 人没 @，只是泛泛说 | 可能是在暗示 | `inferred`（推断） |
| 不是人（bot / CI） | 不能发起干活 | 不接 |

最后"开单"：一张工单里同时写下三样东西——**授权**（谁允许干、干多深）、**标题**、**第一个派工**（交给谁干）。

---

## 工作原理

分步把它翻译成代码。

**第 1 步：给每条消息一个"算出来"的 id。** 相同的内容，永远算出相同的 id，这样同一条消息就不会被处理两次：

```ts
import { createHash } from 'node:crypto'
const key = (...values: string[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
```

**第 2 步：消息进来，先看存过没有。** 存过了 → `duplicate`；来源不听的 → `filtered`；否则存下来、排进队里：

```ts
receive(trigger): 'stored' | 'duplicate' | 'filtered' {
  if (triggers.has(trigger.id)) return 'duplicate'   // 处理过，跳过
  triggers.set(trigger.id, trigger)                   // 先记下来
  if (!scope.listened) return 'filtered'              // 不是发给我们的
  thread.pending.push(trigger.id)                     // 排队等判断
  return 'stored'
}
```

**第 3 步：判断"这人能不能让我干活"。** 只查规则，**不叫模型**：

```ts
evaluateDue() {
  for (const thread of threads) {
    if (thread.evaluating || !thread.pending.length) continue
    const gate = policy.gate(trigger)                  // 查规则：人 + @了 → explicit
    if (!gate.admissible) { thread.pending.shift(); continue }
    thread.evaluating = { triggerId, strength: gate.strength }
    assessor.request(...)                              // 这一步才轮到模型
  }
}
```

**第 4 步：接单，开一张工单。** 授权、标题、第一个派工，一口气写完：

```ts
decide(triggerId, { title, scope }) {
  const mandate = { strength: evaluation.strength, scope, actor }     // 授权
  const ticket = { id: key('ticket', ...), title, mandate,
    assignments: [{ id: key('assignment', ...), state: 'pending' }] } // 工单 + 派工
  tickets.set(ticket.id, ticket)
  executor.start(ticket, ticket.assignments[0])                       // 交给干活的人
  return decision
}
```

**组装：** 完整代码在 [`framework/engine.ts`](../framework/engine.ts)，入口 [`framework/main.ts`](../framework/main.ts)。真实项目里的对应位置：`src/core/ids.ts`（算 id）、`src/core/intake.ts`（第 2 步）、`src/core/evals.ts`（第 3 步）、`src/core/tickets.ts`（第 4 步）。

---

## 试一下

```sh
node framework/main.ts
```

你会看到：

1. 第一次 `receive` 输出 `stored`，第二次输出 `duplicate` —— **同一条消息只处理一次**。
2. `evaluateDue` 之后，评估的强度是 `explicit`（因为"人 + @ 了 agent"）。
3. `decide` 之后，工单里 `mandate.strength: "explicit"`、`assignments[0].state: "pending"`。

试试改 `framework/main.ts` 里的 `policy.gate`，让"没 @ agent 的人"返回 `admissible: false`，再看 `evaluateDue` 是不是就不起评估了。

---

## 接下来

现在它只会"开单"，还不会"干活"，也不会"回话"。而且判断和开单、干活，现在全挤在你自己手动调用的几步里。

s02 双层架构 → 把它拆成两个角色：一个专门判断、开单、回话，另一个专门干活。
