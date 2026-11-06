# s12: 订阅扇出 —— 后续消息自动到达，免 @agent、免评估

> *"工单订阅了它出生的对话，人接着说，它自己知道。"*

---

## 问题

上一章里，"人在对话里说一句"还得你手动调 `resume`。真实场景里不该这样：人已经在同一个 issue / 同一个群里授权过 agent 了，他接着说一句"再改一下"，agent 应该**自己**把这条消息送到那个工单，并且**自动**把工单唤回——不用人再 @ 一遍，也不用重新走"判断→接单"。

真实项目 `src/core/intake.ts` 的答案是：**工单订阅了它出生的线程，线程上的新消息自动"扇出"给所有订阅工单**。

---

## 解决方案

```
 接单时                         线程来新消息时
 工单订阅它出生的线程 ──────→ 新消息自动扇出给每个订阅工单
                              ├ 活着的工单：把消息记成 followup
                              └ 结束的工单：被人的消息自动唤回（s11 的 resume）
```

---

## 工作原理

**第 1 步：线程记下"谁订阅了我"。** 加一个 `subscriptions` 数组：

```ts
export interface Thread {
  key: string
  pending: string[]
  evaluating?: Evaluation
  subscriptions: string[]   // 订阅了这个线程的工单 id
}
```

**第 2 步：接单时，工单订阅它出生的线程：**

```ts
thread.subscriptions = [...(thread.subscriptions ?? []), ticket.id]
```

**第 3 步：新消息进来，扇出给每个订阅工单。** 活着的记 followup；结束的（执行器结束）被人的消息自动唤回：

```ts
for (const ticketId of t.subscriptions ?? []) {
  const ticket = this.repo.tickets.get(ticketId)
  if (!ticket || ticket.ended?.by === 'human') continue          // 人停过 → 不送
  ticket.followups = [...(ticket.followups ?? []), trigger.id]
  if (ticket.ended && trigger.human && this.policy().revalidate(ticket.mandate)) {
    delete ticket.ended                                            // 自动唤回，免重新评估
    ticket.assignments.push({ ... state: 'pending' })
    this.executor.start(...)                                       // 重新交给 worker
  }
}
```

完整代码：`framework/engine.ts` 的 `receive`。

---

## 试一下

```sh
node framework/main.ts
```

看"订阅扇出"那段：

1. 事件 1 走完链，工单 `ended by executor`、派工数 1；
2. 事件 2（`@agent 再补一段测试`）`receive` 后：工单 `ended: undefined`（自动复活了）、`派工数: 2`、`followups: 1`——**没有重新评估、没有重新接单**，消息自己流到了工单。

对比：下一段"人停撤销授权"里，`stop` 之后再 `resume`，ended 还是 `stopped`——**扇出会跳过人停过的工单**。

---

## 接下来

现在"判断该不该接"还是写死的一行 `gate`（"人 + @了 agent 就接"）。真实系统里，准入规则复杂得多：白名单、@ 不 @、@ 了是不是明确要求、推断性工作要不要在 auto 模式才接。

s13 Gate + Assessment → 把准入（确定性规则）和研判（模型判断）拆成两段。
