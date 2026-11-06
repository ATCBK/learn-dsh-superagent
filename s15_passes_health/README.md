# s15: Pass 心跳 + HealthBoard —— 系统自己转，自己盯

> *"每 2 秒一次心跳，每个部件一个健康条目。"*

---

## 问题

到现在，整套系统的运转全靠你在 `main.ts` 里手动一步步调 `evaluateDue`、`dispatch`。真实系统里没人手动点——它必须**自己转起来**，并且**自己盯着自己**：哪个部件挂了，人（或看门狗）能一眼看到。

真实项目里这是两块：`src/app/passes.ts`（心跳）和 `src/infra/health.ts`（健康看板）。这就是"外部 Watchdog"的内核。

---

## 解决方案

| 部件 | 干什么 |
|---|---|
| **Pass**（心跳） | 每 2 秒跑一次：`effects.dispatch()`（跑到期效果）+ `engine.evaluateDue()`（推进评估） |
| **HealthBoard**（健康看板） | 每个部件认领一个健康条目，**单一写入者**；谁挂了写谁，别人不能乱写 |

---

## 工作原理

**第 1 步：一个 Pass 循环。** 每 2 秒调一次 `pump`：

```ts
// framework/passes.ts
export class Passes {
  start() { this.timer = setInterval(() => this.pump(), 2000) }
  run() { this.pump() }   // 手动跑一次（真实版由 setInterval 驱动）
}
```

真实版更严：一个 pass 同时只跑一个，并发 `request` 合并成一次后续 pass。

**第 2 步：健康看板，单一写入者。** `claim` 一个名字，第二次认领会报错——防止两个部件写同一个条目互相覆盖：

```ts
// framework/health.ts
claim(name, initial) {
  if (this.claimed.has(name)) throw new Error(`health entry ${name} is claimed by another part`)
  this.claimed.add(name)
  return { set: h => { this.entries[name] = h }, get: () => this.entries[name] }
}
```

**第 3 步：每个部件报自己的死活。** 运行时、worker、效果队列……各写各的：

```ts
const runtimeHealth = board.claim('runtime', { state: 'starting', detail: '' })
runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready' })
workerHealth.set({ state: 'error', detail: 'worker 挂了' })
```

完整代码：`framework/passes.ts` + `framework/health.ts`。

---

## 试一下

```sh
node framework/main.ts
```

看"Pass 心跳 + HealthBoard"那段：

1. `健康` 显示 runtime 和 worker 两个条目各自 `ready`；
2. worker 报错后，`健康(worker 挂了)` 里 worker 变 `error`——但 runtime 还是 `ready`，互不干扰；
3. `重复 claim worker` 报错——**单一写入者**。

试着把 `claim('worker')` 的重复认领那行去掉，再在别处 `claim('worker')`——就会报错，因为名字只能认领一次。

---

## 接下来

健康看板有了，但"谁来看它、谁在进程挂了之后把它拉起来"还缺最后一块。真实项目里是 `scripts/dsh-superagent`——一个**进程外的看门狗脚本**，用退出码告诉监控系统"该不该重启"。

s16 服务脚本 → 进程级看门狗：`status/start/stop` + 退出码语义 0/1/2/3。
