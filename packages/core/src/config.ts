import type { TaskMode } from './types.js'

export interface ThrottleConfig {
  globalConcurrency: number
  minIntervalMs: number
  jitterMs: number
}

export interface FailoverConfig {
  enabled: boolean
  maxRetries: number
}

export interface UiConfig {
  theme: 'auto' | 'light' | 'dark'
  language: 'zh-CN'
  startMinimized: boolean
  autoStart: boolean
}

export interface NotifyConfig {
  onComplete: boolean
  onFail: boolean
}

export interface McpConfig {
  enabled: boolean
  port: number
}

export interface UpdateConfig {
  channel: 'stable'
  autoDownload: boolean
}

/**
 * 单客户端套餐校准(G5-02):用户在设置页对注册默认值的覆盖。
 * remainingCredits/remainingTokens 为"显式剩余值"模式——zcode 等本地口径
 * 无法对齐启用本应用之前的用量时,由用户直接填当前剩余,余量按此展示。
 *
 * K-02 滚动扣减:显式剩余值写入时同时记录当时的周期消耗快照(calibratedConsumed*),
 * 余量改为 `base − max(0, 当前周期消耗 − 快照)`,随后续消耗自动递减;
 * remainingCredits/remainingTokens 保留为 base 初值(旧数据零迁移,旧版本读取语义不变)。
 * K-03 周期口径:cycleDays>0 时周期起点按 now 对齐的固定窗口计算,缺省=自首次任务累计(近似)。
 */
export interface PlanOverrideConfig {
  quotaKind?: 'credits' | 'daily' | 'subscription'
  totalCredits?: number
  totalTokens?: number
  dailyTaskCap?: number
  remainingCredits?: number
  remainingTokens?: number
  calibratedAt?: number
  /** K-02:校准当时的剩余点数(滚动扣减基准);旧数据缺失时回落 remainingCredits */
  remainingCreditsBase?: number
  /** K-02:校准当时的剩余 Token(滚动扣减基准);旧数据缺失时回落 remainingTokens */
  remainingTokensBase?: number
  /** K-02:校准当时的周期累计消耗点数快照(与余量计算同口径,含 zcode 本地库合并值) */
  calibratedConsumedCredits?: number
  /** K-02:校准当时的周期累计消耗 Token 快照 */
  calibratedConsumedTokens?: number
  /**
   * K-03:套餐周期天数;>0 = 周期起点按本地零点锚定的固定窗口对齐(如 30/31 天),
   * 缺省/0 = 自首次任务累计(近似)口径,即既有行为。
   */
  cycleDays?: number
}

export interface AppConfig {
  task: {
    defaultTimeoutMs: number
    failover: FailoverConfig
    /** 重试会再消耗套餐,默认确认 */
    confirmRetry: boolean
    defaultToolPolicy: { denyList: string[]; maxTurns: number | null }
    defaultMode: TaskMode
    workspaceCleanupHours: number
  }
  ui: UiConfig
  hotkey: string
  throttle: ThrottleConfig
  notify: NotifyConfig
  mcp: McpConfig
  /** 托盘"暂停调度"=放行闸,持久化,重启恢复 */
  schedulerPaused: boolean
  /** --mode yolo 默认禁止,Danger 区二次确认后开启 */
  danger: { allowYolo: boolean }
  update: UpdateConfig
  /** 按 agentId 的套餐校准(G5-02);设置页写入,组装档案与额度计算时优先应用 */
  planOverrides?: Record<string, PlanOverrideConfig>
}

export const DEFAULT_CONFIG: AppConfig = {
  task: {
    defaultTimeoutMs: 600_000,
    failover: { enabled: false, maxRetries: 1 },
    confirmRetry: true,
    defaultToolPolicy: { denyList: [], maxTurns: null },
    defaultMode: 'build',
    workspaceCleanupHours: 24,
  },
  ui: { theme: 'auto', language: 'zh-CN', startMinimized: true, autoStart: false },
  hotkey: 'Ctrl+Shift+Space',
  throttle: { globalConcurrency: 2, minIntervalMs: 8000, jitterMs: 4000 },
  notify: { onComplete: true, onFail: true },
  mcp: { enabled: false, port: 18731 },
  schedulerPaused: false,
  danger: { allowYolo: false },
  update: { channel: 'stable', autoDownload: true },
}

/** 用户覆盖与内置默认合并;非对象/缺失字段一律回落默认,用户手改 YAML 不至于炸启动 */
export function mergeConfig(defaults: AppConfig, override: unknown): AppConfig {
  return deepMerge(defaults, override) as AppConfig
}

/** 始终重建对象/数组,避免默认值嵌套引用被调用方意外改写;非对象覆盖整体忽略 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base)) {
    const patchObject = isPlainObject(patch) ? patch : {}
    const out: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(base), ...Object.keys(patchObject)])) {
      out[key] = deepMerge(base[key], patchObject[key])
    }
    return out
  }
  // 数组叶子(如 denyList)必须克隆;patch 数组同样克隆,否则用户配置的数组引用被改穿;
  // patch 非数组(手改 yaml 写错类型)按"非对象覆盖忽略"处理,保留默认数组避免标量穿透炸派发
  if (Array.isArray(base)) {
    if (patch === undefined) return [...base]
    return Array.isArray(patch) ? [...patch] : [...base]
  }
  return patch === undefined ? base : patch
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 配置来源端口:组合根提供 YAML 实现,核心只读结构化配置 */
export interface ConfigSource {
  load(): AppConfig
}
