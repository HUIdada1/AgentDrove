import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type {
  AgentView,
  EventsPageDto,
  MergeResult,
  Project,
  SubmitTaskDto,
  TaskFilterDto,
  UsageView,
} from '@agent-drove/shared'
import {
  ArtifactScanner,
  type ArtifactChange,
  localDayOf,
  mergeConfig,
  type AppConfig,
  type TaskRecord,
  type WorkspaceRow,
} from '@agent-drove/core'
import { DAILY_PROJECT_ID, persistAgent, type AppContext } from '../context.js'
import { tailLogs } from '../logger.js'

/** 事件单页最大条数:防止渲染层传超大 limit 一次性压垮 IPC */
const EVENTS_PAGE_MAX_LIMIT = 1000

/** 按契约注册全部 IPC 通道;handler 只做参数适配,业务规则都在 core */
export function registerIpcHandlers(ctx: AppContext): void {
  // 按调用取当天(本地时区):跨零点后注册时缓存的旧日期会让今日用量归零
  const today = (): string => localDayOf(Date.now())

  // ---- agents ----
  // 列表组装口径只维护一份:agents:list 与 agents:rescan 共用
  const buildAgentViews = async (): Promise<AgentView[]> => {
    const day = today()
    const profiles = ctx.registry.list()
    // 探活并行:串行时每个无缓存客户端都要等 doctor 跑完,四个客户端启动首拉要拖 5~15s
    const healths = await Promise.all(
      profiles.map((profile) => ctx.health.check(profile.id).catch(() => undefined)),
    )
    return profiles.map((profile, index) => ({
      id: profile.id,
      label: profile.label,
      driver: profile.driver,
      entry: profile.entry,
      cliEntry: profile.cliEntry,
      version: profile.version,
      logoPath: profile.logoPath,
      models: ctx.registry.modelPresets(profile.id),
      defaultModel: profile.defaultModel,
      capabilities: profile.capabilities,
      plan: profile.plan,
      enabled: profile.enabled,
      health: healths[index],
      usedToday: ctx.store.countOf(profile.id, day),
    }))
  }

  ipcMain.handle('agents:list', (): Promise<AgentView[]> => buildAgentViews())

  ipcMain.handle('agents:rescan', async (): Promise<AgentView[]> => {
    // 重扫幂等且保留启停状态(以 agents 表落库为准),完成后按最新注册表组装列表
    await ctx.rescanAgents()
    ctx.notify('agents:changed')
    return buildAgentViews()
  })

  ipcMain.handle('agents:set-enabled', (_e, agentId: string, enabled: boolean) => {
    ctx.registry.setEnabled(agentId, enabled)
    persistAgent(ctx.store, ctx.registry.get(agentId))
    ctx.notify('agents:changed')
  })

  // ---- projects(项目工作区)----
  ipcMain.handle('projects:list', (): Project[] => ctx.store.allProjects())

  ipcMain.handle('projects:pick-and-add', async (): Promise<Project | null> => {
    const dir = await pickDirectory(ctx)
    if (!dir) return null
    // 同目录重复登记返回既有项目,不产生重复行
    const existing = ctx.store.allProjects().find((p) => p.path === dir)
    if (existing) return existing
    const project: Project = {
      id: randomUUID(),
      name: basename(dir) || dir,
      path: dir,
      createdAt: Date.now(),
    }
    ctx.store.upsertProject(project)
    return project
  })

  ipcMain.handle('projects:bind-daily', (_e, path: string | null): Project => {
    const daily = ctx.store.allProjects().find((p) => p.id === DAILY_PROJECT_ID)
    if (!daily) throw new Error('内置日常工作区缺失')
    const next: Project = { ...daily, path: path ?? null }
    ctx.store.upsertProject(next)
    return next
  })

  ipcMain.handle('projects:rename', (_e, projectId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('项目名不能为空')
    ctx.store.renameProject(projectId, trimmed)
  })

  ipcMain.handle('projects:remove', (_e, projectId: string) => {
    if (projectId === DAILY_PROJECT_ID) throw new Error('内置日常工作区不可删除')
    ctx.store.deleteProject(projectId)
  })

  ipcMain.handle('dialog:pick-directory', async (): Promise<string | null> => pickDirectory(ctx))

  // ---- tasks ----
  ipcMain.handle('tasks:list', (_e, filter?: TaskFilterDto): TaskRecord[] => {
    // 以仓库为事实源:任务删除/保留期清理能立刻从列表消失(orchestrator 存活表不感知删除)
    const tasks = ctx.store.allTasks().filter((task) => matchesFilter(task, filter))
    return tasks.sort((a, b) => b.createdAt - a.createdAt)
  })

  ipcMain.handle('tasks:get', (_e, taskId: string) => ctx.store.getTask(taskId) ?? null)

  ipcMain.handle('tasks:events-page', (_e, query: EventsPageDto) => {
    const limit = Math.min(Math.max(1, query.limit ?? 200), EVENTS_PAGE_MAX_LIMIT)
    // 直接走 SQL 分页取尾部,避免为一个任务的上万条事件做全量读取 + JSON.parse
    const page = ctx.store.eventsPageOf(query.taskId, query.beforeSeq, limit)
    // beforeSeq 未命中(任务被清理/传入过期 seq)时回落到最新一页,而不是返回空页
    if (page.length === 0 && query.beforeSeq !== undefined) {
      return ctx.store.eventsPageOf(query.taskId, undefined, limit)
    }
    return page
  })

  ipcMain.handle('tasks:submit', async (_e, dto: SubmitTaskDto): Promise<TaskRecord> => {
    return submitDedup(ctx, dto)
  })

  ipcMain.handle('tasks:submit-batch', async (_e, dtos: SubmitTaskDto[]): Promise<TaskRecord[]> => {
    // 同策略批量入队:逐条走同一闸门,超限异常抛给渲染层提示
    const created: TaskRecord[] = []
    for (const dto of dtos) {
      created.push(await submitDedup(ctx, dto))
    }
    return created
  })

  ipcMain.handle('tasks:retry', (_e, taskId: string): TaskRecord => {
    const parent = ctx.orchestrator.get(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    // 手动重试与 failover 同构:同端派生、attempt+1、retry_of 记链,重走节流无豁免
    return ctx.orchestrator.submit({
      agentId: parent.agentId,
      prompt: parent.prompt,
      cwd: parent.cwd,
      projectId: parent.projectId,
      modelId: parent.modelId,
      mode: parent.mode,
      attachments: parent.attachments,
      toolPolicy: parent.toolPolicy,
      sessionId: parent.sessionId,
      origin: 'panel',
      attempt: parent.attempt + 1,
      retryOf: parent.id,
    })
  })

  ipcMain.handle('tasks:continue', (_e, taskId: string, prompt: string): TaskRecord => {
    return ctx.orchestrator.continueConversation(taskId, prompt)
  })

  ipcMain.handle('tasks:cancel', (_e, taskId: string) => ctx.orchestrator.cancel(taskId))

  ipcMain.handle('tasks:mark-failed', (_e, taskId: string, reason?: string) => {
    const ok = ctx.orchestrator.markFailed(taskId, reason)
    const task = ctx.orchestrator.get(taskId)
    if (ok && task) {
      void ctx.artifactTracking.rescanAfterMarkFailed(task, ctx.orchestrator)
    }
    return ok
  })

  ipcMain.handle('tasks:batch-cancel', (_e, taskIds: string[]) => {
    let count = 0
    for (const id of taskIds) {
      if (ctx.orchestrator.cancel(id)) count++
    }
    return count
  })

  ipcMain.handle('tasks:batch-delete', (_e, taskIds: string[]) => {
    let count = 0
    for (const id of taskIds) {
      const task = ctx.orchestrator.get(id)
      if (!task) continue
      if (task.state === 'running') continue // 运行中不可删,先取消
      // queued 必须先出队再删:否则调度器稍后放行会把已删任务重新落库"复活"
      ctx.orchestrator.cancel(id)
      // 派生工作区随任务一并清理,避免删了任务留下孤儿目录等保留期兜底
      for (const row of ctx.workspaces.rowsForTask(id)) {
        void ctx.workspaces.cleanup(row).catch(() => undefined)
      }
      ctx.store.deleteTask(id)
      count++
    }
    return count
  })

  ipcMain.handle('tasks:resubmit-on', (_e, taskId: string, targetAgentId: string): TaskRecord => {
    const parent = ctx.orchestrator.get(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    const target = ctx.registry.get(targetAgentId)
    // 换客户端 = 手动指定目标的降级:模型映射到目标 default_model,附件按目标能力决定是否继承
    const attachments = target.capabilities.attachments ? parent.attachments : []
    return ctx.orchestrator.submit({
      agentId: targetAgentId,
      prompt: parent.prompt,
      cwd: parent.cwd,
      projectId: parent.projectId,
      modelId: target.defaultModel,
      mode: parent.mode,
      attachments,
      toolPolicy: parent.toolPolicy,
      sessionId: target.id === parent.agentId ? parent.sessionId : undefined,
      origin: 'failover',
      attempt: parent.attempt + 1,
      retryOf: parent.id,
    })
  })

  // ---- health / launch / usage ----
  ipcMain.handle('health:check', (_e, agentId: string, options?: { bypassCache?: boolean }) =>
    ctx.health.check(agentId, options),
  )

  ipcMain.handle('launch:app', (_e, agentId: string) => {
    const profile = ctx.registry.get(agentId)
    return ctx.launcher.launchClient(profile)
  })

  ipcMain.handle('usage:get', (): UsageView[] => {
    const day = today()
    return ctx.registry.list().map((profile) => {
      const usage = ctx.store.usageOf(profile.id, day)
      return {
        agentId: profile.id,
        label: profile.label,
        day,
        taskCount: usage.taskCount,
        estimated: usage.estimated,
        dailyTaskCap: profile.plan.dailyTaskCap,
      }
    })
  })

  // ---- settings ----
  ipcMain.handle('settings:get', (): AppConfig => ctx.getConfig())

  ipcMain.handle('settings:update', (_e, patch: Partial<AppConfig>): AppConfig => {
    const prev = ctx.getConfig()
    // 深合并:renderer 只送局部嵌套配置(如仅改 throttle.minIntervalMs)时不得整体覆盖丢默认项
    const next = mergeConfig(prev, patch)
    ctx.saveConfig(next)
    // 运行中的模块热应用新配置:节流参数/暂停闸/降级策略都持有可变引用
    ctx.orchestrator.throttleState.configure(next.throttle)
    ctx.orchestrator.throttleState.setPaused(next.schedulerPaused)
    ctx.failover.config = next.task.failover
    if (next.hotkey !== prev.hotkey) ctx.applyHotkey(next.hotkey)
    return ctx.getConfig()
  })

  ipcMain.handle('scheduler:pause', (_e, paused: boolean) => {
    ctx.orchestrator.setPaused(paused)
    // 落盘持久化 + 广播渲染层(托盘入口的暂停走 app.ts 同款逻辑,两端口径一致)
    ctx.saveConfig({ ...ctx.getConfig(), schedulerPaused: paused })
    ctx.notify('scheduler:changed', paused)
  })

  // ---- logs / export ----
  ipcMain.handle('logs:tail', (_e, limit?: number) =>
    tailLogs(ctx.paths.logs, Math.min(Math.max(1, limit ?? 200), 2000)),
  )

  ipcMain.handle('export:data', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出数据(JSON)',
      defaultPath: `agentdrove-export-${localDayOf(Date.now())}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) throw new Error('已取消导出')
    writeFileSync(filePath, JSON.stringify(ctx.store.exportAll(), null, 2), 'utf8')
    return { path: filePath }
  })

  ipcMain.handle('export:report', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出周用量报告(CSV)',
      defaultPath: `agentdrove-weekly-${localDayOf(Date.now())}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) throw new Error('已取消导出')
    const weekAgo = localDayOf(Date.now() - 7 * 24 * 3600_000)
    const rows = ctx.store
      .allUsageRows()
      .filter((row) => row.day >= weekAgo)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
    const labels = new Map(ctx.registry.list().map((p) => [p.id, p.label]))
    // CSV 引号字段内部的双引号必须翻倍转义,否则客户端名带引号会撕开列边界
    const csvCell = (text: string): string => `"${text.replace(/"/g, '""')}"`
    const csv = [
      'day,agent,task_count,estimated',
      ...rows.map(
        (row) =>
          `${row.day},${csvCell(labels.get(row.agentId) ?? row.agentId)},${row.taskCount},${row.estimated}`,
      ),
    ].join('\n')
    writeFileSync(filePath, '\ufeff' + csv, 'utf8')
    return { path: filePath }
  })

  // ---- workspaces ----
  ipcMain.handle('workspaces:list', (): WorkspaceRow[] => ctx.store.all())

  ipcMain.handle('workspaces:clean', async (_e, workspaceId: string) => {
    const row = ctx.store.get(workspaceId)
    if (!row) throw new Error(`unknown workspace: ${workspaceId}`)
    await ctx.workspaces.cleanup(row)
  })

  ipcMain.handle('workspaces:merge', async (_e, workspaceId: string): Promise<MergeResult> => {
    const row = ctx.store.get(workspaceId)
    if (!row) throw new Error(`unknown workspace: ${workspaceId}`)
    return mergeWorkspaceArtifacts(ctx, row)
  })

  // ---- update ----
  ipcMain.handle('update:check', () => {
    ctx.update.checkForUpdates()
    return { phase: 'checking' as const }
  })
  ipcMain.handle('update:install', () => ctx.update.installUpdate())

  // ---- 通用 ----
  ipcMain.handle('open-path', (_e, targetPath: string) => {
    // openPath 失败以返回值字符串传达(不 reject),不记日志的话"打不开"将无迹可循
    void shell.openPath(targetPath).then((error) => {
      if (error) ctx.logger.warn('打开路径失败', { targetPath, error })
    })
  })

  // 单向通知无需回执,用 on;sender 定位窗口,避免主/迷你条互相误隐藏
  ipcMain.on('window:hide-mini', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })

  // ---- 自定义标题栏窗口控制 ----
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  // 主窗 close 被统一拦截为隐藏到托盘(7.1),走 close() 与系统关闭钮同路径
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

/** 同内容派发在窗口期内去重:双击/Enter 连击在渲染层 disable 生效前可能重入 */
const SUBMIT_DEDUP_MS = 1500
const recentSubmits = new Map<string, number>()

function submitDedupKey(dto: SubmitTaskDto): string {
  // 用 NUL 分隔,避免字段拼接产生歧义碰撞;附件/模型/会话不同即视为不同任务
  const attachments = (dto.attachments ?? []).map((a) => a.path).join('|')
  return [
    dto.agentId,
    dto.prompt,
    dto.cwd ?? '',
    dto.projectId ?? '',
    dto.workspaceSource ?? '',
    dto.mode ?? '',
    dto.modelId ?? '',
    dto.sessionId ?? '',
    attachments,
  ].join('\u0000')
}

function pruneRecentSubmits(now: number): void {
  if (recentSubmits.size < 100) return
  for (const [key, at] of recentSubmits) {
    if (now - at > SUBMIT_DEDUP_MS) recentSubmits.delete(key)
  }
}

async function submitDedup(ctx: AppContext, dto: SubmitTaskDto): Promise<TaskRecord> {
  const now = Date.now()
  pruneRecentSubmits(now)
  const key = submitDedupKey(dto)
  const last = recentSubmits.get(key)
  if (last !== undefined && now - last < SUBMIT_DEDUP_MS) {
    throw new Error('相同任务刚派发过,请勿重复提交')
  }
  const task = await submitOne(ctx, dto)
  recentSubmits.set(key, now)
  return task
}

/** 派发单条:选中工作区注入 projectId;显式 cwd 优先,否则项目目录,再否则编排层默认目录 */
async function submitOne(ctx: AppContext, dto: SubmitTaskDto): Promise<TaskRecord> {
  const { workspaceSource, projectId, ...rest } = dto
  const config = ctx.getConfig()
  const mode = rest.mode ?? config.task.defaultMode
  // yolo 为全权限档位:未在设置页显式放行时一律拒绝(渲染层可绕过,此处兜底)
  if (mode === 'yolo' && !config.danger.allowYolo) {
    throw new Error('yolo 档位未放行:请先在设置页 Danger 区开启')
  }
  let { cwd } = rest
  if (!cwd && projectId) {
    cwd = ctx.store.allProjects().find((p) => p.id === projectId)?.path ?? undefined
  }
  const request = { ...rest, mode, projectId, origin: rest.origin ?? 'panel' }
  if (!workspaceSource) {
    return ctx.orchestrator.submit({ ...request, cwd })
  }
  const taskId = randomUUID()
  const row = await ctx.workspaces.derive(
    workspaceSource,
    taskId,
    ctx.paths.workspaces,
    config.task.workspaceCleanupHours,
  )
  try {
    return ctx.orchestrator.submit({ ...request, cwd: row.path, id: taskId })
  } catch (error) {
    // 入队被拒(cap 超限/id 冲突)时回收刚派生的工作区,避免磁盘目录与登记行成为孤儿
    await ctx.workspaces.cleanup(row).catch(() => undefined)
    throw error
  }
}

async function pickDirectory(ctx: AppContext): Promise<string | null> {
  const win = ctx.getMainWindow() ?? undefined
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, { title: '选择项目工作区', properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ title: '选择项目工作区', properties: ['openDirectory'] })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0] ?? null
}

function matchesFilter(task: TaskRecord, filter?: TaskFilterDto): boolean {
  if (!filter) return true
  if (filter.agentId && task.agentId !== filter.agentId) return false
  if (filter.state && task.state !== filter.state) return false
  if (filter.projectId && task.projectId !== filter.projectId) return false
  if (filter.search && !task.prompt.includes(filter.search)) return false
  if (filter.sinceDay) {
    const day = localDayOf(task.createdAt)
    if (day < filter.sinceDay) return false
  }
  if (filter.untilDay) {
    const day = localDayOf(task.createdAt)
    if (day > filter.untilDay) return false
  }
  return true
}

/**
 * 产物合并(7.2):把工作区里相对基线的变更文件复制回源目录。
 * 冲突口径:目标已存在且内容不同 → 跳过并列出,绝不静默覆盖用户文件。
 */
async function mergeWorkspaceArtifacts(ctx: AppContext, row: WorkspaceRow): Promise<MergeResult> {
  if (row.kind === 'userdir') {
    return { merged: [], conflicts: [] }
  }
  const scanner = new ArtifactScanner(ctx.processRunner, ctx.fs)
  let changes: ArtifactChange[]
  let baseDir: string
  if (row.kind === 'worktree' && row.source) {
    const source = JSON.parse(row.source) as { repo: string; baseHead: string }
    const baseline = await scanner.snapshotWorktree(source.repo, row.path)
    changes = await scanner.scan(baseline)
    baseDir = source.repo
  } else if (row.kind === 'tempcopy' && row.source) {
    // tempcopy 无跨重启基线:与源目录现状逐文件比对(mtime/size),差异即变更
    changes = diffSnapshots(
      scanner.snapshotDir(row.source).files,
      scanner.snapshotDir(row.path).files,
    )
    baseDir = row.source
  } else {
    return { merged: [], conflicts: [] }
  }

  const merged: string[] = []
  const conflicts: string[] = []
  for (const change of changes) {
    if (change.change === 'deleted') continue // 删除不回写
    const from = join(row.path, ...change.path.split('/'))
    const to = join(baseDir, ...change.path.split('/'))
    if (!existsSync(from)) continue
    if (existsSync(to)) {
      if (sameFileContent(from, to)) {
        merged.push(change.path) // 内容一致视为已合并
        continue
      }
      conflicts.push(change.path)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    merged.push(change.path)
  }
  return { merged, conflicts }
}

/**
 * 逐块比对两文件内容;尺寸先决(size 不同直接判不同),
 * 避免把可能上百 MB 的产物整读进内存。
 */
function sameFileContent(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false
    const fdA = openSync(a, 'r')
    const fdB = openSync(b, 'r')
    try {
      const CHUNK = 1024 * 1024
      const bufA = Buffer.allocUnsafe(CHUNK)
      const bufB = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        const readA = readSync(fdA, bufA, 0, CHUNK, null)
        const readB = readSync(fdB, bufB, 0, CHUNK, null)
        if (readA !== readB) return false
        if (readA === 0) return true
        if (!bufA.subarray(0, readA).equals(bufB.subarray(0, readB))) return false
      }
    } finally {
      closeSync(fdA)
      closeSync(fdB)
    }
  } catch {
    // 读取失败按冲突处理
    return false
  }
}

/** 源目录快照 vs 工作区现状:added/modified/deleted */
function diffSnapshots(
  origin: Map<string, { mtimeMs: number; size: number }>,
  current: Map<string, { mtimeMs: number; size: number }>,
): Array<{ path: string; change: string }> {
  const changes: Array<{ path: string; change: string }> = []
  for (const [path, entry] of current) {
    const before = origin.get(path)
    if (!before) changes.push({ path, change: 'added' })
    else if (before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) {
      changes.push({ path, change: 'modified' })
    }
  }
  for (const path of origin.keys()) {
    if (!current.has(path)) changes.push({ path, change: 'deleted' })
  }
  return changes
}
