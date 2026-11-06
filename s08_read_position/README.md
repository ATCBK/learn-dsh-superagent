# s08: 读位防重放 —— 重启后接着读，不重放

> *"来源记住自己读到哪，重启不回头。"*

---

## 问题

来源会轮询了，但有个致命问题：**进程重启后，来源会不会把已经处理过的事件再读一遍？**

GitHub 的接口是"给我最近的通知"，它不管你上次读到哪。如果 agent 重启后从头再读一遍，就会把同一批消息再开工单——重复干活、重复回话。

真实项目 `src/sources/poll.ts` 的答案是：**每个来源记一个"读位"（cursor）**，重启后从读位接着读。

---

## 解决方案

来源每次轮询，只读"读位之后"的新事件，读完把读位前移；读位存在持久化存储里，进程重启也不丢：

```
 第 1 次轮询          第 2 次轮询（模拟重启）
 读位=0                读位=1
   │ 读第 0 条            │ 读第 1 条（不是第 0 条！）
   │ 读位 → 1             │ 读位 → 2
   ▼                     ▼
 [事件1]               [事件2]
```

---

## 工作原理

**第 1 步：给来源一个"持久化状态"的口子。** 读位存在这，不存进程内存（真实版是 SQLite 的 kv 表，s10 会换过去）：

```ts
// framework/source.ts
export interface SourceState { get(key): string | undefined; set(key, value): void }
readonly state = new Map<string, string>()   // 模拟 kv 表
```

**第 2 步：来源靠读位决定"这次读什么"。** 每次最多读下一条，读完读位 +1：

```ts
// framework/github.ts
poll: state => {
  const cursor = Number(state.get('github-cursor') ?? '0')      // 上次读到第几条
  const fresh = events.slice(cursor, cursor + 1)                 // 只读下一条
  if (fresh.length) state.set('github-cursor', String(cursor + 1)) // 前移
  return fresh.map(/* → Trigger */)
}
```

**第 3 步：轮询时把 state 传进去。** 注册表替来源拿着这个 state：

```ts
poll() {
  const state = { get: k => this.state.get(k), set: (k, v) => this.state.set(k, v) }
  return [...this.kinds.values()].flatMap(kind => kind.poll?.(state) ?? [])
}
```

完整代码：`framework/source.ts` + `framework/github.ts`。

> 真实版更细：cursor 会**回拨 5 秒**（防止"刚好卡在读位上的迟到事件"被漏掉），并且靠"内容派生的 id"（s05）去重——即使有重叠，同 id 也只处理一次。

---

## 试一下

```sh
node framework/main.ts
```

看结尾"读位防重放"：

1. 处理完事件 1 后，`数据库里的读位` 是 `[["github-cursor","1"]]`；
2. `再轮询（模拟重启后接着读）` 拿到的是 `@agent 再补一段测试`（第 2 条），**不是**第 1 条；
3. 读位前移到 `"2"`。

试着把 `state.set(...)` 那行删掉再跑——每次轮询都会重放第 1 条。这就是读位存在的意义。

---

## 接下来

现在能"收"了，但"回话"还是 `console.log` 一下假渠道。真实系统里，回复要**可靠**：同一条消息不能发两遍、来源关了要等一等、会话删了要放弃、同一个工单往同一个会话发要**保序**。

s09 Outbox + 回执 → 给每条要发的消息记一张"回执"，把多信道投递做成可靠的。
