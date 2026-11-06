# s11: Mandate 不可变授权 + 恢复 —— 结束 ≠ 撤销

> *"工单可以结束，授权不随之作废。"*

---

## 问题

工单干完了（worker 报告 `ready`），它就该结束。但这里有个关键区分：

- **工单结束**：这一份活干完了；
- **授权撤销**：这个人以后不能再凭这个授权让我干活。

两者不是一回事。真实场景：人让 agent 修个 bug，agent 修完、发了 PR，工单结束了。过两天人又在同一个 PR 下说"再改一下"。这时应该**直接用原来的授权把工单唤回来**，而不是重新走一遍"判断→接单"——人已经明确授权过了。

真实项目 `src/core/tickets.ts` 的规则是：**工单结束不撤销授权；只有人的 `stop` 或策略变更才撤销；恢复免重新评估。**

---

## 解决方案

一张不可变授权（Mandate，s01 就签了）跟着工单走；工单可以结束、可以复活，但授权要么一直在、要么被明确撤销：

```
 工单生命周期：
   接单(签 Mandate) → 执行 → report ready → 结束(ended)
                                    ↑ 人的消息 → resume（原授权唤回，免评估）
                                    ✗ 人的 stop → 撤销，永不再复活
```

---

## 工作原理

**第 1 步：给工单加一个 `ended` 字段。** 谁结束的、什么结局：

```ts
ended?: { at: string; by: 'executor' | 'human'; outcome: string }
```

**第 2 步：worker 报 `ready` / `dropped`，工单结束（执行器结束）。** 授权不动：

```ts
if (report.state === 'ready') ticket.ended = { at: now(), by: 'executor', outcome: 'completed' }
if (report.state === 'dropped') ticket.ended = { at: now(), by: 'executor', outcome: 'dropped' }
```

**第 3 步：人的 `stop` 才撤销授权。** 结束且不可复活：

```ts
stop(ticketId) { if (!ticket.ended) ticket.ended = { at: now(), by: 'human', outcome: 'stopped' } }
```

**第 4 步：`resume` 用原授权唤回。** 只有"执行器结束、且授权仍有效"的能复活；人停过的不能：

```ts
resume(ticketId) {
  if (!ticket.ended || ticket.ended.by === 'human') return ticket      // 人停过 → 不可复活
  if (!this.policy().revalidate(ticket.mandate)) return ticket          // 授权已失效 → 不可复活
  delete ticket.ended                                                  // 复活
  ticket.assignments.push({ ... state: 'pending' })                    // 新派工
  this.executor.start(...)                                             // 重新交给 worker
}
```

**第 5 步：`revalidate` 是策略的事。** 授权是否仍成立（人还在白名单吗、规则还开着吗），由 Policy 回答，内核只问不判（s14 展开）。

完整代码：`framework/engine.ts`。

---

## 试一下

```sh
node framework/main.ts
```

看"结束 ≠ 撤销授权"那段：

1. `ended: {"by":"executor","outcome":"completed"}` —— worker 报 ready，工单结束了；
2. `resume 后 ended: undefined，派工数: 2` —— 原授权唤回，**没重新评估**，直接多了一次派工；
3. `人停后再 resume，ended 仍是 {"by":"human","outcome":"stopped"}` —— 人停过，授权撤销，再也唤不回来。

把 `resume` 里的 `revalidate` 检查换成 `return false` 再看——即便人没停，授权失效也不能复活。这就是"授权独立于工单生命周期"。

---

## 接下来

现在"人在对话里说一句"还是你手动调 `resume`。真实系统里，这条消息应该**自动**流到那个工单——因为工单"订阅"了那个对话。

s12 订阅扇出 → 一条消息自动到达所有订阅它的工单，无需再 @agent。
