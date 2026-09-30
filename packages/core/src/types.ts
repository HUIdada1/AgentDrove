export type AgentId = string
export type ModelId = string

export interface ModelPreset {
  id: ModelId
  label: string
}

export type ModelSwitchKind = 'cli-arg' | 'config-file' | 'profile' | 'none'

export interface AgentCapabilities {
  /** 是否支持无头执行(如 zcode -p) */
  headless: boolean
  /** 是否支持会话续接(-c/-r) */
  sessionResume: boolean
  /** 模型切换的实现方式 */
  modelSwitch: ModelSwitchKind
}

export type QuotaKind = 'daily' | 'credits' | 'subscription'

/**
 * 套餐信息:本项目的核心意图是"套餐池化"——
 * 任务配发给某客户端执行时,消耗的是该客户端登录账号绑定的付费套餐。
 */
export interface PlanInfo {
  name: string
  quotaKind: QuotaKind
  /** 该套餐覆盖的模型档位;缺省回落到 profile.models */
  modelIds: ModelId[]
  /** 每日任务硬上限(风控节流,与套餐真实额度无关) */
  dailyTaskCap: number
}

export interface AgentProfile {
  id: AgentId
  label: string
  /** 对应注册到 Orchestrator 的 driver id */
  driver: string
  /** 可执行入口描述(命令 + 路径),供 L1 driver 使用 */
  entry: string
  models: ModelPreset[]
  defaultModel: ModelId
  maxConcurrency: number
  capabilities: AgentCapabilities
  plan?: PlanInfo
}

export type TaskState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface TaskInput {
  prompt: string
  cwd?: string
}

export type TaskEvent =
  | { type: 'state-changed'; from: TaskState; to: TaskState; at: number }
  | { type: 'message'; channel: 'stdout' | 'stderr' | 'agent'; text: string; at: number }
  | { type: 'artifact'; kind: string; path?: string; at: number }

export interface TaskRecord {
  id: string
  agentId: AgentId
  modelId: ModelId
  input: TaskInput
  state: TaskState
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  events: TaskEvent[]
}