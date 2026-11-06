/**
 * 完整链路入口：来源轮询 → 准入(Gate) → 研判(Assessment) → 开单 → 执行 → 报告 → 回话 → 持久化。
 * 运行：node framework/main.ts
 */
import { join } from 'node:path'
import { Effects } from './effects.ts'
import { Engine, key } from './engine.ts'
import { Executor } from './executor.ts'
import { githubSource } from './github.ts'
import { HealthBoard } from './health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { assess, policyEffects, settingsPolicy } from './policy.ts'
import { Sessions } from './sessions.ts'
import { SourceRegistry } from './source.ts'
import { Store } from './store.ts'

const dbPath = join(import.meta.dirname, 'state.sqlite')
const store = new Store(dbPath)
const effects = new Effects()
const sessions = new Sessions()
const registry = new SourceRegistry({ get: k => store.kv.get(k), set: (k, v) => store.kv.set(k, v) })
registry.register(githubSource())

const settings = {
  allowed: [{ source: 'github', id: 'alice' }],
  mode: 'auto',
  rules: [{ id: 'copy', name: 'Copy fixes', enabled: true }],
} as const
const policy = settingsPolicy(settings)

const outbox = new Outbox({
  effects,
  channelAvailable: channel => channel.thread === 'issue-deleted' ? 'gone' : 'sent',
})

let engine: Engine
const executor = new Executor(
  { report: (ticketId, _a, report) => engine.report(ticketId, report) },
  { workRoot: join(import.meta.dirname, 'work'), effects, env: { REPO: 'dsh-superagent' } },
)

let createdTicketId: string | undefined
effects.handle('assessment', p => {
  const t = engine.trigger(p.triggerId)!
  const gate = policy.gate(t)
  const outcome = assess(t, gate.strength, settings)
  console.log(`  [gate] 准入强度: ${gate.strength}`)
  console.log(`  [模型研判] ${outcome.kind}: ${outcome.reason}`)
  if (outcome.kind === 'accept') {
    const d = engine.decide(p.triggerId, { kind: 'accept', title: outcome.title, scope: outcome.scope })
    createdTicketId = d.ticketId
    console.log(`  [接单] ticket ${d.ticketId?.slice(0, 12)}`)
  }
})
effects.handle('launch', p => { const t = engine.ticket(p.ticketId)!; executor.launch(t, t.assignments.at(-1)!) })
effects.handle('reply', (_p, id) => outbox.deliver(id))

engine = new Engine({
  repo: store,
  policy: () => policy,
  scope: { scope: trigger => registry.scope(trigger) },
  assessor: { request: (evalId, triggerId) => effects.enqueue('assessment', evalId, { evalId, triggerId }) },
  executor: { start: (ticket, assignment) => executor.start(ticket, assignment) },
  outbox: { send: message => outbox.send(message) },
  emit: event => {
    if (event.type === 'trigger.received') sessions.notice('收到新事件')
    else if (event.type === 'decision.recorded') sessions.notice(`已接单（${event.kind}）`)
    else if (event.type === 'report.recorded') sessions.relay(`worker 报告：${event.state}`)
  },
})

// ===== 事件1：一条 @agent 的消息走完整条链 =====
const trigger = registry.poll()[0]!
console.log('== 1. 来源轮询：事件1 ==')
console.log(`来自 ${trigger.source}：${trigger.text}`)
console.log('receive:', engine.receive(trigger))
engine.evaluateDue()
effects.dispatch()   // 研判：gate 判强度 → 模型判内容 → 接单
effects.dispatch()   // 起 worker → 报告 ready → 工单结束

const ticket = engine.ticket(createdTicketId!)!
console.log('\n== 2. 工单状态（worker 已报 ready） ==')
console.log('派工数:', ticket.assignments.length, 'ended:', JSON.stringify(ticket.ended))

// ===== Gate 演示：名单决定强度 =====
console.log('\n== 3. Gate 演示：谁能发起、什么强度 ==')
const bobTrigger = { ...trigger, id: key('trigger', 'github', 'issue-1', 'bob'), actor: { source: 'github', id: 'bob' }, text: '@agent 修一下' }
console.log('alice @agent →', policy.gate(trigger).strength)     // explicit（在名单）
console.log('bob   @agent →', policy.gate(bobTrigger).strength)  // inferred（不在名单）

// ===== s12 订阅扇出：事件2 自动到达工单并唤回它 =====
const cursorBefore = store.kv.get('github-cursor')
const event2 = registry.poll()[0]!
console.log('\n== 4. 订阅扇出（事件2 自动到达，免 @agent / 免评估） ==')
console.log('读位:', cursorBefore, '→ 轮询后:', store.kv.get('github-cursor'), '拿到:', event2.text)
console.log('receive:', engine.receive(event2))
const t2 = engine.ticket(ticket.id)!
console.log('工单 ended:', JSON.stringify(t2.ended), '派工数:', t2.assignments.length, 'followups:', t2.followups.length)

// ===== s11 人停撤销授权 =====
engine.stop(ticket.id)
const afterStop = engine.resume(ticket.id)
console.log('\n== 5. 人停撤销授权 ==')
console.log('stop 后再 resume，ended 仍是:', JSON.stringify(afterStop.ended))

// ===== s14 Policy 版本化 =====
console.log('\n== 6. Policy 版本化（规则变了不误杀、不静默） ==')
const newSettings = { ...settings, allowed: [] }   // 把 alice 移出名单
console.log('旧策略版本:', settingsPolicy(settings).version)
console.log('新策略版本:', settingsPolicy(newSettings).version)
console.log('受影响的在跑工单:', [...policyEffects([ticket], settings, newSettings).keys()])
console.log('旧策略下 revalidate:', settingsPolicy(settings).revalidate(ticket.mandate))
console.log('新策略下 revalidate:', settingsPolicy(newSettings).revalidate(ticket.mandate))

// ===== s09 回复原对话 =====
console.log('\n== 7. 回复原对话（Outbox 回执） ==')
const replyId = key('reply', ticket.id, 'result')
outbox.send({ id: replyId, channel: { source: 'github', thread: 'issue-1' }, text: '已完成「修复 README 示例」', ticketId: ticket.id })
console.log('回执状态(投递前):', outbox.status(replyId))
effects.dispatch()
console.log('回执状态(投递后):', outbox.status(replyId))

console.log('\n== 主会话收件箱 ==')
sessions.flush()

// ===== s15 Pass 心跳 + HealthBoard =====
console.log('\n== 8. Pass 心跳 + HealthBoard（系统自己转、自己盯） ==')
const board = new HealthBoard()
const runtimeHealth = board.claim('runtime', { state: 'starting', detail: '' })
const workerHealth = board.claim('worker', { state: 'ready', detail: 'No worker' })
runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready' })
console.log('健康:', JSON.stringify(board.all))
workerHealth.set({ state: 'error', detail: 'worker 挂了' })
console.log('健康(worker 挂了):', JSON.stringify(board.all))
try { board.claim('worker') } catch (e) { console.log('重复 claim worker:', (e as Error).message) }
const passes = new Passes(() => console.log('  [pass] 心跳一次：驱动效果队列 + 评估'))
passes.run()

// ===== s10 持久化 =====
console.log('\n== 持久化（重启不丢） ==')
console.log('状态已写到:', dbPath)
store.close()
const reopened = new Store(dbPath)
console.log('重启后读位还在:', reopened.kv.get('github-cursor'))
console.log('重启后工单还在:', !!reopened.tickets.get(createdTicketId!))
reopened.close()
