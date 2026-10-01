import type {
  AgentId,
  AgentProfile,
  ModelId,
  ModelPreset,
  PlanInfo,
} from './types.js'
import { MODEL_CLIENT_FOLLOW } from './types.js'

const DEFAULT_DAILY_TASK_CAP = 20
const DEFAULT_MAX_CONCURRENCY = 1

function normalizePlan(plan: Partial<PlanInfo> | undefined, label: string): PlanInfo {
  return {
    name: plan?.name ?? label,
    quotaKind: plan?.quotaKind ?? 'subscription',
    modelIds: plan?.modelIds ?? [],
    // cap 与并发必须有确定值,节流器才能硬闸
    dailyTaskCap: plan?.dailyTaskCap ?? DEFAULT_DAILY_TASK_CAP,
    maxConcurrency: plan?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  }
}

/**
 * Agent 注册表:持有每个客户端的档案,负责模型档位的校验与解析。
 * 这是"控制各 agent + 每个 agent 可选模型"的数据核心。
 */
export class Registry {
  private agents = new Map<AgentId, AgentProfile>()

  register(raw: AgentProfile): void {
    if (this.agents.has(raw.id)) {
      throw new Error(`agent already registered: ${raw.id}`)
    }
    const profile: AgentProfile = { ...raw, plan: normalizePlan(raw.plan, raw.label) }
    // 模型跟随客户端的档案没有可选模型,默认模型即哨兵,豁免目录校验
    const followsClient =
      profile.capabilities.modelSwitch === 'none' &&
      profile.defaultModel === MODEL_CLIENT_FOLLOW
    if (!followsClient && !this.hasModelIn(profile, profile.defaultModel)) {
      throw new Error(
        `defaultModel "${profile.defaultModel}" not in models of "${profile.id}"`,
      )
    }
    if (profile.plan.maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be >= 1: ${profile.id}`)
    }
    this.agents.set(profile.id, profile)
  }

  get(id: AgentId): AgentProfile {
    const profile = this.agents.get(id)
    if (!profile) throw new Error(`unknown agent: ${id}`)
    return profile
  }

  list(): AgentProfile[] {
    return [...this.agents.values()]
  }

  setEnabled(id: AgentId, enabled: boolean): void {
    this.get(id).enabled = enabled
  }

  /** 套餐声明了覆盖范围时以套餐为准,否则回落模型目录 */
  hasModel(agentId: AgentId, modelId: ModelId): boolean {
    return this.hasModelIn(this.get(agentId), modelId)
  }

  private hasModelIn(profile: AgentProfile, modelId: ModelId): boolean {
    const covered = profile.plan.modelIds
    if (covered.length > 0) return covered.includes(modelId)
    return profile.models.some((m) => m.id === modelId)
  }

  /**
   * 缺省回落默认模型;非法模型直接抛错(拒绝下发)。
   * modelSwitch=none 的客户端统一透传哨兵,任务记录如实反映"跟随客户端"。
   */
  resolveModel(agentId: AgentId, modelId?: ModelId): ModelId {
    const profile = this.get(agentId)
    if (profile.capabilities.modelSwitch === 'none') return MODEL_CLIENT_FOLLOW
    if (modelId === undefined) return profile.defaultModel
    if (!this.hasModelIn(profile, modelId)) {
      throw new Error(
        `model "${modelId}" not available on agent "${agentId}"`,
      )
    }
    return modelId
  }

  modelPresets(agentId: AgentId): ModelPreset[] {
    const profile = this.get(agentId)
    if (profile.capabilities.modelSwitch === 'none') {
      // 无可选模型,UI 展示为"跟随客户端"
      return [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }]
    }
    return profile.models
  }
}
