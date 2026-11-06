/**
 * s15 Pass 心跳：每 2 秒跑一次，驱动效果队列 + 评估。
 * 真实版 src/app/passes.ts：一个 pass 同时只跑一个，并发 request 合并成一次后续 pass。
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>
  readonly pump: () => void

  constructor(pump: () => void) { this.pump = pump }

  /** 跑一次 pass（真实版由 setInterval 每 2 秒调一次）。 */
  run(): void { this.pump() }

  /** 启动心跳。 */
  start(): void { this.timer = setInterval(() => this.pump(), 2000) }

  /** 停心跳。 */
  stop(): void { if (this.timer) clearInterval(this.timer) }
}
