# s10: SQLite 持久化 + 嵌套事务 —— 状态是唯一真相，会话可弃

> *"存的是真相，算的是可丢弃的。"*

---

## 问题

到现在，所有状态——工单、授权、读位、回执——都装在**内存的 Map** 里。进程一退出，全没了。而且"改状态"要能回滚：改到一半出错了，不能留半截。

真实项目 `src/app/store.ts` 的答案是：**状态搬进 SQLite 文件**。这是整个"存算分离"支柱的落点——

| 半边 | 装在哪 | 崩了/重启了怎么办 |
|---|---|---|
| **存**（工单/授权/读位/回执） | SQLite 文件 | 还在，读回来继续 |
| **算**（worker 会话 / 目录里的活） | 内存 / DSH 会话 | 丢弃重建，**从"存"里恢复** |

记住这句：**SQLite 里的是唯一真相，会话（算的那半边）是可丢弃的执行体**。工单定义了它自己的状态，不跟着会话走（s11 展开）。

---

## 解决方案

把"存储"抽成一个接口，内核只认方法、不认存哪；然后给它一个 SQLite 的实现：

```
 内核（Engine）                   存储
 ┌──────────────┐   atomic()      ┌──────────────────────┐
 │ 只调 repo.*   │ ─────────────→ │ Repositories 接口     │
 │ 不关心存哪     │                │  ├ 内存版 MemoryRepos │
 └──────────────┘                │  └ SQLite 版 Store    │
                                  └──────────────────────┘
```

---

## 工作原理

**第 1 步：抽一个仓储接口。** 内核只认这组方法（对应真实 `src/core/ports.ts` 的 `Repositories`）：

```ts
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: { has; get; set }
  dispositions: { get; set }
  threads: { get; set; list }
  decisions: { set }
  tickets: { get; set }
}
```

**第 2 步：`atomic` 用 SAVEPOINT 做可嵌套事务。** 出错只回滚到本层（对应真实 `src/app/store.ts` 的 `atomic`）：

```ts
atomic<T>(work: () => T): T {
  const name = `sp_${this.depth++}`
  this.db.exec(`SAVEPOINT ${name}`)
  try { const v = work(); this.db.exec(`RELEASE ${name}`); this.depth--; return v }
  catch (e) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); this.depth--; throw e }
}
```

**第 3 步：每个方法就是一条 SQL。** 存进去的是整条 JSON，读出来再 `JSON.parse`：

```ts
set: (id, value) => this.db.prepare('INSERT INTO trigger(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
get: (id) => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined }
```

**第 4 步：键值表 `kv` 也进 SQLite。** 读位（s08）从内存 Map 换成 `kv` 表，重启才真不丢：

```ts
readonly kv = {
  get: key => { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return r?.value },
  set: (key, value) => this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value),
}
```

**第 5 步：换上去。** 内核一行不改，只把 `new MemoryRepositories()` 换成 `new Store(path)`——这就是接口的价值。

完整代码：`framework/store.ts`。

---

## 试一下

```sh
node framework/main.ts
```

看最后两段：

1. `读位防重放` 里，读位现在写在 SQLite 的 `kv` 表（不是内存 Map 了）；
2. `持久化（重启不丢）`：`store.close()`（模拟退出）→ `new Store(dbPath)`（模拟重启）→ **读位还是 `2`、工单还在**。

去 `framework/` 下能看到 `state.sqlite` 文件——状态真的在磁盘上了。

---

## 接下来

状态能存、能重启恢复了，但还缺一环：**工单"结束"之后，如果人又在对话里说了一句，它能不能用原来的授权"复活"？** 授权（Mandate）现在还只是个标签，没有"结束≠撤销、恢复免重新评估"的语义。

s11 Mandate 不可变授权 + 恢复 → 让工单状态自决：结束不等于授权作废，人的一句话能在原授权下把它唤回来。
