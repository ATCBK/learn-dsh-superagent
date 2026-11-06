# s03: 每工单一目录 —— 把"执行"装进盒子里

> *"一个工单一个盒子，谁也别踩谁。"*

---

## 问题

上一章的 worker 是在"当前目录"里假装干活。如果同时来两个工单，它们会写同一堆文件、用同一套变量，互相踩踏。更糟的是，干活时往往要先做点准备——`git clone` 一个仓库、装个依赖——这些准备一旦失败，你怎么知道该重来、还是该报错？

真实项目里，每个工单有自己的一块地方，开工前还要先跑一条"准备命令"。这就是 `src/executor/dsh.ts` 里 `DshExecutor` 干的事：**一个工单 = 一个 Session + 一个目录**。

---

## 解决方案

给 worker 一块独立的地方，进去之前先"准备"，再把环境变量带进去：

```
 开工
  │  1. 算出这个工单的目录名（短名 + 工单 id 前 8 位，同名稳定、互不覆盖）
  │  2. 建目录
  │  3. 若有 prepare 命令，在目录里跑（带环境变量）
  │  4. worker 在目录里干活（写文件 / 改代码）
  │  5. 报告结果，附上产物路径
  ▼
```

两个工单的目录名不一样，就永远不会互相踩。

---

## 工作原理

**第 1 步：目录名由工单派生，稳定且唯一。** 用"标题短名 + 工单 id 前 8 位"，重来一次还是同一个目录（真实版 `src/executor/dsh.ts` 的 `ticketWorktreeName`）：

```ts
private directoryFor(ticket: Ticket): string {
  const name = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')   // 标题 → 安全短名
  return join(this.workRoot, `${name}-${ticket.id.slice(0, 8)}`)         // + 工单 id 前 8 位
}
```

**第 2 步：开工先建目录、再跑 prepare。** `mkdirSync` 建目录；`prepare` 命令在目录里、带上环境变量跑（真实版 `DshExecutor.prepareDirectory`，`src/executor/dsh.ts:247`）：

```ts
start(ticket: Ticket, assignment: Assignment): void {
  const dir = this.directoryFor(ticket)
  ticket.execution = { directory: dir }                     // 目录记到工单上
  mkdirSync(dir, { recursive: true })
  if (this.prepare) execSync(this.prepare, { cwd: dir, env: { ...process.env, ...this.env } })
  // ... worker 在 dir 里干活
}
```

**第 3 步：worker 在独立目录里产出东西。** 这里用一个写文件假装"干活"，你能直接去目录里看到产物：

```ts
writeFileSync(join(dir, 'result.md'), `# ${ticket.title}\n在独立目录 ${dir} 完成了工作。环境变量：${envLine}`)
this.host.report(ticket.id, assignment.id, { state: 'ready', summary: `产物在 ${dir}` })
```

**第 4 步：环境变量是配置进来的，不是 worker 自己乱读的。** 真实版里这些变量由 Executor 和各个 Source 各自注册（`src/app/execution-environment.ts`），这里先硬传一个：

```ts
new Executor(host, { workRoot: join(import.meta.dirname, 'work'), env: { REPO: 'dsh-superagent' } })
```

完整代码：`framework/executor.ts`。

---

## 试一下

```sh
node framework/main.ts
```

然后去看 `framework/work/readme-xxxxxxxx/` 目录——里面有个 `result.md`，写着"在独立目录 … 完成了工作，环境变量 REPO=dsh-superagent"。再跑第二次，还是同一个目录（目录名稳定），这就是"一个工单一个盒子"。

---

## 接下来

现在的问题是：**worker 报告、回话、起评估，全都是"立刻同步"发生的**。真实系统里，这些是"副作用"——改完状态之后才该做的、还得保证崩溃不丢不重的事。

s04 事务 + 效果队列 → 把"改状态"和"做效果"拆开：命令先在一个事务里改完状态，副作用踢进一条队列，提交之后才真正跑。
