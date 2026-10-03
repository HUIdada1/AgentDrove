import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  Throttle,
  TraeDriver,
  WorkspaceManager,
  ZcodeDriver,
  MODEL_CLIENT_FOLLOW,
  type AgentDriver,
  type AgentProfile,
  type Clock,
  type DetectedAgent,
  type OrchestratorDeps,
} from '@agent-drove/core'
import type { UpdateStatus } from '@agent-drove/shared'
import { NodeFileSystem } from './adapters/node-fs.js'
import { NodeProcessRunner } from './adapters/node-process.js'
import { openStore, type SqliteStore } from './adapters/sqlite-repo.js'
import { loadYamlConfig, saveYamlConfig } from './adapters/yaml-config.js'
import { createFileLogger, type Logger } from './logger.js'
import { registerIpcHandlers } from './ipc/handlers.js'
import { DAILY_PROJECT_ID, persistAgent, type AppContext } from './context.js'
import { acquireSingleInstance } from './shell/single-instance.js'
import { confirmExitWithRunning, createTray, showPanel } from './shell/tray.js'
import { createMiniBarWindow, registerHotkey, toggleMiniBar } from './shell/hotkey.js'
import { initUpdater } from './shell/updater.js'

// 单实例唤起与启动竞态:窗口就绪前的 second-instance 请求先挂起,就绪后补执行
let panelReady = false
let pendingShowPanel = false

function requestShowPanel(): void {
  if (panelReady) showPanel()
  else pendingShowPanel = true
}

if (!acquireSingleInstance(requestShowPanel)) {
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

/**
 * 运行期环境变量(集中登记,便于部署排查):
 * - AGENTDROVE_HOME:数据根目录重定向(默认 %APPDATA%\AgentDrove,见 core resolvePaths)
 * - AGENTDROVE_ZCODE_CLI / AGENTDROVE_TRAE_ROOTS / AGENTDROVE_CODEX_CLI:客户端探测路径覆盖
 * - AGENTDROVE_UPDATE_OWNER / AGENTDROVE_UPDATE_REPO:更新源覆盖(默认同 electron-builder.yml)
 * - VITE_DEV_SERVER_URL:开发期渲染层 dev server 地址
 */
async function bootstrap(): Promise<void> {
  const paths = resolvePaths()
  const allDirs = [
    paths.base,
    paths.data,
    paths.config,
    paths.logs,
    paths.logos,
    paths.workspaces,
    paths.defaultWorkspace,
    paths.bundles,
  ]
  for (const dir of allDirs) {
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

  // 系统菜单(File/Edit/View/...)整条移除:窗口改用自绘标题栏,菜单占位一并去掉
  Menu.setApplicationMenu(null)

  // 关闭=隐藏到托盘(7.1):监听必须在任何 BrowserWindow 创建前注册,
  // 否则已存在的窗口不覆盖 browser-window-created,关闭会真的销毁窗口而非隐藏
  let forceQuit = false
  app.on('browser-window-created', (_event, win) => {
    win.on('close', (closeEvent) => {
      if (!forceQuit) {
        closeEvent.preventDefault()
        win.hide()
      }
    })
  })

  // 主窗在主进程启动早期创建:更新状态/热键冲突等推送若先于此,渲染层桥尚未装好会丢
  const entryUrl = await loadEntryUrl()
  const mainWindow = createMainWindow(entryUrl)
  const miniBar = createMiniBarWindow(entryUrl)

  // 窗口已就绪:补执行启动期间挂起的"唤起面板"请求(second-instance 竞态)
  panelReady = true
  if (pendingShowPanel) {
    pendingShowPanel = false
    showPanel()
  }

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
  await detectAndRegisterAgents({ store, registry, logger, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver })

  // ---- 核心装配 ----
  const scanner = new ArtifactScanner(runner, fs)
  const artifactTracking = new ArtifactTracking(scanner, store)
  const sink = new EventBuffer(store, (batch) => {
    notifyRenderer('tasks:events-batch', batch)
    notifyRenderer('tasks:updated')
  })
  // 时钟与节流器必须显式注入。缺省时 Orchestrator 会回落到内存台账 + 不限流兜底,
  // 用户配置的日上限/并发/节拍将全部失效,且重启后当日计数归零;
  // SqliteStore 同时实现 UsageLedger,是跨重启的唯一记账事实源。
  const clock: Clock = { now: Date.now, monotonic: () => performance.now() }
  const throttle = new Throttle(store, clock, config.throttle, config.schedulerPaused)

  const orchestratorDeps: OrchestratorDeps = {
    repo: store,
    sink,
    clock,
    throttle,
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

  const workspaces = new WorkspaceManager(fs, runner, clock, store)
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

  // ---- 保留期清理:启动时 + 每 24h(5.4)----
  const purge = (): void => {
    const now = Date.now()
    try {
      const removedTasks = store.purgeTasksBefore(now - 90 * 24 * 3600_000)
      const removedJournal = store.purgeJournalBefore(now - 180 * 24 * 3600_000)
      if (removedTasks > 0 || removedJournal > 0) {
        logger.info('保留期清理完成', { removedTasks, removedJournal })
      }
    } catch (error) {
      // 定时清理失败不能击穿主进程,留日志下一轮再试
      logger.warn('保留期清理失败', { error: error instanceof Error ? error.message : String(error) })
    }
    void workspaces
      .cleanupExpired(now)
      .then((cleaned) => {
        if (cleaned.length > 0) logger.info('到期工作区已清理', { count: cleaned.length })
      })
      .catch((error: unknown) => {
        logger.warn('到期工作区清理失败', { error: error instanceof Error ? error.message : String(error) })
      })
  }
  purge()
  const purgeTimer = setInterval(purge, 24 * 3600_000)

  // ---- 更新(轨道 A):状态推送广播到所有窗口,设置页在迷你条里同样看得到进度 ----
  const pushUpdateStatus = (status: UpdateStatus): void => {
    notifyRenderer('update:status', status)
  }
  const update = initUpdater({
    autoDownload: config.update.autoDownload,
    // 未打包环境 GitHub provider 必然拉不到 release,自动检查只会刷错误状态;dev 下仅手动检查
    enabled: app.isPackaged,
    onStatus: pushUpdateStatus,
  })

  // ---- 托盘 / 热键 ----
  createTray({
    orchestrator,
    registry,
    iconPath: resolveIconPath(),
    isPaused: () => orchestrator.isPaused(),
    setPaused: (paused) => {
      orchestrator.setPaused(paused)
      try {
        saveYamlConfig(paths.config, { ...configSource.load(), schedulerPaused: paused })
      } catch (error) {
        // 落盘失败不回滚内存状态,只在托盘入口记日志(下次仍可再切换)
        logger.warn('暂停状态落盘失败', { error: error instanceof Error ? error.message : String(error) })
      }
      notifyRenderer('scheduler:changed', paused)
    },
    checkUpdates: () => update.checkForUpdates(),
    launchClient: (agentId) => {
      void launcher.launchClient(registry.get(agentId))
    },
    onQuitRequested: async () => {
      const active = orchestrator.list().filter((t) => t.state === 'running' || t.state === 'queued')
      if (active.length === 0) return 'cancel-and-exit'
      const choice = await confirmExitWithRunning(active.length)
      // "取消任务并退出"必须真的落 canceled,否则下次启动会被恢复成 interrupted
      if (choice === 'cancel-and-exit') {
        for (const task of active) orchestrator.cancel(task.id)
      }
      return choice
    },
  })

  // 热键可在设置页改键:保存后先注销旧键再注册新键,失败回执复用同一回调
  const hotkeyHandlers = {
    onActivate: () => toggleMiniBar(miniBar),
    onRegisterFailed: (accelerator: string) => {
      logger.warn('全局热键注册失败(可能冲突)', { accelerator })
      notifyRenderer('hotkey:conflict', accelerator)
    },
  }
  let unregisterHotkey = registerHotkey({ accelerator: config.hotkey, ...hotkeyHandlers })
  const applyHotkey = (accelerator: string): void => {
    unregisterHotkey()
    unregisterHotkey = registerHotkey({ accelerator, ...hotkeyHandlers })
  }

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
    getConfig: () => configSource.load(),
    saveConfig: (next) => saveYamlConfig(paths.config, next),
    update,
    rescanAgents: () =>
      detectAndRegisterAgents({ store, registry, logger, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver }),
    applyHotkey,
    logger,
    getMainWindow: () => mainWindow,
    pushUpdateStatus,
  }
  registerIpcHandlers(ctx)

  // 生命周期:关闭=隐藏到托盘(7.1);托盘"退出"经 app.quit 触发本分支做落盘/关库清理
  let shuttingDown = false
  app.on('before-quit', () => {
    forceQuit = true
    if (shuttingDown) return
    shuttingDown = true
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
    // 退出/关闭竞态下窗口可能已销毁,向已销毁 webContents send 会抛错并击穿调用方
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
}

// 打包成 CJS 后 import.meta.dirname 由打包器 define 成 __dirname;tsx 直跑时用 fileURLToPath 兜底
const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))

/** 套餐日上限占位值:三类客户端均无公开日任务数口径,先给保守默认,设置页后续可调 */
const DEFAULT_DAILY_TASK_CAP = 20
/** 单机调度按串行起步,避免同一客户端并发挤兑套餐 */
const DEFAULT_AGENT_CONCURRENCY = 1

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

/** 启动与设置页"重新扫描"共用的客户端探测登记:启停状态以 agents 表落库为准,重扫幂等 */
async function detectAndRegisterAgents(deps: {
  store: SqliteStore
  registry: Registry
  logger: Logger
  /** ZcodeDriver 的 cliPath,zcodeRoot 由它派生,保持与驱动配置同源 */
  zcodeCli: string
  zcodeDriver: ZcodeDriver
  traeDriver: TraeDriver
  qoderDriver: QoderDriver
  codexDriver: CodexDriver
}): Promise<void> {
  const { store, registry, logger, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver } = deps
  const savedAgents = new Map(store.allAgents().map((row) => [row.id, row]))
  const registerDetected = (detected: DetectedAgent, plan: AgentPlanOptions): void => {
    const profile = buildProfile(detected, plan, savedAgents.get(detected.id)?.enabled)
    // 重扫会再次命中已登记的 id,Registry.register 禁止重复注册,先移除旧档案按最新探测结果重建
    registry.unregister(detected.id)
    registry.register(profile)
    persistAgent(store, profile)
  }
  // 单个客户端探测异常(CLI 损坏/权限)不应拖垮整个启动或重扫:记日志后跳过
  const detectSafely = async (
    client: string,
    run: () => Promise<DetectedAgent | null | undefined>,
  ): Promise<DetectedAgent | null | undefined> => {
    try {
      return await run()
    } catch (error) {
      logger.warn('客户端探测异常,跳过该客户端', {
        client,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  const zcodeRoot = zcodeCli.replace(/[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i, '')
  const zcodeDetected = await detectSafely('zcode', () => zcodeDriver.detect([zcodeRoot, zcodeCli]))
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
  const traeDetected = await detectSafely('trae', () => traeDriver.detect(traeRoots))
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
    const qoderDetected = await detectSafely('qoder', () => qoderDriver.detect(['qoderclicn']))
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
    const codexDetected = await detectSafely('codex', () =>
      codexDriver.detect([process.env.AGENTDROVE_CODEX_CLI ?? 'codex'].filter(Boolean)),
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

function createMainWindow(entryUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1216',
    title: 'AgentDrove',
    // 隐藏原生标题栏(保留系统缩放/阴影/圆角),窗口控制由渲染层自绘
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(HERE, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 最大化状态推给渲染层切图标;双击拖拽区走系统切换,同样落到这两个事件
  const pushMaximized = (maximized: boolean): void => {
    win.webContents.send('window:maximized', maximized)
  }
  win.on('maximize', () => pushMaximized(true))
  win.on('unmaximize', () => pushMaximized(false))

  if (process.env.VITE_DEV_SERVER_URL) {
    // 菜单移除后 devtools 快捷键随之失效,开发期单独放行 F12
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }

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
