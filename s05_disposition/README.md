# s05: 幂等 + 去向账 —— 每条事件都能查到"走到哪了"

> *"同一件事只做一次，而且随时能说出它做到哪了。"*

---

## 问题

s01 里我们用"内容派生的 id"解决了"同一条消息处理两次"——相同内容算出相同 id，第二次进来直接 `duplicate`。

但"不重复处理"只回答了一半问题。另一半是：**这条消息后来到底去了哪？** 它被来源过滤掉了吗？进了哪个评估？被哪个决定处理了？现在这些全是黑箱。系统跑起来之后，如果有人问你"这条 issue 上的消息处理过没有、到哪一步了"，你答不上来。

真实项目 `src/core/model.ts` 里的 `TriggerDisposition`（去向账）就是为这个而设的：**每条事件跟着一本账，走到哪记到哪**。

---

## 解决方案

给每条事件一本"去向账"，随状态写进同一个事务里。它走到哪一步，账上就多一笔：

| 事件的状态 | 去向账记什么 |
|---|---|
| 被来源过滤掉 | `filtered: { reason }` |
| 排队等判断 | 只有个 `at`（记下时间） |
| 被某个评估接管 | `evalId` |
| 被某个决定处理 | `decisionId` |

因为账和状态写进**同一个事务**，所以永远对得上——不会出现"工单建了、账上却没有"这种对不上的情况。

---

## 工作原理

**第 1 步：幂等 id 是地基。** 同输入必同 id（s01 已写）：

```ts
const key = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
```

**第 2 步：加一本账，纳入事务回滚。** 账和触发器、线程、工单一样，是仓储的一部分，出错一起回滚：

```ts
readonly dispositions = new Map<string, TriggerDisposition>()
atomic<T>(work) {
  const maps = [this.triggers, this.threads, this.decisions, this.tickets, this.dispositions]  // 账也在里面
  // 快照 → 回滚
}
```

**第 3 步：每走一步，写一笔。** 过滤时记原因；评估时记 `evalId`；接单时记 `decisionId`：

```ts
// receive：被过滤 → 记原因
this.o.repo.dispositions.set(trigger.id, { id: trigger.id, filtered: { reason: scope.reason ?? 'not_listened' }, at: now() })

// evaluateDue：起评估 → 记 evalId
disp.evalId = evaluation.id

// decide：接单 → 记 decisionId
disp.decisionId = decision.id
```

**第 4 步：随时能查。** 给 Engine 加一个 `disposition(id)`，任何环节都能问"这条消息走到哪了"：

```ts
disposition(id: string): TriggerDisposition | undefined { return this.o.repo.dispositions.get(id) }
```

完整代码：`framework/engine.ts`。

---

## 试一下

```sh
node framework/main.ts
```

盯住三行 `去向账`：

1. `receive` 后：`{"at":...}` —— 存下了，还在排队；
2. `评估后`：多了 `"evalId":...` —— 被某个评估接管了；
3. `接单后`：多了 `"decisionId":...` —— 被某个决定处理了。

这就是"一条事件的一生"。真实版记得更细（扇出给了哪些工单、被谁退回、被谁接手），但道理一样：**账随状态走，永远查得到**。

---

## 接下来

现在状态机会"记"、会"查"，但它**不会"说"**——评估结果、worker 报告这些事发生之后，没人把它们**通知**给该知道的人。而且"通知"分两种：一种是"必须叫醒人/主会话"，一种是"塞过去就行、别打扰"。

s06 域事件 → notice / relay → 让状态机往外发事件，并区分"唤醒"和"不唤醒"两种投递。
