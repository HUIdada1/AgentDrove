import type { BrowserWindow } from 'electron'
import type { UpdateStatus } from '@agent-drove/shared'
import type {
  AppPaths,
  AppConfig,
  ConfigSource,
  Failover,
  FileSystem,
  HealthCheckService,
  Launcher,
  Orchestrator,
  ProcessRunner,
  Registry,
  WorkspaceManager,
} from '@agent-drove/core'
import type { UpdateController } from './shell/updater.js'
import type { Logger } from './logger.js'
import type { SqliteStore } from './adapters/sqlite-repo.js'
import type { ArtifactTracking } from '@agent-drove/core'

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
  configSource: ConfigSource
  getConfig(): AppConfig
  saveConfig(next: AppConfig): void
  update: UpdateController
  logger: Logger
  getMainWindow(): BrowserWindow | null
  getMiniBar(): BrowserWindow | null
  /** 向渲染层推更新状态 */
  pushUpdateStatus(status: UpdateStatus): void
}
