# s07: Source 插件 —— 加一个新渠道，不改内核

> *"内核只认'事件'，不认'渠道'。"*

---

## 问题

到现在，那条 GitHub 消息还是你手写在 `main.ts` 里的常量。真实系统里，事件来自**不同的渠道**：GitHub 的 issue / PR / CI、飞书的群聊……每个渠道的消息格式、发件人身份、"什么算 @agent"都不一样。

如果内核写死"去读 GitHub"，那加一个飞书就得改内核。真实项目 `src/sources/kind.ts` 的答案是：**来源是插件**，每个来源自己把外部事件翻译成统一的 `Trigger`，内核只认 `Trigger`、不认渠道。

---

## 解决方案

把职责划清：

| 谁 | 负责什么 |
|---|---|
| **内核（Engine）** | 只认统一的 `Trigger`，判断、开单、派工 |
| **来源插件（Source）** | 读自己那个渠道，把消息翻译成 `Trigger` |
| **注册表（Registry）** | 登记有哪些来源，替内核"问"来源听不听某条事件 |

加一个新渠道 = 写一个新的来源插件 + 注册进去，内核一行不动。

---

## 工作原理

**第 1 步：定一个来源协议。** 每个来源至少要回答两件事：听不听某条事件、轮询出什么新事件：

```ts
// framework/source.ts
export interface SourceKind {
  kind: string                                            // 'github' / 'feishu' ...
  scope?(meta): { listened: boolean; reason?: string }    // 听不听
  poll?(): Trigger[]                                       // 这一轮的新事件
}
```

**第 2 步：注册表实现"引擎问、来源答"。** 内核之前是写死 `{ listened: true }`，现在改成问注册表：

```ts
class SourceRegistry {
  scope(trigger) {
    const kind = this.kinds.get(trigger.source)
    if (!kind) return { listened: false, reason: 'source_not_installed' }
    return kind.scope?.(trigger.meta) ?? { listened: true }
  }
}
```

**第 3 步：写一个假 GitHub 插件。** 它自己造出一条"有人 @agent"的事件（真实版是 `src/sources/github.ts` 去读 API）：

```ts
// framework/github.ts
export function githubSource(): SourceKind {
  let sent = false
  return {
    kind: 'github',
    scope: () => ({ listened: true }),
    poll: () => { if (sent) return []; sent = true; return [/* 一条 Trigger */] },
  }
}
```

**第 4 步：内核的 `scope` 端口，从写死改成委托。** 事件入口也从手写常量改成轮询：

```ts
registry.register(githubSource())
engine = new Engine({ ..., scope: { scope: t => registry.scope(t) }, ... })
const trigger = registry.poll()[0]!   // 事件来自插件，不再是常量
```

完整代码：`framework/source.ts` + `framework/github.ts`。

---

## 试一下

```sh
node framework/main.ts
```

开头多了一行 `== 0. 来源轮询 ==`，显示事件来自 `github` 来源插件。内核从头到尾**不知道也不关心**这是 GitHub 还是飞书——它只拿到一条 `Trigger`。

试着再写一个 `feishu.ts` 插件（换个 `kind`、换条 `text`），`registry.register` 一下——内核不用改，事件就变成飞书的了。

---

## 接下来

来源会轮询了，但有个致命问题：**进程重启后，来源会不会把已经处理过的事件再读一遍？** 如果会，就会重复开工单。

s08 读位防重放 → 让每个来源记住自己"读到哪了"，重启后接着读，不重放。
