import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ArtifactScanner,
  ArtifactTracking,
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
import { openStore } from './adapters/sqlite-repo.js'
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
    // 延迟到主窗口出现后再提示,避免启动时序吞掉弹窗
    setTimeout(() => {
      void dialog.showMessageBox({
        type: 'warning',
        message: '数据库损坏,已自动备份并重建',
        detail: `备份位置:${recoveredFrom}`,
      })
    }, 1200)
  }

  const { source: configSource, warning: configWarning } = loadYamlConfig(paths.config)
  const config = configSource.load()
  if (configWarning) logger.warn('配置文件损坏,按内置默认运行', { file: configWarning })

  // ---- 客户端探测与注册(探测结果 + agents 表恢复启用状态)----
  const registry = new Registry()
  const drivers = new Map<string, AgentDriver>()
  const zcodeCli = process.env.AGENTDROVE_ZCODE_CLI ?? 'E:\\ZCode\\resources\\glm\\zcode.cjs'
  const zcodeDriver = new ZcodeDriver(runner, fs, { nodeBin: process.execPath, cliPath: zcodeCli })
  const qoderDriver = new QoderDriver(runner, fs)
  const traeDriver = new TraeDriver(runner, fs)
  drivers.set(zcodeDriver.id, zcodeDriver)
  drivers.set(qoderDriver.id, qoderDriver)
  drivers.set(traeDriver.id, traeDriver)

  const savedAgents = new Map(store.allAgents().map((row) => [row.id, row]))
  const registerDetected = (
    detected: DetectedAgent,
    options: {
      planName: string
      quota: 'daily' | 'credits' | 'subscription'
      models: Array<{ id: string; label: string }>
      followClient: boolean
      attachments: boolean
    },
  ): void => {
    const profile: AgentProfile = {
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
        : options.models[0]?.id ?? 'client-follow',
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
        dailyTaskCap: 20,
        maxConcurrency: 1,
      },
      enabled: savedAgents.get(detected.id)?.enabled ?? true,
    }
    registry.register(profile)
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

  // ---- 核心装配 ----
  const scanner = new ArtifactScanner(runner, fs)
  const artifactTracking = new ArtifactTracking(scanner, store)
  const sink = new EventBuffer(store, (batch) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tasks:events-batch', batch)
    }
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

  // ---- 窗口 ----
  const entryUrl = await loadEntryUrl()
  const mainWindow = createMainWindow(entryUrl)
  const miniBar = createMiniBarWindow(entryUrl)

  // ---- 更新(轨道 A)----
  const pushUpdateStatus = (status: UpdateStatus): void => {
    mainWindow.webContents.send('update:status', status)
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
      mainWindow.webContents.send('scheduler:changed', paused)
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
      mainWindow.webContents.send('hotkey:conflict', accelerator)
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

  // 生命周期:关闭=隐藏到托盘(7.1);托盘"退出"走 app.exit 绕过本分支
  let forceQuit = false
  mainWindow.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  app.on('before-quit', () => {
    forceQuit = true
    unregisterHotkey()
    clearInterval(purgeTimer)
    sink.flush()
    try {
      store.close()
    } catch {
      // WAL 已落盘,关闭失败不阻断退出
    }
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
      preload: join(import.meta.dirname, 'preload', 'index.cjs'),
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
  const packaged = join(import.meta.dirname, '..', 'renderer', 'index.html')
  const dev = join(import.meta.dirname, '../../renderer/dist/index.html')
  return pathToFileURL(existsSync(packaged) ? packaged : dev).href
}

function resolveIconPath(): string {
  const candidates = [
    join(import.meta.dirname, '../../build/icon.png'),
    join(import.meta.dirname, '../build/icon.png'),
  ]
  return candidates.find((p) => existsSync(p)) ?? ''
}

function commandExists(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const result = spawnSync('where', [name], { timeout: 5000, windowsHide: true })
    resolve(result.status === 0)
  })
}
