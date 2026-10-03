import type { BrowserWindow } from 'electron'
import type { UpdateStatus } from '@agent-drove/shared'
import type {
  AppPaths,
  AppConfig,
  Failover,
  FileSystem,
  HealthCheckService,
  Launcher,
  Orchestrator,
  ProcessRunner,
  Registry,
  WorkspaceManager,
} from '@agent-drove/core'
import type { AgentProfile } from '@agent-drove/core'
import type { UpdateController } from './shell/updater.js'
import type { Logger } from './logger.js'
import type { SqliteStore } from './adapters/sqlite-repo.js'
import type { ArtifactTracking } from '@agent-drove/core'

/** 内置"日常工作区"的固定 id:重启幂等恢复,UI 禁止删除 */
export const DAILY_PROJECT_ID = 'daily'

/**
 * agents 表落库唯一入口:启动登记与启停切换共用,字段口径只维护一份。
 * 放在组合根上下文模块(而非 app.ts),避免 ipc/handlers ↔ app 的循环依赖。
 */
export function persistAgent(store: SqliteStore, profile: AgentProfile): void {
  store.upsertAgent({
    id: profile.id,
    label: profile.label,
    driver: profile.driver,
    entry: profile.entry,
    version: profile.version,
    logoPath: profile.logoPath,
    plan: profile.plan,
    models: profile.models,
    defaultModel: profile.defaultModel,
    enabled: profile.enabled,
    supportedVersions: profile.supportedVersions,
  })
}

export interface AppContext {
  paths: AppPaths
  store: SqliteStore
  registry: Registry
  orchestrator: Orchestrator
  health: HealthCheckService
  launcher: Launcher
  workspaces: WorkspaceManager
  failover: Failover
  /** 产物跟踪与扫描依赖(合并产物/补扫复用) */
  artifactTracking: ArtifactTracking
  processRunner: ProcessRunner
  fs: FileSystem
  getConfig(): AppConfig
  saveConfig(next: AppConfig): void
  update: UpdateController
  /** 重新探测本机客户端并登记(幂等,保留用户启停状态);探测细节封装在组合根,handler 不接触 */
  rescanAgents(): Promise<void>
  /** 热键改键后立即重注册(设置页保存热键时调用) */
  applyHotkey(accelerator: string): void
  logger: Logger
  getMainWindow(): BrowserWindow | null
  /** 向渲染层推更新状态 */
  pushUpdateStatus(status: UpdateStatus): void
}
