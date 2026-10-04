export type AgentId = string
export type ModelId = string

export interface ModelPreset {
  id: ModelId
  label: string
}

export type ModelSwitchKind = 'cli-arg' | 'config-file' | 'profile' | 'none'

export interface AgentCapabilities {
  /** 是否支持无头执行(如 zcode -p);trae 这类只有 GUI 通道的客户端为 false */
  headless: boolean
  /** 是否支持会话续接(--resume/-c) */
  sessionResume: boolean
  /** 模型切换的实现方式;none = 模型跟随客户端当前会话(zcode 实测无 --model 参数) */
  modelSwitch: ModelSwitchKind
  /** 附件透传能力(不支持的客户端派发前提示,不静默丢弃) */
  attachments: boolean
}

export type QuotaKind = 'daily' | 'credits' | 'subscription'

/**
 * 套餐信息:本项目的核心意图是"套餐池化"——
 * 任务配发给某客户端执行时,消耗的是该客户端登录账号绑定的付费套餐。
 */
export interface PlanInfo {
  name: string
  quotaKind: QuotaKind
  /** 该套餐覆盖的模型档位;为空时回落到档案的 models 目录 */
  modelIds: ModelId[]
  /** 每日任务硬上限,入队时检查(默认 20) */
  dailyTaskCap: number
  /** 每客户端并发上限(默认 1) */
  maxConcurrency: number
  /** 套餐总点数(可选,如 1000 点) */
  totalCredits?: number
  /** 套餐 Token 配额(可选,如 150_000_000) */
  totalTokens?: number
}

/** 模型跟随客户端时任务记录的哨兵值(zcode 无模型参数,见 R2 实测降级) */
export const MODEL_CLIENT_FOLLOW = 'client-follow'

export interface AgentProfile {
  id: AgentId
  label: string
  /** 对应注册到 Orchestrator 的 driver id */
  driver: string
  /** 可执行入口(GUI 主程序),供唤起与探测 */
  entry: string
  /** 无头 CLI 入口;headless 客户端必填 */
  cliEntry?: string
  version?: string
  logoPath?: string
  models: ModelPreset[]
  /** failover 换端时的模型映射目标;modelSwitch=none 时填哨兵 client-follow */
  defaultModel: ModelId
  capabilities: AgentCapabilities
  plan: PlanInfo
  /** 停用后拒绝新任务入队,failover 候选也会跳过 */
  enabled: boolean
  /** driver 兼容版本范围声明,越界仅发 warning 不阻断 */
  supportedVersions?: string
}

export type TaskState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'

/** zcode --mode 档位;无头缺省是 yolo,派发必须显式传,绝不依赖客户端默认值 */
export type TaskMode = 'build' | 'edit' | 'plan' | 'yolo'

/**
 * 思考档位(P0-4):DTO 通用四档,驱动侧各自映射到 CLI 实际参数
 * (zcode 按 optionSpecs.reasoningLevel.values 取位,codex 映射 model_reasoning_effort);
 * 任务记录只存请求档位,实际生效档位以事件流 warning/info 为准。
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export type TaskOrigin =
  | 'panel' // 主面板发布框
  | 'hotkey' // 全局热键迷你条
  | 'selection' // 选中文本发送
  | 'tray' // 托盘快速派发
  | 'mcp' // MCP 网关
  | 'failover' // 失败降级/重试派生

export interface TaskAttachment {
  /** 引用原路径,不复制本体 */
  path: string
  kind: 'file' | 'image' | 'directory'
}

export interface ToolPolicy {
  /** 工具级禁用清单(zcode --disallowed-tools,不支持命令级 pattern) */
  denyList?: string[]
  maxTurns?: number | null
}

export interface TaskInput {
  prompt: string
  cwd: string
  /** 续聊目标会话(--resume <id>) */
  sessionId?: string
  /** 无目标会话时续接该工作区最近会话(zcode -c 语义) */
  resumeLatest?: boolean
  attachments?: TaskAttachment[]
  toolPolicy?: ToolPolicy
  mode?: TaskMode
}

export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  credits: number
  cacheHitRate: number
  cost?: number
}

export type TaskEvent =
  | { kind: 'state-changed'; from: TaskState; to: TaskState }
  | { kind: 'message'; channel: 'stdout' | 'stderr' | 'agent'; text: string }
  | { kind: 'progress'; text: string }
  | {
      kind: 'usage'
      inputTokens?: number
      outputTokens?: number
      cachedTokens?: number
      credits?: number
      cacheHitRate?: number
      cost?: number
    }
  | { kind: 'artifact'; path: string; change: 'added' | 'modified' | 'deleted' }
  | { kind: 'warning'; text: string }
  /**
   * 系统说明事件(P0-4):记录驱动侧实际生效的运行参数(如思考档位),
   * 详情侧以事件流实际值为准展示,避免 UI 撒谎;reasoningLevel 供结构化取值。
   */
  | { kind: 'info'; text: string; reasoningLevel?: string }

export type TaskEventKind = TaskEvent['kind']

/** 落库形态:payload 是事件本体,kind 冗余存储便于按类查询 */
export interface StoredEvent {
  taskId: string
  seq: number
  at: number
  event: TaskEvent
}

/**
 * 项目工作区(侧栏可选中):持久化实体,path 为 null 表示未绑定目录,
 * 派发时回落编排层默认工作目录;内置"日常工作区"即 path 可空的分组。
 */
export interface Project {
  id: string
  name: string
  /** null = 未绑定目录(纯分组) */
  path: string | null
  createdAt: number
}

export interface FollowupQueueItem {
  id: string
  parentTaskId: string
  prompt: string
  skills?: string[]
  createdAt: number
  /** 排队时随项记录的本轮覆盖参数(P0-6);缺省沿用父任务 */
  modelId?: ModelId
  mode?: TaskMode
  toolPolicy?: ToolPolicy
  reasoningEffort?: ReasoningEffort
}

/**
 * 续聊本轮参数(P0-6):缺省字段沿用父任务,完全向后兼容;
 * 排队时(queueIfRunning)整组覆盖随 FollowupQueueItem 落内存队列。
 */
export interface ContinueOptions {
  queueIfRunning?: boolean
  skills?: string[]
  /** 本轮覆盖:模型;缺省沿用 parent.modelId */
  modelId?: ModelId
  mode?: TaskMode
  toolPolicy?: ToolPolicy
  reasoningEffort?: ReasoningEffort
}

/** 追问队列自动接续推送(P0-6):父任务完成后排队消息落地为新任务 */
export interface FollowupContinuedEvent {
  /** 接续来源(父任务) */
  fromTaskId: string
  /** 接续落地的新任务 */
  toTaskId: string
}

export interface TaskRecord {
  id: string
  agentId: AgentId
  modelId: ModelId
  title?: string
  prompt: string
  cwd: string
  /** 派发时所属的项目工作区;历史任务/未选工作区为 undefined */
  projectId?: string
  state: TaskState
  /** 运行后提取到的会话 id,续聊链的锚点 */
  sessionId?: string
  /** 无具体会话 id 时续接该工作区最近会话(zcode -c 语义),随任务落库 */
  resumeLatest?: boolean
  parentId?: string
  error?: string
  attachments: TaskAttachment[]
  skills?: string[]
  toolPolicy?: ToolPolicy
  mode: TaskMode
  /** 请求的思考档位(P0-4);实际生效档位以事件流 warning/info 为准,避免 UI 撒谎 */
  reasoningEffort?: ReasoningEffort
  origin: TaskOrigin
  createdAt: number
  startedAt?: number
  finishedAt?: number
  retryOf?: string
  attempt: number
  /** 本次对话消耗统计与缓存命中率 */
  usage?: TaskUsage
}
