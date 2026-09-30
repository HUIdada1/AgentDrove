import type {
  AgentProfile,
  ModelId,
  TaskEvent,
  TaskInput,
} from './types.js'

export interface DriverRunOptions {
  agent: AgentProfile
  modelId: ModelId
  input: TaskInput
  emit: (event: TaskEvent) => void
  signal: AbortSignal
}

/**
 * 每个客户端一个实现,相互隔离。
 *
 * - resolveModel:把注册表的模型档位翻译为该客户端实际使用的模型标识,
 *   例如 config-file 型可在此返回写入配置用的模型名。
 * - run:负责拉起客户端进程/会话并产出统一事件流,返回进程退出码;
 *   signal 触发 abort 时应尽快终止并抛错。
 */
export interface AgentDriver {
  readonly id: string
  resolveModel(modelId: ModelId): ModelId
  run(options: DriverRunOptions): Promise<number>
}