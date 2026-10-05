import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
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
  BatchSubmitResult,
  ContinueOptions,
  EventsPageDto,
  MergeResult,
  MoveTaskDto,
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
  type AgentProfile,
  type AppConfig,
  type PlanOverrideConfig,
  type TaskRecord,
  type WorkspaceRow,
} from '@agent-drove/core'
import { DAILY_PROJECT_ID, persistAgent, type AppContext } from '../context.js'
import { tailLogs } from '../logger.js'

/** 事件单页最大条数:防止渲染层传超大 limit 一次性压垮 IPC */
const EVENTS_PAGE_MAX_LIMIT = 1000

/**
 * 思考档位能力(P0-4):按驱动判定的最小实现——core 的 AgentCapabilities 尚无 reasoningEffort 字段,
 * 正式落地后改为透传 profile.capabilities。zcode 走 reasoningLevel、codex 走 model_reasoning_effort;
 * qoder/trae 置空(缺省),渲染层据此隐藏"思考"下拉,不做假控件。
 */
const REASONING_EFFORT_CAPABLE = new Set(['zcode', 'codex'])

/** zcode 本地用量库的最小查询面(node:sqlite 无 @types 时按此结构断言) */
interface ZcodeUsageRow {
  inTok: number | null
  outTok: number | null
  cacheTok: number | null
}

interface ZcodeDatabase {
  prepare(sql: string): { get(...params: unknown[]): ZcodeUsageRow | undefined }
  close(): void
}

/** G5-09:zcode 本地库单次读出的有效用量行;合并进 stats 时随对应口径现算 */
interface ZcodeUsageRaw {
  inTok: number
  outTok: number
  cacheTok: number
}

/** G5-09:zcode 单次开库同时取出的两个口径聚合(周期/今日) */
interface ZcodeUsagePair {
  cycle: ZcodeUsageRaw | null
  today: ZcodeUsageRaw | null
}

/** agentUsageStats 的返回形状(合并 zcode 本地库用量时复用) */
interface UsageStatsSnapshot {
  usedTokens: number
  usedCredits: number
  cachedTokens: number
  cacheHitRate: number
}

/**
 * G5-09:zcode 本地 sqlite 同步读的短 TTL 缓存。
 * agents:list 是最高频通道(任务事件 500ms 节流/60s 轮询/聚焦重拉),每拍同步开库
 * 会阻塞主进程事件循环;5s 内复用上次读取结果(一次开库同时取周期与今日两个聚合)。
 * null 成员同时表示"该口径无有效行"与"读取失败",TTL 内同样不再重试,失败 warn 也因此按窗口去抖。
 */
let zcodeUsageCache: { at: number; raw: ZcodeUsagePair } | null = null
const ZCODE_USAGE_CACHE_TTL_MS = 5000

/** ZcodeUsageRow → 有效用量行;无行或无消耗返回 null */
function toZcodeRaw(row: ZcodeUsageRow | undefined): ZcodeUsageRaw | null {
  if (!row || (!row.inTok && !row.outTok)) return null
  return {
    inTok: Number(row.inTok) || 0,
    outTok: Number(row.outTok) || 0,
    cacheTok: Number(row.cacheTok) || 0,
  }
}

/**
 * 读 zcode 本地权威库(~/.zcode/cli/db/db.sqlite),一次开库同时取周期与今日两个口径的
 * 聚合用量;库缺失/读取失败返回双 null(回落本应用派发口径)。
 */
function readZcodeLocalUsage(
  ctx: AppContext,
  cycleStartMs: number,
  todayStartMs: number,
): ZcodeUsagePair {
  try {
    const zdbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
    if (!existsSync(zdbPath)) return { cycle: null, today: null }
    // R03:globalThis.require 在 ESM 产物里非契约;bundle 成 CJS 后 import.meta.url 由
    // bundle 脚本垫为 file:// 形式,统一走 createRequire 标准获取 node:sqlite
    const req = createRequire(import.meta.url)
    const sqlite = req('node:sqlite') as {
      DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => ZcodeDatabase
    }
    const DatabaseSync = sqlite?.DatabaseSync
    if (!DatabaseSync) {
      throw new Error('node:sqlite.DatabaseSync 不可用(需要 Node 22.5+)')
    }
    const zdb = new DatabaseSync(zdbPath, { readOnly: true })
    try {
      const stmt = zdb.prepare(
        `SELECT SUM(input_tokens) as inTok, SUM(output_tokens) as outTok, SUM(cache_read_input_tokens) as cacheTok
         FROM model_usage
         WHERE started_at >= ?`,
      )
      return {
        cycle: toZcodeRaw(stmt.get(cycleStartMs)),
        today: toZcodeRaw(stmt.get(todayStartMs)),
      }
    } finally {
      zdb.close()
    }
  } catch (error) {
    // R03:读取失败留痕不静默——此前整段静默吞掉,排障无从下手
    ctx.logger.warn('zcode 本地用量库读取失败,Token/点数统计回落到本应用派发口径', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { cycle: null, today: null }
  }
}

/** 把 zcode 本地库聚合行合并进口径快照:各值取两者较大者(与 R03 既有合并语义一致) */
function mergeZcodeRaw(stats: UsageStatsSnapshot, raw: ZcodeUsageRaw): void {
  stats.usedTokens = Math.max(stats.usedTokens, raw.inTok + raw.outTok + raw.cacheTok)
  stats.cachedTokens = Math.max(stats.cachedTokens, raw.cacheTok)
  const totalIn = raw.inTok + raw.cacheTok
  if (totalIn > 0) {
    stats.cacheHitRate = Number(((raw.cacheTok / totalIn) * 100).toFixed(1))
  }
  stats.usedCredits = Math.max(
    stats.usedCredits,
    Number(((raw.inTok + raw.outTok + raw.cacheTok) / 1000).toFixed(2)),
  )
}

/**
 * R03:quota 计算输出统一「展示口径」——remainingPercent 为剩余百分比,
 * 未配置 totalCredits/totalTokens 且无 dailyTaskCap 时返回 undefined(未知态),
 * 不再默认 100 虚构满格;值的单位(点/Token/次)与来源标签(套餐名)由渲染层按 plan 推导。
 */
function computeAgentQuotaAndUsage(
  ctx: AppContext,
  profile: AgentProfile,
  day: string,
  todayStartMs: number,
) {
  const usedToday = ctx.store.countOf(profile.id, day)
  // G5-02:余量口径修正——套餐总量是周期量,余量按"总量−周期累计"计算
  // (起点=min(最早任务,今日零点)),不再"总量−仅今日消耗"(跨日累积从不计入,余量系统性虚高)。
  // 复核修订:今日口径独立保留(usedTokensToday/usedCreditsToday 仍为今日累计),
  // 与周期口径在 tooltip 中可区分——两个统计各查一次,首任务就在今日时复用同一次查询。
  const cycleStartMs = Math.min(
    ctx.store.firstTaskCreatedAt(profile.id) ?? todayStartMs,
    todayStartMs,
  )
  const cycleStats = ctx.store.agentUsageStats(profile.id, cycleStartMs)
  const todayStats =
    cycleStartMs === todayStartMs
      ? cycleStats
      : ctx.store.agentUsageStats(profile.id, todayStartMs)

  // 若为 zcode,叠加本地权威 ~/.zcode/cli/db/db.sqlite 的用量(G5-09:5s TTL 缓存内不再开库,
  // 一次开库同时取周期与今日两个聚合)
  if (profile.id === 'zcode') {
    let raw: ZcodeUsagePair
    if (zcodeUsageCache && Date.now() - zcodeUsageCache.at < ZCODE_USAGE_CACHE_TTL_MS) {
      raw = zcodeUsageCache.raw
    } else {
      raw = readZcodeLocalUsage(ctx, cycleStartMs, todayStartMs)
      zcodeUsageCache = { at: Date.now(), raw }
    }
    if (raw.cycle) mergeZcodeRaw(cycleStats, raw.cycle)
    if (raw.today) mergeZcodeRaw(todayStats, raw.today)
  }

  const config = ctx.getConfig()
  const override = config.planOverrides?.[profile.id]

  // 1. 基准配置优先应用用户 Plan Override
  const plan = {
    ...profile.plan,
    quotaKind: override?.quotaKind ?? profile.plan.quotaKind,
    totalCredits: override?.totalCredits ?? profile.plan.totalCredits,
    totalTokens: override?.totalTokens ?? profile.plan.totalTokens,
    dailyTaskCap: override?.dailyTaskCap ?? profile.plan.dailyTaskCap,
  }

  let totalCredits = plan.totalCredits
  let totalTokens = plan.totalTokens

  let remainingTokens: number | undefined
  let remainingCredits: number | undefined
  // R03:未知态 = undefined,不虚构满格
  let remainingPercent: number | undefined

  if (plan.quotaKind === 'credits') {
    if (override?.remainingCredits !== undefined) {
      // G5-02 模式 B:用户直接填当前剩余值,原样展示(启用本应用前的用量无法回溯,
      // 不再由总量倒推,也不叠加统计消耗重复扣减);校准后可随时再校准
      remainingCredits = Math.max(0, Number(override.remainingCredits.toFixed(1)))
      if (totalCredits && totalCredits > 0) {
        remainingPercent = Math.max(0, Math.min(100, Math.round((remainingCredits / totalCredits) * 100)))
      }
    } else if (totalCredits && totalCredits > 0) {
      remainingCredits = Math.max(0, Number((totalCredits - cycleStats.usedCredits).toFixed(1)))
      remainingPercent = Math.max(0, Math.min(100, Math.round((remainingCredits / totalCredits) * 100)))
    } else if (plan.dailyTaskCap > 0) {
      remainingPercent = Math.max(0, Math.round(((plan.dailyTaskCap - usedToday) / plan.dailyTaskCap) * 100))
    }
  } else if (plan.quotaKind === 'daily') {
    // 每日配额核心依据是任务次数 (dailyTaskCap);未设上限时保持未知态
    if (plan.dailyTaskCap > 0) {
      remainingPercent = Math.max(0, Math.round(((plan.dailyTaskCap - usedToday) / plan.dailyTaskCap) * 100))
    }
    if (override?.remainingTokens !== undefined) {
      // G5-02 模式 B:显式剩余 Token 值原样展示
      remainingTokens = Math.max(0, override.remainingTokens)
    } else if (totalTokens && totalTokens > 0) {
      remainingTokens = Math.max(0, totalTokens - cycleStats.usedTokens)
    }
  } else {
    // subscription 订阅制:无 Token 总量且无每日上限时保持未知态
    if (override?.remainingTokens !== undefined) {
      // G5-02 模式 B:显式剩余 Token 值原样展示
      remainingTokens = Math.max(0, override.remainingTokens)
      if (totalTokens && totalTokens > 0) {
        remainingPercent = Math.max(0, Math.min(100, Math.round((remainingTokens / totalTokens) * 100)))
      }
    } else if (totalTokens && totalTokens > 0) {
      remainingTokens = Math.max(0, totalTokens - cycleStats.usedTokens)
      remainingPercent = Math.max(0, Math.min(100, Math.round((remainingTokens / totalTokens) * 100)))
    } else if (plan.dailyTaskCap > 0) {
      remainingPercent = Math.max(0, Math.round(((plan.dailyTaskCap - usedToday) / plan.dailyTaskCap) * 100))
    }
  }

  return {
    usedToday,
    // 今日口径(独立保留,tooltip 与渲染层"今日约 X 点"文案的事实源)
    usedTokensToday: todayStats.usedTokens,
    usedCreditsToday: todayStats.usedCredits,
    cachedTokensToday: todayStats.cachedTokens,
    cacheHitRateToday: todayStats.cacheHitRate,
    // G5-02:周期口径累计(余量计算的事实源),tooltip 与"今日"口径区分
    usedTokensCycle: cycleStats.usedTokens,
    usedCreditsCycle: cycleStats.usedCredits,
    remainingCredits,
    remainingTokens,
    remainingPercent,
    totalCredits,
    totalTokens,
    isOverridden: !!override,
  }
}

/** computeAgentQuotaAndUsage 的返回类型(缓存 Map 的值类型复用) */
type AgentQuotaResult = ReturnType<typeof computeAgentQuotaAndUsage>

/** 按契约注册全部 IPC 通道;handler 只做参数适配,业务规则都在 core */
export function registerIpcHandlers(ctx: AppContext): void {
  // 按调用取当天(本地时区):跨零点后注册时缓存的旧日期会让今日用量归零
  const today = (): string => localDayOf(Date.now())

  // 追问队列自动接续推送(P0-6/D2):父任务完成后排队消息落地为新任务,转发渲染层切选中并提示
  ctx.orchestrator.onFollowupContinued((payload) => ctx.notify('followup:continued', payload))

  // ---- agents ----
  // 列表组装口径只维护一份:agents:list 与 agents:rescan 共用
  // R03:buildAgentViews 的 quota 结果按「本地日」缓存;usage:get 命中当日缓存直接复用,
  // 不再重复执行 computeAgentQuotaAndUsage(zcode 每次都要开本地 sqlite 读模型用量)。
  // 任务事件触发的 agents:list 重拉会刷新缓存,usage:get 与侧栏展示因此严格同源。
  let quotaCache: {
    day: string
    byAgent: Map<string, AgentQuotaResult>
  } | null = null

  const buildAgentViews = async (): Promise<AgentView[]> => {
    const day = today()
    const now = new Date()
    const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const profiles = ctx.registry.list()
    // 探活并行:串行时每个无缓存客户端都要等 doctor 跑完,四个客户端启动首拉要拖 5~15s
    const healths = await Promise.all(
      profiles.map((profile) => ctx.health.check(profile.id).catch(() => undefined)),
    )
    const quotaByAgent = new Map<string, AgentQuotaResult>()
    const views = profiles.map((profile, index) => {
      const quota = computeAgentQuotaAndUsage(ctx, profile, day, todayStartMs)
      quotaByAgent.set(profile.id, quota)
      return {
        id: profile.id,
        label: profile.label,
        driver: profile.driver,
        entry: profile.entry,
        cliEntry: profile.cliEntry,
        version: profile.version,
        logoPath: profile.logoPath,
        models: ctx.registry.modelPresets(profile.id),
        defaultModel: profile.defaultModel,
        capabilities: {
          ...profile.capabilities,
          reasoningEffort: REASONING_EFFORT_CAPABLE.has(profile.driver),
        },
        plan: profile.plan,
        enabled: profile.enabled,
        health: healths[index],
        usedToday: quota.usedToday,
        remainingCredits: quota.remainingCredits,
        remainingTokens: quota.remainingTokens,
        remainingPercent: quota.remainingPercent,
        usedTokensToday: quota.usedTokensToday,
        usedCreditsToday: quota.usedCreditsToday,
        cacheHitRateToday: quota.cacheHitRateToday,
        // G5-02:周期口径消耗,tooltip 区分"今日/周期"
        usedTokensCycle: quota.usedTokensCycle,
        usedCreditsCycle: quota.usedCreditsCycle,
        isOverridden: quota.isOverridden,
        totalCredits: quota.totalCredits,
        totalTokens: quota.totalTokens,
      }
    })
    // R03:缓存本批 quota(按日失效),供 usage:get 复用免双算
    quotaCache = { day, byAgent: quotaByAgent }
    return views
  }

  ipcMain.handle('agents:list', (): Promise<AgentView[]> => buildAgentViews())

  ipcMain.handle('quota:get', () => {
    const day = today()
    const now = new Date()
    const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return ctx.registry.list().map((profile) => ({
      agentId: profile.id,
      ...computeAgentQuotaAndUsage(ctx, profile, day, todayStartMs),
    }))
  })

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
  ipcMain.handle('tasks:list', (_e, filter?: TaskFilterDto) => {
    // 以仓库为事实源:任务删除/保留期清理能立刻从列表消失(orchestrator 存活表不感知删除)
    const tasks = ctx.store.allTasks().filter((task) => matchesFilter(task, filter))
    // 全局序维持 createdAt 倒序(P0-2 复审):compareTaskOrder 是组内良构序,orderIndex 是组内
    // 连续值——若在此全局应用,任一组拖过一次后其余未排序组的任务会在"全部"视图整体后置,
    // 未手动排序的组将失去创建时间倒序。手动序由渲染层在分组子序列上应用(TaskList.visible)。
    const sorted = tasks.sort((a, b) => b.createdAt - a.createdAt)
    // G5-05:附带排队追问数量(契约层此前无数据,渲染层无法在任务列表标识队列)
    const counts = ctx.orchestrator.getFollowupCounts()
    return sorted.map((task) => {
      const followupCount = counts.get(task.id)
      return followupCount ? { ...task, followupCount } : task
    })
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

  ipcMain.handle('tasks:submit-batch', async (_e, dtos: SubmitTaskDto[]): Promise<BatchSubmitResult> => {
    // G5-07:per-item 容错——单行失败(参数非法/去重命中)收集进 errors,不中断剩余行;
    // 返回 {created, errors} 供渲染层汇总"已入队 N 条,失败 M 条"
    const created: TaskRecord[] = []
    const errors: Array<{ index: number; message: string }> = []
    for (let i = 0; i < dtos.length; i++) {
      try {
        created.push(await submitDedup(ctx, dtos[i]!))
      } catch (e) {
        errors.push({ index: i, message: e instanceof Error ? e.message : String(e) })
      }
    }
    return { created, errors }
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

  ipcMain.handle(
    'tasks:continue',
    (_e, taskId: string, prompt: string, options?: ContinueOptions) => {
      return ctx.orchestrator.continueConversation(taskId, prompt, options)
    },
  )

  ipcMain.handle(
    'tasks:enqueue-followup',
    (_e, taskId: string, prompt: string, skills?: string[]) => {
      return ctx.orchestrator.enqueueFollowup(taskId, prompt, skills)
    },
  )

  ipcMain.handle('tasks:get-followups', (_e, taskId: string) => {
    return ctx.orchestrator.getFollowups(taskId)
  })

  ipcMain.handle('tasks:remove-followup', (_e, taskId: string, followupId: string) => {
    return ctx.orchestrator.removeFollowup(taskId, followupId)
  })

  ipcMain.handle('tasks:clear-followups', (_e, taskId: string) => {
    ctx.orchestrator.clearFollowups(taskId)
  })

  // 编辑排队消息文案(P0-6/D3):目标不存在时由编排层抛错回传渲染层
  ipcMain.handle(
    'tasks:update-followup',
    (_e, taskId: string, followupId: string, prompt: string) => {
      return ctx.orchestrator.updateFollowup(taskId, followupId, prompt)
    },
  )

  // 队列内移动(P0-6/D3):beforeFollowupId 须同队列,null/缺省 = 移到队尾
  ipcMain.handle(
    'tasks:reorder-followup',
    (_e, taskId: string, followupId: string, beforeFollowupId?: string | null) => {
      ctx.orchestrator.reorderFollowup(taskId, followupId, beforeFollowupId ?? null)
    },
  )

  // 队列整体迁移(P0-6 复审):打断发送拿到新任务后,遗留排队项搬到新任务继续自动接续
  ipcMain.handle('tasks:migrate-followups', (_e, fromTaskId: string, toTaskId: string) => {
    return ctx.orchestrator.migrateFollowups(fromTaskId, toTaskId)
  })

  // 卡片归属变更(P0-2):移入另一项目工作区;受影响分组 orderIndex 由仓库重算,客户端不传全量数组
  ipcMain.handle('tasks:move', (_e, dto: MoveTaskDto) => {
    if (!ctx.store.allProjects().some((p) => p.id === dto.projectId)) {
      throw new Error('目标工作区不存在')
    }
    if (!ctx.store.moveTask(dto.taskId, dto.projectId)) {
      throw new Error(`unknown task: ${dto.taskId}`)
    }
    // live 表同步归属:否则后续状态迁移/usage 落库经 putTask 会把旧 projectId 回写,
    // 排序位保住了而归属被静默回滚(P0-2 复审)
    ctx.orchestrator.syncTaskProject(dto.taskId, dto.projectId)
    // 排序/归属不产生任务事件,经 tasks:updated 让各窗口重拉列表
    ctx.notify('tasks:updated')
  })

  // 组内相邻插入排序(P0-2):beforeTaskId 须同组,null/缺省 = 移到组尾
  ipcMain.handle('tasks:reorder', (_e, taskId: string, beforeTaskId?: string | null) => {
    if (!ctx.store.reorderTask(taskId, beforeTaskId ?? null)) {
      throw new Error(`unknown task: ${taskId}`)
    }
    ctx.notify('tasks:updated')
  })

  ipcMain.handle('tasks:rename', (_e, taskId: string, title: string) => {
    return ctx.orchestrator.rename(taskId, title)
  })

  ipcMain.handle('tasks:cancel', (_e, taskId: string, clearFollowups?: boolean) => {
    // R07:终止只停当前轮——IPC 层缺省按 false 保留排队追问(打断发送显式传 false 不受影响);
    // 批量删除继续依赖 orchestrator.cancel 签名默认 true 在删除时清队列,防止 followupQueues 留孤儿键
    return ctx.orchestrator.cancel(taskId, clearFollowups ?? false)
  })

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
      // R07:批量终止同样只停任务不清队列(显式 false,不踩 orchestrator.cancel 签名默认 true)
      if (ctx.orchestrator.cancel(id, false)) count++
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
      // (R07:此处依赖 cancel 签名默认 clearFollowups=true,删除时一并清掉追问队列)
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
      // G5-08:右键/详情页的"换客户端重跑"是用户主动操作,origin 记 panel(徽标显示"面板"),
      // 不再冒充系统自动降级(failover 观察者路径保持显式 'failover')
      origin: 'panel',
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
    const now = new Date()
    const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    // R03:命中当日缓存复用 agents:list 刚算好的 quota,不再重复执行 computeAgentQuotaAndUsage;
    // 仅在尚无当日缓存(启动后先调 usage)或跨零点(day 失效)时现算
    const cached = quotaCache?.day === day ? quotaCache.byAgent : null
    return ctx.registry.list().map((profile) => {
      const usage = ctx.store.usageOf(profile.id, day)
      const quota =
        cached?.get(profile.id) ?? computeAgentQuotaAndUsage(ctx, profile, day, todayStartMs)
      return {
        agentId: profile.id,
        label: profile.label,
        day,
        taskCount: usage.taskCount,
        estimated: usage.estimated,
        dailyTaskCap: profile.plan.dailyTaskCap,
        usedTokensToday: quota.usedTokensToday,
        usedCreditsToday: quota.usedCreditsToday,
        cachedTokensToday: quota.cachedTokensToday,
        cacheHitRateToday: quota.cacheHitRateToday,
        remainingCredits: quota.remainingCredits,
        remainingTokens: quota.remainingTokens,
        remainingPercent: quota.remainingPercent,
        totalCredits: quota.totalCredits,
        totalTokens: quota.totalTokens,
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

  // G5-02:单客户端套餐校准(设置页写入,含"直接填当前剩余值"模式 B);
  // patch=null 清除该校准恢复注册默认。写入即广播,侧栏余量立即按新校准呈现。
  ipcMain.handle(
    'settings:set-plan-override',
    (_e, agentId: string, patch: PlanOverrideConfig | null): AppConfig => {
      const prev = ctx.getConfig()
      const planOverrides: Record<string, PlanOverrideConfig> = { ...(prev.planOverrides ?? {}) }
      if (patch) {
        planOverrides[agentId] = { ...planOverrides[agentId], ...patch }
      } else {
        delete planOverrides[agentId]
      }
      ctx.saveConfig({ ...prev, planOverrides })
      ctx.notify('agents:changed')
      return ctx.getConfig()
    },
  )

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
    dto.reasoningEffort ?? '',
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
  // G5-05:search 口径与渲染层(TaskList toLowerCase+含标题)逐字对齐——
  // 大小写不敏感且匹配标题,避免有任务运行期重拉时按旧口径收窄列表
  if (filter.search) {
    const q = filter.search.toLowerCase()
    const hit =
      task.prompt.toLowerCase().includes(q) || (task.title ?? '').toLowerCase().includes(q)
    if (!hit) return false
  }
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
): ArtifactChange[] {
  const changes: ArtifactChange[] = []
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
