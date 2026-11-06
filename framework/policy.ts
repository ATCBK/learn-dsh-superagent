/**
 * s13 准入（Gate）与研判（Assessment）分离。
 * 真实版 src/policy.ts：Gate 确定性判"谁能发起、什么强度"，Assessment 是模型对内容做判断。
 */
import { key, type Mandate, type Policy, type Strength, type Trigger } from './engine.ts'

export interface Settings {
  /** 白名单：谁可以发起干活。 */
  allowed: { source: string; id: string }[]
  /** 接受模式：off 不接推断 / observe 只记录本会接 / auto 真接。 */
  mode: 'off' | 'observe' | 'auto'
  /** 评估规则（推断性工作必须命中启用的规则）。 */
  rules: { id: string; name: string; enabled: boolean }[]
}

export function settingsPolicy(settings: Settings): Policy {
  const listed = (actor: { source: string; id: string }) =>
    settings.allowed.some(a => a.source === actor.source && a.id === actor.id)

  return {
    version: policyVersion(settings),
    paused: false,
    gate(trigger: Trigger) {
      if (!trigger.human) return { admissible: false, strength: 'inferred' as Strength, reason: 'not_human' }
      if (listed(trigger.actor) && trigger.addressed) {
        return { admissible: true, strength: 'explicit' as Strength }   // 名单内 + @了 → 明确
      }
      if (trigger.addressed && settings.mode !== 'off') {
        return { admissible: true, strength: 'inferred' as Strength }   // @了但不在名单 → 推断
      }
      return { admissible: false, strength: 'inferred' as Strength, reason: 'not_a_member' }
    },
    revalidate(mandate: Mandate) {
      if (mandate.strength === 'explicit') return listed(mandate.actor)
      return settings.mode === 'auto' && settings.rules.some(r => r.enabled)
    },
  }
}

/** 策略版本：哈希所有影响授权的设置（真实版 src/policy.ts 的 policyVersion）。 */
export function policyVersion(settings: Settings): string {
  return key('policy', JSON.stringify({ allowed: settings.allowed, mode: settings.mode, rules: settings.rules }))
}

/** 策略变化对哪些在跑工单有影响：旧策略下授权成立、新策略下不再成立（真实版 policyEffects）。 */
export function policyEffects(tickets: { id: string; mandate: Mandate }[], oldSettings: Settings, newSettings: Settings):
  Map<string, { reason: string }> {
  const oldPolicy = settingsPolicy(oldSettings)
  const newPolicy = settingsPolicy(newSettings)
  const effects = new Map<string, { reason: string }>()
  for (const ticket of tickets) {
    if (oldPolicy.revalidate(ticket.mandate) && !newPolicy.revalidate(ticket.mandate)) {
      effects.set(ticket.id, { reason: '授权不再成立（人下了名单 / 规则关了）' })
    }
  }
  return effects
}

/** 假模型研判：只判断"内容是不是真要干活、干多深"。真实版是 MasterAssessor + prompts/admission.md。 */
export function assess(trigger: Trigger, strength: Strength, settings: Settings):
  { kind: 'accept' | 'ignore'; title: string; scope: string; reason: string } {
  const wantsWork = /修复|补|改|跑通/.test(trigger.text)
  if (!wantsWork) return { kind: 'ignore', title: '', scope: '', reason: '不是明确要求' }
  if (strength === 'inferred' && settings.mode !== 'auto') {
    return { kind: 'ignore', title: '', scope: '', reason: '推断性工作在非 auto 模式只记录不接' }
  }
  return { kind: 'accept', title: '修复 README 示例', scope: 'repo', reason: '明确要求' }
}
