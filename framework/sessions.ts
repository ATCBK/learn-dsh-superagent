/**
 * s06 主会话：两种投递——notice 不唤醒（塞进去，下次自己看），relay 唤醒（立刻叫起来处理）。
 * 真实版 src/app/sessions.ts：notice 走 inject，relay 走 steer；两者都经效果队列、都去重、都持久化。
 */
export class Sessions {
  readonly inbox: string[] = []

  /** 不唤醒：塞进收件箱，主会话下次自己看（真实版 inject）。 */
  notice(text: string): void {
    this.inbox.push(text)
    console.log(`  [inject·不唤醒] ${text}`)
  }

  /** 唤醒：塞进收件箱，并立刻叫醒主会话来处理（真实版 steer）。 */
  relay(text: string): void {
    this.inbox.push(text)
    console.log(`  [steer·唤醒] ${text} —— 主会话被叫起来处理`)
  }

  /** 模拟主会话读收件箱（真实版由 agent 的下一轮 turn 消费）。 */
  flush(): void {
    if (!this.inbox.length) { console.log('  （收件箱为空）'); return }
    for (const m of this.inbox) console.log('  ' + m)
    this.inbox.length = 0
  }
}
