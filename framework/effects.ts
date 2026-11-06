/**
 * s04 效果队列：副作用在这里排队，状态提交之后才跑。
 * 真实版 src/app/effects.ts 是 SQLite 持久化 + 合并去重 + 指数退避 + 按种类并发/有序 + 健康上报。
 * 这里先用内存版，讲清"改状态"与"做效果"的分离这件事本身。
 */
export interface EffectPayloads {
  assessment: { evalId: string; triggerId: string }
  launch: { ticketId: string; assignmentId: string }
  /** 回复效果：key 是消息 id，payload 空（真实版 src/app/effects.ts 也是空的）。 */
  reply: Record<string, never>
}
export type EffectKind = keyof EffectPayloads

interface Row { kind: EffectKind; key: string; payload: unknown; seq: number }

export class Effects {
  private rows = new Map<string, Row>()
  private handlers = new Map<EffectKind, (payload: never) => void>()
  private seq = 0

  /** 在命令的事务里调用：只"记下要做的事"，不真的做。同 (kind,key) 只保留一行（去重）。 */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.rows.set(`${kind}:${key}`, { kind, key, payload, seq: ++this.seq })
  }

  /** 注册某种效果"真正该做什么"；第二参是 key（如消息 id）。 */
  handle<K extends EffectKind>(kind: K, run: (payload: EffectPayloads[K], key: string) => void): void {
    this.handlers.set(kind, run as (payload: never, key: string) => void)
  }

  /** 提交之后调用：按入队顺序跑一遍待处理效果（真实版由 Pass 每 2 秒驱动一次）。 */
  dispatch(): void {
    for (const row of [...this.rows.values()].sort((a, b) => a.seq - b.seq)) {
      this.rows.delete(`${row.kind}:${row.key}`)
      this.handlers.get(row.kind)?.(row.payload as never, row.key)
    }
  }

  /** 还有多少效果没跑（真实版能查 pending，用于测试和健康）。 */
  pending(): number { return this.rows.size }
}
