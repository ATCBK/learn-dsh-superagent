# s14: Policy 版本化 —— 规则变了，不误杀、不静默

> *"策略每变一次，就有一个新版本号；谁受影响，算得出来。"*

---

## 问题

策略不是写死的——人会加人、踢人、开关规则。策略一变，麻烦来了：

- **正在跑的工单怎么办**？直接作废？那会留下半截活（误杀）；
- **悄悄不管**？那工单还按旧授权继续干（静默），可能干出不该干的事。

真实项目 `src/policy.ts` 的答案是：**策略有个版本号，每个工单的授权都记着"它是在哪个版本下签的"；策略变了，能精确算出哪些在跑工单受影响。**

---

## 解决方案

```
 策略(settings) ──哈希──→ 版本号(version)
                              │ 每个 Mandate 都记着自己出生时的版本
 策略变了 → 新版本号 → policyEffects 算出：
            "旧版本下授权成立、新版本下不成立的工单" → 通知它们
```

不误杀（工单还在，只是被通知"规则变了，收着点"），不静默（被影响的工单一定知道）。

---

## 工作原理

**第 1 步：版本号 = 授权相关设置的哈希。** 只有"影响授权"的设置才算进版本（改模型、改并发不算）：

```ts
export function policyVersion(settings) {
  return key('policy', JSON.stringify({ allowed: settings.allowed, mode: settings.mode, rules: settings.rules }))
}
```

**第 2 步：每个工单的 Mandate 都带着版本号**（s01 就记了 `policyVersion`）。所以能知道"它是旧规则下签的"。

**第 3 步：策略变了，算谁受影响。** 旧策略下授权成立、新策略下不成立 → 受影响：

```ts
export function policyEffects(tickets, oldSettings, newSettings) {
  const oldPolicy = settingsPolicy(oldSettings), newPolicy = settingsPolicy(newSettings)
  for (const ticket of tickets) {
    if (oldPolicy.revalidate(ticket.mandate) && !newPolicy.revalidate(ticket.mandate)) {
      effects.set(ticket.id, { reason: '授权不再成立' })
    }
  }
}
```

**第 4 步：revalidate 是裁决者。** 它判断一张授权在当前策略下还成不成立（s11 就靠它决定能不能复活）。

完整代码：`framework/policy.ts`。

---

## 试一下

```sh
node framework/main.ts
```

看"Policy 版本化"那段：

1. `旧策略版本` 和 `新策略版本` 两个不同的哈希（因为把 alice 移出了名单）；
2. `受影响的在跑工单` 列出了那个工单 id；
3. `旧策略下 revalidate: true` → `新策略下 revalidate: false`。

这就是"策略一变，谁受影响、授权还成不成立，全算得清"。

---

## 接下来

现在整套系统的运转，全靠你在 `main.ts` 里手动一步步调 `evaluateDue`、`dispatch`。真实系统里，这些由一个**每 2 秒跑一次的循环（Pass）**自动驱动，并且每个部件在**健康看板（HealthBoard）**上报自己的死活。

s15 Pass 心跳 + HealthBoard → 让系统自己转起来，自己盯着自己。
