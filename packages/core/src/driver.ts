import type {
  AgentProfile,
  ModelId,
  ModelPreset,
  TaskEvent,
  TaskInput,
} from './types.js'

export interface DriverRunOptions {
  agent: AgentProfile
  modelId: ModelId
  input: TaskInput
  /** 事件经编排器包装(seq/时间戳)后落 sink,driver 只管发 */
  emit(event: TaskEvent): void
  signal: AbortSignal
  onSpawn?: (pid: number) => void
  /** 看门狗时长;不传按驱动内置默认 */
  timeoutMs?: number
}

export interface DriverUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 驱动看门狗缺省时长;编排层注入的 defaultTimeoutMs 优先于此值 */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000

export interface RunResult {
  code: number
  /** 从输出中提取到的会话 id,续聊链依赖它;提取不到为 undefined */
  sessionId?: string
  usage?: DriverUsage
}

/**
 * 每个客户端一个实现,相互隔离,单客户端崩溃不外溢。
 * resolveModelArg 把模型档位翻译为该客户端的 CLI 参数(zcode 无模型参数,返回空)。
 * run 负责拉起客户端进程并产出统一事件流;signal abort 时必须终止进程树并尽快返回。
 */
export interface AgentDriver {
  readonly id: string
  readonly supportedVersions?: string
  /** 在候选入口中探测本客户端;未命中返回 null */
  detect(entries: string[]): Promise<DetectedAgent | null>
  /** 探活(如 doctor);登录态缺失等不健康场景返回 ok:false + reason */
  health(agent: AgentProfile): Promise<{ ok: boolean; reason?: string }>
  resolveModelArg(modelId: ModelId, agent: AgentProfile): string[]
  run(options: DriverRunOptions): Promise<RunResult>
  /** 拉取套餐可选模型(qoder 可刷新;zcode 不支持,不实现) */
  fetchModels?(agent: AgentProfile): Promise<ModelPreset[]>
}

export interface DetectedAgent {
  id: string
  label: string
  entry: string
  version?: string
  logoPath?: string
  /** 无头 CLI 入口,与 GUI entry 分开登记 */
  cliEntry?: string
}
