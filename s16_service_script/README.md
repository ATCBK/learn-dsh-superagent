# s16: 服务脚本 —— 进程外的看门狗

> *"它自己转，自己盯，还留一个外头的人，专管'要不要拉它起来'。"*

---

## 问题

健康看板（s15）在**进程内**。但进程本身要是崩了、退出了，谁来看健康、谁把它拉起来？

真实项目 `scripts/dsh-superagent` 的答案是：**一个进程外的看门狗脚本**，用退出码告诉外部的监控系统（systemd / 你自己的 cron）"该不该重启、还是该叫人"。

---

## 解决方案

看门狗只干一件事：查健康，给退出码。退出码是有语义的——**不是所有失败都能靠重启修好**：

| 退出码 | 含义 | 监控系统该怎么处理 |
|---|---|---|
| `0` | 运行正常 | 什么都不做 |
| `1` | 停了 / 不可达 / 运行时错 | **重启**（可能修好） |
| `2` | 部件报错（如 worker 挂了） | **叫人**（重启修不好） |
| `3` | 等 setup | **叫人**（重启修不好） |

关键洞见：**2 和 3 是"重启也修不好，需要人"**，所以看门狗只对 1 自动重启。

---

## 工作原理

**第 1 步：读健康，算退出码。** 一个纯函数，从健康状态映射到退出码：

```ts
// framework/service.ts
function outcome(h) {
  if (h.runtime !== 'ready' && h.runtime !== 'paused') return 1   // 停了 / 不可达 → 重启
  if (h.setup) return 3                                            // 等 setup → 叫人
  if (h.worker === 'error') return 2                               // 部件报错 → 叫人
  return 0
}
```

**第 2 步：`status` 命令打印状态 + 退出码。** 监控系统读退出码决定下一步：

```ts
if (action === 'status') {
  const code = outcome(load())
  console.log(JSON.stringify({ health, exit: code }))
  process.exit(code)   // 这就是给监控系统的信号
}
```

完整代码：`framework/service.ts`。

> 真实版更强：用 tmux 托管 DSH 进程、`start/stop/restart` 管理生命周期、写"手动停"标记文件（尊重人主动停掉，别自动拉起来）、记录 PID、轮转日志。但骨架就是这个"查健康 → 退出码"的契约。

---

## 试一下

```sh
cd framework
echo '{"runtime":"ready"}' > health.json && node service.ts status; echo "退出码: $?"
echo '{"runtime":"ready","worker":"error"}' > health.json && node service.ts status; echo "退出码: $?"
echo '{}' > health.json && node service.ts status; echo "退出码: $?"
```

三种情况，三个退出码：`0`（正常）、`2`（worker 挂了，叫人）、`1`（停了，重启）。注意：**只有 `1` 才该自动重启**。

---

## 下一步

恭喜，16 章走完了。回看 `framework/`——你已经从零搭出了一个能跑的最小核心框架：状态机 → 效果队列 → SQLite → Outbox → 来源插件 → 授权策略 → 执行器 → 心跳 → 看门狗。真正的 dsh-superagent 就是在这套骨架上，把"假模型 / 假渠道 / 假 worker"换成 DeepSeek Harness 的 Session、真实的 GitHub/飞书 CLI，和真正的模型。
