import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ArtifactScanner,
  ArtifactTracking,
  CodexDriver,
  EventBuffer,
  Failover,
  attachFailover,
  HealthCheckService,
  Launcher,
  Orchestrator,
  QoderDriver,
  Registry,
  resolvePaths,
  localDayOf,
  TraeDriver,
  WorkspaceManager,
  ZcodeDriver,
  MODEL_CLIENT_FOLLOW,
  type AgentDriver,
  type AgentProfile,
  type DetectedAgent,
  type OrchestratorDeps,
} from '@agent-drove/core'
import type { UpdateStatus } from '@agent-drove/shared'
import { NodeFileSystem } from './adapters/node-fs.js'
import { NodeProcessRunner } from './adapters/node-process.js'
import { openStore, type SqliteStore } from './adapters/sqlite-repo.js'
import { loadYamlConfig, saveYamlConfig } from './adapters/yaml-config.js'
import { createFileLogger } from './logger.js'
import { registerIpcHandlers } from './ipc/handlers.js'
import type { AppContext } from './context.js'
import { acquireSingleInstance } from './shell/single-instance.js'
import { confirmExitWithRunning, createTray, showPanel } from './shell/tray.js'
import { createMiniBarWindow, registerHotkey, toggleMiniBar } from './shell/hotkey.js'
import { initUpdater } from './shell/updater.js'

if (!acquireSingleInstance(() => showPanel())) {
  app.quit()
} else {
  // 打包产物为 CJS,启动链路避免顶层 await
  void app.whenReady().then(() => {
    bootstrap().catch((error) => {
      dialog.showErrorBox(
        'AgentDrove 启动失败',
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      )
      app.exit(1)
    })
  })
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths()
  for (const dir of [paths.base, paths.data, paths.config, paths.logs, paths.logos, paths.workspaces, paths.bundles]) {
    mkdirSync(dir, { recursive: true })
  }
  const logger = createFileLogger(paths.logs)
  const runner = new NodeProcessRunner()
  const fs = new NodeFileSystem()

  const { store, recoveredFrom } = openStore(paths.db)
  if (recoveredFrom) {
    logger.warn('数据库已重建', { recoveredFrom })
    // 用一次性对话框:渲染桥未装好前 webContents.send 会丢,弹窗比通道可靠
    void dialog.showMessageBox({
      type: 'warning',
      message: '数据库损坏,已自动备份并重建',
      detail: `备份位置:${recoveredFrom}`,
    })
  }

  // 内置"日常工作区"(id 固定):未绑定目录=分组态,派发落默认工作区;绑定后可整组过滤
  if (!store.allProjects().some((p) => p.id === DAILY_PROJECT_ID)) {
    store.upsertProject({
      id: DAILY_PROJECT_ID,
      name: '日常工作区',
      path: null,
      createdAt: Date.now(),
    })
  }

  const { source: configSource, warning: configWarning } = loadYamlConfig(paths.config)
  const config = configSource.load()
  if (configWarning) logger.warn('配置文件损坏,按内置默认运行', { file: configWarning })

  // 主窗在主进程启动早期创建:更新状态/热键冲突等推送若先于此,渲染层桥尚未装好会丢
  const entryUrl = await loadEntryUrl()
  const mainWindow = createMainWindow(entryUrl)
  const miniBar = createMiniBarWindow(entryUrl)

  // ---- 客户端探测与注册(探测结果 + agents 表恢复启用状态)----
  const registry = new Registry()
  const drivers = new Map<string, AgentDriver>()
  const zcodeCli = process.env.AGENTDROVE_ZCODE_CLI ?? 'E:\\ZCode\\resources\\glm\\zcode.cjs'
  const zcodeDriver = new ZcodeDriver(runner, fs, { nodeBin: process.execPath, cliPath: zcodeCli })
  const qoderDriver = new QoderDriver(runner, fs)
  const traeDriver = new TraeDriver(runner, fs)
  const codexDriver = new CodexDriver(runner, fs)
  drivers.set(zcodeDriver.id, zcodeDriver)
  drivers.set(qoderDriver.id, qoderDriver)
  drivers.set(traeDriver.id, traeDriver)
  drivers.set(codexDriver.id, codexDriver)

  const savedAgents = new Map(store.allAgents().map((row) => [row.id, row]))
  const registerDetected = (detected: DetectedAgent, plan: AgentPlanOptions): void => {
    const profile = buildProfile(detected, plan, savedAgents.get(detected.id)?.enabled)
    registry.register(profile)
    persistAgent(store, profile)
  }

  const zcodeRoot = zcodeCli.replace(/[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i, '')
  const zcodeDetected = await zcodeDriver.detect([zcodeRoot, zcodeCli])
  if (zcodeDetected) {
    registerDetected(zcodeDetected, {
      planName: 'GLM Coding Plan',
      quota: 'daily',
      models: [],
      followClient: true,
      attachments: true,
    })
  }
  const traeRoots = (process.env.AGENTDROVE_TRAE_ROOTS ?? 'E:\\Trae_guoji;E:\\Trae')
    .split(';')
    .filter(Boolean)
  const traeDetected = await traeDriver.detect(traeRoots)
  if (traeDetected) {
    registerDetected(traeDetected, {
      planName: 'Trae 官方套餐',
      quota: 'subscription',
      models: [],
      followClient: true,
      attachments: true,
    })
  }
  if (await commandExists('qoderclicn')) {
    const qoderDetected = await qoderDriver.detect(['qoderclicn'])
    if (qoderDetected) {
      registerDetected(qoderDetected, {
        planName: 'Qoder Credits',
        quota: 'credits',
        // V5 复测回填前给占位模型目录;注册表校验要求 defaultModel ∈ models
        models: [{ id: 'qoder-default', label: '默认模型' }],
        followClient: false,
        attachments: false,
      })
    }
  }
  if (await commandExists('codex')) {
    const codexDetected = await codexDriver.detect(
      [process.env.AGENTDROVE_CODEX_CLI ?? 'codex'].filter(Boolean),
    )
    if (codexDetected) {
      registerDetected(codexDetected, {
        planName: 'ChatGPT 套餐',
        quota: 'subscription',
        // 模型档位由 resolveModelArg 透传 --model;client-follow 时恒空
        models: CODEX_MODELS,
        followClient: false,
        attachments: false,
      })
    }
  }

  // ---- 核心装配 ----
  const scanner = new ArtifactScanner(runner, fs)
  const artifactTracking = new ArtifactTracking(scanner, store)
  const sink = new EventBuffer(store, (batch) => {
    notifyRenderer('tasks:events-batch', batch)
    notifyRenderer('tasks:updated')
  })
  const orchestratorDeps: OrchestratorDeps = {
    repo: store,
    sink,
    defaultCwd: paths.defaultWorkspace,
    defaultTimeoutMs: config.task.defaultTimeoutMs,
    journal: store,
    onRunStart: (task) => artifactTracking.onRunStart(task),
    onRunEnd: (task) => artifactTracking.onRunEnd(task, orchestrator),
    // 放行健康闸走 60s TTL 缓存;手动重查与降级筛选由各自入口 bypass
    healthAtRelease: (agentId) => health.check(agentId),
  }
  const orchestrator = new Orchestrator(registry, orchestratorDeps)
  for (const driver of drivers.values()) orchestrator.registerDriver(driver)

  const workspaces = new WorkspaceManager(
    fs,
    runner,
    { now: Date.now, monotonic: () => performance.now() },
    store,
  )
  const failover = new Failover(registry, orchestrator, config.task.failover)

  // userdir 登记(派生工作区在派发时已登记);终态迁移 active→done
  orchestrator.onTaskSubmitted((task) => {
    const known = store.all().some((row) => row.taskId === task.id)
    if (!known) workspaces.registerUserDir(task.cwd, task.id)
  })
  orchestrator.onTaskTerminal((task) => workspaces.markDoneForTask(task.id))

  const health = new HealthCheckService((agentId) => {
    const profile = registry.get(agentId)
    const driver = drivers.get(profile.driver)
    if (!driver) return Promise.resolve({ ok: false, reason: 'no driver' })
    return driver.health(profile)
  })
  const launcher = new Launcher({
    openExternal: (target) => shell.openExternal(target),
    spawnDetached: (entry) => {
      spawn(entry, [], { detached: true, shell: true, stdio: 'ignore' }).unref()
    },
  })

  attachFailover(orchestrator, failover, {
    healthOf: (agent) => health.check(agent.id, { bypassCache: true }),
    runningCwds: () =>
      new Set(orchestrator.list().filter((t) => t.state === 'running').map((t) => t.cwd)),
    chargedToday: (agent) => store.countOf(agent.id, localDayOf(Date.now())),
  })

  orchestrator.throttleState.setPaused(config.schedulerPaused)

  // ---- 保留期清理:启动时 + 每 24h(5.4)----
  const purge = (): void => {
    const now = Date.now()
    const removedTasks = store.purgeTasksBefore(now - 90 * 24 * 3600_000)
    const removedJournal = store.purgeJournalBefore(now - 180 * 24 * 3600_000)
    void workspaces.cleanupExpired(now).then((cleaned) => {
      if (cleaned.length > 0) logger.info('到期工作区已清理', { count: cleaned.length })
    })
    if (removedTasks > 0 || removedJournal > 0) {
      logger.info('保留期清理完成', { removedTasks, removedJournal })
    }
  }
  purge()
  const purgeTimer = setInterval(purge, 24 * 3600_000)

  // ---- 更新(轨道 A):状态推送广播到所有窗口,设置页在迷你条里同样看得到进度 ----
  const pushUpdateStatus = (status: UpdateStatus): void => {
    notifyRenderer('update:status', status)
  }
  const update = initUpdater({
    autoDownload: config.update.autoDownload,
    onStatus: pushUpdateStatus,
  })

  // ---- 托盘 / 热键 ----
  const tray = createTray({
    orchestrator,
    registry,
    iconPath: resolveIconPath(),
    isPaused: () => orchestrator.isPaused(),
    setPaused: (paused) => {
      orchestrator.setPaused(paused)
      saveYamlConfig(paths.config, { ...configSource.load(), schedulerPaused: paused })
      notifyRenderer('scheduler:changed', paused)
    },
    checkUpdates: () => update.checkForUpdates(),
    launchClient: (agentId) => {
      void launcher.launchClient(registry.get(agentId))
    },
    onQuitRequested: async () => {
      const running = orchestrator.list().filter((t) => t.state === 'running').length
      if (running === 0) return 'cancel-and-exit'
      return confirmExitWithRunning(running)
    },
  })

  const unregisterHotkey = registerHotkey({
    accelerator: config.hotkey,
    onActivate: () => toggleMiniBar(miniBar),
    onRegisterFailed: (accelerator) => {
      logger.warn('全局热键注册失败(可能冲突)', { accelerator })
      notifyRenderer('hotkey:conflict', accelerator)
    },
  })

  // ---- 组合根上下文 + IPC ----
  const ctx: AppContext = {
    paths,
    store,
    registry,
    orchestrator,
    health,
    launcher,
    workspaces,
    failover,
    artifactTracking,
    processRunner: runner,
    fs,
    configSource,
    getConfig: () => configSource.load(),
    saveConfig: (next) => saveYamlConfig(paths.config, next),
    update,
    logger,
    getMainWindow: () => mainWindow,
    getMiniBar: () => miniBar,
    pushUpdateStatus,
  }
  registerIpcHandlers(ctx)
  void tray

  // 生命周期:关闭=隐藏到托盘(7.1);托盘"退出"走 app.exit 触发 before-quit 绕过本分支
  let forceQuit = false
  app.on('browser-window-created', (_event, win) => {
    win.on('close', (closeEvent) => {
      if (!forceQuit) {
        closeEvent.preventDefault()
        win.hide()
      }
    })
  })
  app.on('before-quit', () => {
    forceQuit = true
    unregisterHotkey()
    clearInterval(purgeTimer)
    update.dispose()
    sink.flush()
    try {
      store.close()
    } catch {
      // WAL 已落盘,关闭失败不阻断退出
    }
  })
}

/** 主→渲染单向推送统一出口:广播所有窗口(主窗与迷你条),空窗时静默丢弃 */
function notifyRenderer(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

// 打包成 CJS 后 import.meta.dirname 由打包器 define 成 __dirname;tsx 直跑时手动兜底
const HERE = import.meta.dirname ?? dirname(pathToFileURL(import.meta.url).pathname)

/** 套餐日上限占位值:三类客户端均无公开日任务数口径,先给保守默认,设置页后续可调 */
const DEFAULT_DAILY_TASK_CAP = 20
/** 单机调度按串行起步,避免同一客户端并发挤兑套餐 */
const DEFAULT_AGENT_CONCURRENCY = 1

/** 内置日常工作区的固定 id:重启幂等恢复,UI 禁止删除 */
export const DAILY_PROJECT_ID = 'daily'

/** Codex CLI 模型档位目录(0.2x 口径);模型跟随登录套餐,失败档位运行期由 CLI 报错兜底 */
const CODEX_MODELS = [
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
]

interface AgentPlanOptions {
  planName: string
  quota: 'daily' | 'credits' | 'subscription'
  models: Array<{ id: string; label: string }>
  followClient: boolean
  attachments: boolean
}

/** 探测结果 → 注册档案:启用状态以 agents 表为准(用户在 UI 停用过则保持停用) */
function buildProfile(
  detected: DetectedAgent,
  options: AgentPlanOptions,
  savedEnabled?: boolean,
): AgentProfile {
  return {
    id: detected.id,
    label: detected.label,
    driver: detected.id,
    entry: detected.entry,
    cliEntry: detected.cliEntry,
    version: detected.version,
    logoPath: detected.logoPath,
    models: options.models,
    defaultModel: options.followClient
      ? MODEL_CLIENT_FOLLOW
      : options.models[0]?.id ?? MODEL_CLIENT_FOLLOW,
    capabilities: {
      headless: detected.id !== 'trae',
      sessionResume: detected.id !== 'trae',
      modelSwitch: options.followClient ? 'none' : 'cli-arg',
      attachments: options.attachments,
    },
    plan: {
      name: options.planName,
      quotaKind: options.quota,
      modelIds: options.models.map((m) => m.id),
      dailyTaskCap: DEFAULT_DAILY_TASK_CAP,
      maxConcurrency: DEFAULT_AGENT_CONCURRENCY,
    },
    enabled: savedEnabled ?? true,
  }
}

/** agents 表落库唯一入口:启动登记与启停切换共用,字段口径只维护一份 */
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

function createMainWindow(entryUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1216',
    title: 'AgentDrove',
    webPreferences: {
      preload: join(HERE, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(entryUrl)
  return win
}

async function loadEntryUrl(): Promise<string> {
  const devServer = process.env.VITE_DEV_SERVER_URL
  if (devServer) return devServer
  // 打包:dist/app.cjs + renderer/index.html;开发:packages/main/dist + packages/renderer/dist
  const packaged = join(HERE, '..', 'renderer', 'index.html')
  const dev = join(HERE, '../../renderer/dist/index.html')
  return pathToFileURL(existsSync(packaged) ? packaged : dev).href
}

function resolveIconPath(): string {
  const candidates = [join(HERE, '../../build/icon.png'), join(HERE, '../build/icon.png')]
  return candidates.find((p) => existsSync(p)) ?? ''
}

function commandExists(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const result = spawnSync('where', [name], { timeout: 5000, windowsHide: true })
    resolve(result.status === 0)
  })
}
