/**
 * s15 健康看板：每个部件一个健康条目，单一写入者。
 * 真实版 src/infra/health.ts：claim 拒绝二次认领，面板和外部看门狗读它判断谁挂了。
 */
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }

export interface HealthEntry {
  set(health: Health): void
  get(): Health | undefined
}

export class HealthBoard {
  private entries: Record<string, Health> = {}
  private claimed = new Set<string>()

  /** 认领一个健康条目；名字重复会报错（单一写入者）。 */
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`health entry ${name} is claimed by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    return {
      set: h => { this.entries[name] = h },
      get: () => this.entries[name],
    }
  }

  get all(): Record<string, Health> { return this.entries }
}
