/**
 * s07/s08 来源插件协议 + 读位防重放。
 * 简化自 src/sources/kind.ts（SourceKind）、src/sources/registry.ts（SourceRegistry）、src/sources/poll.ts（读位）。
 */
import type { Trigger } from './engine.ts'

/** 来源能读写的持久化状态（真实版是 SQLite 的 kv 表，s10 会换过去）。 */
export interface SourceState {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export interface SourceKind {
  /** 稳定 id，如 'github'、'feishu'。 */
  kind: string
  title: string
  /** 是否听这条事件（对应真实 scope）；不实现就全听。 */
  scope?(meta: Record<string, unknown>): { listened: boolean; reason?: string }
  /** 轮询一轮：只产出"读位之后"的新事件，并把读位前移。 */
  poll?(state: SourceState): Trigger[]
}

export class SourceRegistry {
  private kinds = new Map<string, SourceKind>()
  /** 读位存哪：默认内存 Map，s10 换成 SQLite 的 kv。 */
  readonly kv: SourceState

  constructor(kv?: SourceState) {
    const memory = new Map<string, string>()
    this.kv = kv ?? { get: key => memory.get(key), set: (key, value) => { memory.set(key, value) } }
  }

  register(kind: SourceKind): void { this.kinds.set(kind.kind, kind) }

  scope(trigger: Trigger): { listened: boolean; reason?: string } {
    const kind = this.kinds.get(trigger.source)
    if (!kind) return { listened: false, reason: 'source_not_installed' }
    return kind.scope?.(trigger.meta) ?? { listened: true }
  }

  poll(): Trigger[] {
    return [...this.kinds.values()].flatMap(kind => kind.poll?.(this.kv) ?? [])
  }
}
