import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
  resolveZcodeBuiltinConfig,
  localDayOf,
  Throttle,
  TraeDriver,
  WorkspaceManager,
  ZcodeDriver,
  resolveZcodeCliPaths,
  resolveZcodePersonalConfigPath,
  parseZcodePersonalModels,
  MODEL_CLIENT_FOLLOW,
  DEFAULT_DAILY_TASK_CAP,
  DEFAULT_MAX_CONCURRENCY,
  type AgentDriver,
  type AgentProfile,
  type Clock,
  type DetectedAgent,
  type ModelSwitchKind,
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

  // ---- 客户端驱动与注册表:探测延后到窗口就绪后后台跑,注册表先以空态参与装配 ----
  const registry = new Registry()
  const drivers = new Map<string, AgentDriver>()
  const zcodeCandidates = resolveZcodeCliPaths(process.env.AGENTDROVE_ZCODE_CLI)
  const zcodeCli = zcodeCandidates.find((p) => fs.exists(p)) ?? zcodeCandidates[0]
  const zcodeBuiltinConfig = ensureZcodeBuiltinConfig(zcodeCli, fs)
  const zcodePersonalConfig = resolveZcodePersonalConfigPath()
  const zcodeDriver = new ZcodeDriver(runner, fs, {
    nodeBin: resolveNodeBin(),
    cliPath: zcodeCli,
    builtinProviderConfigPath: zcodeBuiltinConfig,
    personalProviderConfigPath: fs.exists(zcodePersonalConfig) ? zcodePersonalConfig : undefined,
    // 打包态若回落到 Electron 运行时,必须 ELECTRON_RUN_AS_NODE 才按 node 执行,
    // 否则探测与派发都会拉起第二个 GUI 实例;系统 node 下该变量无副作用;
    // 显式带上 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 确保官方 CLI 能正确定位内置 Provider
    nodeEnv: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(zcodeBuiltinConfig ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinConfig } : {}),
    },
  })
  const qoderDriver = new QoderDriver(runner, fs)
  const traeDriver = new TraeDriver(runner, fs)
  const codexDriver = new CodexDriver(runner, fs)
  drivers.set(zcodeDriver.id, zcodeDriver)
  drivers.set(qoderDriver.id, qoderDriver)
  drivers.set(traeDriver.id, traeDriver)
  drivers.set(codexDriver.id, codexDriver)

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
      const removedTasks = store.purgeTasksBefore(now - TASK_RETENTION_MS)
      const removedJournal = store.purgeJournalBefore(now - JOURNAL_RETENTION_MS)
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

  // ---- 托盘(窗口前就位:关闭=隐藏到托盘依赖托盘存在;客户端菜单探测完成后 rebuild)----
  const { rebuild: rebuildTrayMenu } = createTray({
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
      // 重扫注销后托盘菜单可能仍持旧项(菜单按暂停态轮询重建):查不到就跳过,别让 get 抛错打穿托盘回调
      const agent = registry.list().find((p) => p.id === agentId)
      if (agent) void launcher.launchClient(agent)
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

  // ---- 主窗 + 迷你条:与下方 IPC 注册同属一个同步段,渲染层首拉时 handler 必已就绪 ----
  // (客户端探测已移出启动链路,窗口不再被 10~30s 探测卡在"加载中"空数据态)
  const entryUrl = await loadEntryUrl()
  const mainWindow = createMainWindow(entryUrl)
  const miniBar = createMiniBarWindow(entryUrl)

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
      detectAndRegisterAgents({ store, registry, logger, zcodeCandidates, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver, fs }),
    applyHotkey,
    logger,
    getMainWindow: () => mainWindow,
    pushUpdateStatus,
    notify: notifyRenderer,
  }
  registerIpcHandlers(ctx)

  // 窗口已就绪:补执行启动期间挂起的"唤起面板"请求(second-instance 竞态)
  panelReady = true
  if (pendingShowPanel) {
    pendingShowPanel = false
    showPanel()
  }

  // ---- 客户端探测后台化(探测结果 + agents 表恢复启用状态)----
  // 完成后广播渲染层重拉客户端,并重建托盘"打开客户端"菜单(创建托盘时注册表还是空的)
  void detectAndRegisterAgents({ store, registry, logger, zcodeCandidates, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver, fs })
    .then(() => {
      notifyRenderer('agents:changed')
      rebuildTrayMenu()
    })
    .catch((error) => {
      logger.error('客户端探测失败', { error: error instanceof Error ? error.message : String(error) })
    })

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

/** 保留期(5.4):任务完成 90 天后清理,审计日志 180 天 */
const TASK_RETENTION_MS = 90 * 24 * 3600_000
const JOURNAL_RETENTION_MS = 180 * 24 * 3600_000

/** Codex CLI 模型档位目录(含跟随客户端) */
const CODEX_MODELS = [
  { id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
]

/** Qoder CLI 常见模型档位目录(含跟随客户端) */
const QODER_MODELS = [
  { id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' },
  { id: 'qwen3.7-max', label: 'Qwen 3.7 Max' },
  { id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' },
  { id: 'deepseek-v3', label: 'DeepSeek-V3' },
  { id: 'deepseek-r1', label: 'DeepSeek-R1' },
]

function resolveTraeRoots(): string[] {
  const list: string[] = []
  if (process.env.AGENTDROVE_TRAE_ROOTS) {
    list.push(...process.env.AGENTDROVE_TRAE_ROOTS.split(';').filter(Boolean))
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    list.push(join(localAppData, 'Programs', 'Trae'))
    list.push(join(localAppData, 'Programs', 'Trae_guoji'))
  }
  const progFiles = process.env.ProgramFiles
  if (progFiles) {
    list.push(join(progFiles, 'Trae'))
    list.push(join(progFiles, 'Trae_guoji'))
  }
  const progFilesX86 = process.env['ProgramFiles(x86)']
  if (progFilesX86) {
    list.push(join(progFilesX86, 'Trae'))
    list.push(join(progFilesX86, 'Trae_guoji'))
  }
  list.push('E:\\Trae_guoji', 'E:\\Trae', 'D:\\Trae_guoji', 'D:\\Trae', 'C:\\Trae')
  return [...new Set(list)]
}

function resolveQoderCandidates(): string[] {
  const list: string[] = []
  if (process.env.AGENTDROVE_QODER_CLI) {
    list.push(process.env.AGENTDROVE_QODER_CLI)
  }
  list.push('qoderclicn')
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    list.push(join(localAppData, 'Programs', 'Qoder', 'bin', 'qoderclicn.exe'))
    list.push(join(localAppData, 'Programs', 'Qoder', 'qoderclicn.exe'))
    list.push(join(localAppData, 'Programs', 'qoder', 'bin', 'qoderclicn.exe'))
  }
  const progFiles = process.env.ProgramFiles
  if (progFiles) {
    list.push(join(progFiles, 'Qoder', 'bin', 'qoderclicn.exe'))
    list.push(join(progFiles, 'Qoder', 'qoderclicn.exe'))
  }
  return [...new Set(list)]
}

function resolveCodexCandidates(): string[] {
  const list: string[] = []
  if (process.env.AGENTDROVE_CODEX_CLI) {
    list.push(process.env.AGENTDROVE_CODEX_CLI)
  }
  list.push('codex')
  const appData = process.env.APPDATA
  if (appData) {
    list.push(join(appData, 'npm', 'codex.cmd'))
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    list.push(join(localAppData, 'Programs', 'codex', 'bin', 'codex.cmd'))
    list.push(join(localAppData, 'Programs', 'codex', 'codex.cmd'))
  }
  return [...new Set(list)]
}


interface AgentPlanOptions {
  planName: string
  quota: 'daily' | 'credits' | 'subscription'
  models: Array<{ id: string; label: string }>
  followClient: boolean
  attachments: boolean
  modelSwitch?: ModelSwitchKind
  defaultModel?: string
}

/** 启动与设置页"重新扫描"共用的客户端探测登记:启停状态以 agents 表落库为准,重扫幂等 */
async function detectAndRegisterAgents(deps: {
  store: SqliteStore
  registry: Registry
  logger: Logger
  zcodeCandidates: string[]
  zcodeCli: string
  zcodeDriver: ZcodeDriver
  traeDriver: TraeDriver
  qoderDriver: QoderDriver
  codexDriver: CodexDriver
  fs: NodeFileSystem
}): Promise<void> {
  const { store, registry, logger, zcodeCandidates, zcodeCli, zcodeDriver, traeDriver, qoderDriver, codexDriver, fs } = deps
  const savedAgents = new Map(store.allAgents().map((row) => [row.id, row]))
  // 本轮探测命中的 id;收尾据此注销"装过但现在没了"的客户端
  const detectedIds = new Set<string>()
  const registerDetected = (detected: DetectedAgent, plan: AgentPlanOptions): void => {
    const profile = buildProfile(detected, plan, savedAgents.get(detected.id)?.enabled)
    // 重扫会再次命中已登记的 id,Registry.register 禁止重复注册,先移除旧档案按最新探测结果重建
    registry.unregister(detected.id)
    registry.register(profile)
    persistAgent(store, profile)
    detectedIds.add(detected.id)
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

  const zcodeEntries: string[] = []
  for (const c of zcodeCandidates) {
    const root = c.replace(/[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i, '')
    zcodeEntries.push(root, c)
  }
  const zcodeDetected = await detectSafely('zcode', () => zcodeDriver.detect(zcodeEntries))
  if (zcodeDetected) {
    let parsedModels: Array<{ id: string; label: string }> = []
    const personalPath = resolveZcodePersonalConfigPath()
    if (fs.exists(personalPath)) {
      try {
        const raw = fs.readTextFile(personalPath)
        parsedModels = parseZcodePersonalModels(raw)
      } catch (err) {
        logger.warn('解析 ZCode personal provider 配置文件失败', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (parsedModels.length > 0) {
      registerDetected(zcodeDetected, {
        planName: 'GLM Coding Plan',
        quota: 'daily',
        models: [
          { id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' },
          ...parsedModels,
        ],
        followClient: false,
        modelSwitch: 'config-file',
        defaultModel: MODEL_CLIENT_FOLLOW,
        attachments: true,
      })
    } else {
      registerDetected(zcodeDetected, {
        planName: 'GLM Coding Plan',
        quota: 'daily',
        models: [],
        followClient: true,
        attachments: true,
      })
    }
  }
  const traeRoots = resolveTraeRoots()
  const traeDetected = await detectSafely('trae', () => traeDriver.detect(traeRoots))
  if (traeDetected) {
    registerDetected(traeDetected, {
      planName: 'Trae 官方套餐',
      quota: 'subscription',
      models: [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }],
      followClient: true,
      modelSwitch: 'none',
      defaultModel: MODEL_CLIENT_FOLLOW,
      attachments: true,
    })
  }

  const qoderCandidates = resolveQoderCandidates()
  const qoderDetected = await detectSafely('qoder', () => qoderDriver.detect(qoderCandidates))
  if (qoderDetected) {
    registerDetected(qoderDetected, {
      planName: 'Qoder Credits',
      quota: 'credits',
      models: QODER_MODELS,
      followClient: false,
      modelSwitch: 'cli-arg',
      defaultModel: MODEL_CLIENT_FOLLOW,
      attachments: false,
    })
  }

  const codexCandidates = resolveCodexCandidates()
  const codexDetected = await detectSafely('codex', () => codexDriver.detect(codexCandidates))
  if (codexDetected) {
    registerDetected(codexDetected, {
      planName: 'ChatGPT 套餐',
      quota: 'subscription',
      models: CODEX_MODELS,
      followClient: false,
      modelSwitch: 'cli-arg',
      defaultModel: MODEL_CLIENT_FOLLOW,
      attachments: false,
    })
  }

  // 旧登记但本轮未探到的客户端(卸载/目录迁移)注销出注册表,UI 即不再展示;
  // agents 表行保留,重装后重扫可原样恢复启停状态
  for (const profile of registry.list()) {
    if (!detectedIds.has(profile.id)) {
      registry.unregister(profile.id)
      logger.info('客户端本轮未探到,已注销', { agent: profile.id })
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
    defaultModel: options.defaultModel ?? (options.followClient
      ? MODEL_CLIENT_FOLLOW
      : options.models[0]?.id ?? MODEL_CLIENT_FOLLOW),
    capabilities: {
      headless: detected.id !== 'trae',
      sessionResume: detected.id !== 'trae',
      modelSwitch: options.modelSwitch ?? (options.followClient ? 'none' : 'cli-arg'),
      attachments: options.attachments,
    },
    plan: {
      name: options.planName,
      quotaKind: options.quota,
      modelIds: options.models.map((m) => m.id),
      // 默认值以 core 注册表为唯一出处;register 时的 normalizePlan 还会再兜底一次
      dailyTaskCap: DEFAULT_DAILY_TASK_CAP,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
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

  win.once('ready-to-show', () => {
    win.show()
    // 渲染层就绪前若已处于最大化(会话恢复/启动即最大化),补推初始状态对齐标题栏图标
    pushMaximized(win.isMaximized())
  })
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

/**
 * zcode CLI 的 node 二进制:dev 态 execPath 就是系统 node;
 * 打包态 execPath 是 Electron 运行时——即便 ELECTRON_RUN_AS_NODE 也缺 node:sqlite
 * 等 zcode 依赖的内置模块(doctor 直接退出码 1),必须落到系统 node。
 * 优先级:环境变量覆盖 > PATH 里的 node > 回落 Electron-as-node(仅保证不再拉起 GUI 实例)。
 */
function resolveNodeBin(): string {
  if (!app.isPackaged) return process.execPath
  if (process.env.AGENTDROVE_NODE_BIN) return process.env.AGENTDROVE_NODE_BIN
  const found = spawnSync('where', ['node'], { timeout: 5000, windowsHide: true })
  const first =
    found.status === 0
      ? (found.stdout.toString().split(/\r?\n/).find((line) => line.trim()) ?? '').trim()
      : ''
  return first || process.execPath
}

/**
 * 确保 ZCode 内置 provider 配置文件可用:
 * 1. 自动寻找 zcode-builtin.json 的位置(如 resources/config/provider/zcode-builtin.json);
 * 2. 若 cli 同级的 provider/zcode-builtin.json 不存在,尝试做物理兜底复制(解决裸跑官方 CLI 寻找 provider/zcode-builtin.json 失败);
 * 3. 返回解析到的配置绝对路径供驱动注入环境变量 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE。
 */
function ensureZcodeBuiltinConfig(zcodeCli: string, fsx: NodeFileSystem): string | undefined {
  const resolved = resolveZcodeBuiltinConfig(zcodeCli, fsx)
  if (!resolved) return undefined

  try {
    const cliDir = dirname(zcodeCli)
    const targetDir = join(cliDir, 'provider')
    const targetFile = join(targetDir, 'zcode-builtin.json')
    if (resolved !== targetFile && !existsSync(targetFile)) {
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
      }
      copyFileSync(resolved, targetFile)
    }
  } catch {
    // 目录只读或权限受限时静默忽略,环境变量已足以生效
  }

  return resolved
}

