# s09: Outbox + 回执 —— 把"回话"做成可靠的

> *"同一条消息只发一次；能发才发，会话没了就放弃。"*

---

## 问题

现在"回话"还是 `console.log` 一下假渠道。真实系统里，往 GitHub / 飞书上发消息，会遇到一堆坑：

- 同一条消息**发了两遍**（重试导致的重复）；
- 来源**暂时关了**，发不出去，但也不能丢；
- 会话**已经被删了**（issue 删了、群解散了），这条消息永远发不出去了，还一直重试；
- 同一个工单往同一个会话，要**按顺序**发（先"收到"，再"结果"），不能乱。

真实项目 `src/app/outbox.ts` 的答案是：**每条要发的消息，先记一张"回执"**，投递、排序、放弃都围着回执做。

---

## 解决方案

一条消息的一生，只有三种状态：

| 状态 | 含义 | 何时变成 |
|---|---|---|
| `pending` | 记了回执，还没发出去 | `send` 时 |
| `sent` | 发出去了 | 投递成功 |
| `dropped` | 放弃（会话没了） | 会话再也收不到时 |

回执由消息 id 唯一确定——**同一个 id 只记一次，也就只投递一次**。

---

## 工作原理

**第 1 步：`send` 先记回执、再入队。** 同 id 重复调用，第二次直接返回，绝不发两遍：

```ts
// framework/outbox.ts
send(message) {
  if (this.receipts.has(message.id)) return          // 幂等：同 id 只发一次
  this.receipts.set(message.id, { ...message, status: 'pending' })
  this.host.effects.enqueue('reply', message.id, {})  // 投递进效果队列（s04）
}
```

**第 2 步：投递时先问"渠道还能不能收"。** 三种答案，三种处理：

```ts
deliver(id) {
  const receipt = this.receipts.get(id)
  if (receipt.status !== 'pending') return
  const result = this.host.channelAvailable(receipt.channel)   // 'sent' | 'gone' | 'waiting'
  if (result === 'waiting') throw new Error('Source is off')   // 真实版是 Later：稍后重试
  receipt.status = result === 'gone' ? 'dropped' : 'sent'       // 会话没了 → 放弃
}
```

**第 3 步：看回执状态。** `pending → sent`，或者 `pending → dropped`，任何时候都能查：

```ts
status(id): ReplyStatus | undefined { return this.receipts.get(id)?.status }
```

完整代码：`framework/outbox.ts`。

> 真实版更狠：回执持久化在 SQLite（s10）、同一 Ticket 往同一会话**保序**（后面的消息会等前面那条，除非前面失败太多次）、来源关了走 `Later` 稍后重试（不算失败）。这里先抓住"回执 + 三种结局"。

---

## 试一下

```sh
node framework/main.ts
```

看"回复原对话"那段：

1. 第一条发到 `issue-1`：回执 `投递前 pending` → `投递后 sent`；
2. 第二条发到 `issue-deleted`：回执变成 `dropped`（会话没了，放弃，不无限重试）。

试着把同一条消息 `send` 两次，再看回执——第二次不会多发。这就是"同一条消息只发一次"。

---

## 接下来

现在所有状态还装在**内存的 Map** 里——进程一退出，工单、读位、回执全没了。这就是"存算分离"里"存"还没落地。

s10 SQLite 持久化 → 把状态搬进 SQLite 文件，用 SAVEPOINT 做可嵌套事务；状态成了唯一真相，进程崩了、重启了，状态都在。
