import type {
  AgentDroveApi,
  AgentView,
  AppConfig,
  FollowupQueueItem,
  Project,
  StoredEvent,
  TaskRecord,
} from '@agent-drove/shared'
import { DEFAULT_CONFIG, MODEL_CLIENT_FOLLOW } from '@agent-drove/core'

/**
 * 浏览器直开(无 Electron 桥)时的样例数据,
 * 仅 import.meta.env.DEV 生效且会被产物构建剔除,不影响打包产物。
 * 所有方法按 shared 的 AgentDroveApi 契约实现,形状与真实 preload 一致。
 */
export function installDevMock(): void {
  const agents: AgentView[] = [
    {
      id: 'zcode',
      label: 'ZCode',
      driver: 'zcode',
      entry: 'E:/ZCode/ZCode.exe',
      cliEntry: 'E:/ZCode/resources/glm/zcode.cjs',
      version: '0.16.9',
      models: [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }],
      defaultModel: MODEL_CLIENT_FOLLOW,
      capabilities: { headless: true, sessionResume: true, modelSwitch: 'none', attachments: true },
      plan: { name: 'GLM Coding Plan', quotaKind: 'daily', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: true,
      health: { ok: true, at: Date.now() },
      usedToday: 7,
    },
    {
      id: 'trae',
      label: 'TraeCode',
      driver: 'trae',
      entry: 'E:/Trae/bin/trae.cmd',
      version: '1.107.1',
      models: [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }],
      defaultModel: MODEL_CLIENT_FOLLOW,
      capabilities: { headless: false, sessionResume: false, modelSwitch: 'none', attachments: true },
      plan: { name: 'Trae 官方套餐', quotaKind: 'subscription', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: true,
      health: { ok: false, reason: '未登录', at: Date.now() },
      usedToday: 2,
    },
    {
      id: 'qoder',
      label: 'Qoder CN',
      driver: 'qoder',
      entry: 'qoderclicn',
      models: [{ id: 'qoder-default', label: '默认模型' }],
      defaultModel: 'qoder-default',
      capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg', attachments: false },
      plan: { name: 'Qoder Credits', quotaKind: 'credits', modelIds: ['qoder-default'], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: false,
      health: { ok: true, at: Date.now() },
      usedToday: 0,
    },
  ]

  const now = Date.now()
  const tasks: TaskRecord[] = [
    ['completed', '重构 packages/core 的节流器,抽离公平放行逻辑,补 12 个单测', 'zcode', 52 * 60_000],
    ['running', '给设置页补深色对比度检查,输出修复清单', 'zcode', 3 * 60_000],
    ['failed', '把 README 的安装章节翻译成英文', 'trae', 90_000],
    ['queued', '梳理 qoder CLI 参数矩阵,回填方案 3.1 表格', 'zcode', 0],
    ['canceled', '试验 websockets 方案', 'zcode', 8_000],
    ['interrupted', '迁移 journal 表到 v3 schema', 'trae', 15 * 60_000],
  ].map(([state, prompt, agentId, runMs], i) => ({
    id: `demo-task-${i + 1}`,
    agentId: agentId as string,
    modelId: MODEL_CLIENT_FOLLOW,
    prompt: prompt as string,
    cwd: 'E:/idea work/AgentDrove',
    projectId: i % 2 === 0 ? 'demo-proj-1' : 'daily',
    state: state as TaskRecord['state'],
    sessionId: i === 0 ? 'sess-demo-0001' : undefined,
    attachments: [],
    mode: 'build' as const,
    origin: (['panel', 'hotkey', 'failover', 'panel', 'tray', 'panel'] as const)[i],
    createdAt: now - (i + 1) * 40 * 60_000,
    startedAt: now - (i + 1) * 40 * 60_000 + 5_000,
    finishedAt: (state as string) === 'queued' || (state as string) === 'running' ? undefined : now - (i + 1) * 40 * 60_000 + 5_000 + (runMs as number),
    attempt: i === 2 ? 2 : 1,
  }))

  let seq = 100
  const followups = new Map<string, FollowupQueueItem[]>()
  const projects: Project[] = [
    { id: 'daily', name: '日常工作区', path: null, createdAt: now },
    { id: 'demo-proj-1', name: 'AgentDrove', path: 'E:/idea work/AgentDrove', createdAt: now - 1 },
  ]
  /** 可变配置:settingsUpdate 落地后 settingsGet 能读回,开发期验证保存链路 */
  let currentConfig: AppConfig = DEFAULT_CONFIG

  /** 每任务的样例事件流,按 seq 升序;翻页时按 beforeSeq 截取 */
  function eventsFor(taskId: string): StoredEvent[] {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return []
    const base = task.createdAt
    return [
      { taskId, seq: 1, at: base, event: { kind: 'state-changed', from: 'queued', to: 'running' } },
      { taskId, seq: 2, at: base + 6_000, event: { kind: 'message', channel: 'stdout', text: '已读取 14 个文件,定位到 throttle.ts 与 orchestrator.ts 的耦合点。' } },
      { taskId, seq: 3, at: base + 21_000, event: { kind: 'progress', text: '分析依赖图 (3/7)' } },
      { taskId, seq: 4, at: base + 40_000, event: { kind: 'warning', text: '客户端版本 0.16.9 超出驱动声明范围 >=0.16 <0.17 边缘' } },
      { taskId, seq: 5, at: base + 61_000, event: { kind: 'artifact', path: 'packages/core/src/throttle.ts', change: 'modified' } },
      { taskId, seq: 6, at: base + 62_000, event: { kind: 'usage', inputTokens: 12400, outputTokens: 3120 } },
      { taskId, seq: 7, at: base + 63_000, event: { kind: 'state-changed', from: 'running', to: 'completed' } },
    ]
  }

  function findTask(taskId: string): TaskRecord {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`mock: 任务不存在 ${taskId}`)
    return task
  }

  /** mock 组内展示序比较器:orderIndex 非空升序在前,空缺按 createdAt 倒序随后(与 main 同语义) */
  function byManualOrder(a: TaskRecord, b: TaskRecord): number {
    return (
      (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER) ||
      b.createdAt - a.createdAt
    )
  }

  /** mock 重赋某分组连续 orderIndex(0..n-1);appendTask 存在时先追加到组尾再整体编号 */
  function renumberGroup(projectId: string | null, appendTask?: TaskRecord): void {
    const ids = tasks
      .filter((t) => (t.projectId ?? null) === projectId)
      .sort(byManualOrder)
      .map((t) => t.id)
    if (appendTask) {
      const at = ids.indexOf(appendTask.id)
      if (at >= 0) ids.splice(at, 1)
      ids.push(appendTask.id)
    }
    ids.forEach((id, index) => {
      const t = tasks.find((x) => x.id === id)
      if (t) t.orderIndex = index
    })
  }

  const mock: AgentDroveApi = {
    agentsList: async () => agents,
    agentsSetEnabled: async (agentId, enabled) => {
      const agent = agents.find((a) => a.id === agentId)
      if (agent) agent.enabled = enabled
    },
    agentsRescan: async () => agents,
    projectsList: async () => projects,
    projectsPickAndAdd: async () => null, // 浏览器环境无原生目录弹窗
    projectsBindDaily: async (path) => {
      const daily = projects.find((p) => p.id === 'daily')
      if (!daily) throw new Error('mock: 日常工作区缺失')
      daily.path = path
      return daily
    },
    projectsRename: async (projectId, name) => {
      const project = projects.find((p) => p.id === projectId)
      if (project) project.name = name
    },
    projectsRemove: async (projectId) => {
      const index = projects.findIndex((p) => p.id === projectId)
      if (index >= 0) projects.splice(index, 1)
    },
    pickDirectory: async () => null, // 浏览器环境无原生目录弹窗
    tasksList: async () => tasks,
    tasksGet: async (id) => tasks.find((t) => t.id === id) ?? null,
    tasksEventsPage: async ({ taskId, beforeSeq, limit = 200 }) => {
      const all = eventsFor(taskId)
      const page = beforeSeq === undefined ? all : all.filter((e) => e.seq < beforeSeq)
      return page.slice(-limit)
    },
    tasksSubmit: async (dto) => {
      const task: TaskRecord = {
        id: `demo-${++seq}`,
        agentId: dto.agentId,
        modelId: dto.modelId ?? MODEL_CLIENT_FOLLOW,
        prompt: dto.prompt,
        cwd: dto.cwd ?? 'E:/idea work/AgentDrove',
        projectId: dto.projectId,
        state: 'queued',
        sessionId: dto.sessionId,
        resumeLatest: dto.resumeLatest,
        attachments: dto.attachments ?? [],
        toolPolicy: dto.toolPolicy,
        mode: dto.mode ?? 'build',
        origin: dto.origin ?? 'panel',
        createdAt: Date.now(),
        attempt: 1,
      }
      tasks.unshift(task)
      return task
    },
    tasksSubmitBatch: async (dtos) => {
      // G5-07:per-item 容错,与主进程 handlers 同构——单行失败收集进 errors,不中断剩余行
      const created: TaskRecord[] = []
      const errors: Array<{ index: number; message: string }> = []
      for (let i = 0; i < dtos.length; i++) {
        try {
          created.push(await mock.tasksSubmit(dtos[i]!))
        } catch (e) {
          errors.push({ index: i, message: e instanceof Error ? e.message : String(e) })
        }
      }
      return { created, errors }
    },
    tasksRetry: async (taskId) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({ agentId: parent.agentId, prompt: parent.prompt, origin: 'panel' })
    },
    tasksContinue: async (taskId, prompt) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({
        agentId: parent.agentId,
        prompt,
        sessionId: parent.sessionId,
        resumeLatest: parent.resumeLatest,
      })
    },
    tasksCancel: async (taskId) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task || (task.state !== 'queued' && task.state !== 'running')) return false
      task.state = 'canceled'
      task.finishedAt = Date.now()
      return true
    },
    tasksMarkFailed: async (taskId, reason) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return false
      task.state = 'failed'
      task.error = reason ?? '手动标记失败'
      task.finishedAt = Date.now()
      return true
    },
    tasksBatchCancel: async (ids) => {
      let canceled = 0
      for (const task of tasks) {
        if (!ids.includes(task.id)) continue
        if (task.state !== 'queued' && task.state !== 'running') continue
        task.state = 'canceled'
        task.finishedAt = Date.now()
        canceled++
      }
      return canceled
    },
    tasksBatchDelete: async (ids) => {
      let removed = 0
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i]!
        if (ids.includes(task.id) && task.state !== 'running') {
          tasks.splice(i, 1)
          removed++
        }
      }
      return removed
    },
    tasksResubmitOn: async (taskId, target) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({ agentId: target, prompt: parent.prompt, origin: 'failover' })
    },
    tasksEnqueueFollowup: async (taskId, prompt, skills) => {
      findTask(taskId)
      const item: FollowupQueueItem = {
        id: `fq-${++seq}`,
        parentTaskId: taskId,
        prompt,
        skills,
        createdAt: Date.now(),
      }
      const queue = followups.get(taskId) ?? []
      queue.push(item)
      followups.set(taskId, queue)
      return item
    },
    tasksGetFollowups: async (taskId) => [...(followups.get(taskId) ?? [])],
    tasksRemoveFollowup: async (taskId, followupId) => {
      const queue = followups.get(taskId)
      if (!queue) return false
      const idx = queue.findIndex((item) => item.id === followupId)
      if (idx < 0) return false
      queue.splice(idx, 1)
      if (queue.length === 0) followups.delete(taskId)
      return true
    },
    tasksClearFollowups: async (taskId) => {
      followups.delete(taskId)
    },
    // —— P0-2/P0-6 通道内存实现:编辑排队文案/拖拽排序/移动归属/队列迁移,dev 自测不失真 ——
    tasksUpdateFollowup: async (taskId, followupId, prompt) => {
      const item = followups.get(taskId)?.find((i) => i.id === followupId)
      if (!item) throw new Error(`mock: 排队消息不存在 ${followupId}`)
      item.prompt = prompt.trim()
      return item
    },
    tasksReorderFollowup: async (taskId, followupId, beforeFollowupId) => {
      const queue = followups.get(taskId)
      const idx = queue?.findIndex((i) => i.id === followupId) ?? -1
      if (!queue || idx < 0) throw new Error(`mock: 排队消息不存在 ${followupId}`)
      if (beforeFollowupId === followupId) return
      if (beforeFollowupId != null && !queue.some((i) => i.id === beforeFollowupId)) {
        throw new Error(`mock: 排队消息不存在 ${beforeFollowupId}`)
      }
      const [item] = queue.splice(idx, 1)
      if (beforeFollowupId == null) queue.push(item!)
      else queue.splice(queue.findIndex((i) => i.id === beforeFollowupId), 0, item!)
    },
    tasksMigrateFollowups: async (fromTaskId, toTaskId) => {
      if (fromTaskId === toTaskId) return 0
      const queue = followups.get(fromTaskId)
      if (!queue || queue.length === 0) return 0
      for (const item of queue) item.parentTaskId = toTaskId
      const target = followups.get(toTaskId) ?? []
      target.push(...queue)
      followups.set(toTaskId, target)
      followups.delete(fromTaskId)
      return queue.length
    },
    tasksMove: async (dto) => {
      const task = findTask(dto.taskId)
      const fromProject = task.projectId ?? null
      task.projectId = dto.projectId
      // 与 core 语义一致:移出组剔除后重赋,移入组追加组尾
      renumberGroup(fromProject)
      renumberGroup(dto.projectId, task)
    },
    tasksReorder: async (taskId, beforeTaskId) => {
      const task = findTask(taskId)
      const group = tasks
        .filter((t) => (t.projectId ?? null) === (task.projectId ?? null))
        .sort(byManualOrder)
        .map((t) => t.id)
      const ids = group.filter((id) => id !== taskId)
      const at = beforeTaskId ? Math.max(0, ids.indexOf(beforeTaskId)) : ids.length
      ids.splice(at, 0, taskId)
      ids.forEach((id, index) => {
        const t = tasks.find((x) => x.id === id)
        if (t) t.orderIndex = index
      })
    },
    tasksRename: async (taskId, title) => {
      findTask(taskId).title = title
    },
    healthCheck: async () => ({ ok: true, at: Date.now() }),
    launchApp: async () => 'deep-link',
    usageGet: async () => {
      const today = new Date()
      const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      return agents.map((a) => ({
        agentId: a.id,
        label: a.label,
        day,
        taskCount: a.usedToday,
        estimated: 0,
        dailyTaskCap: a.plan.dailyTaskCap,
        usedTokensToday: 0,
        usedCreditsToday: 0,
        cachedTokensToday: 0,
        cacheHitRateToday: 0,
      }))
    },
    settingsGet: async () => currentConfig,
    settingsUpdate: async (patch) => {
      currentConfig = { ...currentConfig, ...patch }
      return currentConfig
    },
    // G5-02/G4-06:套餐校准,语义与 main handlers 一致——patch 合并进该客户端校准,
    // null 删除恢复注册默认;mock 只落 planOverrides,余量折算由真实链路(core)计算
    settingsSetPlanOverride: async (agentId, patch) => {
      const overrides = { ...(currentConfig.planOverrides ?? {}) }
      if (patch) overrides[agentId] = { ...overrides[agentId], ...patch }
      else delete overrides[agentId]
      currentConfig = { ...currentConfig, planOverrides: overrides }
      return currentConfig
    },
    schedulerPause: async (paused) => {
      currentConfig = { ...currentConfig, schedulerPaused: paused }
    },
    logsTail: async () => ['2026-10-01T22:00:00 info 保留期清理完成 { removedTasks: 3 }'],
    exportData: async () => ({ path: 'C:/Users/demo/Desktop/agentdrove-export.json' }),
    exportWeeklyReport: async () => ({ path: 'C:/Users/demo/Desktop/agentdrove-weekly.csv' }),
    workspacesList: async () => [
      { id: 'ws-1', taskId: 'demo-task-1', path: 'E:/ws/agentdrove-t1', kind: 'worktree', source: '{"repo":"E:/idea work/AgentDrove","baseHead":"cafe123"}', status: 'done', createdAt: now },
    ],
    workspacesClean: async () => {},
    workspacesMerge: async () => ({ merged: ['packages/core/src/throttle.ts'], conflicts: ['README.md'] }),
    updateCheck: async () => ({ phase: 'checking' }),
    updateInstall: async () => {},
    openPath: async () => {},
    onTasksEventsBatch: () => () => {},
    onTasksUpdated: () => () => {},
    onAgentsChanged: () => () => {},
    onSchedulerChanged: () => () => {},
    onUpdateStatus: () => () => {},
    onPanelFocus: () => () => {},
    onHotkeyConflict: () => () => {},
    onMiniPrefill: () => () => {},
    onWindowMaximized: () => () => {},
    windowMinimize: async () => {},
    windowToggleMaximize: async () => {},
    windowClose: async () => {},
    hideMini: async () => {},
    filePath: (file) => file.name,
  }
  window.api = mock
}