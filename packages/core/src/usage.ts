import type { AgentId, TaskRecord } from './types.js'

/** 本地时区 YYYY-MM-DD;日界与重置均按本地零点 */
export function localDayOf(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 用量台账:入队 +1,未运行即终态返还 -1(记回产生时的原 day 行)。
 * 台账是节流 cap 的数据源,SQLite 适配器落 usage 表。
 */
export interface UsageLedger {
  countOf(agentId: AgentId, day: string): number
  charge(agentId: AgentId, day: string): void
  refund(agentId: AgentId, day: string): void
}

export class MemoryUsageLedger implements UsageLedger {
  private counts = new Map<string, number>()

  countOf(agentId: AgentId, day: string): number {
    return this.counts.get(key(agentId, day)) ?? 0
  }

  charge(agentId: AgentId, day: string): void {
    this.counts.set(key(agentId, day), this.countOf(agentId, day) + 1)
  }

  refund(agentId: AgentId, day: string): void {
    const current = this.countOf(agentId, day)
    // 不出现负数:返还到 0 为止
    if (current > 0) this.counts.set(key(agentId, day), current - 1)
  }
}

/** 任务记账的日子 = 创建日;跨零点返还也不写新日 */
export function chargeDayOf(task: TaskRecord): string {
  return localDayOf(task.createdAt)
}

function key(agentId: AgentId, day: string): string {
  return `${agentId}|${day}`
}
