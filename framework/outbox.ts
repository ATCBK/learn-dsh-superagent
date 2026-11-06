/**
 * s09 Outbox + 回执：每条要发的消息记一张回执，投递做成可靠的。
 * 真实版 src/app/outbox.ts：回执持久化在 SQLite、按 Ticket+会话保序、来源关了 Later 重试、会话没了 settle 为 dropped。
 */
import type { Effects } from './effects.ts'
import type { OutboundMessage } from './engine.ts'

export type ReplyStatus = 'pending' | 'sent' | 'dropped'

interface Receipt extends OutboundMessage { status: ReplyStatus }

export interface OutboxHost {
  effects: Effects
  /** 渠道现在能不能收到回复：'sent' 能投、'gone' 会话没了、'waiting' 来源暂时不可用。 */
  channelAvailable(channel: { source: string; thread: string }): 'sent' | 'gone' | 'waiting'
}

export class Outbox {
  readonly receipts = new Map<string, Receipt>()
  readonly host: OutboxHost
  constructor(host: OutboxHost) { this.host = host }

  /** 记回执 + 入队 reply 效果。同 id 只记一次，所以投递也只会发生一次。 */
  send(message: OutboundMessage): void {
    if (this.receipts.has(message.id)) return
    this.receipts.set(message.id, { ...message, status: 'pending' })
    this.host.effects.enqueue('reply', message.id, {})
  }

  /** reply 效果真正做的事：投递。 */
  deliver(id: string): void {
    const receipt = this.receipts.get(id)
    if (!receipt || receipt.status !== 'pending') return
    const result = this.host.channelAvailable(receipt.channel)
    if (result === 'waiting') throw new Error('Source is off')   // 真实版是 Later：不记失败，稍后重试
    receipt.status = result === 'gone' ? 'dropped' : 'sent'
    console.log(`  [outbox] ${receipt.status}: ${receipt.text}`)
  }

  status(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
}
