export interface RetentionPolicy {
  /** tasks+events 保留毫秒数,默认 90 天 */
  tasksMs: number
  /** journal 保留毫秒数,默认 180 天 */
  journalMs: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  tasksMs: 90 * 24 * 60 * 60 * 1000,
  journalMs: 180 * 24 * 60 * 60 * 1000,
}

/**
 * 保留期清理的纯逻辑部分:给出截止时刻。
 * 触发节奏(启动时 + 每日 03:00)与实际删除由仓库/组合根执行。
 */
export function retentionCutoffs(now: number, policy = DEFAULT_RETENTION): {
  tasksBefore: number
  journalBefore: number
} {
  return {
    tasksBefore: now - policy.tasksMs,
    journalBefore: now - policy.journalMs,
  }
}

/** 本地时区下一个"每日 03:00"的下一次触发时刻 */
export function nextDailyRun(now: number, hour = 3): number {
  const date = new Date(now)
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0)
  if (next.getTime() <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime()
}
