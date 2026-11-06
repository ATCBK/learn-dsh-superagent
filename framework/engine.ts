/**
 * s01 内核：事件 → 决定 → 工单（一台状态机）。
 * 简化自真实项目的 src/core/*，零 I/O、零 LLM，可跑在内存仓储上。
 */
import { createHash } from 'node:crypto'

/** 内容派生 id：相同输入必得相同 id（对应 src/core/ids.ts）。 */
export const key = (...values: string[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)

// —— 领域类型（简化自 src/core/model.ts）——
export interface Trigger {
  id: string
  source: string
  /** 事件所属的线程；第一个是主线程，承载它的评估。 */
  threads: { source: string; id: string }[]
  actor: { source: string; id: string }
  /** 来源声明：写它的是人，而非 bot / CI / 本 agent 自己。 */
  human: boolean
  /** 来源声明：发送者@了 agent，或私信了它。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: { source: string; thread: string; address: Record<string, string> }
  meta: Record<string, unknown>
}

/** 一条事件的去向账（简化自 src/core/model.ts 的 TriggerDisposition）。 */
export interface TriggerDisposition {
  id: string
  /** 被来源过滤掉，带原因。 */
  filtered?: { reason: string }
  /** 哪个评估在管它。 */
  evalId?: string
  /** 哪个决定处理了它。 */
  decisionId?: string
  at: string
}

export type Strength = 'explicit' | 'inferred'

/** 不可变授权：接单即签发，记录策略版本 + 范围 + 强度（简化自 src/core/model.ts 的 Mandate）。 */
export interface Mandate {
  strength: Strength
  policyVersion: string
  scope: string
  actor: { source: string; id: string }
}

/** 一个线程上一次进行中的评估（简化：一次只评估一个 trigger）。 */
export interface Evaluation {
  id: string
  triggerId: string
  strength: Strength
  policyVersion: string
}

/** 线程聚合：评估的一致性边界（简化自 src/core/model.ts 的 Thread）。 */
export interface Thread {
  key: string
  /** 排队等待评估的 trigger id（去抖缓冲）。 */
  pending: string[]
  /** 进行中的评估；同一线程最多一个。 */
  evaluating?: Evaluation
  /** 订阅了这个线程的工单 id：线程上来了新消息，就扇出给它们。 */
  subscriptions: string[]
}

export interface Decision {
  id: string
  triggerId: string
  kind: 'accept' | 'ignore' | 'stop'
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  at: string
}

/** 状态机对外发的事件（简化自 src/core/ports.ts 的 DomainEvents）。 */
export type DomainEvent =
  | { type: 'trigger.received'; triggerId: string }
  | { type: 'decision.recorded'; decisionId: string; kind: string }
  | { type: 'report.recorded'; ticketId: string; state: ReportState }

export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface Assignment {
  id: string
  state: 'pending' | 'running' | 'ended'
  report?: { state: ReportState; summary: string; at: string }
}

/** 授权工单（简化自 src/core/model.ts 的 Ticket）。 */
export interface Ticket {
  id: string
  title: string
  mandate: Mandate
  assignments: Assignment[]
  origin: { triggerId: string }
  createdAt: string
  /** 通过订阅扇出到达工单的后续消息（人的消息免评估直达）。 */
  followups: string[]
  /** 执行器选定的：短名 + 目录（真实版 src/executor/dsh.ts 的 ticketExecution）。 */
  execution?: { directory: string }
  /** 工单结束：谁、什么结局。授权（mandate）不随之作废，只有人的 stop 或策略变更才撤销。 */
  ended?: { at: string; by: 'executor' | 'human'; outcome: string }
}

// —— 端口（简化自 src/core/ports.ts）——
export interface Policy {
  version: string
  paused: boolean
  /** 确定性准入：谁能发起、什么强度（对应真实实现 Gate 的模型部分）。 */
  gate(trigger: Trigger): { admissible: boolean; strength: Strength; reason?: string }
  /** 一张授权在当前策略下是否仍然成立（对应真实 Policy.revalidate）。 */
  revalidate(mandate: Mandate): boolean
}

export interface Scope {
  /** 来源是否听这条事件（对应 SourceScope）。 */
  scope(trigger: Trigger): { listened: boolean; reason?: string }
}

export interface Assessor {
  request(evalId: string, triggerId: string): void
}

export interface Executor {
  start(ticket: Ticket, assignment: Assignment): void
}

export interface OutboundMessage {
  id: string
  channel: { source: string; thread: string }
  text: string
  ticketId?: string
}
export interface Outbox {
  send(message: OutboundMessage): void
}

// —— 仓储接口：内核只认这组方法，存内存还是存 SQLite 都可以（对应 src/core/ports.ts 的 Repositories）——
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: { has(id: string): boolean; get(id: string): Trigger | undefined; set(id: string, value: Trigger): void }
  dispositions: { get(id: string): TriggerDisposition | undefined; set(id: string, value: TriggerDisposition): void }
  threads: { get(key: string): Thread | undefined; set(key: string, value: Thread): void; list(): Thread[] }
  decisions: { set(id: string, value: Decision): void }
  tickets: { get(id: string): Ticket | undefined; set(id: string, value: Ticket): void }
}

// —— 内存仓储（简化自 src/core/memory.ts）——
export class MemoryRepositories implements Repositories {
  private readonly triggerMap = new Map<string, Trigger>()
  private readonly dispositionMap = new Map<string, TriggerDisposition>()
  private readonly threadMap = new Map<string, Thread>()
  private readonly decisionMap = new Map<string, Decision>()
  private readonly ticketMap = new Map<string, Ticket>()

  /** 快照式事务回滚：work 抛错则整组还原。 */
  atomic<T>(work: () => T): T {
    const maps = [this.triggerMap, this.dispositionMap, this.threadMap, this.decisionMap, this.ticketMap]
    const snap = maps.map(m => new Map(m))
    try {
      return work()
    } catch (error) {
      maps.forEach((m, i) => { m.clear(); for (const [k, v] of snap[i]!) m.set(k, v) })
      throw error
    }
  }

  readonly triggers = {
    has: (id: string) => this.triggerMap.has(id),
    get: (id: string) => this.triggerMap.get(id),
    set: (id: string, value: Trigger) => { this.triggerMap.set(id, value) },
  }
  readonly dispositions = {
    get: (id: string) => this.dispositionMap.get(id),
    set: (id: string, value: TriggerDisposition) => { this.dispositionMap.set(id, value) },
  }
  readonly threads = {
    get: (key: string) => this.threadMap.get(key),
    set: (key: string, value: Thread) => { this.threadMap.set(key, value) },
    list: () => [...this.threadMap.values()],
  }
  readonly decisions = {
    set: (id: string, value: Decision) => { this.decisionMap.set(id, value) },
  }
  readonly tickets = {
    get: (id: string) => this.ticketMap.get(id),
    set: (id: string, value: Ticket) => { this.ticketMap.set(id, value) },
  }
}

export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  scope: Scope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  now?: () => string
  /** 状态机只发事件，不关心谁在听（真实版 Engine.emit）。 */
  emit?: (event: DomainEvent) => void
}

/**
 * 内核：单一入口，把所有领域改动包进同步事务（对应 src/core/engine.ts）。
 * 只有它写 Triggers / Threads / Decisions / Tickets；副作用交给端口。
 */
export class Engine {
  readonly o: EngineOptions
  constructor(o: EngineOptions) { this.o = o }

  private now(): string { return this.o.now?.() ?? new Date().toISOString() }

  /** 事件进来：存一次、过滤、排队评估（对应 src/core/engine.ts 的 receive → Intake.receive）。 */
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered' {
    return this.o.repo.atomic(() => {
      if (this.o.repo.triggers.has(trigger.id)) return 'duplicate'
      this.o.repo.triggers.set(trigger.id, trigger)
      const scope = this.o.scope.scope(trigger)
      if (!scope.listened) {
        this.o.repo.dispositions.set(trigger.id, { id: trigger.id, filtered: { reason: scope.reason ?? 'not_listened' }, at: this.now() })
        return 'filtered'
      }
      const t = this.o.repo.threads.get(this.threadKey(trigger)) ?? { key: this.threadKey(trigger), pending: [], subscriptions: [] }
      // 扇出：这条消息自动送到订阅了这个线程的每个工单（对应 src/core/intake.ts 的 fan-out）
      for (const ticketId of t.subscriptions ?? []) {
        const ticket = this.o.repo.tickets.get(ticketId)
        if (!ticket || ticket.ended?.by === 'human') continue
        ticket.followups = [...(ticket.followups ?? []), trigger.id]
        // 执行器结束的工单，被人的消息唤回（复用 s11 的 resume 语义，免重新评估）
        if (ticket.ended && trigger.human && this.o.policy().revalidate(ticket.mandate)) {
          delete ticket.ended
          ticket.assignments.push({ id: key('assignment', ticketId, String(ticket.assignments.length)), state: 'pending' })
          this.o.executor.start(ticket, ticket.assignments.at(-1)!)
        }
        this.o.repo.tickets.set(ticket.id, ticket)
      }
      t.pending.push(trigger.id)
      this.o.repo.threads.set(t.key, t)
      this.o.repo.dispositions.set(trigger.id, { id: trigger.id, at: this.now() })
      this.o.emit?.({ type: 'trigger.received', triggerId: trigger.id })
      return 'stored'
    })
  }

  /** 时钟：起评估（对应 src/core/engine.ts 的 evaluateDue → Evals.start）。 */
  evaluateDue(): void {
    const policy = this.o.policy()
    if (policy.paused) return
    for (const thread of this.o.repo.threads.list()) {
      if (thread.evaluating || !thread.pending.length) continue
      this.o.repo.atomic(() => {
        const triggerId = thread.pending[0]!
        const trigger = this.o.repo.triggers.get(triggerId)!
        const gate = policy.gate(trigger)
        if (!gate.admissible) { thread.pending.shift(); return }
        const evaluation: Evaluation = {
          id: key('eval', thread.key, triggerId),
          triggerId,
          strength: gate.strength,
          policyVersion: policy.version,
        }
        thread.evaluating = evaluation
        thread.pending.shift()
        this.o.repo.threads.set(thread.key, thread)
        const disp = this.o.repo.dispositions.get(triggerId) ?? { id: triggerId, at: this.now() }
        disp.evalId = evaluation.id
        this.o.repo.dispositions.set(triggerId, disp)
        this.o.assessor.request(evaluation.id, triggerId)
      })
    }
  }

  /** 接单：签发 Mandate、建工单 + 首个派工（对应 src/core/engine.ts 的 decide → Evals.decide → Tickets.create）。 */
  decide(triggerId: string, outcome: { kind: 'accept'; title: string; scope: string }): Decision {
    return this.o.repo.atomic(() => {
      const trigger = this.o.repo.triggers.get(triggerId)
      if (!trigger) throw new Error('unknown trigger')
      const thread = this.o.repo.threads.get(this.threadKey(trigger))!
      const evaluation = thread.evaluating
        ?? { id: key('eval', thread.key, triggerId), triggerId, strength: 'explicit', policyVersion: this.o.policy().version }
      const mandate: Mandate = {
        strength: evaluation.strength,
        policyVersion: evaluation.policyVersion,
        scope: outcome.scope,
        actor: trigger.actor,
      }
      const ticketId = key('ticket', evaluation.id)
      const decision: Decision = {
        id: key('decision', evaluation.id),
        triggerId,
        kind: 'accept',
        strength: evaluation.strength,
        ticketId,
        mandate,
        at: this.now(),
      }
      this.o.repo.decisions.set(decision.id, decision)
      const disp = this.o.repo.dispositions.get(triggerId) ?? { id: triggerId, at: this.now() }
      disp.decisionId = decision.id
      this.o.repo.dispositions.set(triggerId, disp)
      this.o.emit?.({ type: 'decision.recorded', decisionId: decision.id, kind: decision.kind })
      const ticket: Ticket = {
        id: ticketId,
        title: outcome.title,
        mandate,
        assignments: [{ id: key('assignment', ticketId, '0'), state: 'pending' }],
        origin: { triggerId },
        createdAt: this.now(),
        followups: [],
      }
      this.o.repo.tickets.set(ticket.id, ticket)
      delete thread.evaluating
      thread.subscriptions = [...(thread.subscriptions ?? []), ticket.id]   // 工单订阅它出生的线程
      this.o.repo.threads.set(thread.key, thread)
      this.o.executor.start(ticket, ticket.assignments[0]!)
      return decision
    })
  }

  /** 执行器的回话：worker 干完活把结果写回工单（对应 src/core/engine.ts 的 report）。 */
  report(ticketId: string, report: { state: ReportState; summary: string }): Ticket {
    return this.o.repo.atomic(() => {
      const ticket = this.o.repo.tickets.get(ticketId)
      if (!ticket) throw new Error('unknown ticket')
      const assignment = ticket.assignments.at(-1)
      if (!assignment) throw new Error('no assignment')
      assignment.state = 'ended'
      assignment.report = { ...report, at: this.now() }
      if (report.state === 'ready') ticket.ended = { at: this.now(), by: 'executor', outcome: 'completed' }
      if (report.state === 'dropped') ticket.ended = { at: this.now(), by: 'executor', outcome: 'dropped' }
      this.o.repo.tickets.set(ticket.id, ticket)
      this.o.emit?.({ type: 'report.recorded', ticketId, state: report.state })
      return ticket
    })
  }

  /** 人的停止：撤销授权，工单结束（对应 src/core/engine.ts 的 stopTicket → Tickets.stop）。 */
  stop(ticketId: string): Ticket {
    return this.o.repo.atomic(() => {
      const ticket = this.o.repo.tickets.get(ticketId)
      if (!ticket) throw new Error('unknown ticket')
      if (!ticket.ended) ticket.ended = { at: this.now(), by: 'human', outcome: 'stopped' }
      this.o.repo.tickets.set(ticket.id, ticket)
      return ticket
    })
  }

  /** 复活：一张执行器结束的工单，人的消息能在原授权下唤回它，无需重新评估（对应 src/core/engine.ts 的 wake → Tickets.wake）。 */
  resume(ticketId: string): Ticket {
    return this.o.repo.atomic(() => {
      const ticket = this.o.repo.tickets.get(ticketId)
      if (!ticket) throw new Error('unknown ticket')
      if (!ticket.ended || ticket.ended.by === 'human') return ticket        // 人停过 → 授权已撤销，不能复活
      if (!this.o.policy().revalidate(ticket.mandate)) return ticket          // 授权在当前策略下已失效
      delete ticket.ended
      ticket.assignments.push({ id: key('assignment', ticketId, String(ticket.assignments.length)), state: 'pending' })
      this.o.repo.tickets.set(ticket.id, ticket)
      this.o.executor.start(ticket, ticket.assignments.at(-1)!)
      return ticket
    })
  }

  ticket(id: string): Ticket | undefined { return this.o.repo.tickets.get(id) }

  trigger(id: string): Trigger | undefined { return this.o.repo.triggers.get(id) }

  /** 查一条事件走到哪了（对应真实 Store 的 disposition 读）。 */
  disposition(id: string): TriggerDisposition | undefined { return this.o.repo.dispositions.get(id) }

  private threadKey(trigger: Trigger): string {
    const primary = trigger.threads[0]!
    return `${primary.source}:${primary.id}`
  }
}
