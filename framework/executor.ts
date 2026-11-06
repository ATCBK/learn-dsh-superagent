/**
 * s03/s04 执行器角色：每工单一个独立目录 + prepare + 环境变量。
 * 真实版是 src/executor/dsh.ts 的 DshExecutor：`start` 只 enqueue 一个 launch 效果，真正起会话在效果队列里做。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Effects } from './effects.ts'
import type { Assignment, ReportState, Ticket } from './engine.ts'

export interface ExecutorHost {
  report(ticketId: string, assignmentId: string, report: { state: ReportState; summary: string }): void
}

export interface ExecutorOptions {
  /** 所有工单目录的根（真实版默认 <stateDir>/work）。 */
  workRoot: string
  /** 效果队列：`start` 只把"启动"这件事放进队列。 */
  effects: Effects
  /** 开新目录时先跑的命令（真实版 executor.prepare，如 git clone）。 */
  prepare?: string
  /** 干活时的环境变量（真实版由 Executor 和 Sources 各自注册）。 */
  env?: Record<string, string>
}

export class Executor {
  readonly host: ExecutorHost
  readonly workRoot: string
  readonly effects: Effects
  readonly prepare: string
  readonly env: Record<string, string>
  constructor(host: ExecutorHost, options: ExecutorOptions) {
    this.host = host
    this.workRoot = options.workRoot
    this.effects = options.effects
    this.prepare = options.prepare ?? ''
    this.env = options.env ?? {}
  }

  /** 接单后：只"记下要启动"，不真的启动（对应真实 DshExecutor.start → enqueue launch 效果）。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** 真正干活：由效果队列在提交之后调用（对应真实 DshExecutor 的 launch 效果处理器）。 */
  launch(ticket: Ticket, assignment: Assignment): void {
    if (ticket.ended) return   // 工单已结束（含人停），不再开工（对应真实 launchQueued 的 liveTicket 检查）
    assignment.state = 'running'
    console.log(`  [worker] 开工：${ticket.title}`)
    const dir = this.directoryFor(ticket)
    ticket.execution = { directory: dir }
    mkdirSync(dir, { recursive: true })
    if (this.prepare) execSync(this.prepare, { cwd: dir, env: { ...process.env, ...this.env } })
    // 假 worker：在独立目录里写一个结果文件，代表"干完了"。
    const envLine = Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join(', ') || '（无）'
    writeFileSync(join(dir, 'result.md'), `# ${ticket.title}\n\n在独立目录 ${dir} 完成了工作。环境变量：${envLine}\n`)
    this.host.report(ticket.id, assignment.id, { state: 'ready', summary: `已完成「${ticket.title}」，产物在 ${dir}` })
    console.log(`  [worker] 报告：ready —— 已完成「${ticket.title}」`)
  }

  /** 每工单一目录：短名 + 工单 id 前 8 位，同名稳定、互不覆盖（真实版 src/executor/dsh.ts 的 ticketWorktreeName）。 */
  private directoryFor(ticket: Ticket): string {
    const name = (ticket.title || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'work'
    return join(this.workRoot, `${name}-${ticket.id.slice(0, 8)}`)
  }
}
