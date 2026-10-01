import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  AgentView,
  EventsPageDto,
  MergeResult,
  SubmitTaskDto,
  TaskFilterDto,
  UsageView,
} from '@agent-drove/shared'
import {
  ArtifactScanner,
  localDayOf,
  type AppConfig,
  type TaskRecord,
  type WorkspaceRow,
} from '@agent-drove/core'
import type { AppContext } from '../context.js'
import { tailLogs } from '../logger.js'

/** 按契约注册全部 IPC 通道;handler 只做参数适配,业务规则都在 core */
export function registerIpcHandlers(ctx: AppContext): void {
  const day = localDayOf(Date.now())

  // ---- agents ----
  ipcMain.handle('agents:list', async (): Promise<AgentView[]> => {
    const views: AgentView[] = []
    for (const profile of ctx.registry.list()) {
      const health = await ctx.health.check(profile.id).catch(() => undefined)
      const models = ctx.registry.modelPresets(profile.id)
      views.push({
        id: profile.id,
        label: profile.label,
        driver: profile.driver,
        entry: profile.entry,
        cliEntry: profile.cliEntry,
        version: profile.version,
        logoPath: profile.logoPath,
        models,
        defaultModel: profile.defaultModel,
        capabilities: profile.capabilities,
        plan: profile.plan,
        enabled: profile.enabled,
        health,
        usedToday: ctx.store.countOf(profile.id, day),
      })
    }
    return views
  })

  ipcMain.handle('agents:set-enabled', (_e, agentId: string, enabled: boolean) => {
    ctx.registry.setEnabled(agentId, enabled)
    persistAgent(ctx, agentId)
  })

  // ---- tasks ----
  ipcMain.handle('tasks:list', (_e, filter?: TaskFilterDto): TaskRecord[] => {
    const tasks = ctx.orchestrator.list().filter((task) => matchesFilter(task, filter))
    return tasks.sort((a, b) => b.createdAt - a.createdAt)
  })

  ipcMain.handle('tasks:get', (_e, taskId: string) => ctx.orchestrator.get(taskId) ?? null)

  ipcMain.handle('tasks:events-page', (_e, query: EventsPageDto) => {
    const all = ctx.orchestrator.eventsOf(query.taskId)
    const limit = query.limit ?? 200
    const end = query.beforeSeq !== undefined
      ? all.findIndex((event) => event.seq === query.beforeSeq)
      : all.length
    const slice = end <= 0 ? [] : all.slice(Math.max(0, end - limit), end)
    return slice
  })

  ipcMain.handle('tasks:submit', async (_e, dto: SubmitTaskDto): Promise<TaskRecord> => {
    return submitOne(ctx, dto)
  })

  ipcMain.handle('tasks:submit-batch', async (_e, dtos: SubmitTaskDto[]): Promise<TaskRecord[]> => {
    // 同策略批量入队:逐条走同一闸门,超限异常抛给渲染层提示
    const created: TaskRecord[] = []
    for (const dto of dtos) {
      created.push(await submitOne(ctx, dto))
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
    const attachments =
      target.capabilities.attachments && target.id !== parent.agentId ? parent.attachments : []
    return ctx.orchestrator.submit({
      agentId: targetAgentId,
      prompt: parent.prompt,
      cwd: parent.cwd,
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
    const next = { ...ctx.getConfig(), ...patch }
    ctx.saveConfig(next)
    // 运行中的模块热应用新配置:节流参数/暂停闸/降级策略都持有可变引用
    ctx.orchestrator.throttleState.configure(next.throttle)
    ctx.orchestrator.throttleState.setPaused(next.schedulerPaused)
    ctx.failover.config = next.task.failover
    return ctx.getConfig()
  })

  ipcMain.handle('scheduler:pause', (_e, paused: boolean) => {
    ctx.orchestrator.setPaused(paused)
    persistConfigPaused(ctx, paused)
  })

  // ---- logs / export ----
  ipcMain.handle('logs:tail', (_e, limit?: number) => tailLogs(ctx.paths.logs, limit ?? 200))

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
    const csv = [
      'day,agent,task_count,estimated',
      ...rows.map(
        (row) =>
          `${row.day},"${labels.get(row.agentId) ?? row.agentId}",${row.taskCount},${row.estimated}`,
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
    void shell.openPath(targetPath)
  })

  // 单向通知无需回执,用 on;sender 定位窗口,避免主/迷你条互相误隐藏
  ipcMain.on('window:hide-mini', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })
}

/** 派发单条:带 workspaceSource 时先派生工作区(git→worktree / 其他→tempcopy),任务 cwd 指向派生目录 */
async function submitOne(ctx: AppContext, dto: SubmitTaskDto): Promise<TaskRecord> {
  const { workspaceSource, ...rest } = dto
  if (!workspaceSource) {
    return ctx.orchestrator.submit({ ...rest, origin: rest.origin ?? 'panel' })
  }
  const taskId = randomUUID()
  const cleanupHours = ctx.getConfig().task.workspaceCleanupHours
  const row = await ctx.workspaces.derive(workspaceSource, taskId, ctx.paths.workspaces, cleanupHours)
  return ctx.orchestrator.submit({
    ...rest,
    id: taskId,
    cwd: row.path,
    origin: rest.origin ?? 'panel',
  })
}

function matchesFilter(task: TaskRecord, filter?: TaskFilterDto): boolean {  if (!filter) return true
  if (filter.agentId && task.agentId !== filter.agentId) return false
  if (filter.state && task.state !== filter.state) return false
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

function persistAgent(ctx: AppContext, agentId: string): void {
  const profile = ctx.registry.get(agentId)
  ctx.store.upsertAgent({
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

function persistConfigPaused(ctx: AppContext, paused: boolean): void {
  const next = { ...ctx.getConfig(), schedulerPaused: paused }
  ctx.saveConfig(next)
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
  let changes: Array<{ path: string; change: string }>
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
      try {
        if (readFileSync(to).equals(readFileSync(from))) {
          merged.push(change.path) // 内容一致视为已合并
          continue
        }
      } catch {
        // 读取失败按冲突处理
      }
      conflicts.push(change.path)
      continue
    }
    mkdirSync(join(to, '..'), { recursive: true })
    copyFileSync(from, to)
    merged.push(change.path)
  }
  return { merged, conflicts }
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
