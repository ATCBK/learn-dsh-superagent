# s06: 域事件 → notice / relay —— 状态机往外"说"，分"叫醒"和"不叫醒"

> *"该叫醒的才叫醒，该安静的塞过去。"*

---

## 问题

到现在，状态机会"记"（s01）、会"查"（s05）、会"做效果"（s04），但它**不会往外说**。真实系统里，"收到新事件""接单了""worker 干完了"这些事，得有人告诉主会话（orchestrator），否则它不知道发生了什么。

但这里有个坑：**不是每件事都值得打断**。"收到新事件"这种，塞给主会话、它下次自己看就行；"worker 报告 ready"这种，主会话得**立刻**醒过来回复对方。如果每件事都叫醒，主会话会被刷屏、浪费大量注意力——这恰恰违背了整个项目的初衷。

真实项目 `src/core/ports.ts`（DomainEvents）+ `src/app/notices.ts` + `src/app/sessions.ts` 的答案是：**状态机只发事件，投递分成两种**。

---

## 解决方案

| 投递方式 | 含义 | 什么时候用 |
|---|---|---|
| `notice`（inject） | 塞进收件箱，**不唤醒** | "收到新事件""已接单"这种 FYI |
| `relay`（steer） | 塞进收件箱，**并唤醒** | "worker 报告 ready / 有问题"这种要立刻处理的 |

状态机自己不知道这些——它只调一个 `emit` 发事件；"哪些该叫醒、哪些不该"，是**外面**翻译的时候决定的。

---

## 工作原理

**第 1 步：状态机加一个"发事件"的口子，只发不关心谁听。** 对应真实 `Engine.emit`（`src/core/engine.ts` 的 `emit` 选项）：

```ts
// 改状态的同时，往外发一个事件
this.o.emit?.({ type: 'trigger.received', triggerId: trigger.id })
this.o.emit?.({ type: 'decision.recorded', decisionId, kind })
this.o.emit?.({ type: 'report.recorded', ticketId, state })
```

**第 2 步：一个"收件箱"，区分两种投递。** `notice` 只 push，`relay` push 之外还"叫醒"：

```ts
// framework/sessions.ts
notice(text) { this.inbox.push(text); console.log(`[inject·不唤醒] ${text}`) }
relay(text)  { this.inbox.push(text); console.log(`[steer·唤醒] ${text} —— 主会话被叫起来处理`) }
```

**第 3 步：在外面把"事件"翻译成"通知或叫醒"。** 谁该唤醒，是这里拍板的，不是状态机：

```ts
emit: event => {
  if (event.type === 'trigger.received') sessions.notice('收到新事件')      // FYI，不唤醒
  else if (event.type === 'decision.recorded') sessions.notice(`已接单（${event.kind}）`)
  else if (event.type === 'report.recorded') sessions.relay(`worker 报告：${event.state}`) // 要处理，唤醒
}
```

完整代码：`framework/sessions.ts` + `framework/engine.ts` 的 `emit`。

---

## 试一下

```sh
node framework/main.ts
```

盯住三类输出：

1. `[inject·不唤醒] 收到新事件`、`[inject·不唤醒] 已接单（accept）` —— 只是塞进收件箱；
2. `[steer·唤醒] worker 报告：ready —— 主会话被叫起来处理` —— 这一步才叫醒；
3. 结尾"主会话收件箱"里躺着三样东西——不管叫没叫醒，都进了收件箱，区别只在**要不要立刻处理**。

试着把 `report.recorded` 也改成 `notice`，再看输出——主会话就不会被叫醒了。这就是"把打断人的次数压到最小"。

---

## 接下来

现在这台机器的消息来源，还是你在 `main.ts` 里手写的一条假 `Trigger`。真实系统里，事件来自**不同的渠道**——GitHub、飞书……每个渠道的事件格式、身份、读法都不一样。

s07 Source 插件 → 把"来源"抽象成插件协议：每个来源自己把外部事件翻译成统一的 Trigger，加一个新来源不改内核。
