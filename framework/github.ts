/**
 * s07/s08 假 GitHub 来源：有两条评论，靠读位（cursor）保证重启后不重放。
 * 真实版是 src/sources/github.ts（读 notifications / subscribed issues / CI 变化）。
 */
import { key, type Trigger } from './engine.ts'
import type { SourceKind } from './source.ts'

export function githubSource(): SourceKind {
  const events = [
    { comment: 'comment-1', text: '@agent 把 README 示例跑通并修复' },
    { comment: 'comment-2', text: '@agent 再补一段测试' },
  ]
  return {
    kind: 'github',
    title: 'GitHub',
    scope: () => ({ listened: true }),
    poll: state => {
      const cursor = Number(state.get('github-cursor') ?? '0')   // 读位置：上次读到第几条
      const fresh = events.slice(cursor, cursor + 1)              // 只读"读位之后"的下一条
      if (fresh.length) state.set('github-cursor', String(cursor + 1)) // 读位前移
      return fresh.map(e => {
        const trigger: Trigger = {
          id: key('trigger', 'github', 'issue-1', e.comment),
          source: 'github',
          threads: [{ source: 'github', id: 'issue-1' }],
          actor: { source: 'github', id: 'alice' },
          human: true,
          addressed: 'mention',
          at: new Date().toISOString(),
          text: e.text,
          channel: { source: 'github', thread: 'issue-1', address: { number: '1' } },
          meta: {},
        }
        return trigger
      })
    },
  }
}
