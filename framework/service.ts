/**
 * s16 外部看门狗（简易版）：对应真实 scripts/dsh-superagent 的 status 命令。
 * 读 framework/health.json，给出退出码：
 *   0 运行正常 · 1 停/不可达/运行时错（重启可能修好）· 2 部件报错（要人处理）· 3 等 setup（要人处理）
 * 运行：node framework/service.ts status
 */
import { readFileSync } from 'node:fs'

type State = 'ready' | 'paused' | 'error'
interface HealthFile { runtime?: State; worker?: State; setup?: string }

function load(): HealthFile {
  try {
    return JSON.parse(readFileSync(new URL('./health.json', import.meta.url), 'utf8')) as HealthFile
  } catch {
    return {}
  }
}

/** 退出码语义：2 和 3 是"重启也修不好，需要人"，所以看门狗只对 1 自动重启。 */
function outcome(h: HealthFile): number {
  if (h.runtime !== 'ready' && h.runtime !== 'paused') return 1   // 停了 / 不可达
  if (h.setup) return 3                                            // 等 setup
  if (h.worker === 'error') return 2                               // 部件报错
  return 0
}

const action = process.argv[2] ?? 'status'
if (action === 'status') {
  const h = load()
  const code = outcome(h)
  console.log(JSON.stringify({ pids: code === 1 ? [] : [1], health: h, exit: code }, null, 2))
  process.exit(code)
}
