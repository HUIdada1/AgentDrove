import type { ThrottleConfig } from './config.js'
import type { Clock } from './ports.js'
import type { AgentProfile, TaskRecord } from './types.js'
import { chargeDayOf, type UsageLedger } from './usage.js'
import { localDayOf } from './usage.js'

export interface ReleaseContext {
  agentRunning: number
  globalRunning: number
  /** 同 cwd 已有 running 任务占用(按任务状态判定,workspaces 行不作依据) */
  cwdOccupied: boolean
}

export type ReleaseBlockReason =
  | 'paused'
  | 'daily-cap'
  | 'global-concurrency'
  | 'agent-concurrency'
  | 'interval'
  | 'cwd-busy'

export interface ReleaseDecision {
  ok: boolean
  reason?: ReleaseBlockReason
  /** 仅 interval 场景给出建议重试等待毫秒数 */
  retryInMs?: number
}

/**
 * 节流器:
 * - cap 在入队时硬闸(不产生任务记录),入队即记账 +1;
 * - 终态但从未运行的任务返还(记回创建日行,跨零点不写新日);
 * - 放行闸(pause)只挡放行,不影响已 running;
 * - 每客户端节拍 = minInterval + 随机抖动,与全局/每客户端并发共同构成放行条件。
 */
export class Throttle {
  private config: ThrottleConfig
  private paused: boolean
  private readonly nextAllowedAt = new Map<string, number>()

  constructor(
    private readonly ledger: UsageLedger,
    private readonly clock: Clock,
    config: ThrottleConfig,
    initialPaused = false,
  ) {
    this.config = config
    this.paused = initialPaused
  }

  configure(config: ThrottleConfig): void {
    this.config = config
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  isPaused(): boolean {
    return this.paused
  }

  /** 入队前调用:超上限直接抛错,调用方不得产生任务记录 */
  checkCapAtSubmit(agent: AgentProfile): void {
    const today = localDayOf(this.clock.now())
    if (this.ledger.countOf(agent.id, today) >= agent.plan.dailyTaskCap) {
      throw new Error(
        `客户端 "${agent.label}" 今日任务已达上限 ${agent.plan.dailyTaskCap},拒绝入队`,
      )
    }
  }

  /** 入队记账 */
  chargeAtSubmit(task: TaskRecord): void {
    this.ledger.charge(task.agentId, chargeDayOf(task))
  }

  /** 终态但从未运行(排队取消/驱动缺失/健康不通过)→ 返还 */
  refundIfNeverRan(task: TaskRecord): void {
    if (task.startedAt === undefined) {
      this.ledger.refund(task.agentId, chargeDayOf(task))
    }
  }

  canRelease(task: TaskRecord, agent: AgentProfile, ctx: ReleaseContext): ReleaseDecision {
    if (this.paused) return { ok: false, reason: 'paused' }
    if (ctx.globalRunning >= this.config.globalConcurrency) {
      return { ok: false, reason: 'global-concurrency' }
    }
    if (ctx.agentRunning >= agent.plan.maxConcurrency) {
      return { ok: false, reason: 'agent-concurrency' }
    }
    const today = localDayOf(this.clock.now())
    if (this.ledger.countOf(agent.id, today) >= agent.plan.dailyTaskCap) {
      // 恢复放行时按当日重查 cap(暂停跨天场景),已记账份额不重复扣
      return { ok: false, reason: 'daily-cap' }
    }
    if (ctx.cwdOccupied) return { ok: false, reason: 'cwd-busy' }
    const allowedAt = this.nextAllowedAt.get(agent.id)
    if (allowedAt !== undefined) {
      const now = this.clock.monotonic()
      if (now < allowedAt) {
        return { ok: false, reason: 'interval', retryInMs: allowedAt - now }
      }
    }
    return { ok: true }
  }

  /** 放行后登记节拍:下次放行距现在 minInterval + 抖动 */
  markReleased(agentId: string): void {
    const gap = this.config.minIntervalMs + Math.random() * this.config.jitterMs
    this.nextAllowedAt.set(agentId, this.clock.monotonic() + gap)
  }

  /** 测试钩子:直接查看某客户端最早可放行时刻 */
  nextAllowedTimeOf(agentId: string): number | undefined {
    return this.nextAllowedAt.get(agentId)
  }
}
