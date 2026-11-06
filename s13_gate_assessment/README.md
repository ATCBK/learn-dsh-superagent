# s13: Gate + Assessment —— 准入靠规则，研判靠模型

> *"谁能发起是规则定的，该不该做是模型判的。"*

---

## 问题

"要不要接这个活"，其实是两件完全不同的事：

1. **谁有资格发起**？这人是不是团队允许的人？这必须**确定性**——不能靠模型，因为模型会"心软"，今天放一个不该放的人进来。
2. **这条消息是不是真的在求干活、干多深**？这需要理解语义，**必须靠模型**——写死规则判断不了"帮我改个错别字"和"帮我重新设计首页"的区别。

真实项目 `src/policy.ts` 把这两件事拆成两段：**Gate（准入，确定性）** 和 **Assessment（研判，模型）**。

---

## 解决方案

| 阶段 | 谁 | 干什么 | 产出 |
|---|---|---|---|
| **Gate** | 规则（不叫模型） | 查名单、查有没有 @，判"能不能发起" | 强度：`explicit` / `inferred` / 不接 |
| **Assessment** | 模型 | 读内容，判"是不是真要干活、干多深" | accept / ignore + 标题 + 范围 |

关键：**授权边界是规则定的，内容判断才是模型的**。推断性工作（`inferred`）只在 `auto` 模式 + 命中启用规则时才真接。

---

## 工作原理

**第 1 步：Gate 是纯规则。** 名单内 + @了 → `explicit`；@了但不在名单 → `inferred`；不是人 → 不接：

```ts
// framework/policy.ts
gate(trigger) {
  if (!trigger.human) return { admissible: false, strength: 'inferred', reason: 'not_human' }
  if (listed(trigger.actor) && trigger.addressed) return { admissible: true, strength: 'explicit' }
  if (trigger.addressed && settings.mode !== 'off') return { admissible: true, strength: 'inferred' }
  return { admissible: false, strength: 'inferred', reason: 'not_a_member' }
}
```

**第 2 步：Assessment 是（假）模型。** 读内容，判断是不是真要求 + 推断性工作在非 auto 模式只记录不接：

```ts
export function assess(trigger, strength, settings) {
  const wantsWork = /修复|补|改|跑通/.test(trigger.text)
  if (!wantsWork) return { kind: 'ignore', ... }
  if (strength === 'inferred' && settings.mode !== 'auto') return { kind: 'ignore', ... }
  return { kind: 'accept', title: '修复 README 示例', scope: 'repo', ... }
}
```

**第 3 步：两段接起来。** 先 Gate 给强度，再把强度和内容一起交给模型研判，accept 才 `decide`：

```ts
const gate = policy.gate(t)
const outcome = assess(t, gate.strength, settings)   // 模型只拿到"强度 + 内容"
if (outcome.kind === 'accept') engine.decide(t.id, outcome)
```

完整代码：`framework/policy.ts`。

---

## 试一下

```sh
node framework/main.ts
```

看两处：

1. 事件 1：`[gate] 准入强度: explicit` → `[模型研判] accept` → 接单；
2. "Gate 演示"：`alice @agent → explicit`（在名单）、`bob @agent → inferred`（不在名单）。

把 `settings.mode` 改成 `'observe'` 再跑——bob 的推断性工作会被模型判成 `ignore`（"非 auto 模式只记录不接"）。这就是"授权边界不靠模型"。

---

## 接下来

策略现在是个写死的 `settings` 常量。真实系统里，人会**改策略**：加人、踢人、开关规则。策略一变，正在跑的工单怎么办？

s14 Policy 版本化 → 给策略算个版本号，规则变了能算出"哪些在跑工单受影响"，不误杀、不静默。
