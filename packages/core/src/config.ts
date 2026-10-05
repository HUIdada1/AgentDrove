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
 */
export interface PlanOverrideConfig {
  quotaKind?: 'credits' | 'daily' | 'subscription'
  totalCredits?: number
  totalTokens?: number
  dailyTaskCap?: number
  remainingCredits?: number
  remainingTokens?: number
  calibratedAt?: number
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
