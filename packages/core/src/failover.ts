import type { Orchestrator, TerminalListener } from './orchestrator.js'
import type { Registry } from './registry.js'
import type { AgentProfile, TaskRecord } from './types.js'

export interface FailoverCandidateContext {
  /** 强制绕过 health 缓存的探活函数(避免旧缓存造成降级死循环) */
  healthOf(agent: AgentProfile): Promise<{ ok: boolean }>
  /** 当前被 running 任务占用的 cwd 集合 */
  runningCwds(): Set<string>
  /** 当日已计数 */
  chargedToday(agent: AgentProfile): number
}

export interface FailoverOutcome {
  derived: TaskRecord | null
  /** 无可用目标时的原因,落回原任务 error 附言 */
  reason?: string
}

/**
 * 失败降级:failed 后按序筛选候选(跳过 disabled/满额/不健康/同 cwd 占用/不支持附件),
 * 换端派生新任务——model_id 映射为目标 default_model(各端命名空间不互通),
 * 附件与工具策略原样继承,attempt+1、retry_of 记链。
 * 换端不带 sessionId:各客户端会话命名空间不互通,续聊只在本端链内有效。
 */
export class Failover {
  constructor(
    private readonly registry: Registry,
    private readonly orchestrator: Orchestrator,
    private readonly config: { enabled: boolean; maxRetries: number },
  ) {}

  get enabled(): boolean {
    return this.config.enabled
  }

  async deriveFor(failedTask: TaskRecord, ctx: FailoverCandidateContext): Promise<FailoverOutcome> {
    if (!this.config.enabled) return { derived: null, reason: 'failover 未开启' }
    if (failedTask.attempt > this.config.maxRetries) {
      return { derived: null, reason: `已达最大降级次数 ${this.config.maxRetries}` }
    }
    if (ctx.runningCwds().has(failedTask.cwd)) {
      return { derived: null, reason: '工作区正被运行中任务占用' }
    }
    for (const candidate of this.orderedCandidates(failedTask.agentId)) {
      if (!candidate.enabled) continue
      if (ctx.chargedToday(candidate) >= candidate.plan.dailyTaskCap) continue
      if (failedTask.attachments.length > 0 && !candidate.capabilities.attachments) continue
      const health = await ctx.healthOf(candidate)
      if (!health.ok) continue
      try {
        const derived = this.orchestrator.submit({
          agentId: candidate.id,
          prompt: failedTask.prompt,
          cwd: failedTask.cwd,
          attachments: failedTask.attachments,
          toolPolicy: failedTask.toolPolicy,
          modelId: candidate.defaultModel,
          mode: failedTask.mode,
          origin: 'failover',
          attempt: failedTask.attempt + 1,
          retryOf: failedTask.id,
        })
        return { derived }
      } catch (error) {
        // 候选检查与派生之间存在竞态(如 cap 满),换下一候选
        void error
        continue
      }
    }
    return { derived: null, reason: '无可用降级目标' }
  }

  private orderedCandidates(excludeAgentId: string): AgentProfile[] {
    return this.registry.list().filter((profile) => profile.id !== excludeAgentId)
  }
}

/** 把降级挂到编排器终态事件上;失败信息以 warning 事件回填原任务时间线 */
export function attachFailover(
  orchestrator: Orchestrator,
  failover: Failover,
  ctx: FailoverCandidateContext,
): void {
  const listener: TerminalListener = (task) => {
    if (task.state !== 'failed') return
    void failover.deriveFor(task, ctx).then((outcome) => {
      if (outcome.derived) {
        orchestrator.emitTaskEvent(task.id, {
          kind: 'warning',
          text: `已降级派生新任务(客户端 ${outcome.derived.agentId},attempt=${outcome.derived.attempt})`,
        })
      } else if (outcome.reason) {
        orchestrator.emitTaskEvent(task.id, {
          kind: 'warning',
          text: `自动降级未执行:${outcome.reason}`,
        })
      }
    })
  }
  orchestrator.onTaskTerminal(listener)
}
