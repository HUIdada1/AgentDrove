import type { AgentId, AgentProfile, ModelId } from './types.js'

/**
 * Agent 注册表:持有每个客户端的档案,负责模型档位的校验与解析。
 * 这是"控制各 agent + 每个 agent 可选模型"的数据核心。
 */
export class Registry {
  private agents = new Map<AgentId, AgentProfile>()

  register(profile: AgentProfile): void {
    if (this.agents.has(profile.id)) {
      throw new Error(`agent already registered: ${profile.id}`)
    }
    if (!profile.models.some((m) => m.id === profile.defaultModel)) {
      throw new Error(
        `defaultModel "${profile.defaultModel}" not in models of "${profile.id}"`,
      )
    }
    if (profile.maxConcurrency < 1) {
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

  hasModel(agentId: AgentId, modelId: ModelId): boolean {
    return this.get(agentId).models.some((m) => m.id === modelId)
  }

  /** 缺省回落到默认模型;非法模型直接抛错(拒绝下发)。 */
  resolveModel(agentId: AgentId, modelId?: ModelId): ModelId {
    const profile = this.get(agentId)
    if (modelId === undefined) return profile.defaultModel
    if (!this.hasModel(agentId, modelId)) {
      throw new Error(
        `model "${modelId}" not available on agent "${agentId}"`,
      )
    }
    return modelId
  }
}